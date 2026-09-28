import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { DEPARTMENT_MANAGERS, GENERAL_MANAGERS, getGmCostForWeeks, getSalaryMgrCostSplitForWeeks, isActiveGm } from '@/lib/managers';
import { getWeekMondays } from '@/lib/weekDates';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { filterToHistoricalsRows } from '@/lib/historicalsRows';
import {
  projectDept, buildManagerHomeDept,
  type DesignRosterEntry, type PresRosterEntry, type HoursMap, type DailyHoursMap, type MemberCostLine,
} from '@/lib/scheduleProjection';

// Admin-only: labor cost per location / department / month.
//  - Planned: projected from the saved Scheduling rosters + schedules
//    (schedule_settings) and each person's pay on the roster — the same
//    projectDept math as All KPIs' "Est." months, plus Preservation's
//    check/unboxing hours (see payOnlyDailyHours in scheduleProjection.ts).
//  - Actual (past + current months): what payroll actually paid, from
//    weekly_labor_cost, plus salaried managers (never in that upload).
//
// Past months' Planned is reconstructed from TODAY's saved settings:
// schedule_settings keeps every past week's hours, but rosters/pay rates are
// only stored as they are now — there's no frozen month-end copy (the
// monthly_schedule_snapshots table All KPIs checks for doesn't exist), so a
// raise since then shows up in that month's Planned too.
//
// Employment windows, for Actual comparisons only (see payrollSpan): a
// roster member with no start date would have their standard schedule
// projected back before they were hired, so their plan starts at their
// first paycheck; and someone since removed from the roster (skipped by
// projectDept everywhere else) is planned again up to their last paycheck
// for the months they actually worked. Every such adjustment is reported
// back in `inferredDates` so real dates can be set on the roster.

export const dynamic = 'force-dynamic';

const DEPTS = ['Design', 'Preservation', 'Fulfillment', 'Resin'] as const;
type Dept = typeof DEPTS[number];
type Loc = 'Utah' | 'Georgia';

interface SettingRow { location: string; key: string; value: unknown }
interface LaborRow   { employee: string; location: string; department: string; week_of: string; gross_pay: number }
interface ActualRow  { week_of: string; member_name: string; department: string; location: string; actual_hours: number; actual_orders: number }

export interface DeptForecast {
  cost:    number;
  hours:   number;
  members: MemberCostLine[];
}

export interface LocationMonthForecast {
  depts: Record<Dept, DeptForecast>;
  gm:    { cost: number; names: string[] };
}

export interface ActualDept {
  cost:    number;
  members: { name: string; cost: number; salaried?: boolean }[];
}

export interface LocationMonthActual {
  // Weeks of this month with any payroll uploaded for this location — the
  // current month (and a month whose last payroll hasn't landed yet) only
  // has some of them.
  paidWeeks: number;
  // Design/Preservation/Fulfillment/Resin, plus 'G&A' and 'Other' (any
  // payroll department that isn't one of those) so the total reconciles
  // with what was actually paid.
  depts:     Record<string, ActualDept>;
  gm:        { cost: number };
  // Planned restricted to just the paid weeks — what Actual should be
  // compared against while a month is only partly paid. Equal to the full
  // month's Planned once every week has payroll.
  plannedForPaidWeeks: LocationMonthForecast;
}

// A roster member whose employment window here came from payroll rather
// than their roster — only those it actually changed.
export interface InferredDate {
  location: string;
  dept:     string;
  name:     string;
  kind:     'start' | 'end';   // start = first paycheck; end = removed from roster, last paycheck
  week:     string;            // that paycheck's week (Monday)
}

// `${location}|${normName}` -> first/last payroll week, plus the first week
// payroll data exists at all. Someone first paid within a week of that is
// assumed to have been employed already, not hired then.
interface PayrollSpan {
  byPerson:  Map<string, { first: string; last: string }>;
  dataStart: string;
}

