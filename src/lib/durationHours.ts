// Rippling's "Time entry duration (hours)" column comes through as a decimal
// ("8.65"), as clock time ("8:39" or "8:39:00"), or — when the cell is
// time-formatted — as a Date from SheetJS (cellDates) or an Excel day
// fraction. parseFloat alone read "8:39" as 8 and a Date as 0.

/** Hours as a decimal, or 0 when the value can't be read. */
export function parseDurationHours(val: unknown): number {
  if (val == null || val === '') return 0;
  if (val instanceof Date) {
    // A time-formatted cell: SheetJS builds it from Excel's 1899-12-30 epoch
    // in local time, so read the clock parts (shifts are under 24h).
    return val.getHours() + val.getMinutes() / 60 + val.getSeconds() / 3600;
  }
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  const s = String(val).trim();
  const clock = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60 + Number(clock[3] ?? 0) / 3600;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
