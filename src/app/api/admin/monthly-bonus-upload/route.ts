import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

interface MonthlyBonusRow {
  employee:     string;
  location:     string;   // raw, e.g. "Pressed Floral Georgia" -- '' if the file has no such column
  department:   string;   // raw, e.g. "Operations" -- '' if the file has no such column
  payRunName:   string;
  bonusMonth:   string | null;
  grossPay:     number;
  checkDate:    string | null;
  payRunStatus: string;
}

// Same normalization weekly-labor-upload applies to its own location/dept
// columns -- kept as a local copy rather than a shared util, matching this
// codebase's existing convention of duplicating these small pure functions
// per upload route (see weekly-labor-upload/route.ts).
function normalizeLocation(raw: string): string {
  if (!raw) return '';
  const l = raw.toLowerCase();
  if (l.includes('georgia')) return 'Georgia';
  if (l.includes('utah'))    return 'Utah';
  return raw;
}

function normalizeDept(raw: string): string {
  if (!raw) return '';
  const l = raw.toLowerCase();
  if (l.includes('design'))                         return 'Design';
  if (l.includes('preservation'))                   return 'Preservation';
  if (l.includes('fulfillment'))                    return 'Fulfillment';
  if (l.includes('general') || l.includes('admin')) return 'G&A';
  if (l.includes('operations'))                     return 'G&A';
  if (l.includes('resin'))                          return 'Resin';
  return raw;
}

// POST /api/admin/monthly-bonus-upload
// Body: { rows: MonthlyBonusRow[] }
//
// The current Rippling bonus report includes "Work location name"/
// "Department" columns directly -- those are used first (normalized the
// same way weekly-labor-upload normalizes its own). Older exports without
// those columns come through with location/department = '', in which case
// this route falls back to joining `employee` against the full
// rippling_employees directory (not just active=true, since a bonus can
// legitimately be paid to someone who has since left) by name.
//
// A row that still has no department after both attempts, or whose location
// isn't Utah or Georgia (e.g. a remote employee with no location mapping),
// is still stored (never silently dropped) and reported back in `unmatched`
// with a reason -- it's excluded from department/location-level KPI totals
// until reconciled.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { rows } = await req.json() as { rows: MonthlyBonusRow[] };
    if (!Array.isArray(rows) || rows.length === 0)
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 });

    const valid = rows.filter(r =>
      r.employee && r.grossPay > 0 && r.bonusMonth && r.checkDate && r.payRunStatus === 'PAID');
    const skipped = rows.length - valid.length;

    const { data: empRows, error: empErr } = await supabase
      .from('rippling_employees')
      .select('full_name,location,department');
    if (empErr) throw empErr;

    const nameMap = new Map<string, { location: string; department: string }[]>();
    for (const e of empRows ?? []) {
      const key = e.full_name.trim().toLowerCase();
      const combos = nameMap.get(key) ?? [];
      if (!combos.some(c => c.location === e.location && c.department === e.department))
        combos.push({ location: e.location, department: e.department });
      nameMap.set(key, combos);
    }

    const unmatched: { employee: string; grossPay: number; reason: string }[] = [];
    const ambiguous: { employee: string; grossPay: number; candidates: { location: string; department: string }[] }[] = [];

    const records = valid.map(r => {
      let location   = normalizeLocation(r.location);
      let department = normalizeDept(r.department);

      // Fall back to the directory join only when the file itself didn't
      // supply a usable location/department (older report format).
      if (!location || !department) {
        const matches = nameMap.get(r.employee.trim().toLowerCase()) ?? [];
        if (matches.length === 1) {
          location   = location   || matches[0].location;
          department = department || matches[0].department;
        } else if (matches.length > 1) {
          ambiguous.push({ employee: r.employee, grossPay: r.grossPay, candidates: matches });
        }
      }

      if (!department) {
        unmatched.push({ employee: r.employee, grossPay: r.grossPay, reason: 'No department found (not in the file or the Employee Directory)' });
      } else if (location !== 'Utah' && location !== 'Georgia') {
        unmatched.push({ employee: r.employee, grossPay: r.grossPay, reason: `Location "${location || 'unknown'}" isn't Utah or Georgia` });
      }

      return {
        employee:     r.employee.trim(),
        location:     location || null,
        department:   department || null,
        bonus_month:  r.bonusMonth,
        gross_pay:    r.grossPay,
        check_date:   r.checkDate,
        pay_run_name: r.payRunName,
        uploaded_at:  new Date().toISOString(),
      };
    });

    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const { error } = await supabase
        .from('monthly_bonus')
        .upsert(records.slice(i, i + BATCH), { onConflict: 'employee,bonus_month,check_date,pay_run_name' });
      if (error) throw new Error(`Supabase error: ${error.message}`);
      inserted += records.slice(i, i + BATCH).length;
    }

    const months = [...new Set(records.map(r => r.bonus_month))].sort();
    return NextResponse.json({
      ok: true,
      inserted,
      skipped,
      totalGross: records.reduce((s, r) => s + r.gross_pay, 0),
      dateRange: { from: months[0], to: months[months.length - 1] },
      unmatched,
      ambiguous,
    });
  } catch (e) {
    console.error('Monthly bonus upload error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
