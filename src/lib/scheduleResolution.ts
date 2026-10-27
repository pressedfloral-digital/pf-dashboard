// ─── Shared hours resolution for "This Week" / "Weekly Schedule" linkage ────────
// One implementation reused by Design, Fulfillment, Preservation, and Resin so
// the fallback chain (explicit day override → standard weekly template →
// legacy pre-cutover weekly value → hardcoded per-member default → 0) can't
// drift between departments the way the daily-hours padding logic already had
// (the exact "pad untouched days with 0 instead of null" bug independently
// existed in all four departments before this module existed).

export type DailyHoursMap = Record<string, (number | null)[]>;

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// A roster member's employment window — startDate/endDate are ISO 'YYYY-MM-DD'
// dates, both inclusive. Either bound may be omitted (open-ended). Passed
// alongside the plain ISO Monday of the week being resolved (weekIso) so day
// dayIdx's calendar date can be checked against the window.
export interface EmploymentWindow {
  weekIso:    string;
  startDate?: string;
  endDate?:   string;
  // The member's schedule rules (see ScheduleRule) — carried here rather than
  // as a separate param because every caller already builds this object per
  // member+week, and rules need that same weekIso to know which dates apply.
  rules?:     ScheduleRule[];
  // ISO dates the member is marked off (Time Off calendar). Like the
  // employment window, a day off forces production hours to 0 and outranks
  // an explicit override.
  daysOff?:   string[];
}

// True if dayIdx of the week in `employment` is one of the member's days off.
export function isDayOff(dayIdx: number, employment?: EmploymentWindow): boolean {
  if (!employment?.daysOff?.length) return false;
  return employment.daysOff.includes(addIsoDays(employment.weekIso, dayIdx));
}

// A manager-defined, date-bounded replacement for a member's standard
// schedule — e.g. "Feb 1 – May 31: Mon/Wed/Fri 8h only". For every day that
// falls inside [startDate, endDate] (inclusive, either bound optional) of an
// enabled rule, hours[dayIdx] REPLACES the standard template for that
// weekday; a null entry leaves the standard template in place for that day.
// When several enabled rules cover the same date, the later one in the list
// wins.
//
// Rules only ever stand in for the TEMPLATE — an explicit day override from
// "This Week" still outranks them, so hand-entered hours (and anything
// already recorded for a past week) are never rewritten. Actuals live in
// team_member_week_actuals and never read the schedule at all.
export interface ScheduleRule {
  id:         string;
  label?:     string;
  enabled:    boolean;
  startDate?: string;
  endDate?:   string;
  hours:      (number | null)[];
}

// The rule (if any) that governs dayIdx of the week in `employment`.
export function activeRuleForDay(dayIdx: number, employment?: EmploymentWindow): ScheduleRule | undefined {
  const rules = employment?.rules;
  if (!rules || rules.length === 0 || !employment) return undefined;
  const date = addIsoDays(employment.weekIso, dayIdx);
  let match: ScheduleRule | undefined;
  for (const r of rules) {
    if (!r.enabled || r.hours[dayIdx] == null) continue;
    if (r.startDate && date < r.startDate) continue;
    if (r.endDate && date > r.endDate) continue;
    match = r;
  }
  return match;
}

// The standard template with any active rules applied for the week in
// `employment`. Returns the template untouched (same reference, possibly
// undefined) when no rule covers any day of the week, so a member with no
// template and no applicable rule still falls through to the legacy /
// hardcoded-default branches of resolveWeekHoursBoth.
export function effectiveTemplate(standardWeeklyHours: number[] | undefined, employment?: EmploymentWindow): number[] | undefined {
  if (!employment?.rules?.length) return standardWeeklyHours;
  let out: number[] | undefined;
  for (let d = 0; d < 7; d++) {
    const rule = activeRuleForDay(d, employment);
    if (!rule) continue;
    out ??= Array.from({ length: 7 }, (_, j) => standardWeeklyHours?.[j] ?? 0);
    out[d] = rule.hours[d] ?? 0;
  }
  return out ?? standardWeeklyHours;
}

function addIsoDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// True if the given weekIso+dayIdx calendar date falls on or after startDate
// and on or before endDate (either bound optional). No window (or a window
// with neither bound set) always resolves true.
export function isWithinEmployment(dayIdx: number, employment?: EmploymentWindow): boolean {
  if (!employment || (!employment.startDate && !employment.endDate)) return true;
  const date = addIsoDays(employment.weekIso, dayIdx);
  if (employment.startDate && date < employment.startDate) return false;
  if (employment.endDate && date > employment.endDate) return false;
  return true;
}

