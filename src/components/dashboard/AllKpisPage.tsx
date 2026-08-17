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
  dept,
  colorClassOverride,
}: {
  metrics:  KpiMetrics;
  section:  KpiSection;
  showGM:   boolean;
  dept:     KpiDept;
  colorClassOverride?: string;
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
          <div className="text-xs text-slate-400 tabular-nums">
            {fmtHours(metrics.ratioHours)}h / {fmtUnits(metrics.ratioProduction)} {DEPT_PRODUCTION_UNIT[dept]}
          </div>
        )}
      </div>
    );
  }

  // CPO section
  const cpoVal = showGM ? metrics.cpoWithGM : metrics.cpo;
  return (
    <div className="space-y-0.5">
      <div className={`text-lg font-semibold tabular-nums ${cpoVal == null ? 'text-slate-300' : 'text-slate-800'}`}>
        {fmtCPO(cpoVal)}
      </div>
      {cpoVal != null && dept !== 'ga' && (
        <div className="text-xs text-slate-400 tabular-nums">
          {fmtCPO(metrics.laborCost)} / {fmtUnits(metrics.production)} {DEPT_PRODUCTION_UNIT[dept]}
        </div>
      )}
      {cpoVal != null && dept === 'ga' && (
        <div className="text-xs text-slate-400 tabular-nums">
          {fmtCPO(metrics.laborCost)} total cost
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
}: {
  window:   WindowResult;
  section:  KpiSection;
  location: KpiLocation;
  depts:    KpiDept[];
  showGM:   boolean;
}) {
  const period = selectLocation(w, location);
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="py-3 px-4 text-sm text-slate-600 font-medium whitespace-nowrap">{w.label}</td>
      {depts.map(dept => {
        if (!showResin(location, dept)) {
          return <td key={dept} className="py-3 px-4 text-xs text-slate-300 text-center">Utah only</td>;
        }
        return (
          <td key={dept} className="py-3 px-4">
            <KpiCell
              metrics={selectDept(period, dept)}
              section={section}
              showGM={showGM}
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

function tierColorClass(dept: KpiDept, ratio: number | null): string | undefined {
  const key = RATIO_TIER_DEPT[dept];
  if (!key || ratio == null) return undefined;
  const t = RATIO_TARGETS[key];
  if (ratio <= t.master)     return 'text-green-700';
  if (ratio <= t.senior)     return 'text-amber-600';
  if (ratio <= t.specialist) return 'text-slate-600';
  return 'text-red-600';
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
}: {
  windows:  WindowResult[];
  section:  KpiSection;
  location: KpiLocation;
  depts:    KpiDept[];
  showGM:   boolean;
}) {
  if (windows.length === 0) {
    return <div className="text-sm text-slate-400 py-8 text-center">No data for this period</div>;
  }
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
              <div className="px-5 py-4 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">Weekly — {weeklyWindows.length} weeks</div>
              </div>
              <HistoricalTable windows={weeklyWindows} section={section} location={location} depts={depts} showGM={showGM} />
            </div>
          )}

          {/* Monthly historical table */}
          {timeWindow === 'monthly' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">Monthly — {monthlyWindows.length} months</div>
              </div>
              <HistoricalTable windows={monthlyWindows} section={section} location={location} depts={depts} showGM={showGM} />
            </div>
          )}

          {/* Quarterly historical table */}
          {timeWindow === 'quarterly' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">Quarterly — {quarterlyWindows.length} quarters</div>
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
            {(timeWindow === 'est-current' || timeWindow === 'est-next') && (
              <>
                <p><strong>Estimated</strong> = each team member&apos;s own actual pay rate × their scheduled hours, over production at their own roster ratio.</p>
                <p><strong>Expected</strong> = the official wage target for that role/department/location × scheduled hours, over production at the role-tier ratio — ignores this specific person&apos;s actual rate. Managers use their real pay instead, since management pay isn&apos;t on the Specialist/Senior/Master scale.</p>
                <p><strong>Goal</strong> = the cheaper of a member&apos;s actual rate and their role&apos;s wage target, over production at the stricter (lower) ratio. Managers always use actual pay.</p>
                <p>Wage targets are a fixed table per location + department + role (e.g. Utah Design senior vs Utah Fulfillment senior differ) since pay varies by all three, not just role.</p>
              </>
            )}
          </>
        )}
      </div>

    </div>
  );
}
