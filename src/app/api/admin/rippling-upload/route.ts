import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';

// ── POST /api/admin/rippling-upload ───────────────────────────────────────────
// Accepts parsed payroll rows from the client (already parsed from XLSX there)
// and upserts them into rippling_payroll.
// Body: { rows: RipplingRow[] }
// RipplingRow: { fullName, department, location, title, employmentType, grossPay, bonusAmount, checkDate }

interface RipplingRow {
  fullName:       string;
  department:     string;
  location:       string;
  title:          string;
  employmentType: string;
  grossPay:       number;
  bonusAmount:    number;
  checkDate:      string; // ISO date string YYYY-MM-DD
}

// Normalize Rippling location names → Utah / Georgia
function normalizeLocation(raw: string): string {
  if (raw.toLowerCase().includes('georgia')) return 'Georgia';
  if (raw.toLowerCase().includes('utah'))    return 'Utah';
  return raw;
}

// Normalize department names to match dashboard dept keys
function normalizeDepartment(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('design'))        return 'Design';
  if (lower.includes('preservation'))  return 'Preservation';
  if (lower.includes('fulfillment'))   return 'Fulfillment';
  if (lower.includes('operations'))    return 'Operations';
  if (lower.includes('growth'))        return 'Growth';
  if (lower.includes('client'))        return 'Client Care';
  if (lower.includes('resin'))         return 'Resin';
  return raw;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { rows } = await req.json() as { rows: RipplingRow[] };

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 });
    }

    // Normalize and validate rows
    const records = rows
      .filter(r => r.fullName && r.checkDate && r.grossPay >= 0)
      .map(r => ({
        full_name:       r.fullName.trim(),
        department:      normalizeDepartment(r.department ?? ''),
        location:        normalizeLocation(r.location ?? ''),
        title:           r.title?.trim() ?? '',
        employment_type: r.employmentType?.trim() ?? '',
        gross_pay:       r.grossPay,
        bonus_amount:    r.bonusAmount ?? 0,
        check_date:      r.checkDate,
        uploaded_at:     new Date().toISOString(),
      }));

    if (records.length === 0) {
      return NextResponse.json({ error: 'No valid rows after filtering' }, { status: 400 });
    }

    // Upsert in batches of 100
    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await supabase
        .from('rippling_payroll')
        .upsert(batch, { onConflict: 'full_name,check_date,gross_pay' });
      if (error) throw error;
      inserted += batch.length;
    }

    // Summary stats
    const names      = [...new Set(records.map(r => r.full_name))];
    const dates      = records.map(r => r.check_date).sort();
    const dateFrom   = dates[0];
    const dateTo     = dates[dates.length - 1];
    const depts      = [...new Set(records.map(r => r.department))];
    const totalGross = records.reduce((s, r) => s + r.gross_pay, 0);

    return NextResponse.json({
      ok: true,
      inserted,
      people: names.length,
      dateRange: { from: dateFrom, to: dateTo },
      departments: depts,
      totalGross,
      names,
    });
  } catch (e) {
    console.error('Rippling upload error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── GET /api/admin/rippling-upload?location=Utah&department=Design&from=2026-01-01&to=2026-04-26
// Returns gross pay totals per person for a dept/location/date range
// Used by historicals CPO calculation
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location   = req.nextUrl.searchParams.get('location');
  const department = req.nextUrl.searchParams.get('department');
  const from       = req.nextUrl.searchParams.get('from');
  const to         = req.nextUrl.searchParams.get('to');

  try {
    // fetchAllRows — same reasoning as weekly-labor-upload/payroll-upload:
    // an unranged .select() silently truncates past Postgrest's 1000-row
    // default with no error, and an unfiltered call to this route has
    // nothing bounding it. See src/lib/fetchAllRows.ts.
    const data = await fetchAllRows<{ full_name: string; department: string; location: string; gross_pay: number; bonus_amount: number | null; check_date: string; title: string | null }>((rangeFrom, rangeTo) => {
      let query = supabase
        .from('rippling_payroll')
        .select('full_name, department, location, gross_pay, bonus_amount, check_date, title');
      if (location)   query = query.eq('location', location);
      if (department) query = query.eq('department', department);
      if (from)       query = query.gte('check_date', from);
      if (to)         query = query.lte('check_date', to);
      return query.order('check_date', { ascending: true }).range(rangeFrom, rangeTo);
    });

    // Aggregate by person
    const byPerson: Record<string, { fullName: string; totalGross: number; totalBonus: number; checkCount: number; title: string }> = {};
    for (const row of data) {
      if (!byPerson[row.full_name]) {
        byPerson[row.full_name] = { fullName: row.full_name, totalGross: 0, totalBonus: 0, checkCount: 0, title: row.title ?? '' };
      }
      byPerson[row.full_name].totalGross += row.gross_pay;
      byPerson[row.full_name].totalBonus += row.bonus_amount ?? 0;
      byPerson[row.full_name].checkCount += 1;
    }

    return NextResponse.json({ ok: true, people: Object.values(byPerson), rawRows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
