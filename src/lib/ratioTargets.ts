// Single source of truth for per-role-tier ratio targets (hours per unit of
// production), shared by /api/kpis (Estimated/Expected/Goal projections),
// ScorecardTab.tsx (Actual Ratios tiering), and useHistoricalMetrics.ts
// (Schedule tab goal projections). Update this file (only) when a target
// changes — every consumer picks it up automatically.

export type RatioTier = 'specialist' | 'senior' | 'master';
export type RatioDept  = 'Design' | 'Preservation' | 'Fulfillment' | 'G&A' | 'Resin';

export const RATIO_TARGETS: Record<RatioDept, Record<RatioTier, number>> = {
  Design:       { specialist: 2.00, senior: 1.60, master: 1.20 },
  Preservation: { specialist: 1.00, senior: 0.80, master: 0.60 },
  Fulfillment:  { specialist: 0.50, senior: 0.40, master: 0.30 },
  'G&A':        { specialist: 0, senior: 0, master: 0 },
  Resin:        { specialist: 0.60, senior: 0.45, master: 0.30 },
};