export interface MonthForecast {
  monthStart: string;   // 'YYYY-MM-01'
  label:      string;   // 'Oct 2026'
  weeks:      number;   // Mondays attributed to this month (first-Monday rule)
  when:       'past' | 'current' | 'future';
  isSnapshot: boolean;  // current month read from its locked month-end snapshot
  locations:  Record<Loc, LocationMonthForecast>;
  actual?:    Record<Loc, LocationMonthActual>;   // past + current months only
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function monthLabel(monthStart: string): string {
  return new Date(monthStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Payroll department -> this view's department. Local copy per repo
// convention (every route keeps its own), same as /api/kpis' normDept except
// Checks & Unboxing counts as Preservation here — matching Historicals and
// Scheduling, where check/unboxing time is part of Preservation. (/api/kpis
// currently maps it nowhere, so that pay is missing from its dept costs.)
function normPayrollDept(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes('design'))                                         return 'Design';
  if (l.includes('preservation'))                                   return 'Preservation';
  if (l.includes('checks') || l.includes('unboxing'))               return 'Preservation';
  if (l.includes('fulfillment'))                                    return 'Fulfillment';
  // Before the G&A/admin branch — "Resin - Admin" contains "admin" too.
  if (l.includes('resin'))                                          return 'Resin';
  if (l.includes('general') || l.includes('admin') || l === 'g&a') return 'G&A';
  return 'Other';
}

const normName = (n: string) => n.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();

function projectLocationMonth(
  settings: SettingRow[],
  location: string,
  weekOfs: string[],
  holidaySet: Set<string>,
  managerHomeDept: Map<string, Set<string>>,
  // When passed (Actual comparisons only), employment windows are filled in
  // from payroll — see the header comment.
  payrollSpan?: PayrollSpan,
  inferred?: Map<string, InferredDate>,
): LocationMonthForecast {
  const get = (key: string) => settings.find(r => r.location === location && r.key === key)?.value ?? {};

  // Resin's roster is a plain array (see ResinPage.tsx) — key it by id like
  // the other three departments, same as /api/kpis does.
  const resinRaw = get('resinRoster');
  const resinArr = Array.isArray(resinRaw) ? resinRaw as (DesignRosterEntry & { id: string })[] : [];
  const resinRoster: Record<string, DesignRosterEntry> = Object.fromEntries(resinArr.map(m => [m.id, m]));

  const inputs: Record<Dept, [Record<string, DesignRosterEntry | PresRosterEntry>, HoursMap, DailyHoursMap, DailyHoursMap?]> = {
    Design:       [get('designRoster') as Record<string, DesignRosterEntry>, get('designHours') as HoursMap, get('designDailyHours') as DailyHoursMap],
    Preservation: [get('presRoster')   as Record<string, PresRosterEntry>,   get('presHours')   as HoursMap, get('presDailyHours')   as DailyHoursMap, get('presCheckHours') as DailyHoursMap],
    Fulfillment:  [get('ffRoster')     as Record<string, PresRosterEntry>,   get('ffHours')     as HoursMap, get('ffDailyHours')     as DailyHoursMap],
    Resin:        [resinRoster,                                              get('resinHours')  as HoursMap, get('resinDailyHours')  as DailyHoursMap],
  };
  const mgrTotalHours = get('mgrTotalHours') as HoursMap;

  const depts = {} as Record<Dept, DeptForecast>;
  for (const dept of DEPTS) {
    const [rawRoster, hours, daily, payOnly] = inputs[dept];
    let roster = rawRoster;
    if (payrollSpan && weekOfs.length > 0) {
      const monthStart = weekOfs[0], monthEnd = addDays(weekOfs[weekOfs.length - 1], 6);
      const next: Record<string, DesignRosterEntry | PresRosterEntry> = {};
      for (const [id, member] of Object.entries(rawRoster)) {
        if (!member?.name) continue;
        const span = payrollSpan.byPerson.get(`${location}|${normName(member.name)}`);
        let entry = { ...member } as (DesignRosterEntry | PresRosterEntry) & { _removed?: boolean };
        if (entry._removed) {
          // Removed with no payroll at all here: nothing to anchor to, leave out.
          if (!span) continue;
          delete entry._removed;
          if (!entry.endDate) {
            entry = { ...entry, endDate: addDays(span.last, 6) };
            if (span.last < monthEnd) inferred?.set(`${location}|${dept}|${member.name}|end`, { location, dept, name: member.name, kind: 'end', week: span.last });
          }
        }
        if (!entry.startDate && span && span.first > addDays(payrollSpan.dataStart, 7)) {
          entry = { ...entry, startDate: span.first };
          if (span.first > monthStart) inferred?.set(`${location}|${dept}|${member.name}|start`, { location, dept, name: member.name, kind: 'start', week: span.first });
        }
        next[id] = entry;
      }
      roster = next;
    }
    const members: MemberCostLine[] = [];
    // Cost is real pay in every mode; 'estimate' only affects production,
    // which this view doesn't use.
    const r = projectDept(roster, hours, daily, weekOfs, location, dept, holidaySet, 'estimate', mgrTotalHours, managerHomeDept, undefined, members, payOnly);
    members.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
    depts[dept] = { cost: r.laborCost, hours: r.hours, members };
  }

  const gmNames = GENERAL_MANAGERS
    .filter(gm => gm.location === location && weekOfs.some(w => (!gm.from || w >= gm.from) && (!gm.to || w <= gm.to)))
    .map(gm => gm.name);

  return { depts, gm: { cost: getGmCostForWeeks(location, weekOfs), names: [...new Set(gmNames)] } };
}

// What was actually paid — mirrors /api/kpis' computePeriodKpis labor cost
// (payroll rows minus an active GM's own rows, plus salaried managers split
// by where they logged hours), with a per-person breakdown and Checks &
// Unboxing counted as Preservation (see normPayrollDept).
function actualLocationMonth(
  laborRows: LaborRow[],
  actualRows: ActualRow[],
  location: string,
  paidWeeks: string[],
): Pick<LocationMonthActual, 'depts' | 'gm'> {
  const depts: Record<string, ActualDept> = {};
  const byPerson: Record<string, Record<string, number>> = {};   // dept -> name -> $
  const weekSet = new Set(paidWeeks);

  for (const row of laborRows) {
    if (row.location !== location || !weekSet.has(row.week_of)) continue;
    // A GM's own pay for weeks they held the role lives only in the GM row.
    if (isActiveGm(location, row.employee, row.week_of)) continue;
    const dept = normPayrollDept(row.department);
    byPerson[dept] ??= {};
    byPerson[dept][row.employee] = (byPerson[dept][row.employee] ?? 0) + row.gross_pay;
  }
  for (const [dept, people] of Object.entries(byPerson)) {
    depts[dept] = { cost: 0, members: Object.entries(people).map(([name, cost]) => ({ name, cost })) };
  }

  // Salaried managers never appear in weekly_labor_cost.
  const locActuals = actualRows.filter(r => r.location === location);
  for (const mgr of DEPARTMENT_MANAGERS) {
    if (mgr.location !== location) continue;
    const split = getSalaryMgrCostSplitForWeeks([mgr], location, paidWeeks, locActuals, normPayrollDept);
    for (const [dept, cost] of Object.entries(split)) {
      if (cost <= 0) continue;
      depts[dept] ??= { cost: 0, members: [] };
      const existing = depts[dept].members.find(m => m.name === mgr.name && m.salaried);
      if (existing) existing.cost += cost;
      else depts[dept].members.push({ name: mgr.name, cost, salaried: true });
    }
  }

  for (const d of Object.values(depts)) {
    d.cost = d.members.reduce((s, m) => s + m.cost, 0);
    d.members.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  }
  return { depts, gm: { cost: getGmCostForWeeks(location, paidWeeks) } };
}

// GET /api/labor-forecast?back=6&months=12
// `back` past months (max 12) with Actual alongside Planned, then the current
// business month (the month containing this week's Monday — same convention
// as /api/kpis) and `months - 1` months forward.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('clerk_user_id', userId)
    .single();
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const clampInt = (raw: string | null, dflt: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(parseInt(raw ?? '')) ? parseInt(raw!) : dflt));
  const months = clampInt(req.nextUrl.searchParams.get('months'), 12, 1, 24);
  const back   = clampInt(req.nextUrl.searchParams.get('back'),   0,  0, 12);

