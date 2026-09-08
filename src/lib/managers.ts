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

function deptMatches(mgrDepts: string[], dept: string): boolean {
  return mgrDepts.some(d => d.toLowerCase() === dept.toLowerCase());
}

// Department-manager cost for one location+department across a set of weeks.
export function getSalaryMgrCostForWeeks(
  managers: SalaryMgr[],
  location: string,
  dept:     string,
  weekOfs:  string[]
): number {
  let total = 0;
  for (const weekOf of weekOfs) {
    for (const mgr of managers) {
      if (mgr.location !== location) continue;
      if (!deptMatches(mgr.departments, dept)) continue;
      const after  = !mgr.from || weekOf >= mgr.from;
      const before = !mgr.to   || weekOf <= mgr.to;
      if (after && before) {
        total += (mgr.annualSalary / 52) / mgr.departments.length;
      }
    }
  }
  return total;
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
