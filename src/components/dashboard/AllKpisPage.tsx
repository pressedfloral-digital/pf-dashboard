'use client';

import { useState, useMemo } from 'react';
import {
  useKpiMetrics,
  getWindowsByType,
  selectLocation,
  selectDept,
  selectEstimated,
  fmtRatio,
  fmtCPO,
  fmtHours,
  fmtUnits,
  DEPT_LABELS,
  DEPT_PRODUCTION_UNIT,
  RATIO_DEPTS,
  CPO_DEPTS,
  showResin,
  type KpiLocation,
  type KpiDept,
  type KpiMetrics,
  type WindowResult,
  type EstimatedMonthResult,
  type RatioVariant,
} from '@/hooks/useKpiMetrics';
import { RATIO_TARGETS, type RatioDept } from '@/lib/ratioTargets';

// ── Types ─────────────────────────────────────────────────────────────────────

type KpiSection  = 'ratio' | 'cpo';
type TimeWindow  = 'mtd' | 'qtd' | 'ytd' | 'weekly' | 'monthly' | 'quarterly' | 'est-current' | 'est-next';

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCATIONS: { id: KpiLocation; label: string }[] = [
  { id: 'Utah',     label: 'Utah'     },
  { id: 'Georgia',  label: 'Georgia'  },
  { id: 'Combined', label: 'Combined' },
];

const TIME_WINDOWS: { id: TimeWindow; label: string }[] = [
  { id: 'mtd',        label: 'Month to date'   },
  { id: 'qtd',        label: 'Quarter to date' },
  { id: 'ytd',        label: 'Year to date'    },
  { id: 'monthly',    label: 'Monthly'         },
  { id: 'weekly',     label: 'Weekly'          },
  { id: 'quarterly',  label: 'Quarterly'       },
  { id: 'est-current',label: 'Est. this month' },
  { id: 'est-next',   label: 'Est. next month' },
];

// Singular form of DEPT_PRODUCTION_UNIT, for a per-unit rate like
// "+$2.29/frame" where the plural ("frames") would read oddly.
const SINGULAR_UNIT: Record<KpiDept, string> = {
  design: 'frame', preservation: 'bouquet', fulfillment: 'order', resin: 'piece', ga: 'order', combined: 'order',
};

// The CPO figure actually shown for a cell, given the GM/Bonus toggles —
// shared by KpiCell (rendering) and the heatmap stats below (coloring), so
// the two can never drift apart on which number is "the" CPO.
function getCpoValue(metrics: KpiMetrics, showGM: boolean, showBonus: boolean): number | null {
  return showGM && showBonus ? metrics.cpoWithGMBonus :
         showGM              ? metrics.cpoWithGM :
         showBonus           ? metrics.cpoWithBonus :
                                metrics.cpo;
}

// The value a cell's heatmap shading (and its big number) is based on —
// Ratio uses hrs/unit directly; both sections agree lower is better (see
// classifyTier), so one scale direction works for either.
function getSectionValue(metrics: KpiMetrics, section: KpiSection, showGM: boolean, showBonus: boolean): number | null {
  return section === 'ratio' ? metrics.ratio : getCpoValue(metrics, showGM, showBonus);
}

interface HeatColumnStats { min: number; max: number; median: number }

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Per-dept min/max/median (Ratio or CPO, per `section`) across every row
// currently in a historical table, so each cell can be shaded relative to
// its own column's history — a department with a $0.10-$1 CPO (G&A) and one
// with a $10-$50 CPO (Design) need independent scales, not one shared
// across the whole table. Median (not mean) anchors the midpoint — matches
// Sheets' min/50th-percentile/max color scale, and keeps a single outlier
// month (e.g. a slow holiday month) from dragging the whole column toward
// one color the way a mean would.
function computeColumnStats(
  windows:   WindowResult[],
  location:  KpiLocation,
  depts:     KpiDept[],
  section:   KpiSection,
  showGM:    boolean,
  showBonus: boolean,
): Partial<Record<KpiDept, HeatColumnStats>> {
  const stats: Partial<Record<KpiDept, HeatColumnStats>> = {};
  for (const dept of depts) {
    const values: number[] = [];
    for (const w of windows) {
      if (!showResin(location, dept)) continue;
      const metrics = selectDept(selectLocation(w, location), dept);
      if (!metrics.hasData) continue;
      const v = getSectionValue(metrics, section, showGM, showBonus);
      if (v != null) values.push(v);
    }
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    stats[dept] = { min: values[0], max: values[values.length - 1], median: median(values) };
  }
  return stats;
}

