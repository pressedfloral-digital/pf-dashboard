'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssignmentCounts, AssignmentDepartment, DailyAssignmentCountRow } from '@/lib/assignment-counts';
import { createSingleFlight } from '@/lib/assignment-batch';
import { pollAfterCompletion } from '@/lib/poll-after-completion';

interface AssignmentCountsResponse {
  rows: DailyAssignmentCountRow[];
  unmatched: string[];
  refreshedAt: string;
  error?: string;
}
interface UseProductionAssignmentCountsOptions { names: string[]; dates: string[]; enabled?: boolean }
interface Snapshot {
  key: string;
  counts: Record<string, Record<string, AssignmentCounts>>;
  unmatched: string[];
  loading: boolean;
  error: string | null;
  refreshedAt: string | null;
}
const empty = (key: string, loading = false): Snapshot => ({ key, counts: {}, unmatched: [], loading, error: null, refreshedAt: null });
// Share requests across matching mounted views, including effect remounts. Cleanup
// only detaches a subscriber: aborting shared work would allow server-side overlap.
const requestFlight = createSingleFlight<AssignmentCountsResponse>(1000);

export function useProductionAssignmentCounts({ names, dates, enabled = true }: UseProductionAssignmentCountsOptions) {
  const namesKey = useMemo(() => JSON.stringify([...new Set(names.map(name => name.trim()).filter(Boolean))].sort()), [names]);
  const datesKey = useMemo(() => JSON.stringify([...new Set(dates)].sort()), [dates]);
  const active = enabled && namesKey !== '[]' && datesKey !== '[]';
  const key = active ? JSON.stringify([namesKey, datesKey]) : '';
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(key, active));
  // Never display another roster/week's values, even during the render before cleanup.
  const current = snapshot.key === key ? snapshot : empty(key, active);

  useEffect(() => {
    if (!key) return;
    const requestNames = JSON.parse(namesKey) as string[];
    const requestDates = JSON.parse(datesKey) as string[];
    let cancelled = false;
    setSnapshot(empty(key, true));
    const stop = pollAfterCompletion(async () => {
      try {
        const data = await requestFlight(key, async () => {
          const response = await fetch('/api/production-assignment-counts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start: requestDates[0], end: requestDates.at(-1), names: requestNames }),
            signal: AbortSignal.timeout(90000),
          });
          const result = await response.json() as AssignmentCountsResponse;
          if (!response.ok) throw new Error(result.error ?? 'Unable to load production actuals.');
          if (!Array.isArray(result.rows) || !Array.isArray(result.unmatched) || !Number.isFinite(Date.parse(result.refreshedAt)))
            throw new Error('Incomplete production actuals response.');
          return result;
        });
        if (cancelled) return;
        setSnapshot({ key, counts: Object.fromEntries(data.rows.map(row => [row.staff, row.days])),
          unmatched: data.unmatched, refreshedAt: data.refreshedAt, loading: false, error: null });
      } catch (error) {
        if (cancelled) return;
        // Keep this scope's last successful numbers AND timestamp, visibly stale.
        setSnapshot(previous => ({ ...(previous.key === key ? previous : empty(key)), loading: false,
          error: error instanceof Error ? error.message : 'Unable to load production actuals.' }));
      }
    }, 5 * 60 * 1000);
    return () => { cancelled = true; stop(); };
  }, [key, namesKey, datesKey]);

  const getCount = useCallback((name: string, date: string, department: AssignmentDepartment): number | null =>
    current.counts[name.trim()]?.[date]?.[department] ?? null, [current.counts]);
  return { getCount, unmatched: new Set(current.unmatched.map(name => name.trim())), loading: current.loading,
    error: current.error, refreshedAt: current.refreshedAt };
}
