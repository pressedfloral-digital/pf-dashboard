// Single source of truth for department managers and general managers used in
// CPO calculations across /api/kpis, /api/scorecard, useActualsWithPayroll,
// and useHistoricalMetrics. Update this file (only) when a manager's pay or
// role changes — every consumer picks it up automatically.
//
// Two tiers:
//  - DEPARTMENT_MANAGERS: fixed-salary staff whose pay never appears in the
//    weekly_labor_cost / actuals upload. Included in their department's CPO.
//    Hourly managers need NO entry here — their pay already flows through the
//    normal actuals/payroll path like any other hourly employee.
//  - GENERAL_MANAGERS: location-wide GMs. Always excluded from per-department
//    CPO; only ever folded into the combined "cpoWithGM" metric.
//
// To record a manager change: close the outgoing entry with a `to` date
// (the last day it applied) and add a new entry with a `from` date (the
// first day the new arrangement applies). Never mutate an entry's history —
// append a new one so past weeks still compute correctly.

export interface SalaryMgr {
  name:         string;
  location:     string;
  departments:  string[];  // cost is split evenly across these
  annualSalary: number;
  from?:        string;    // inclusive, 'YYYY-MM-DD' (Monday week_of)
  to?:          string;    // inclusive, 'YYYY-MM-DD' (Monday week_of)
}

export const DEPARTMENT_MANAGERS: SalaryMgr[] = [
  // Utah
  { name: 'Jennika Merrill', location: 'Utah',    departments: ['Design'],                annualSalary: 45760,  to:   '2026-04-27' },
  { name: 'Jennika Merrill', location: 'Utah',    departments: ['Design'],                annualSalary: 49420,  from: '2026-05-04' },
  { name: 'Bella DePrima',   location: 'Utah',    departments: ['Fulfillment'],           annualSalary: 41600 },
  // Georgia — time-aware
  { name: 'Amber Garrett',   location: 'Georgia', departments: ['Preservation'],          annualSalary: 47008,  to:   '2026-04-12' },
  { name: 'Amber Garrett',   location: 'Georgia', departments: ['Design','Preservation'], annualSalary: 56000,  from: '2026-04-13', to: '2026-06-19' },
  // From 2026-06-20: Katherine Piper (Design) and Celt Stewart (Preservation)
  // are the Georgia dept managers. Both are hourly — their pay flows through
  // weekly_labor_cost / actuals like any other team member, so no entry is
  // needed here.
];

export const GENERAL_MANAGERS: SalaryMgr[] = [
  // Lauren Boyd's last day was 2026-07-31 (last full week 2026-07-27); Sloane
  // James took over as Utah GM from 2026-08-03.
  { name: 'Lauren Boyd',  location: 'Utah',    departments: ['Design','Preservation','Fulfillment'], annualSalary: 60000.20, to:   '2026-07-27' },
  { name: 'Sloane James', location: 'Utah',    departments: ['Design','Preservation','Fulfillment'], annualSalary: 52000,    from: '2026-08-03' },
  { name: 'Zac Williams', location: 'Georgia', departments: ['Design','Preservation','Fulfillment'], annualSalary: 52000 },
];

// Was `name` the active GM for `location` on `weekOf`? Time-aware (not a flat
// name blacklist) because a GM can be someone who also has a real, ongoing
// hourly role outside their GM weeks (e.g. Sloane James did production work
// for months before becoming Utah's GM) — a name-only exclusion would wrongly
// strip their legitimate department pay from every week, not just the ones
// they were GM. Used to keep a GM's own weekly_labor_cost row out of any
// department's CPO (see kpis/route.ts) without touching weeks before/after
// their tenure, or another employee's cost that happens to share the week.
export function isActiveGm(location: string, name: string, weekOf: string): boolean {
  const n = name.trim().toLowerCase();
  return GENERAL_MANAGERS.some(gm => {
    if (gm.location !== location) return false;
    if (gm.name.trim().toLowerCase() !== n) return false;
    const after  = !gm.from || weekOf >= gm.from;
    const before = !gm.to   || weekOf <= gm.to;
    return after && before;
  });
}

