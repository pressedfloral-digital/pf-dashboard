'use client';

import { useState, useEffect, useCallback } from 'react';

export interface WeekEstimate { utPct: number | null; hasSeasonalData: boolean }

// Seasonal + planned-move-aware suggested Utah % distribution per week, from
// /api/distribution-estimate. This is only ever a DEFAULT — callers should
// fall back to it just like distributionPct[weekOf]?.ut ?? estimates[weekOf]
// ?? 50, never overriding a manually-set week. Shared by SchedulePage.tsx
// (Queue & Turnaround's projection) and GrowthDistributionPage.tsx (Company
// Total table + reassignment planner) so both agree on the same default.
//
// Call refresh() after adding/removing a planned_state_moves row — the
// server recomputes from scratch each request, so there's no other way for
// a client to know the estimate shifted.
export function useDistributionEstimate(weeks = 52) {
  const [estimates, setEstimates] = useState<Record<string, WeekEstimate>>({});
  const [yearsOfHistory, setYearsOfHistory] = useState(0);

  const refresh = useCallback(() => {
    return fetch(`/api/distribution-estimate?weeks=${weeks}`)
      .then(r => r.json())
      .then((d: { estimates?: Record<string, WeekEstimate>; yearsOfHistory?: number }) => {
        setEstimates(d.estimates ?? {});
        setYearsOfHistory(d.yearsOfHistory ?? 0);
      })
      .catch(() => {});
  }, [weeks]);

  useEffect(() => { refresh(); }, [refresh]);

  function getSuggestedUtPct(weekOf: string): number {
    return estimates[weekOf]?.utPct ?? 50;
  }

  return { estimates, yearsOfHistory, getSuggestedUtPct, refresh };
}
