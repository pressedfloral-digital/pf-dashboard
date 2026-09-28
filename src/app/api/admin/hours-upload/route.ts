import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { canonicalPayrollName } from '@/lib/payrollNames';

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
  if (l.includes('design'))        return 'design';
  if (l.includes('preservation'))  return 'preservation';
  if (l.includes('fulfillment'))   return 'fulfillment';
  if (l.includes('checks') || l.includes('unboxing')) return 'checks_unboxing';
  if (l.includes('resin'))         return 'Resin';
  return raw.toLowerCase();
}

function getMondayISO(dateStr: string): string {
  // Week runs Mon–Sun; return the Monday of the week this date falls in
  // e.g. Mon May 18 → 2026-05-18, Sat May 23 → 2026-05-18, Sun May 24 → 2026-05-18
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Days to subtract to get back to Monday
  // Sun(0) → subtract 6, Mon(1) → 0, Tue(2) → 1, ... Sat(6) → 5
  const toMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - toMonday);
  return monday.toISOString().split('T')[0];
}

interface HoursRow {
  employee:       string;
  location:       string;
  department:     string;
  date:           string; // ISO date of the shift
  durationHours:  number;
}

// POST /api/admin/hours-upload
// Body: { rows: HoursRow[] }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { rows } = await req.json() as { rows: HoursRow[] };
    if (!Array.isArray(rows) || rows.length === 0)
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 });

    // Group by person + week + dept + location
    const grouped: Record<string, {
      member_name: string;
      location:    string;
      department:  string;
      week_of:     string;
      hours:       number;
    }> = {};

    for (const r of rows) {
      if (!r.employee || !r.date || !r.department || !r.location) continue;
      const dept = normalizeDept(r.department);
      const loc  = normalizeLocation(r.location);
      if (!['design', 'preservation', 'fulfillment', 'checks_unboxing', 'Resin'].includes(dept)) continue;

      const weekOf = getMondayISO(r.date);
      // File hours under the roster name so they share a row with the
      // person's synced orders (see payrollNames.ts).
      const member = canonicalPayrollName(r.employee);
      const key    = `${member}|${loc}|${dept}|${weekOf}`;

      if (!grouped[key]) {
        grouped[key] = { member_name: member, location: loc, department: dept, week_of: weekOf, hours: 0 };
      }
      grouped[key].hours += r.durationHours ?? 0;
    }

    const records = Object.values(grouped).filter(r => r.hours > 0);
    if (records.length === 0)
      return NextResponse.json({ error: 'No valid rows after grouping' }, { status: 400 });

    // Upsert into team_member_week_actuals — only update actual_hours, preserve actual_orders
    let upserted = 0;
    for (const rec of records) {
      // Check if row exists — if so, update hours only
      const { data: existing } = await supabase
        .from('team_member_week_actuals')
        .select('actual_orders, orders_source')
        .eq('location', rec.location)
        .eq('department', rec.department)
        .eq('week_of', rec.week_of)
        .eq('member_name', rec.member_name)
        .single();

      const { error } = await supabase
        .from('team_member_week_actuals')
        .upsert({
          location:     rec.location,
          department:   rec.department,
          week_of:      rec.week_of,
          member_name:  rec.member_name,
          actual_hours: Math.round(rec.hours * 100) / 100,
          actual_orders: existing?.actual_orders ?? 0,
          // A row created here has no typed order count, so leave it open to
          // the production sync. The column defaults to 'manual', which would
          // lock a new row at 0 orders forever (sync-production-actuals skips
          // anything not 'auto').
          orders_source: existing?.orders_source ?? 'auto',
          hours_source: 'upload',
          updated_at:   new Date().toISOString(),
        }, { onConflict: 'location,department,week_of,member_name' });

      if (error) throw new Error(`Upsert failed for ${rec.member_name} / ${rec.department} / ${rec.week_of}: ${error.message} (${error.code ?? ''} ${error.details ?? ''})`);
      upserted++;
    }

    // Summary
    const names  = [...new Set(records.map(r => r.member_name))];
    const weeks  = [...new Set(records.map(r => r.week_of))].sort();
    const depts  = [...new Set(records.map(r => r.department))];
    const totalH = records.reduce((s, r) => s + r.hours, 0);

    return NextResponse.json({
      ok: true,
      upserted,
      people: names.length,
      weeks: { from: weeks[0], to: weeks[weeks.length - 1], count: weeks.length },
      departments: depts,
      totalHours: Math.round(totalH * 10) / 10,
      names,
    });
  } catch (e) {
    console.error('Hours upload error:', e);
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
