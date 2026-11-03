// A roster member's ratio (hours per unit) from their own recent actuals —
// what the roster editor's ↻ button and Preservation's auto-sync write.
// Client-safe: no server imports.
import { samePayrollPerson } from './payrollNames';

export interface RatioActualRow {
  department:    string;
  week_of:       string;
  member_name:   string;
  actual_hours:  number;
  actual_orders: number;
}

// Average over this many of the member's latest complete weeks…
export const RATIO_WEEKS = 4;
// …looking back no further than this, so someone who hasn't worked in the
// dept for months keeps their roster ratio instead of picking up a stale one.
export const RATIO_LOOKBACK_WEEKS = 12;

function addWeeks(iso: string, weeks: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().split('T')[0];
}

/**
 * Hours ÷ units over the member's last RATIO_WEEKS complete weeks, rounded to
 * 2 places, or null when there's nothing to go on. `currentMonday` is this
 * week's Monday — that week is still in progress, so it's left out.
 *
 * Only `department` rows count (for Preservation that leaves out
 * checks_unboxing: scheduled check hours aren't production hours, so they
 * shouldn't inflate the press ratio). Names match ignoring case, stray spaces
 * and known Rippling aliases, and a week's rows under different spellings of
 * the same person are combined. Weeks with hours but no units (or units but
 * no hours) are skipped — one side wasn't recorded, so they'd skew the ratio.
 */
export function ratioFromActuals(
  rows:          RatioActualRow[],
  department:    string,
  memberName:    string,
  currentMonday: string,
): number | null {
  const earliest = addWeeks(currentMonday, -RATIO_LOOKBACK_WEEKS);
  const byWeek = new Map<string, { hours: number; units: number }>();
  for (const r of rows) {
    if (r.department !== department) continue;
    if (r.week_of >= currentMonday || r.week_of < earliest) continue;
    if (!samePayrollPerson(r.member_name, memberName)) continue;
    const w = byWeek.get(r.week_of) ?? { hours: 0, units: 0 };
    w.hours += r.actual_hours ?? 0;
    w.units += r.actual_orders ?? 0;
    byWeek.set(r.week_of, w);
  }
  const weeks = [...byWeek.entries()]
    .filter(([, w]) => w.hours > 0 && w.units > 0)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, RATIO_WEEKS);
  const hours = weeks.reduce((s, [, w]) => s + w.hours, 0);
  const units = weeks.reduce((s, [, w]) => s + w.units, 0);
  return hours > 0 && units > 0 ? Math.round((hours / units) * 100) / 100 : null;
}

/**
 * The roster with every active member's ratio set from their actuals, or null
 * when nothing would change (so callers can skip the save).
 */
export function syncRosterRatios<T extends { name?: string; ratio?: number; _removed?: boolean }>(
  roster:        Record<string, T>,
  rows:          RatioActualRow[],
  department:    string,
  currentMonday: string,
): Record<string, T> | null {
  let next: Record<string, T> | null = null;
  for (const [id, member] of Object.entries(roster)) {
    if (member._removed || !member.name) continue;
    const ratio = ratioFromActuals(rows, department, member.name, currentMonday);
    if (ratio === null || ratio === member.ratio) continue;
    next ??= { ...roster };
    next[id] = { ...member, ratio };
  }
  return next;
}
