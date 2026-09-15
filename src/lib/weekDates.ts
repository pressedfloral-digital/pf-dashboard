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

// ISO 8601 week number (1-52 or 53) for a Monday ISO date — the week
// containing that Monday's Thursday determines which calendar year it
// belongs to, so a Monday can be "week 1" even if it falls in late December
// (and vice versa in early January). Purely a display label: any "same week
// last year" math elsewhere (e.g. addDays(weekOf, -364)) is a fixed 52-week
// offset and doesn't depend on this numbering, so it's unaffected by a year
// having 52 vs. 53 ISO weeks.
export function getISOWeekNumber(iso: string): number {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
