import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';

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
  if (l.includes('design'))        return 'Design';
  if (l.includes('preservation'))  return 'Preservation';
  if (l.includes('fulfillment'))   return 'Fulfillment';
  return raw;
}

function inferRole(title: string): string {
  const t = (title ?? '').toLowerCase();
  if (t.includes('manager') || t.includes('head of') || t.includes('director')) return 'master';
  if (t.includes('senior')) return 'senior';
  return 'specialist';
}

function parseDate(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().split('T')[0];
  if (typeof val === 'string') return val.split('T')[0];
  return null;
}

interface PayrollRow {
  employee:       string;
  department:     string;
  location:       string;
  title:          string;
  hourlyRate:     number | null;
  salary:         number | null;
  grossPay:       number;
  periodStart:    string; // ISO date
  periodEnd:      string; // ISO date
  checkDateWeek:  string;
  payRunStatus:   string;
}

// POST /api/admin/payroll-upload
// Body: { rows: PayrollRow[] }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { rows } = await req.json() as { rows: PayrollRow[] };
    if (!Array.isArray(rows) || rows.length === 0)
      return NextResponse.json({ error: 'No rows provided' }, { status: 400 });

    const records: object[] = [];

    for (const r of rows) {
      // Skip rows with 'All' grouping subtotals
      if (!r.employee || r.employee === 'All') continue;
      if (!r.department || r.department === 'All') continue;
      if (!r.location || r.location === 'All') continue;
      if (r.grossPay <= 0) continue;
      // Skip rows with no date info at all
      if (!r.periodStart && !r.periodEnd && !r.checkDateWeek) continue;

      const dept = normalizeDept(r.department);
      const loc  = normalizeLocation(r.location);
      const payType = r.salary && r.salary > 0 ? 'salary' : 'hourly';

      // Amber Garrett: split evenly across Design and Preservation
      const isAmber = r.employee.toLowerCase().includes('amber garrett');
      const depts = isAmber ? ['Design', 'Preservation'] : [dept];

      for (const d of depts) {
        records.push({
          full_name:      r.employee.trim(),
          department:     d,
          location:       loc,
          title:          r.title?.trim() ?? '',
          role:           inferRole(r.title ?? ''),
          pay_type:       payType,
          hourly_rate:    r.hourlyRate ?? 0,
          annual_salary:  r.salary ?? 0,
          gross_pay:      isAmber ? r.grossPay / 2 : r.grossPay,
          period_start:   r.periodStart,
          period_end:     r.periodEnd,
          check_date_week: r.checkDateWeek ?? '',
          uploaded_at:    new Date().toISOString(),
        });
      }
    }

    if (records.length === 0)
      return NextResponse.json({ error: 'No valid rows after filtering' }, { status: 400 });

    // Upsert in batches
    const BATCH = 100;
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const { error } = await supabase
        .from('rippling_payroll')
        .upsert(batch, { onConflict: 'full_name,department,period_start,period_end', ignoreDuplicates: false });
      if (error) {
        console.error('Supabase upsert error:', JSON.stringify(error));
        throw new Error(`Supabase error: ${error.message} (code: ${error.code})`);
      }
      inserted += batch.length;
    }

    const names   = [...new Set((records as {full_name:string}[]).map(r => r.full_name))];
    const dates   = (records as {period_start:string}[]).map(r => r.period_start).sort();
    const depts   = [...new Set((records as {department:string}[]).map(r => r.department))];
    const totalGross = (records as {gross_pay:number}[]).reduce((s, r) => s + r.gross_pay, 0);

    return NextResponse.json({
      ok: true,
      inserted,
      people: names.length,
      dateRange: { from: dates[0], to: dates[dates.length - 1] },
      departments: depts,
      totalGross,
    });
  } catch (e) {
    console.error('Payroll upload error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET /api/admin/payroll-upload?location=Utah&department=Design&from=2026-01-01&to=2026-04-30
// Returns gross pay per person aggregated for a period — used by CPO calculation
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location   = req.nextUrl.searchParams.get('location');
  const department = req.nextUrl.searchParams.get('department');
  const from       = req.nextUrl.searchParams.get('from');
  const to         = req.nextUrl.searchParams.get('to');

  try {
    // fetchAllRows — an unfiltered call to this route (no location/department/
    // from/to) has nothing bounding it, and an unranged .select() silently
    // truncates at Postgrest's 1000-row default once the table crosses it.
    // No caller does that today, but there's no defense if one ever does.
    // See src/lib/fetchAllRows.ts.
    const data = await fetchAllRows<{ full_name: string; department: string; location: string; gross_pay: number; period_start: string; period_end: string; pay_type: string; annual_salary: number }>((from_, to_) => {
      let query = supabase
        .from('rippling_payroll')
        .select('full_name,department,location,gross_pay,period_start,period_end,pay_type,annual_salary');
      if (location)   query = query.eq('location', location);
      if (department) query = query.eq('department', department);
      // Match pay periods that overlap with the requested date range
      if (from) query = query.lte('period_start', to ?? from);
      if (to)   query = query.gte('period_end',   from ?? to);
      return query.range(from_, to_);
    });

    // For each pay record, calculate what fraction of pay falls in the requested range
    // using period overlap: days_overlap / period_length * gross_pay
    const fromDate = from ? new Date(from + 'T00:00:00') : null;
    const toDate   = to   ? new Date(to   + 'T23:59:59') : null;

    const byPerson: Record<string, { fullName: string; totalGross: number; checkCount: number }> = {};

    for (const row of data) {
      const pStart = new Date(row.period_start + 'T00:00:00');
      const pEnd   = new Date(row.period_end   + 'T23:59:59');
      const periodDays = Math.max(1, (pEnd.getTime() - pStart.getTime()) / 86400000);

      // Calculate overlap days
      const overlapStart = fromDate ? new Date(Math.max(pStart.getTime(), fromDate.getTime())) : pStart;
      const overlapEnd   = toDate   ? new Date(Math.min(pEnd.getTime(),   toDate.getTime()))   : pEnd;
      const overlapDays  = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 86400000);

      // For salary employees: prorate by overlap days
      // For hourly employees: use full gross pay (already reflects actual hours worked in the period)
      const fraction = row.pay_type === 'salary' ? overlapDays / periodDays : 1;
      const allocatedGross = row.gross_pay * fraction;

      if (allocatedGross <= 0) continue;

      if (!byPerson[row.full_name]) {
        byPerson[row.full_name] = { fullName: row.full_name, totalGross: 0, checkCount: 0 };
      }
      byPerson[row.full_name].totalGross += allocatedGross;
      byPerson[row.full_name].checkCount += 1;
    }

    return NextResponse.json({ ok: true, people: Object.values(byPerson), rawRows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