// Names actively holding the GM role for `location` on `weekOf` — for
// callers (e.g. HistoricalsSection's Week-total row) that need to net a GM's
// own pay out of a department's cost total but don't already have a
// candidate name to check with isActiveGm.
export function activeGmNames(location: string, weekOf: string): string[] {
  return GENERAL_MANAGERS
    .filter(gm => gm.location === location)
    .map(gm => gm.name)
    .filter(name => isActiveGm(location, name, weekOf));
}

export function deptMatches(mgrDepts: string[], dept: string): boolean {
  return mgrDepts.some(d => d.toLowerCase() === dept.toLowerCase());
}

// Assumed full-time week used to turn a salaried manager's weekly pay into an
// hourly rate — only needed when they clock actual hours outside their home
// department(s) and that slice of pay needs to follow them there (see
// useActualsWithPayroll's getWeekCosts/getManagerDeptCost). Not tied to any
// individual's real contracted hours; a flat, documented assumption.
export const STANDARD_WEEKLY_HOURS = 40;

// Approved PTO taken by salaried department managers, in hours per Monday
// week_of (from Rippling's Time Off report). Append an entry when a manager's
// PTO is approved; a request spanning weeks gets one entry per week. Only
// these weeks are adjusted — see ptoAdjustedHomeCost.
export interface ManagerPto {
  name:     string;
  location: string;
  weekOf:   string;  // Monday 'YYYY-MM-DD'
  hours:    number;
}

export const MANAGER_PTO: ManagerPto[] = [
  // Bella DePrima — wedding (Sep 30–Oct 9) plus two single days in October.
  { name: 'Bella DePrima', location: 'Utah', weekOf: '2026-09-28', hours: 24 }, // Sep 30–Oct 2
  { name: 'Bella DePrima', location: 'Utah', weekOf: '2026-10-05', hours: 40 }, // Oct 5–9
  { name: 'Bella DePrima', location: 'Utah', weekOf: '2026-10-19', hours: 16 }, // Oct 19 + Oct 23
];

// How many weeks before a PTO week set the manager's normal cost per order.
export const PTO_RATE_TRAILING_WEEKS = 12;

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function addWeeks(weekOf: string, n: number): string {
  const d = new Date(weekOf + 'T12:00:00');
  d.setDate(d.getDate() + n * 7);
  return d.toISOString().split('T')[0];
}

function ptoHours(mgr: SalaryMgr, location: string, weekOf: string): number {
  return MANAGER_PTO
    .filter(p => p.location === location && p.weekOf === weekOf && sameName(p.name, mgr.name))
    .reduce((s, p) => s + p.hours, 0);
}

// What a manager's home department(s) are charged in a normal week: their
// weekly salary minus the slice that follows hours they clocked elsewhere.
function normalHomeCost(
  mgr: SalaryMgr, location: string, weekOf: string,
  rows: ManagerActualHoursRow[], normDept: (raw: string) => string
): number {
  const weeklySalary        = mgr.annualSalary / 52;
  const effectiveHourlyRate = weeklySalary / STANDARD_WEEKLY_HOURS;
  let awayHours = 0;
  for (const row of rows) {
    if (row.location !== location || row.week_of !== weekOf) continue;
    if (!sameName(row.member_name, mgr.name)) continue;
    if (deptMatches(mgr.departments, normDept(row.department))) continue;
    awayHours += row.actual_hours;
  }
  return Math.max(0, weeklySalary - awayHours * effectiveHourlyRate);
}

function homeOrders(
  mgr: SalaryMgr, location: string, weekOf: string,
  rows: ManagerActualHoursRow[], normDept: (raw: string) => string
): number {
  let orders = 0;
  for (const row of rows) {
    if (row.location !== location || row.week_of !== weekOf) continue;
    if (!deptMatches(mgr.departments, normDept(row.department))) continue;
    orders += row.actual_orders ?? 0;
  }
  return orders;
}

// How a PTO week's manager cost was worked out — everything the Historicals
// info bubble needs to show the calculation. See ptoAdjustedHomeCost.
export interface PtoAdjustment {
  name:          string;
  ptoHours:      number;  // capped at STANDARD_WEEKLY_HOURS
  ptoShare:      number;  // ptoHours / STANDARD_WEEKLY_HOURS
  fullCost:      number;  // what the home dept(s) would be charged without the adjustment
  normalRate:    number;  // normal cost per home-dept order (trailing non-PTO weeks)
  rateWeeks:     number;  // how many weeks normalRate averaged over
  weekOrders:    number;  // home-dept orders this week
  adjustedCost:  number;  // what's actually charged
  capped:        boolean; // the per-order charge came out higher, so fullCost was kept
}

