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
  // GEM Studio is resin work — its hours count in Resin's historicals.
  if (l.includes('resin') || /gem\s*studio/.test(l)) return 'Resin';
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

    // Rippling's "Recreation" and "Baby Feet Design" departments (or anything
    // named Bloom Stock) are Bloom Stock Products work: those hours go only to
    // bloom_stock_week_actuals (its own table, read by the Bloom Stock
    // Products tab) — checked before normalizeDept so they never land in a
    // team department.
    const bloomGrouped: Record<string, { member_name: string; location: string; week_of: string; hours: number }> = {};

    // Actuals are per site (the tables only allow Utah/Georgia), so shifts
    // worked from any other Rippling location — e.g. "Remote" — are skipped
    // and counted in the response instead of failing the whole upload.
    let skippedOtherLocation = 0;

    for (const r of rows) {
      if (!r.employee || !r.date || !r.department || !r.location) continue;
      if (!['Utah', 'Georgia'].includes(normalizeLocation(r.location))) {
        skippedOtherLocation++;
        continue;
      }
      if (/bloom|recreation|baby\s*feet/i.test(r.department)) {
        const loc = normalizeLocation(r.location);
        const member = canonicalPayrollName(r.employee);
        const weekOf = getMondayISO(r.date);
        const key = `${member}|${loc}|${weekOf}`;
        bloomGrouped[key] ??= { member_name: member, location: loc, week_of: weekOf, hours: 0 };
        bloomGrouped[key].hours += r.durationHours ?? 0;
        continue;
      }
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
    const bloomRecords = Object.values(bloomGrouped).filter(r => r.hours > 0);
    if (records.length === 0 && bloomRecords.length === 0)
      return NextResponse.json({ error: 'No valid rows after grouping' }, { status: 400 });

    if (bloomRecords.length > 0) {
      const { error: bloomErr } = await supabase
        .from('bloom_stock_week_actuals')
        .upsert(bloomRecords.map(r => ({
          location: r.location, week_of: r.week_of, member_name: r.member_name,
          hours: Math.round(r.hours * 100) / 100,
          entered_by: 'payroll upload', updated_at: new Date().toISOString(),
        })), { onConflict: 'location,week_of,member_name' });
      if (bloomErr) throw new Error(`Bloom stock hours upsert failed: ${bloomErr.message}`);
    }

    // Upsert into team_member_week_actuals — only update actual_hours, preserve
    // actual_orders. Batched: a months-long backfill is ~1,300 person-weeks,
    // and one select + upsert per row ran past Vercel's 300s limit.
    const weekList = [...new Set(records.map(r => r.week_of))].sort();
    const existingByKey = new Map<string, { actual_orders: number; orders_source: string }>();
    if (records.length > 0) {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('team_member_week_actuals')
          .select('location, department, week_of, member_name, actual_orders, orders_source')
          .gte('week_of', weekList[0])
          .lte('week_of', weekList[weekList.length - 1])
          .order('id')
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`Reading existing actuals failed: ${error.message}`);
        for (const e of data ?? [])
          existingByKey.set(`${e.member_name}|${e.location}|${e.department}|${e.week_of}`, e);
        if (!data || data.length < PAGE) break;
      }
    }

    const now = new Date().toISOString();
    const upsertRows = records.map(rec => {
      const existing = existingByKey.get(`${rec.member_name}|${rec.location}|${rec.department}|${rec.week_of}`);
      return {
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
        updated_at:   now,
      };
    });

    let upserted = 0;
    const BATCH = 500;
    for (let i = 0; i < upsertRows.length; i += BATCH) {
      const batch = upsertRows.slice(i, i + BATCH);
      const { error } = await supabase
        .from('team_member_week_actuals')
        .upsert(batch, { onConflict: 'location,department,week_of,member_name' });
      if (error) throw new Error(`Upsert failed for weeks ${batch[0].week_of} – ${batch[batch.length - 1].week_of}: ${error.message} (${error.code ?? ''} ${error.details ?? ''})`);
      upserted += batch.length;
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
      bloomStockRows: bloomRecords.length,
      skippedOtherLocation,
    });
  } catch (e) {
    console.error('Hours upload error:', e);
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
