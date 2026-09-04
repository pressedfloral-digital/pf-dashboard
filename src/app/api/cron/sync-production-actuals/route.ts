import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { weekMonday } from '@/lib/pf-api';
import {
  computeAssignmentCounts,
  normalizeAssignmentStaffName,
  type AssignmentDepartment,
} from '@/lib/assignment-counts';

export const maxDuration = 300;

// Weekly: auto-fills team_member_week_actuals.actual_orders from the exact
// assignment-count endpoint used by Support Assistant's Frames > Team view,
// so managers no longer have to hand-type these counts. Runs for the most recently completed
// Mon–Sun week. Any row a manager has edited via the Historicals UI is
// marked orders_source='manual' (src/app/api/actuals/route.ts) and is never
// touched again here. actual_hours is always preserved as-is.
//
// ?dryRun=1 computes and reports what would change without writing anything.

const DEPT_KEYS = ['Preservation', 'Design', 'Fulfillment'] as const;
const ACTUALS_DEPT: Record<(typeof DEPT_KEYS)[number], string> = {
  Preservation: 'preservation',
  Design:       'design',
  Fulfillment:  'fulfillment',
};

const COUNT_KEY: Record<(typeof DEPT_KEYS)[number], AssignmentDepartment> = {
  Preservation: 'preservation',
  Design:       'design',
  Fulfillment:  'fulfillment',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

interface PlannedWrite {
  location: string;
  department: string;
  member: string;
  weekOf: string;
  computedOrders: number;
  previousOrders: number | null;
  action: 'write' | 'skip_locked' | 'skip_unresolved_location';
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

  try {
    // Most recently completed Mon–Sun week by default. An explicit weekOf is
    // available for controlled historical backfills and dry-run validation.
    const requestedWeek = req.nextUrl.searchParams.get('weekOf');
    if (requestedWeek && !ISO_DATE.test(requestedWeek)) {
      return NextResponse.json({ error: 'weekOf must use YYYY-MM-DD.' }, { status: 400 });
    }
    const lastWeekMonday = requestedWeek
      ? new Date(`${requestedWeek}T00:00:00.000Z`)
      : new Date(weekMonday(new Date()));
    if (requestedWeek && (Number.isNaN(lastWeekMonday.getTime()) || lastWeekMonday.getUTCDay() !== 1)) {
      return NextResponse.json({ error: 'weekOf must be a valid Monday.' }, { status: 400 });
    }
    if (!requestedWeek) lastWeekMonday.setDate(lastWeekMonday.getDate() - 7);
    const weekStart = isoDate(lastWeekMonday);
    const weekEndDate = new Date(lastWeekMonday);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEnd = isoDate(weekEndDate);

    const computed = await computeAssignmentCounts(weekStart, weekEnd);

    const [staffResult, rosterResult, payrollResult, employeeResult] = await Promise.all([
      supabase.from('staff_locations').select('name, location'),
      supabase
        .from('schedule_settings')
        .select('location, value')
        .in('key', ['designRoster', 'presRoster', 'ffRoster']),
      supabase
        .from('weekly_labor_cost')
        .select('employee, location')
        .eq('week_of', weekStart),
      supabase
        .from('rippling_employees')
        .select('full_name, location'),
    ]);
    if (staffResult.error) throw staffResult.error;
    if (rosterResult.error) throw rosterResult.error;
    if (payrollResult.error) throw payrollResult.error;
    if (employeeResult.error) throw employeeResult.error;
    const staffLocationMap: Record<string, string> = {};
    const setLocation = (name: string | null | undefined, location: string | null | undefined) => {
      const key = name ? normalizeAssignmentStaffName(name) : '';
      if (key && location && !staffLocationMap[key]) staffLocationMap[key] = location;
    };
    // Payroll is the best evidence for where someone worked during this week.
    payrollResult.data?.forEach(row => setLocation(row.employee, row.location));
    staffResult.data?.forEach(row => setLocation(row.name, row.location));
    rosterResult.data?.forEach(row => {
      const roster = row.value as Record<string, { name?: string; _removed?: boolean }> | null;
      Object.values(roster ?? {}).forEach(member => {
        const name = member.name?.trim();
        if (name && !member._removed) {
          setLocation(name, row.location);
        }
      });
    });
    // The employee directory fills gaps for active people not yet on a roster.
    employeeResult.data?.forEach(row => setLocation(row.full_name, row.location));

    // Former employees may have MT assignments during a historical week but
    // no roster/directory entry and no payroll row in that exact week. Use
    // their most recent earlier payroll location as the last-resort identity
    // evidence instead of dropping a valid historical count.
    const positiveUnresolved = [...new Set(computed.rows
      .filter(row => Object.values(row.counts).some(count => count > 0))
      .map(row => row.staff)
      .filter(name => !staffLocationMap[normalizeAssignmentStaffName(name)]))];
    const priorPayrollResults = await Promise.all(positiveUnresolved.map(employee =>
      supabase
        .from('weekly_labor_cost')
        .select('employee, location, week_of')
        .eq('employee', employee)
        .lte('week_of', weekStart)
        .order('week_of', { ascending: false })
        .limit(1)
        .maybeSingle()
    ));
    const priorPayrollError = priorPayrollResults.find(result => result.error)?.error;
    if (priorPayrollError) throw priorPayrollError;
    priorPayrollResults.forEach(result => {
      if (result.data) setLocation(result.data.employee, result.data.location);
    });

    const { data: existingRows, error: existingErr } = await supabase
      .from('team_member_week_actuals')
      .select('location, department, member_name, actual_hours, actual_orders, orders_source')
      .eq('week_of', weekStart);
    if (existingErr) throw existingErr;

    const planned: PlannedWrite[] = [];
    const toUpsert: Record<string, unknown>[] = [];

    for (const dept of DEPT_KEYS) {
      const actualsDept = ACTUALS_DEPT[dept];
      const countKey = COUNT_KEY[dept];

      for (const row of computed.rows) {
        const count = row.counts[countKey];
        if (!row.staff) continue;

        const normalizedStaff = normalizeAssignmentStaffName(row.staff);
        const existingForPerson = existingRows?.find(r =>
          r.department === actualsDept &&
          normalizeAssignmentStaffName(r.member_name) === normalizedStaff
        );

        // Avoid creating a zero row for every staff member in every department,
        // but do allow an existing auto row to be corrected back to zero after
        // a reassignment.
        if (count === 0 && !existingForPerson) continue;

        const location = staffLocationMap[normalizedStaff] ?? existingForPerson?.location;
        if (!location) {
          planned.push({
            location: '(unresolved)', department: actualsDept, member: row.staff,
            weekOf: weekStart, computedOrders: count, previousOrders: null,
            action: 'skip_unresolved_location',
          });
          continue;
        }

        const existing = existingRows?.find(r =>
          r.location === location && r.department === actualsDept &&
          normalizeAssignmentStaffName(r.member_name) === normalizedStaff
        );

        if (existing?.orders_source === 'manual') {
          planned.push({
            location, department: actualsDept, member: row.staff, weekOf: weekStart,
            computedOrders: count, previousOrders: existing.actual_orders,
            action: 'skip_locked',
          });
          continue;
        }

        planned.push({
          location, department: actualsDept, member: row.staff, weekOf: weekStart,
          computedOrders: count, previousOrders: existing?.actual_orders ?? null,
          action: 'write',
        });

        toUpsert.push({
          location, department: actualsDept, week_of: weekStart,
          member_name: row.staff,
          actual_hours: existing?.actual_hours ?? 0,
          actual_orders: count,
          orders_source: 'auto',
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (!dryRun && toUpsert.length) {
      const { error: upsertErr } = await supabase
        .from('team_member_week_actuals')
        .upsert(toUpsert, { onConflict: 'location,department,week_of,member_name' });
      if (upsertErr) throw upsertErr;
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      weekOf: weekStart,
      weekEnd,
      written:  planned.filter(p => p.action === 'write').length,
      skippedLocked: planned.filter(p => p.action === 'skip_locked').length,
      skippedUnresolved: planned.filter(p => p.action === 'skip_unresolved_location').length,
      unmatchedStaff: computed.unmatched,
      planned,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