// A manager's home-department cost for one week, adjusted only if MANAGER_PTO
// has PTO for them that week. Null when there's no PTO, or no history to rate
// it from — callers then keep `homeCost` as-is.
//
// Their PTO hours are charged at what they normally cost per home-dept order
// — over the PTO_RATE_TRAILING_WEEKS weeks before, skipping other PTO weeks —
// times that week's orders, in place of a full week of salary. Hours they
// did work stay at normal salary. So a week off costs the team what the
// manager usually costs for that much output, instead of a whole salary over
// a short week's orders. Never raises a week's cost: in a busy week, a day
// off can't make the manager more expensive than usual.
//
// e.g. Bella, Oct 5 (40h PTO, 23 orders, normally ~$7/order):
//   $800 → 23 × ~$7 ≈ $163.
export function ptoAdjustmentDetail(
  mgr: SalaryMgr, location: string, weekOf: string, homeCost: number,
  rows: ManagerActualHoursRow[], normDept: (raw: string) => string
): PtoAdjustment | null {
  const pto = Math.min(ptoHours(mgr, location, weekOf), STANDARD_WEEKLY_HOURS);
  if (pto <= 0) return null;

  let normalCost = 0, normalOrders = 0, rateWeeks = 0;
  for (let i = 1; i <= PTO_RATE_TRAILING_WEEKS; i++) {
    const w = addWeeks(weekOf, -i);
    if (ptoHours(mgr, location, w) > 0) continue;
    const orders = homeOrders(mgr, location, w, rows, normDept);
    if (orders <= 0) continue;
    normalCost   += normalHomeCost(mgr, location, w, rows, normDept);
    normalOrders += orders;
    rateWeeks++;
  }
  if (normalOrders <= 0) return null;  // no history to rate from

  const ptoShare   = pto / STANDARD_WEEKLY_HOURS;
  const normalRate = normalCost / normalOrders;
  const weekOrders = homeOrders(mgr, location, weekOf, rows, normDept);
  const perOrder   = (1 - ptoShare) * homeCost + ptoShare * normalRate * weekOrders;
  return {
    name: mgr.name, ptoHours: pto, ptoShare, fullCost: homeCost, normalRate, rateWeeks, weekOrders,
    adjustedCost: Math.min(homeCost, perOrder),
    capped:       perOrder >= homeCost,
  };
}

export interface WeekPtoAdjustment extends PtoAdjustment {
  department: string;  // Title Case home department
  weekOf:     string;
}

export function ptoAdjustedHomeCost(
  mgr: SalaryMgr, location: string, weekOf: string, homeCost: number,
  rows: ManagerActualHoursRow[], normDept: (raw: string) => string
): number {
  return ptoAdjustmentDetail(mgr, location, weekOf, homeCost, rows, normDept)?.adjustedCost ?? homeCost;
}

// Department-manager cost for one location+department across a set of weeks.
// Pass `actualRows` (every team member's, orders included, reaching
// PTO_RATE_TRAILING_WEEKS before the first week) + `normDept` to apply the
// PTO-week adjustment — see ptoAdjustedHomeCost; without them it's flat salary.
export function getSalaryMgrCostForWeeks(
  managers:    SalaryMgr[],
  location:    string,
  dept:        string,
  weekOfs:     string[],
  actualRows?: ManagerActualHoursRow[],
  normDept?:   (raw: string) => string
): number {
  let total = 0;
  for (const weekOf of weekOfs) {
    for (const mgr of managers) {
      if (mgr.location !== location) continue;
      if (!deptMatches(mgr.departments, dept)) continue;
      const after  = !mgr.from || weekOf >= mgr.from;
      const before = !mgr.to   || weekOf <= mgr.to;
      if (after && before) {
        const weeklySalary = mgr.annualSalary / 52;
        const homeCost = actualRows && normDept
          ? ptoAdjustedHomeCost(mgr, location, weekOf, weeklySalary, actualRows, normDept)
          : weeklySalary;
        total += homeCost / mgr.departments.length;
      }
    }
  }
  return total;
}