  try {
    const now = new Date();
    const dow = now.getDay();
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
    const businessMonthStart = `${isoDate(thisMonday).slice(0, 7)}-01`;
    const [y, m] = businessMonthStart.split('-').map(Number);
    const rangeStart = isoDate(new Date(y, m - 1 - back, 1, 12));

    const [settingsRes, empRes, snapRes, laborRows, actualRowsRaw] = await Promise.all([
      supabase.from('schedule_settings').select('location,key,value'),
      supabase.from('rippling_employees').select('full_name,location,department,title').eq('active', true),
      // Current month only: prefer its locked month-end snapshot, same as
      // All KPIs' Est. current month, so the two always agree.
      supabase.from('monthly_schedule_snapshots').select('location,settings_json').eq('snapshot_month', businessMonthStart),
      // All payroll, not just the range, so each person's first paycheck
      // (see firstPaidWeek) is found even if it predates the range.
      back > 0
        ? fetchAllRows<LaborRow>((from, to) => supabase.from('weekly_labor_cost')
            .select('employee,location,department,week_of,gross_pay').range(from, to))
        : Promise.resolve([] as LaborRow[]),
      back > 0
        ? fetchAllRows<ActualRow>((from, to) => supabase.from('team_member_week_actuals')
            .select('week_of,member_name,department,location,actual_hours,actual_orders').gte('week_of', rangeStart).range(from, to))
        : Promise.resolve([] as ActualRow[]),
    ]);
    if (settingsRes.error) throw settingsRes.error;

    const liveSettings: SettingRow[] = settingsRes.data ?? [];
    const snapSettings: SettingRow[] = (snapRes.data ?? []).flatMap(snap =>
      Object.entries(snap.settings_json as Record<string, unknown>).map(([key, value]) => ({ location: snap.location as string, key, value }))
    );
    const paidHolidays = (liveSettings.find(r => r.location === 'Global' && r.key === 'paidHolidays')?.value as string[]) ?? [];
    const holidaySet = new Set(paidHolidays);
    const managerHomeDept = buildManagerHomeDept(empRes.data ?? []);
    // Same rows Historicals shows — used only to place salaried managers'
    // pay in whichever department they logged hours (as /api/kpis does).
    const actualRows = filterToHistoricalsRows(actualRowsRaw, liveSettings);

    const payrollSpan: PayrollSpan = { byPerson: new Map(), dataStart: laborRows.reduce((m, r) => r.week_of < m ? r.week_of : m, '9999-12-31') };
    for (const r of laborRows) {
      if (r.gross_pay <= 0) continue;
      const k = `${r.location}|${normName(r.employee)}`;
      const span = payrollSpan.byPerson.get(k);
      if (!span) payrollSpan.byPerson.set(k, { first: r.week_of, last: r.week_of });
      else {
        if (r.week_of < span.first) span.first = r.week_of;
        if (r.week_of > span.last)  span.last  = r.week_of;
      }
    }
    const inferred = new Map<string, InferredDate>();

    const result: MonthForecast[] = [];
    for (let i = -back; i < months; i++) {
      const first = new Date(y, m - 1 + i, 1, 12);
      const last  = new Date(y, m + i, 0, 12);
      const monthStart = isoDate(first);
      const weekOfs = getWeekMondays(monthStart, isoDate(last));
      const isSnapshot = i === 0 && snapSettings.length > 0;
      const settings = isSnapshot ? snapSettings : liveSettings;
      const when: MonthForecast['when'] = i < 0 ? 'past' : i === 0 ? 'current' : 'future';

      const planned = {
        Utah:    projectLocationMonth(settings, 'Utah',    weekOfs, holidaySet, managerHomeDept),
        Georgia: projectLocationMonth(settings, 'Georgia', weekOfs, holidaySet, managerHomeDept),
      };

      let actual: MonthForecast['actual'];
      if (when !== 'future' && back > 0) {
        actual = {} as Record<Loc, LocationMonthActual>;
        for (const loc of ['Utah', 'Georgia'] as const) {
          const paidWeeks = weekOfs.filter(w => laborRows.some(r => r.location === loc && r.week_of === w));
          actual[loc] = {
            paidWeeks: paidWeeks.length,
            ...actualLocationMonth(laborRows, actualRows, loc, paidWeeks),
            plannedForPaidWeeks: projectLocationMonth(settings, loc, paidWeeks, holidaySet, managerHomeDept, payrollSpan, inferred),
          };
        }
      }

      result.push({ monthStart, label: monthLabel(monthStart), weeks: weekOfs.length, when, isSnapshot, locations: planned, actual });
    }

    return NextResponse.json(
      {
        months: result,
        inferredDates: [...inferred.values()].sort((a, b) => a.location.localeCompare(b.location) || a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
        generatedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message
      : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message
      : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
