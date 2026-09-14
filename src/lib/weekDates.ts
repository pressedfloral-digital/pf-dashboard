// Canonical "week N from today" date helpers.
// Week offset 0 always means "this week" (Monday of the current week),
// recomputed relative to the current date — not a fixed calendar epoch.
// This is the single source of truth; do not duplicate this logic elsewhere.

export function getMondayDate(offsetWeeks: number): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff + offsetWeeks * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isoMonday(offsetWeeks: number): string {
  return getMondayDate(offsetWeeks).toISOString().split('T')[0];
}

export function getWeekLabel(offsetWeeks: number): string {
  return getMondayDate(offsetWeeks).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function getMonthKey(offsetWeeks: number): string {
  return getMondayDate(offsetWeeks).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Offset (in weeks from "this week") of the week containing Dec 31 of the
// current year — used to cap "This Week" navigation at the end of the year
// instead of an arbitrary fixed number of weeks.
export function weeksUntilEndOfYear(): number {
  const now = getMondayDate(0);
  const dec31 = new Date(now.getFullYear(), 11, 31);
  const dec31Monday = isoMondayFromDate(dec31);
  return Math.max(0, Math.round(
    (new Date(dec31Monday + 'T12:00:00').getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000)
  ));
}

// Converts an arbitrary Date to the ISO date of the Monday of its week.
export function isoMondayFromDate(d: Date): string {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split('T')[0];
}

// Splits an arbitrary ISO 'YYYY-MM-DD' date into the Monday-anchored week key
// and the Mon=0..Sun=6 day index that scheduleResolution's DailyHoursMap is
// keyed by. Used by the roster's "day off" request UI, which (unlike "This
// Week") targets a specific calendar date rather than whichever week offset
// is currently being viewed.
export function weekAndDayIndexForDate(dateIso: string): { weekIso: string; dayIdx: number } {
  const d = new Date(dateIso + 'T12:00:00');
  return { weekIso: isoMondayFromDate(d), dayIdx: (d.getDay() + 6) % 7 };
}