export interface ManagerActualHoursRow {
  week_of:      string;
  member_name:  string;
  department:   string;  // raw actuals casing — pass through `normDept` first
  location:     string;
  actual_hours: number;
  // Only needed for the PTO adjustment (ptoAdjustedHomeCost).
  actual_orders?: number;
}

// Same idea as getSalaryMgrCostForWeeks, but hours-aware: instead of always
// splitting a manager's full weekly pay evenly across their home
// department(s), it moves the slice of pay matching any hours they actually
// clocked in a department outside those home department(s) to wherever they
// worked — e.g. Bella DePrima (home: Fulfillment) picking up hours in
// Preservation for part of a week. Returns cost per department (Title Case,
// matching `departments` entries) summed across all of `weekOfs`.
// `normDept` should be the caller's own raw-department -> Title Case
// normalizer, so this lines up with however it already buckets hoursByDept.
// PTO weeks get ptoAdjustmentDetail, which needs `actualRows` to be every
// team member's (orders included) reaching PTO_RATE_TRAILING_WEEKS back.
// Pass `ptoOut` to collect each adjustment made (per home department, with
// that department's share of the cost) — e.g. for the KPIs info bubble.
export function getSalaryMgrCostSplitForWeeks(
  managers:   SalaryMgr[],
  location:   string,
  weekOfs:    string[],
  actualRows: ManagerActualHoursRow[],
  normDept:   (raw: string) => string,
  ptoOut?:    WeekPtoAdjustment[]
): Record<string, number> {
  const costByDept: Record<string, number> = {};
  for (const weekOf of weekOfs) {
    for (const mgr of managers) {
      if (mgr.location !== location) continue;
      const after  = !mgr.from || weekOf >= mgr.from;
      const before = !mgr.to   || weekOf <= mgr.to;
      if (!after || !before) continue;

      const weeklySalary          = mgr.annualSalary / 52;
      const effectiveHourlyRate   = weeklySalary / STANDARD_WEEKLY_HOURS;
      const awayHoursByDept: Record<string, number> = {};
      for (const row of actualRows) {
        if (row.location !== location || row.week_of !== weekOf) continue;
        if (row.member_name.trim().toLowerCase() !== mgr.name.trim().toLowerCase()) continue;
        const dept = normDept(row.department);
        if (deptMatches(mgr.departments, dept)) continue; // home-dept hours, not "away"
        awayHoursByDept[dept] = (awayHoursByDept[dept] ?? 0) + row.actual_hours;
      }

      let totalAway = 0;
      for (const [dept, hrs] of Object.entries(awayHoursByDept)) {
        const cost = hrs * effectiveHourlyRate;
        costByDept[dept] = (costByDept[dept] ?? 0) + cost;
        totalAway += cost;
      }

      const fullHomeCost = Math.max(0, weeklySalary - totalAway);
      const pto          = ptoAdjustmentDetail(mgr, location, weekOf, fullHomeCost, actualRows, normDept);
      const n            = mgr.departments.length;
      const homePerDept  = (pto?.adjustedCost ?? fullHomeCost) / n;
      for (const dept of mgr.departments) {
        costByDept[dept] = (costByDept[dept] ?? 0) + homePerDept;
        if (pto && ptoOut) ptoOut.push({ ...pto, fullCost: pto.fullCost / n, adjustedCost: pto.adjustedCost / n, department: dept, weekOf });
      }
    }
  }
  return costByDept;
}

// Total GM cost for a location across a set of weeks. GMs are location-wide
// (not per-department), so this must be computed once per location — never
// summed once per department and divided back down. Time-aware, same as
// getSalaryMgrCostForWeeks, so a GM transition (see Lauren Boyd/Sloane James
// above) only costs the weeks each one actually held the role.
export function getGmCostForWeeks(location: string, weekOfs: string[]): number {
  let total = 0;
  for (const weekOf of weekOfs) {
    for (const gm of GENERAL_MANAGERS) {
      if (gm.location !== location) continue;
      const after  = !gm.from || weekOf >= gm.from;
      const before = !gm.to   || weekOf <= gm.to;
      if (after && before) total += gm.annualSalary / 52;
    }
  }
  return total;
}
