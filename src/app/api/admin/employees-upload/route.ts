import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { syncRosterRoles } from '@/lib/rosterRoleSync';
import { recordRateHistory } from '@/lib/rateHistorySync';

function normalizeLocation(raw: string): string {
  if (!raw) return '';
  const l = raw.toLowerCase();
  if (l.includes('georgia')) return 'Georgia';
  if (l.includes('utah'))    return 'Utah';
  return raw.replace('Pressed Floral ', '');
}

function normalizeDept(raw: string): string {
  if (!raw) return '';
  const l = raw.toLowerCase();
  if (l.includes('design'))        return 'Design';
  if (l.includes('preservation'))  return 'Preservation';
  if (l.includes('fulfillment'))   return 'Fulfillment';
  if (l.includes('resin'))         return 'Resin';
  return raw;
}

function inferRole(title: string): 'specialist' | 'senior' | 'master' {
  const t = (title ?? '').toLowerCase();
  if (t.includes('manager') || t.includes('head of') || t.includes('director') || t.includes('master')) return 'master';
  if (t.includes('senior')) return 'senior';
  return 'specialist';
}

interface EmployeeRow {
  fullName:       string;
  location:       string;
  department:     string;
  title:          string;
  payType:        'hourly' | 'salary';
  hourlyRate:     number;
  annualSalary:   number;
  employmentType: string;
}

// POST /api/admin/employees-upload
// Body: { employees: EmployeeRow[] }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { employees } = await req.json() as { employees: EmployeeRow[] };
    if (!Array.isArray(employees) || employees.length === 0)
      return NextResponse.json({ error: 'No employees provided' }, { status: 400 });

    const records = employees
      .filter(e => e.fullName && e.location && e.department)
      .map(e => ({
        full_name:       e.fullName.trim(),
        location:        normalizeLocation(e.location),
        department:      normalizeDept(e.department),
        title:           e.title?.trim() ?? '',
        role:            inferRole(e.title ?? ''),
        pay_type:        e.payType,
        hourly_rate:     e.hourlyRate ?? 0,
        annual_salary:   e.annualSalary ?? 0,
        employment_type: e.employmentType?.trim() ?? '',
        active:          true,
        updated_at:      new Date().toISOString(),
      }));

    const { error } = await supabase
      .from('rippling_employees')
      .upsert(records, { onConflict: 'full_name,location,department' });
    if (error) throw error;

    // Propagate any new/changed roles and pay rates into the live Scheduling
    // rosters so Expected/Goal projections and estimated cost/CPO stay
    // current automatically.
    const { updated: rosterRoleUpdates } = await syncRosterRoles(supabase);

    // Record any pay change with today's date so past weeks that estimate
    // cost from a rate keep using the rate that was actually in effect then.
    const { inserted: rateHistoryInserted } = await recordRateHistory(supabase, records);

    return NextResponse.json({
      ok: true,
      inserted: records.length,
      employees: records.map(r => ({ name: r.full_name, location: r.location, department: r.department, title: r.title, role: r.role })),
      rosterRoleUpdates,
      rateHistoryInserted,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// GET /api/admin/employees-upload?location=Utah&department=Design
// Returns employees for autocomplete in roster editor
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location   = req.nextUrl.searchParams.get('location');
  const department = req.nextUrl.searchParams.get('department');
  const search     = req.nextUrl.searchParams.get('search') ?? '';

  try {
    let query = supabase
      .from('rippling_employees')
      .select('full_name,location,department,title,role,pay_type,hourly_rate,annual_salary')
      .eq('active', true)
      .order('full_name');

    if (location)   query = query.eq('location', location);
    // department filter omitted intentionally — workers can flex across depts
    if (search)     query = query.ilike('full_name', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return NextResponse.json({ ok: true, employees: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