// Splits a weekly total across 5 weekdays as evenly as possible (remainder
// goes to the earliest days), leaving Sat/Sun at 0. Used both to seed daily
// hours from a plain weekly number and to materialize a legacy weekly value
// into per-day overrides the first time any single day in that week is edited.
export function distributeHours(total: number): number[] {
  if (total <= 0) return [0, 0, 0, 0, 0, 0, 0];
  const base = Math.floor(total / 5);
  const rem  = Math.round(total) % 5;
  return Array.from({ length: 7 }, (_, i) => i < 5 ? (i < rem ? base + 1 : base) : 0);
}

// True if the calendar date at weekIso+dayIdx is a paid holiday. Staff are
// paid whether or not they produce anything that day, so this only ever
// affects PRODUCTION hours, never the guaranteed-pay basis — see payHours
// below.
function isPaidHolidayDate(weekIso: string | undefined, dayIdx: number, holidays?: string[]): boolean {
  if (!weekIso || !holidays || holidays.length === 0) return false;
  return holidays.includes(addIsoDays(weekIso, dayIdx));
}

// A day off (employment.daysOff) likewise forces production hours to 0 over
// any override, template or rule. Pay follows: an unpaid 0 — except on a
// paid holiday, which still pays the member's standard day.
//
// employment, when passed, forces hours to 0 for any day outside the
// member's [startDate, endDate] window — taking priority over an explicit
// override, so a member's schedule zeroes itself out from their last day
// forward without anyone having to go back and clear entered hours.
//
// holidays, when passed, zeroes PRODUCTION hours (the `hours` field) for a
// paid-holiday day — but never touches `payHours`, which is what hourly cost
// should be computed from instead: on a holiday, payHours is always the
// member's guaranteed standard hours for that weekday, PLUS whatever's
// already sitting in the override for that day (if any). A pre-existing
// override is never treated as "this person is ineligible for holiday pay" —
// it's either genuine worked hours (someone chose to work, or a manager
// recorded it after the fact) or a stale/placeholder value entered before
// the day was ever declared a holiday, and either way the holiday's
// guaranteed standard-day pay still applies on top of it.
export function resolveDayHours(
  dailyMap: DailyHoursMap,
  weekKey: string,
  dayIdx: number,
  standardWeeklyHours: number[] | undefined,
  employment?: EmploymentWindow,
  holidays?: string[],
): { hours: number; isOverride: boolean; payHours: number; isHoliday: boolean; isDayOff: boolean } {
  if (!isWithinEmployment(dayIdx, employment)) return { hours: 0, isOverride: true, payHours: 0, isHoliday: false, isDayOff: false };
  const isHoliday = isPaidHolidayDate(employment?.weekIso, dayIdx, holidays);
  const override = dailyMap[weekKey]?.[dayIdx];
  const standard = activeRuleForDay(dayIdx, employment)?.hours[dayIdx] ?? standardWeeklyHours?.[dayIdx] ?? 0;
  if (isDayOff(dayIdx, employment)) {
    return { hours: 0, isOverride: false, payHours: isHoliday ? standard : 0, isHoliday, isDayOff: true };
  }
  if (override != null) {
    return { hours: override, isOverride: true, payHours: isHoliday ? standard + override : override, isHoliday, isDayOff: false };
  }
  if (isHoliday) return { hours: 0, isOverride: false, payHours: standard, isHoliday: true, isDayOff: false };
  return { hours: standard, isOverride: false, payHours: standard, isHoliday: false, isDayOff: false };
}

export interface ResolveWeekHoursParams {
  dailyMap: DailyHoursMap;
  weekKey: string;
  legacyWeeklyValue?: number;
  standardWeeklyHours?: number[];
  hardcodedDefault?: number;
  employment?: EmploymentWindow;
  holidays?: string[];
}

