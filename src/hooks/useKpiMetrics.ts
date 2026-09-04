'use client';

import { useState, useEffect, useCallback } from 'react';
import type { WindowResult, EstimatedMonthResult, RatioVariantResult, PlannedResult, PeriodKpis, KpiMetrics } from '@/app/api/kpis/route';

// Re-export for consumers
export type { WindowResult, EstimatedMonthResult, RatioVariantResult, PlannedResult, PeriodKpis, KpiMetrics };

export type RatioVariant = 'estimate' | 'expected' | 'goal';

export type KpiLocation = 'Utah' | 'Georgia' | 'Combined';
export type KpiDept     = 'design' | 'preservation' | 'fulfillment' | 'resin' | 'ga' | 'combined';

export interface KpiState {
  windows:    WindowResult[];
  estimated:  { current?: EstimatedMonthResult; next?: EstimatedMonthResult } | null;
  loading:    boolean;
  error:      string | null;
  refresh:    () => void;
}

// Default: fetch all window types with reasonable history depths
const DEFAULT_WINDOWS = 'mtd,qtd,ytd,weekly-104,monthly-36,quarterly-12,est-current,est-next';

export function useKpiMetrics(windowsParam = DEFAULT_WINDOWS): KpiState {
  const [windows,   setWindows]   = useState<WindowResult[]>([]);
  const [estimated, setEstimated] = useState<{ current?: EstimatedMonthResult; next?: EstimatedMonthResult } | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/kpis?windows=${encodeURIComponent(windowsParam)}`, { cache: 'no-store' });
      const data = await res.json() as {
        ok:        boolean;
        windows:   WindowResult[];
        estimated: { current?: EstimatedMonthResult; next?: EstimatedMonthResult } | null;
        error?:    string;
      };
      if (!data.ok) throw new Error(data.error ?? 'Unknown error');
      setWindows(data.windows ?? []);
      setEstimated(data.estimated ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [windowsParam]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return { windows, estimated, loading, error, refresh: fetch_ };
}

// ── Selector helpers ──────────────────────────────────────────────────────────
// These make it easy to pull a specific dept + location from any window result.

export function selectDept(period: PeriodKpis, dept: KpiDept): KpiMetrics {
  return period[dept];
}

export function selectLocation(window: WindowResult, location: KpiLocation): PeriodKpis {
  if (location === 'Utah')     return window.utah;
  if (location === 'Georgia')  return window.georgia;
  return window.combined;
}

// A window's `planned` comparison — what that period's own saved schedule
// implied for CPO/ratio, in the given Goal/Expected/Estimated mode (see
// WindowResult.planned) — or null when the window type doesn't carry one
// (MTD/QTD/YTD).
export function selectPlanned(
  window:   WindowResult,
  location: KpiLocation,
  variant:  RatioVariant = 'estimate'
): PeriodKpis | null {
  if (!window.planned) return null;
  const v = window.planned[variant];
  if (location === 'Utah')    return v.utah;
  if (location === 'Georgia') return v.georgia;
  return v.combined;
}

export function selectEstimated(
  result:   EstimatedMonthResult | undefined,
  location: KpiLocation,
  variant:  RatioVariant = 'estimate'
): PeriodKpis | null {
  if (!result) return null;
  const v = result[variant];
  if (location === 'Utah')    return v.utah;
  if (location === 'Georgia') return v.georgia;
  return v.combined;
}

// ── Window type filters ───────────────────────────────────────────────────────

export function getWindowsByType(
  windows: WindowResult[],
  type:    'mtd' | 'qtd' | 'ytd' | 'weekly' | 'monthly' | 'quarterly'
): WindowResult[] {
  switch (type) {
    case 'mtd':       return windows.filter(w => w.label.endsWith('MTD'));
    case 'qtd':       return windows.filter(w => w.label.endsWith('QTD'));
    case 'ytd':       return windows.filter(w => w.label.endsWith('YTD'));
    case 'weekly':    return windows.filter(w => w.label.startsWith('W/C'));
    case 'monthly':   return windows.filter(w =>
      !w.label.endsWith('MTD') && !w.label.endsWith('QTD') && !w.label.endsWith('YTD') && !w.label.startsWith('W/C') && !w.label.match(/^Q\d/));
    case 'quarterly': return windows.filter(w => w.label.match(/^Q\d/));
    default:          return [];
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

export function fmtRatio(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

export function fmtCPO(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtHours(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function fmtUnits(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export const DEPT_LABELS: Record<KpiDept, string> = {
  design:       'Design',
  preservation: 'Preservation',
  fulfillment:  'Fulfillment',
  resin:        'Resin',
  ga:           'G&A',
  combined:     'Combined',
};

export const DEPT_PRODUCTION_UNIT: Record<KpiDept, string> = {
  design:       'frames',
  preservation: 'bouquets',
  fulfillment:  'orders',
  resin:        'pieces',
  ga:           '—',
  combined:     'orders',
};

// Departments shown in ratio section (G&A has no ratio)
export const RATIO_DEPTS: KpiDept[] = ['combined', 'design', 'preservation', 'fulfillment', 'resin'];

// Departments shown in CPO section
export const CPO_DEPTS: KpiDept[] = ['combined', 'design', 'preservation', 'fulfillment', 'ga'];

// Resin is Utah-only — hide from Georgia and Combined views
export function showResin(location: KpiLocation, dept: KpiDept): boolean {
  if (dept !== 'resin') return true;
  return location === 'Utah';
}
