'use client';

import { isoMonday } from '@/lib/weekDates';
import type { DailyHoursMap } from '@/lib/scheduleResolution';

// Roster, This Week, and Weekly Schedule hide members who aren't working in
// that department right now (e.g. someone who flexed in once, or has left),
// the same way Historicals hides inactive rows. Hidden members are only
// dropped from the rendered rows — every total still uses the full team —
// and a "Show N inactive" toggle brings them back.
//
// A member counts as active when any of these is true:
//   - they have actual hours or orders in this department in the last
//     ACTIVE_LOOKBACK_WEEKS weeks,
//   - they're scheduled: a nonzero standard template (or built-in default
//     hours), or a This Week entry from that window onward — so manually
//     scheduling someone brings them back automatically,
//   - they were added to the roster within that window (new hires start
//     with no hours and still need to show up to be set up),
// and their employment end date, if any, hasn't passed.

export const ACTIVE_LOOKBACK_WEEKS = 4;

interface ActualsRow {
  member_name:   string;
  week_of:       string;
  actual_hours:  number;
  actual_orders: number;
}

export interface MemberActivityInput {
  id:    string;
  name:  string;
  standardWeeklyHours?: number[];
  defaultHrs?: number;
  endDate?: string;
}

// Custom roster ids end in the millisecond timestamp they were created at
// (e.g. `utah-p-1783433010986`); built-in default members don't.
function addedAtMs(id: string): number | null {
  const m = id.match(/(\d{13})$/);
  return m ? Number(m[1]) : null;
}

export function buildActiveMemberIds(
  members: MemberActivityInput[],
  deptActuals: ActualsRow[],
  /** Any per-day schedule maps keyed `${weekIso}-${memberId}` (hours, check hours, ...). */
  dailyHourMaps: (DailyHoursMap | Record<string, number[]> | undefined)[],
): Set<string> {
  const sinceIso = isoMonday(-ACTIVE_LOOKBACK_WEEKS);
  const todayIso = new Date().toISOString().split('T')[0];
  const sinceMs  = new Date(`${sinceIso}T00:00:00`).getTime();

  const workedRecently = new Set(
    deptActuals
      .filter(r => r.week_of >= sinceIso && (r.actual_hours > 0 || r.actual_orders > 0))
      .map(r => r.member_name.trim().toLowerCase()),
  );
  const scheduledIds = new Set<string>();
  for (const map of dailyHourMaps) {
    for (const [key, hours] of Object.entries(map ?? {})) {
      // Keys are `${weekIso}-${memberId}`.
      if (key.slice(0, 10) >= sinceIso && Array.isArray(hours) && hours.some(h => (h ?? 0) > 0)) scheduledIds.add(key.slice(11));
    }
  }

  const active = new Set<string>();
  for (const m of members) {
    if (m.endDate && m.endDate < todayIso) continue;
    const added = addedAtMs(m.id);
    if (
      workedRecently.has(m.name.trim().toLowerCase()) ||
      scheduledIds.has(m.id) ||
      (m.standardWeeklyHours ?? []).some(h => h > 0) ||
      (m.defaultHrs ?? 0) > 0 ||
      (added !== null && added >= sinceMs)
    ) active.add(m.id);
  }
  return active;
}

export function InactiveToggle({ count, showing, onToggle }: { count: number; showing: boolean; onToggle: () => void }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-xs text-slate-500 hover:text-slate-700 underline-offset-2 hover:underline whitespace-nowrap"
      title={`Members with no hours, orders, or schedule in this department in the last ${ACTIVE_LOOKBACK_WEEKS} weeks`}
    >
      {showing ? `Hide ${count} inactive` : `Show ${count} inactive`}
    </button>
  );
}