const HEAT_GREEN:  [number, number, number] = [87, 187, 138];  // best  (min)
const HEAT_YELLOW: [number, number, number] = [255, 214, 102]; // mid   (median)
const HEAT_RED:    [number, number, number] = [230, 124, 115]; // worst (max)

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = a[0] + (b[0] - a[0]) * t;
  const g = a[1] + (b[1] - a[1]) * t;
  const bl = a[2] + (b[2] - a[2]) * t;
  return `rgb(${r}, ${g}, ${bl})`;
}

// Three-stop scale — green at the column's best (lowest) value, yellow at
// its median, red at its worst (highest) — matching the min/50th-
// percentile/max color scale used on the Google Sheet this replaces.
function heatBackground(value: number | null, stats: HeatColumnStats | undefined): string | undefined {
  if (value == null || !stats) return undefined;
  const { min, max, median: mid } = stats;
  if (value <= mid) {
    const t = mid > min ? (mid - value) / (mid - min) : 0; // 0 at median, 1 at min
    return lerpRgb(HEAT_YELLOW, HEAT_GREEN, t);
  } else {
    const t = max > mid ? (value - mid) / (max - mid) : 0; // 0 at median, 1 at max
    return lerpRgb(HEAT_YELLOW, HEAT_RED, t);
  }
}

