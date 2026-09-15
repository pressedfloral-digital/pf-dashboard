'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// Company-wide growth multiplier + Utah/Georgia % distribution, stored under
// schedule_settings' location='Global' bucket (same generic table/route
// useScheduleSettings.ts's usePaidHolidays uses). Shared by the Growth &
// Distribution tab (where these are edited) and SchedulePage.tsx's Queue &
// Turnaround tab (which now derives its per-location "bouquets received"
// projection from these instead of its own local per-location multiplier —
// editing one place should move the other, not disagree with it).
export function useGrowthSettings() {
  const [companyMultipliers, setCompanyMultipliers] = useState<Record<string, number>>({});
  const [distributionPct,    setDistributionPct]    = useState<Record<string, { ut: number; ga: number }>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    fetch('/api/schedule-settings?location=Global')
      .then(r => r.json())
      .then((data: { companyMultipliers?: Record<string, number>; distributionPct?: Record<string, { ut: number; ga: number }> }) => {
        setCompanyMultipliers(data.companyMultipliers ?? {});
        setDistributionPct(data.distributionPct ?? {});
      })
      .catch(() => {});
  }, []);

  const persist = useCallback((key: 'companyMultipliers' | 'distributionPct', value: unknown) => {
    if (timers.current[key]) clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      fetch('/api/schedule-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: 'Global', key, value }),
      }).catch(() => {});
    }, 500);
  }, []);

  const setMultiplier = useCallback((weekOf: string, value: number) => {
    setCompanyMultipliers(prev => {
      const next = { ...prev, [weekOf]: value };
      persist('companyMultipliers', next);
      return next;
    });
  }, [persist]);

  const setDistribution = useCallback((weekOf: string, utPct: number) => {
    setDistributionPct(prev => {
      const next = { ...prev, [weekOf]: { ut: utPct, ga: 100 - utPct } };
      persist('distributionPct', next);
      return next;
    });
  }, [persist]);

  return { companyMultipliers, distributionPct, setMultiplier, setDistribution };
}
