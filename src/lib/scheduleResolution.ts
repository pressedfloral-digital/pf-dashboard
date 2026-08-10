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

// employment, when passed, forces hours to 0 for any day outside the
// member's [startDate, endDate] window — taking priority over an explicit
// override, so a member's schedule zeroes itself out from their last day
// forward without anyone having to go back and clear entered hours.
export function resolveDayHours(
  dailyMap: DailyHoursMap,
  weekKey: string,
  dayIdx: number,
  standardWeeklyHours: number[] | undefined,
  employment?: EmploymentWindow,
): { hours: number; isOverride: boolean } {
  if (!isWithinEmployment(dayIdx, employment)) return { hours: 0, isOverride: true };
  const override = dailyMap[weekKey]?.[dayIdx];
  if (override != null) return { hours: override, isOverride: true };
  return { hours: standardWeeklyHours?.[dayIdx] ?? 0, isOverride: false };
}

// Full per-member-per-week fallback chain, highest to lowest priority:
//   1. Daily entries exist for this member+week -> sum of resolveDayHours (0-6)
//   2. No daily entries yet, but a legacy (pre-cutover) weekly value exists -> that value, as-is
//   3. Standard weekly template set on the roster -> sum(standardWeeklyHours)
//   4. Hardcoded per-member/week default (e.g. onboarding/offboarding ramps) -> that value
//   5. else 0
// employment (see resolveDayHours) is applied on top of whichever branch
// resolves: a week fully outside the window returns 0, a week fully inside
// is untouched, and a week the member starts or ends mid-way through is
// pro-rated to just the days actually within the window.
export function resolveWeekHours(params: {
  dailyMap: DailyHoursMap;
  weekKey: string;
  legacyWeeklyValue?: number;
  standardWeeklyHours?: number[];
  hardcodedDefault?: number;
  employment?: EmploymentWindow;
}): number {
  const { dailyMap, weekKey, legacyWeeklyValue, standardWeeklyHours, hardcodedDefault, employment } = params;
  const daily = dailyMap[weekKey];
  if (daily !== undefined) {
    let sum = 0;
    for (let d = 0; d < 7; d++) sum += resolveDayHours(dailyMap, weekKey, d, standardWeeklyHours, employment).hours;
    return sum;
  }

  const weekTotal = legacyWeeklyValue !== undefined
    ? legacyWeeklyValue
    : standardWeeklyHours !== undefined
      ? standardWeeklyHours.reduce((s, h) => s + (h ?? 0), 0)
      : (hardcodedDefault ?? 0);

  if (!employment || weekTotal <= 0) return weekTotal;
  const daysIn = Array.from({ length: 7 }, (_, d) => isWithinEmployment(d, employment));
  if (daysIn.every(Boolean)) return weekTotal;
  if (daysIn.every(v => !v)) return 0;
  const perDay = standardWeeklyHours ?? distributeHours(weekTotal);
  return perDay.reduce((s, h, d) => s + (daysIn[d] ? (h ?? 0) : 0), 0);
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