// Legend for the heatmap shading — shown next to each historical table's header.
function HeatLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
      <span>Best</span>
      <div className="w-16 h-2 rounded-full" style={{ background: `linear-gradient(to right, rgb(${HEAT_GREEN.join(',')}), rgb(${HEAT_YELLOW.join(',')}), rgb(${HEAT_RED.join(',')}))` }} />
      <span>Worst</span>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TabBar<T extends string>({
  tabs, active, onChange, small,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
  small?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:gap-1">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3.5 py-2.5 sm:px-3 sm:py-1.5 rounded-md font-medium transition-colors ${
            small ? 'text-xs' : 'text-sm'
          } ${
            active === t.id
              ? 'bg-indigo-600 text-white'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 active:bg-slate-100'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Single KPI cell — ratio or CPO value with supporting stats
function KpiCell({
  metrics,
  section,
  showGM,
  showBonus = false,
  dept,
  colorClassOverride,
  heatShaded = false,
}: {
  metrics:  KpiMetrics;
  section:  KpiSection;
  showGM:   boolean;
  showBonus?: boolean;
  dept:     KpiDept;
  colorClassOverride?: string;
  heatShaded?: boolean; // cell sits on a heatmap background — darken the muted/accent text that's tuned for a white cell
}) {
  if (!metrics.hasData) {
    return <span className="text-slate-300 text-sm">—</span>;
  }

  if (section === 'ratio') {
    const val = metrics.ratio;
    return (
      <div className="space-y-0.5">
        <div className={`text-lg font-semibold tabular-nums ${colorClassOverride ?? (val == null ? 'text-slate-300' : 'text-slate-800')}`}>
          {fmtRatio(val)}
        </div>
        {val != null && (
          <div className={`text-xs tabular-nums ${heatShaded ? 'text-slate-800' : 'text-slate-400'}`}>
            {fmtHours(metrics.ratioHours)}h / {fmtUnits(metrics.ratioProduction)} {DEPT_PRODUCTION_UNIT[dept]}
          </div>
        )}
      </div>
    );
  }

  // CPO section — deliberately no fallback chain: with showGM=true, a
  // per-dept cell shows "—" regardless of showBonus, since GM cost still has
  // no department attribution (only Combined gets the fully-blended value).
  // Falling back to bonus-only would misleadingly imply GM was included.
  const cpoVal = getCpoValue(metrics, showGM, showBonus);
  // Only meaningful in bonus-aware mode: the bonus's own contribution to
  // CPO ($/unit, not a raw dollar total that says nothing about scale), and
  // what % that added on top of the non-bonus CPO. Derived as the literal
  // difference between the shown CPO and its no-bonus counterpart (holding
  // GM constant) rather than re-derived from bonusCost/production — for a
  // single dept those are the same number, but Combined's CPO is a sum of
  // each dept's own $/unit (see combined.cpo in the API route), not
  // combinedBonusCost/combinedProduction, so re-deriving it that way
  // silently mixes frames+bouquets+orders into one denominator and
  // understates the real per-unit bonus impact.
  const cpoBase = showGM ? metrics.cpoWithGM : metrics.cpo;
  const bonusPerOrder = showBonus && cpoVal != null && cpoBase != null
    ? cpoVal - cpoBase
    : null;
  const bonusPct = showBonus && bonusPerOrder != null && cpoBase != null && cpoBase > 0
    ? (bonusPerOrder / cpoBase) * 100
    : null;
  // Ties bonus payout to actual performance that same month — a department
  // that got bonus $ while below its baseline (Specialist) tier is worth a
  // second look at how the bonus goal was set.
  const tier = showBonus ? classifyTier(dept, metrics.ratio) : null;
  // On the heat backgrounds, slate-400/amber-600 (tuned for a white cell)
  // fall to ~1-2:1 contrast — nearly invisible. slate-800 stays 5-10:1
  // across green/yellow/red, so secondary lines switch to it too instead of
  // white, which would actually make the bold CPO number itself worse
  // (white on the yellow midpoint is ~1.4:1).
  return (
    <div className="space-y-0.5">
      <div className={`text-lg font-semibold tabular-nums ${
        cpoVal == null ? 'text-slate-300' : 'text-slate-800'
      }`}>
        {fmtCPO(cpoVal)}
      </div>
      {cpoVal != null && dept !== 'ga' && (
        <div className={`text-xs tabular-nums ${heatShaded ? 'text-slate-800' : 'text-slate-400'}`}>
          {fmtCPO(metrics.laborCost)} / {fmtUnits(metrics.production)} {DEPT_PRODUCTION_UNIT[dept]}
        </div>
      )}
      {cpoVal != null && dept === 'ga' && (
        <div className={`text-xs tabular-nums ${heatShaded ? 'text-slate-800' : 'text-slate-400'}`}>
          {fmtCPO(metrics.laborCost)} total cost
        </div>
      )}
      {showBonus && metrics.bonusCost > 0 && (
        <div className={`text-xs tabular-nums font-medium ${heatShaded ? 'text-amber-950' : 'text-amber-600'}`}>
          {bonusPerOrder != null
            ? `+${fmtCPO(bonusPerOrder)}/${SINGULAR_UNIT[dept]}`
            : `+${fmtCPO(metrics.bonusCost)}`} bonus{bonusPct != null ? ` (+${bonusPct.toFixed(1)}% of cost)` : ''}
        </div>
      )}
      {tier && (
        <div className={`text-xs font-medium ${heatShaded ? 'text-slate-800' : tier.colorClass}`}>
          {tier.label} tier · {tier.aboveGoal ? 'at/above goal' : 'below goal'}
        </div>
      )}
    </div>
  );
}

// A single row in a historical table
function HistoricalRow({
  window: w,
  section,
  location,
  depts,
  showGM,
  showBonus = false,
  columnStats,
}: {
  window:   WindowResult;
  section:  KpiSection;
  location: KpiLocation;
  depts:    KpiDept[];
  showGM:   boolean;
  showBonus?: boolean;
  columnStats?: Partial<Record<KpiDept, HeatColumnStats>>;
}) {
  const period = selectLocation(w, location);
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="py-3 px-4 text-sm text-slate-600 font-medium whitespace-nowrap">{w.label}</td>
      {depts.map(dept => {
        if (!showResin(location, dept)) {
          return <td key={dept} className="py-3 px-4 text-xs text-slate-300 text-center">Utah only</td>;
        }
        const metrics = selectDept(period, dept);
        const heatBg = heatBackground(getSectionValue(metrics, section, showGM, showBonus), columnStats?.[dept]);
        return (
          <td key={dept} className="py-3 px-4" style={heatBg ? { backgroundColor: heatBg } : undefined}>
            <KpiCell
              metrics={metrics}
              section={section}
              showGM={showGM}
              showBonus={showBonus}
              heatShaded={heatBg != null}
              dept={dept}
            />
          </td>
        );
      })}
    </tr>
  );
}

// Rolling window card (MTD / QTD / YTD) — single big number per dept
function RollingCard({
  window: w,
  section,
  location,
  depts,
  showGM,
}: {
  window:   WindowResult;
  section:  KpiSection;
  location: KpiLocation;
  depts:    KpiDept[];
  showGM:   boolean;
}) {
  const period = selectLocation(w, location);
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-4">{w.label}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {depts.map(dept => {
          if (!showResin(location, dept)) return null;
          const metrics = selectDept(period, dept);
          return (
            <div key={dept} className="space-y-1">
              <div className="text-xs text-slate-500 font-medium">{DEPT_LABELS[dept]}</div>
              <KpiCell metrics={metrics} section={section} showGM={showGM} dept={dept} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Maps a ratio-section dept to its RATIO_TARGETS key. Combined (and, in the
// CPO section, G&A) has no single tier target of its own, so it's left out
// of this map — those cells just render uncolored.
const RATIO_TIER_DEPT: Partial<Record<KpiDept, RatioDept>> = {
  design:       'Design',
  preservation: 'Preservation',
  fulfillment:  'Fulfillment',
};

interface TierResult {
  label:      string;
  aboveGoal:  boolean;   // "goal" = at least Specialist (the baseline every roster tier is expected to clear)
  colorClass: string;
}

// Classifies a department's actual ratio into the same Master/Senior/
// Specialist tiers used for individual roster targets (RATIO_TARGETS) —
// used both for coloring (tierColorClass) and, on the Monthly CPO view, to
// surface whether a department that got a bonus that month was actually
// performing at or above its baseline (Specialist) tier.
function classifyTier(dept: KpiDept, ratio: number | null): TierResult | null {
  const key = RATIO_TIER_DEPT[dept];
  if (!key || ratio == null) return null;
  const t = RATIO_TARGETS[key];
  if (ratio <= t.master)     return { label: 'Master',             aboveGoal: true,  colorClass: 'text-green-700' };
  if (ratio <= t.senior)     return { label: 'Senior',             aboveGoal: true,  colorClass: 'text-amber-600' };
  if (ratio <= t.specialist) return { label: 'Specialist',         aboveGoal: true,  colorClass: 'text-slate-600' };
  return                            { label: 'Below Specialist',   aboveGoal: false, colorClass: 'text-red-600'  };
}

function tierColorClass(dept: KpiDept, ratio: number | null): string | undefined {
  return classifyTier(dept, ratio)?.colorClass;
}

const EXPECTATION_DEPTS: Record<KpiSection, KpiDept[]> = {
  ratio: ['design', 'preservation', 'fulfillment', 'combined'],
  cpo:   ['design', 'preservation', 'fulfillment', 'ga', 'combined'],
};

const EXPECTATION_ROWS: { key: RatioVariant; label: string; dotClass: string }[] = [
  { key: 'goal',     label: 'Goal',      dotClass: 'bg-green-400'  },
  { key: 'expected', label: 'Expected',  dotClass: 'bg-amber-400'  },
  { key: 'estimate', label: 'Estimated', dotClass: 'bg-indigo-400' },
];

// Goal / Expected / Estimated comparison table for the est-current / est-next
// tabs — covers both Ratio (role-tier target ratio) and CPO (role-average
// pay rate) sections, reusing KpiCell for value/substat formatting so both
// stay in sync with the regular historical views.
function ExpectationTable({
  result,
  location,
  section,
  showGM,
}: {
  result:   EstimatedMonthResult;
  location: KpiLocation;
  section:  KpiSection;
  showGM:   boolean;
}) {
  const depts = EXPECTATION_DEPTS[section];
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{result.label}</div>
        {result.isSnapshot
          ? <span className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">Locked snapshot</span>
          : <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full">Live estimate</span>
        }
        {section === 'ratio' && (
          <div className="flex gap-3 sm:ml-auto text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-green-700 inline-block" />
              Master tier
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
              Senior tier
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-500 inline-block" />
              Specialist tier
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block" />
              Above specialist
            </span>
          </div>
        )}
      </div>
      <div className="sm:hidden flex items-center gap-1 text-[10px] text-slate-400 px-4 pt-2 pb-1.5">
        <span>Swipe to see more</span>
        <span aria-hidden>→</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left text-xs font-medium text-slate-500 min-w-[110px]">Metric</th>
              {depts.map(dept => (
                <th key={dept} className="px-4 py-2 text-left text-xs font-medium text-slate-500 min-w-[130px] whitespace-nowrap">
                  {DEPT_LABELS[dept]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EXPECTATION_ROWS.map(row => {
              const period = selectEstimated(result, location, row.key);
              return (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="sticky left-0 bg-white px-4 py-3 text-sm font-medium text-slate-600 whitespace-nowrap">
                    <span className={`w-2 h-2 rounded-full inline-block mr-1.5 ${row.dotClass}`} />
                    {row.label}
                  </td>
                  {depts.map(dept => {
                    const metrics = period ? selectDept(period, dept) : null;
                    if (!metrics) return <td key={dept} className="px-4 py-3 text-sm text-slate-300">—</td>;
                    const colorClassOverride = section === 'ratio' && row.key === 'estimate' ? tierColorClass(dept, metrics.ratio) : undefined;
                    return (
                      <td key={dept} className="px-4 py-3">
                        <KpiCell metrics={metrics} section={section} showGM={showGM} dept={dept} colorClassOverride={colorClassOverride} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {section === 'ratio' && (
        <div className="px-5 py-2 bg-slate-50/50 border-t border-slate-100 text-[10px] text-slate-400 space-y-0.5">
          <p>Colors on the Estimated row show which tier that department&apos;s projected ratio falls into (same bands as the Scorecards tab — exact hrs/unit vary by department, Combined has no single band so it&apos;s left uncolored).</p>
          <p>G&amp;A cost has no per-tier target — not shown here. See the CPO tab for its trailing average (from {result.gaSourceMonths.join(', ')}).</p>
        </div>
      )}
      {section === 'cpo' && result.gaSourceMonths.length > 0 && (
        <div className="px-5 py-2 bg-slate-50/50 border-t border-slate-100 text-[10px] text-slate-400">
          G&amp;A cost is a trailing 3-month actual average (from {result.gaSourceMonths.join(', ')}) — identical across Goal/Expected/Estimated; only its share of the growing production base shifts.
        </div>
      )}
    </div>
  );
}

// Historical table with dept columns
function HistoricalTable({
  windows,
  section,
  location,
  depts,
  showGM,
  showBonus = false,
}: {
  windows:  WindowResult[];
  section:  KpiSection;
  location: KpiLocation;
  depts:    KpiDept[];
  showGM:   boolean;
  showBonus?: boolean;
}) {
  if (windows.length === 0) {
    return <div className="text-sm text-slate-400 py-8 text-center">No data for this period</div>;
  }
  const columnStats = computeColumnStats(windows, location, depts, section, showGM, showBonus);
  return (
    <div>
      <div className="sm:hidden flex items-center gap-1 text-[10px] text-slate-400 px-4 pt-2 pb-1.5">
        <span>Swipe to see more</span>
        <span aria-hidden>→</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="py-3 px-4 text-xs font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Period</th>
              {depts.map(dept => (
                <th key={dept} className="py-3 px-4 text-xs font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">
                  {DEPT_LABELS[dept]}
                  {dept === 'resin' && location !== 'Utah' ? ' (Utah only)' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...windows].reverse().map(w => (
              <HistoricalRow
                key={`${w.periodStart}-${w.periodEnd}`}
                window={w}
                section={section}
                location={location}
                depts={depts}
                showGM={showGM}
                showBonus={showBonus}
                columnStats={columnStats}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AllKpisPage() {
  const { windows, estimated, loading, error, refresh } = useKpiMetrics();

  const [location,   setLocation]   = useState<KpiLocation>('Utah');
  const [section,    setSection]    = useState<KpiSection>('ratio');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('mtd');
  const [showGM,     setShowGM]     = useState(false);
  const [showBonus,  setShowBonus]  = useState(false);

  const depts = section === 'ratio' ? RATIO_DEPTS : CPO_DEPTS;

  const weeklyWindows    = useMemo(() => getWindowsByType(windows, 'weekly'),    [windows]);
  const monthlyWindows   = useMemo(() => getWindowsByType(windows, 'monthly'),   [windows]);
  const quarterlyWindows = useMemo(() => getWindowsByType(windows, 'quarterly'), [windows]);
  const mtdWindows       = useMemo(() => getWindowsByType(windows, 'mtd'),       [windows]);
  const qtdWindows       = useMemo(() => getWindowsByType(windows, 'qtd'),       [windows]);
  const ytdWindows       = useMemo(() => getWindowsByType(windows, 'ytd'),       [windows]);

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">All KPIs</h2>
          <p className="text-sm text-slate-500 mt-0.5">Ratio and CPO across all departments and locations</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 px-3 py-1.5 rounded-md bg-white hover:bg-slate-50 transition-colors disabled:opacity-40"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {/* ── Controls row ── */}
      <div className="flex flex-wrap gap-4 items-start">
        {/* Location */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Location</div>
          <TabBar tabs={LOCATIONS} active={location} onChange={setLocation} small />
        </div>

        {/* Section */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Metric</div>
          <TabBar
            tabs={[
              { id: 'ratio' as KpiSection, label: 'Ratio' },
              { id: 'cpo'   as KpiSection, label: 'CPO'   },
            ]}
            active={section}
            onChange={setSection}
            small
          />
        </div>

        {/* Time window */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Time window</div>
          <TabBar tabs={TIME_WINDOWS} active={timeWindow} onChange={setTimeWindow} small />
        </div>

        {/* GM toggle — CPO only */}
        {section === 'cpo' && (
          <div className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">GM cost</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowGM(false)}
                className={`text-xs px-3.5 py-2.5 sm:px-3 sm:py-1.5 rounded-md border font-medium transition-colors ${
                  !showGM ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 active:bg-slate-100'
                }`}
              >
                Excl. GM
              </button>
              <button
                onClick={() => setShowGM(true)}
                className={`text-xs px-3.5 py-2.5 sm:px-3 sm:py-1.5 rounded-md border font-medium transition-colors ${
                  showGM ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 active:bg-slate-100'
                }`}
              >
                Incl. GM
              </button>
            </div>
          </div>
        )}

        {/* Bonus toggle — CPO + Monthly only, since bonus data always lags
            the month it was earned by 3-4 weeks and is only meaningful once
            a month has fully closed. */}
        {section === 'cpo' && timeWindow === 'monthly' && (
          <div className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Bonus cost</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowBonus(false)}
                className={`text-xs px-3.5 py-2.5 sm:px-3 sm:py-1.5 rounded-md border font-medium transition-colors ${
                  !showBonus ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 active:bg-slate-100'
                }`}
              >
                Excl. Bonus
              </button>
              <button
                onClick={() => setShowBonus(true)}
                className={`text-xs px-3.5 py-2.5 sm:px-3 sm:py-1.5 rounded-md border font-medium transition-colors ${
                  showBonus ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50 active:bg-slate-100'
                }`}
              >
                Incl. Bonus
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Dept column legend ── */}
      <div className="flex flex-wrap gap-3">
        {depts.map(dept => {
          if (!showResin(location, dept)) return null;
          return (
            <div key={dept} className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-indigo-400" />
              <span className="text-xs text-slate-500">
                {DEPT_LABELS[dept]}
                {dept !== 'ga' && dept !== 'combined' && (
                  <span className="text-slate-300 ml-1">({DEPT_PRODUCTION_UNIT[dept]})</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── Content area ── */}
      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">

          {/* MTD */}
          {timeWindow === 'mtd' && mtdWindows.map(w => (
            <RollingCard key={w.label} window={w} section={section} location={location} depts={depts} showGM={showGM} />
          ))}

          {/* QTD */}
          {timeWindow === 'qtd' && qtdWindows.map(w => (
            <RollingCard key={w.label} window={w} section={section} location={location} depts={depts} showGM={showGM} />
          ))}

          {/* YTD */}
          {timeWindow === 'ytd' && ytdWindows.map(w => (
            <RollingCard key={w.label} window={w} section={section} location={location} depts={depts} showGM={showGM} />
          ))}

          {/* Weekly historical table */}
          {timeWindow === 'weekly' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-medium text-slate-700">Weekly — {weeklyWindows.length} weeks</div>
                <HeatLegend />
              </div>
              <HistoricalTable windows={weeklyWindows} section={section} location={location} depts={depts} showGM={showGM} />
            </div>
          )}

          {/* Monthly historical table */}
          {timeWindow === 'monthly' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-medium text-slate-700">Monthly — {monthlyWindows.length} months</div>
                <HeatLegend />
              </div>
              <HistoricalTable windows={monthlyWindows} section={section} location={location} depts={depts} showGM={showGM} showBonus={showBonus} />
            </div>
          )}

          {/* Quarterly historical table */}
          {timeWindow === 'quarterly' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-medium text-slate-700">Quarterly — {quarterlyWindows.length} quarters</div>
                <HeatLegend />
              </div>
              <HistoricalTable windows={quarterlyWindows} section={section} location={location} depts={depts} showGM={showGM} />
            </div>
          )}

          {/* Estimated current month */}
          {timeWindow === 'est-current' && (
            estimated?.current
              ? <ExpectationTable result={estimated.current} location={location} section={section} showGM={showGM} />
              : <div className="text-sm text-slate-400 py-8 text-center bg-white border border-slate-200 rounded-xl">
                  No estimate available — check that schedule settings are configured
                </div>
          )}

          {/* Estimated next month */}
          {timeWindow === 'est-next' && (
            estimated?.next
              ? <ExpectationTable result={estimated.next} location={location} section={section} showGM={showGM} />
              : <div className="text-sm text-slate-400 py-8 text-center bg-white border border-slate-200 rounded-xl">
                  No estimate available — check that schedule settings are configured
                </div>
          )}

        </div>
      )}

      {/* ── Formula footnote ── */}
      <div className="text-xs text-slate-400 border-t border-slate-100 pt-4 space-y-1">
        {section === 'ratio' && (
          <>
            <p><strong>Ratio</strong> = hours worked ÷ production completed. Lower is more efficient.</p>
            <p><strong>Combined ratio</strong> = Design ratio + Preservation ratio + Fulfillment ratio (additive, not averaged).</p>
            <p>Resin ratio = resin hours ÷ resin production. Utah only.</p>
            {(timeWindow === 'est-current' || timeWindow === 'est-next') && (
              <>
                <p><strong>Estimated</strong> = each team member&apos;s own roster ratio × their scheduled hours for the month.</p>
                <p><strong>Expected</strong> = each member&apos;s role-tier target ratio (Master/Senior/Specialist) × their scheduled hours — ignores their personal roster ratio.</p>
                <p><strong>Goal</strong> = the stricter (lower) of a member&apos;s roster ratio and their tier target, per member.</p>
              </>
            )}
          </>
        )}
        {section === 'cpo' && (
          <>
            <p><strong>CPO</strong> = total labor cost ÷ production. Includes manager pay. Excludes GM unless &quot;Incl. GM&quot; is selected.</p>
            <p><strong>Combined CPO</strong> = Design CPO + Preservation CPO + Fulfillment CPO + (G&A cost ÷ total production).</p>
            <p>Salary manager costs are computed at annual salary ÷ 52 weeks and split across their departments.</p>
            {timeWindow === 'monthly' && (
              <>
                <p><strong>Incl. Bonus</strong> adds each department&apos;s monthly performance bonuses (paid ~3-4 weeks after month-end) into that month&apos;s labor cost — only available on the Monthly view, since bonus data always lags the month it was earned. Bonus rows whose employee couldn&apos;t be matched to the Employee Directory are excluded from department totals until reconciled.</p>
                <p>With <strong>Incl. Bonus</strong> on, each dept cell also shows what the bonus itself added to CPO (per frame/bouquet/order) and what % that was on top of that month&apos;s non-bonus labor cost, plus the tier (Master/Senior/Specialist/Below Specialist) that department&apos;s actual ratio hit that month — a bonus paid out in a month a department was below its Specialist baseline is worth a second look at how that bonus was calculated.</p>
              </>
            )}
            {(timeWindow === 'est-current' || timeWindow === 'est-next') && (
              <>
                <p>Cost is always each team member&apos;s real pay (rate or salary) × their scheduled hours — the same across all three tiers below. Only the ratio used for production changes.</p>
                <p><strong>Estimated</strong> = production at each team member&apos;s own roster ratio.</p>
                <p><strong>Expected</strong> = production at the official ratio target for that role/department/location — ignores this specific person&apos;s own ratio.</p>
                <p><strong>Goal</strong> = production at whichever is lower: their own roster ratio, or their role&apos;s tier ratio.</p>
                <p>Ratio targets are a fixed table per location + department + role (e.g. Utah Design senior vs Utah Fulfillment senior differ), since production efficiency varies by all three, not just role.</p>
              </>
            )}
          </>
        )}
      </div>

    </div>
  );
}
