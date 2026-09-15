'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssignmentCounts, AssignmentDepartment, DailyAssignmentCountRow } from '@/lib/assignment-counts';

interface AssignmentCountsResponse {
  rows?: DailyAssignmentCountRow[];
  unmatched?: string[];
  refreshedAt?: string;
  error?: string;
}

interface UseProductionAssignmentCountsOptions {
  names: string[];
  dates: string[];
  enabled?: boolean;
}

const EMPTY_COUNTS: Record<string, Record<string, AssignmentCounts>> = {};

export function useProductionAssignmentCounts({
  names,
  dates,
  enabled = true,
}: UseProductionAssignmentCountsOptions) {
  const namesKey = useMemo(() => [...new Set(names.map(name => name.trim()).filter(Boolean))].sort().join('\u0001'), [names]);
  const datesKey = useMemo(() => [...new Set(dates)].sort().join('\u0001'), [dates]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !namesKey || !datesKey) {
      setCounts(EMPTY_COUNTS);
      setUnmatched([]);
      setError(null);
      return;
    }

    const requestNames = namesKey.split('\u0001');
    const requestDates = datesKey.split('\u0001');
    let cancelled = false;
    let controller: AbortController | null = null;

    async function load(initial: boolean) {
      controller?.abort();
      controller = new AbortController();
      if (initial) setLoading(true);
      try {
        const response = await fetch('/api/production-assignment-counts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: requestDates[0],
            end: requestDates[requestDates.length - 1],
            names: requestNames,
          }),
          signal: controller.signal,
        });
        const data = await response.json() as AssignmentCountsResponse;
        if (!response.ok) throw new Error(data.error ?? 'Unable to load production actuals.');
        if (cancelled) return;

        const next: Record<string, Record<string, AssignmentCounts>> = {};
        (data.rows ?? []).forEach(row => { next[row.staff] = row.days; });
        setCounts(next);
        setUnmatched(data.unmatched ?? []);
        setRefreshedAt(data.refreshedAt ?? new Date().toISOString());
        setError(null);
      } catch (loadError) {
        if (cancelled || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
        setError(loadError instanceof Error ? loadError.message : 'Unable to load production actuals.');
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    }

    void load(true);
    const interval = window.setInterval(() => { void load(false); }, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [enabled, namesKey, datesKey]);

  const getCount = useCallback((name: string, date: string, department: AssignmentDepartment): number | null => {
    return counts[name.trim()]?.[date]?.[department] ?? null;
  }, [counts]);

  return {
    getCount,
    unmatched: useMemo(() => new Set(unmatched.map(name => name.trim())), [unmatched]),
    loading,
    error,
    refreshedAt,
  };
}