// Full per-member-per-week fallback chain, highest to lowest priority:
//   1. Daily entries exist for this member+week -> sum of resolveDayHours (0-6)
//   2. No daily entries yet, but a legacy (pre-cutover) weekly value exists -> that value, as-is
//   3. Standard weekly template set on the roster, with any active schedule
//      rules applied (see effectiveTemplate) -> its sum
//   4. Hardcoded per-member/week default (e.g. onboarding/offboarding ramps) -> that value
//   5. else 0
// Days off (employment.daysOff) are then zeroed on top, like the employment
// window below.
// employment (see resolveDayHours) is applied on top of whichever branch
// resolves: a week fully outside the window returns 0, a week fully inside
// is untouched, and a week the member starts or ends mid-way through is
// pro-rated to just the days actually within the window.
//
// Returns BOTH the production (`hours`, holiday-zeroed) and guaranteed-pay
// (`payHours`) totals together — see resolveDayHours for what distinguishes
// them on a holiday. The two public exports below are thin views onto this,
// so most callers (capacity/turnaround math, which only ever wanted
// production hours) don't need to change at all beyond passing `holidays`.
export function resolveWeekHoursBoth(params: ResolveWeekHoursParams): { hours: number; payHours: number } {
  const { dailyMap, weekKey, legacyWeeklyValue, hardcodedDefault, employment, holidays } = params;
  const standardWeeklyHours = effectiveTemplate(params.standardWeeklyHours, employment);
  const daily = dailyMap[weekKey];
  if (daily !== undefined) {
    let hours = 0, payHours = 0;
    for (let d = 0; d < 7; d++) {
      const r = resolveDayHours(dailyMap, weekKey, d, standardWeeklyHours, employment, holidays);
      hours += r.hours;
      payHours += r.payHours;
    }
    return { hours, payHours };
  }

  const weekTotal = legacyWeeklyValue !== undefined
    ? legacyWeeklyValue
    : standardWeeklyHours !== undefined
      ? standardWeeklyHours.reduce((s, h) => s + (h ?? 0), 0)
      : (hardcodedDefault ?? 0);
  if (weekTotal <= 0) return { hours: weekTotal, payHours: weekTotal };

  const weekIso = employment?.weekIso;
  const daysIn = Array.from({ length: 7 }, (_, d) => isWithinEmployment(d, employment));
  const hasHoliday = !!weekIso && daysIn.some((inWindow, d) => inWindow && isPaidHolidayDate(weekIso, d, holidays));
  const off = Array.from({ length: 7 }, (_, d) => isDayOff(d, employment));
  if (daysIn.every(Boolean) && !hasHoliday && !off.some(Boolean)) return { hours: weekTotal, payHours: weekTotal };
  if (daysIn.every(v => !v)) return { hours: 0, payHours: 0 };

  const perDay = standardWeeklyHours ?? distributeHours(weekTotal);
  let hours = 0, payHours = 0;
  for (let d = 0; d < 7; d++) {
    if (!daysIn[d]) continue;
    const h = perDay[d] ?? 0;
    const holiday = isPaidHolidayDate(weekIso, d, holidays);
    if (off[d]) { payHours += holiday ? h : 0; continue; }
    payHours += h;
    hours += holiday ? 0 : h;
  }
  return { hours, payHours };
}

export function resolveWeekHours(params: ResolveWeekHoursParams): number {
  return resolveWeekHoursBoth(params).hours;
}

// Guaranteed-pay-basis version of resolveWeekHours, for the smaller set of
// callers that compute an HOURLY member's weekly COST rather than their
// production capacity — see resolveDayHours' payHours for the exact holiday
// semantics (guaranteed standard hours, plus any worked override on top).
export function resolveWeekPayHours(params: ResolveWeekHoursParams): number {
  return resolveWeekHoursBoth(params).payHours;
}

// Returns the 7-element array a daily-hours setter should start mutating from
// for a given member+week: the already-stored array if one exists, otherwise
// — for the current week or earlier only — a freshly materialized array from
// any legacy weekly value (so fixing one day doesn't silently revert days
// that may already represent real worked hours back to "the template"),
// otherwise a fresh all-null array.
//
// currentWeekKey (the caller's isoMonday(0)) gates the legacy-materialize
// path to the current/past week specifically. A future week has no
// already-worked hours to protect — materializing a stale legacy default
// there (e.g. a flat pre-template placeholder repeated across dozens of
// future weeks) would freeze every other day in that week away from the
// template the moment just one day gets edited, defeating the template
// entirely for any future week that happens to carry one of these old
// numbers.
export function baseDailyArray(
  dailyMap: DailyHoursMap,
  weekKey: string,
  legacyWeeklyValue: number | undefined,
  currentWeekKey: string,
): (number | null)[] {
  const existing = dailyMap[weekKey];
  if (existing) return existing;
  const isCurrentOrPast = weekKey <= currentWeekKey;
  if (isCurrentOrPast && legacyWeeklyValue !== undefined && legacyWeeklyValue > 0) {
    return distributeHours(legacyWeeklyValue) as (number | null)[];
  }
  return [null, null, null, null, null, null, null];
}
