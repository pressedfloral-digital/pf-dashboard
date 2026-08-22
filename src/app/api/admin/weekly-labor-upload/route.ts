import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';

// Parse "Mar 30 2026 - Apr 05 2026" → "2026-03-30" (Monday/week start)
function parseWeekStart(raw: string): string | null {
  if (!raw || raw === 'All') return null;
  const part = raw.split(' - ')[0].trim(); // "Mar 30 2026"
  const d = new Date(part + ' 12:00:00');
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

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
  if (l.includes('design'))                          return 'Design';
  if (l.includes('preservation'))                    return 'Preservation';
  if (l.includes('fulfillment'))                     return 'Fulfillment';
  if (l.includes('general') || l.includes('admin'))  return 'G&A';
  if (l.includes('operations'))                      return 'G&A';
  if (l.includes('resin'))                           return 'Resin';
  return raw;
}

interface WeeklyLaborRow {
  employee:  string;
  location:  string;
  department: string;
  weekOf:    string; // ISO Monday
  grossPay:  number;
}

// POST /api/admin/weekly-labor-upload
// Body: { rows: WeeklyLaborRow[] }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { rows } = await req.json() as { rows: WeeklyLaborRow[] };
    if (!Array.isArray(rows) || rows.length === 0)
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 });

    const records = rows
      .filter(r => r.employee && r.location && r.department && r.weekOf && r.grossPay > 0)
      .map(r => ({
        employee:   r.employee.trim(),
        location:   normalizeLocation(r.location),
        department: normalizeDept(r.department),
        week_of:    r.weekOf,
        gross_pay:  r.grossPay,
        uploaded_at: new Date().toISOString(),
      }));

    if (records.length === 0)
      return NextResponse.json({ error: 'No valid rows after filtering' }, { status: 400 });

    // Upsert in batches of 100
    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const { error } = await supabase
        .from('weekly_labor_cost')
        .upsert(records.slice(i, i + BATCH), { onConflict: 'employee,location,department,week_of' });
      if (error) throw new Error(`Supabase error: ${error.message}`);
      inserted += records.slice(i, i + BATCH).length;
    }

    const weeks  = [...new Set(records.map(r => r.week_of))].sort();
    const people = [...new Set(records.map(r => r.employee))];
    const depts  = [...new Set(records.map(r => r.department))];
    const total  = records.reduce((s, r) => s + r.gross_pay, 0);

    return NextResponse.json({
      ok: true, inserted,
      people: people.length,
      weeks: { from: weeks[0], to: weeks[weeks.length - 1], count: weeks.length },
      departments: depts,
      totalGross: total,
    });
  } catch (e) {
    console.error('Weekly labor upload error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET /api/admin/weekly-labor-upload?location=Georgia&from=2026-03-30&to=2026-03-30
// Returns weekly labor cost grouped by dept for CPO calculation
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location');
  const from     = req.nextUrl.searchParams.get('from');
  const to       = req.nextUrl.searchParams.get('to');

  try {
    // fetchAllRows — an unranged .select() silently truncates at Postgrest's
    // 1000-row default once the table crosses it (it already has, at 1124
    // rows), and a caller hitting this without location/from/to would get
    // that truncation with zero indication anything's missing. See
    // src/lib/fetchAllRows.ts.
    const data = await fetchAllRows<{ employee: string; location: string; department: string; week_of: string; gross_pay: number }>((rangeFrom, rangeTo) => {
      let query = supabase
        .from('weekly_labor_cost')
        .select('employee,location,department,week_of,gross_pay');
      if (location) query = query.eq('location', location);
      if (from)     query = query.gte('week_of', from);
      if (to)       query = query.lte('week_of', to);
      return query.order('week_of').order('department').order('employee').range(rangeFrom, rangeTo);
    });

    // Aggregate by dept+week
    const byDeptWeek: Record<string, Record<string, number>> = {};
    // key: dept → week_of → total gross
    for (const row of data) {
      if (!byDeptWeek[row.department]) byDeptWeek[row.department] = {};
      byDeptWeek[row.department][row.week_of] = (byDeptWeek[row.department][row.week_of] ?? 0) + row.gross_pay;
    }

    return NextResponse.json({ ok: true, rows: data ?? [], byDeptWeek });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
