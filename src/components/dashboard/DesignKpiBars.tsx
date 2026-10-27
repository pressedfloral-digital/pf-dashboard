'use client';

import {
  getWindowsByType, selectLocation, selectDept, selectEstimated, selectPlanned,
  fmtRatio, fmtCPO, fmtUnits,
  type KpiLocation, type KpiState,
} from '@/hooks/useKpiMetrics';
import { getWeekMondays } from '@/lib/weekDates';

// First month whose missed frame goal can roll forward. Months before this
// never carry anything, so an old shortfall from before the rollover rule
// existed can't snowball into today's goal.
export const FRAME_ROLLOVER_START = '2026-09-01';

type Status = 'green' | 'yellow' | 'red' | 'none';

const STATUS_STYLE: Record<Status, { bar: string; text: string; chip: string; label: string }> = {
  green:  { bar: 'bg-green-500', text: 'text-green-600', chip: 'bg-green-50 text-green-700',  label: 'On goal' },
  yellow: { bar: 'bg-amber-400', text: 'text-amber-600', chip: 'bg-amber-50 text-amber-700',  label: 'Watch' },
  red:    { bar: 'bg-red-500',   text: 'text-red-600',   chip: 'bg-red-50 text-red-700',      label: 'Off pace' },
  none:   { bar: 'bg-slate-300', text: 'text-slate-500', chip: 'bg-slate-100 text-slate-500', label: 'No data' },
};

// Ratio and CPO are both "lower is better": at/under Goal is green, between
// Goal and Expected is yellow, worse than Expected is red. Compared at 2
// decimals (what's displayed) so "1.29 vs Goal 1.29" never reads as a miss.
function lowerIsBetterStatus(actual: number | null, goal: number | null, expected: number | null): Status {
  if (actual == null || (goal == null && expected == null)) return 'none';
  const r = (n: number) => Math.round(n * 100);
  const g = r(goal ?? expected!);
  const e = Math.max(r(expected ?? goal!), g);
  if (r(actual) <= g) return 'green';
  if (r(actual) <= e) return 'yellow';
  return 'red';
}

function Tick({ pct, label, color }: { pct: number; label: string; color: string }) {
  return (
    <div className="absolute inset-y-0 pointer-events-none" style={{ left: `${pct}%` }} title={label}>
      <div className={`absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded ${color}`} />
    </div>
  );
}

function MetricPaceBar({ label, actual, goal, expected, fmt }: {
  label:    string;
  actual:   number | null;
  goal:     number | null;
  expected: number | null;
  fmt:      (n: number | null) => string;
}) {
  const status = lowerIsBetterStatus(actual, goal, expected);
  const s = STATUS_STYLE[status];
  const max = Math.max(actual ?? 0, goal ?? 0, expected ?? 0) * 1.2 || 1;
  const pct = (n: number) => Math.min(100, (n / max) * 100);

  return (
    <div className="flex-1 min-w-[220px]">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label} · month to date</span>
        <span className={`text-[10px] font-semibold rounded px-1.5 py-px ${s.chip}`}>{s.label}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-lg font-semibold tabular-nums ${s.text}`}>{fmt(actual)}</span>
        <div className="relative flex-1 h-2.5 bg-slate-100 rounded-full">
          {actual != null && (
            <div className={`absolute inset-y-0 left-0 rounded-full ${s.bar}`} style={{ width: `${pct(actual)}%` }} />
          )}
          {goal != null && <Tick pct={pct(goal)} label={`Goal ${fmt(goal)}`} color="bg-green-700" />}
          {expected != null && <Tick pct={pct(expected)} label={`Expected ${fmt(expected)}`} color="bg-amber-600" />}
        </div>
      </div>
      <div className="flex gap-3 mt-1 text-[10px] text-slate-400">
        <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-green-700 mr-1 align-middle" />Goal {fmt(goal)}</span>
        <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-600 mr-1 align-middle" />Expected {fmt(expected)}</span>
      </div>
    </div>
  );
}

// Share of the month's working days (Mon–Fri of every week whose Monday
// falls in the month — the same weeks /api/kpis counts toward MTD and the
// month's goal) that have started by today.
function monthElapsedFraction(monthStart: string, today: Date): number {
  const end = new Date(monthStart + 'T12:00:00');
  end.setMonth(end.getMonth() + 1);
  end.setDate(0);
  const mondays = getWeekMondays(monthStart, end.toISOString().slice(0, 10));
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let total = 0, elapsed = 0;
  for (const m of mondays) {
    const d = new Date(m + 'T12:00:00');
    for (let i = 0; i < 5; i++) {
      const iso = d.toISOString().slice(0, 10);
      total++;
      if (iso <= todayIso) elapsed++;
      d.setDate(d.getDate() + 1);
    }
  }
  return total > 0 ? elapsed / total : 0;
}

export interface FrameRollover {
  monthLabel: string;   // e.g. "Sep 2026"
  goal:       number;   // that month's own goal
  carriedIn:  number;   // shortfall it inherited
  actual:     number;
  carriedOut: number;   // max(0, goal + carriedIn - actual)
}

// Walk completed months oldest → newest: each month's target is its own goal
// plus whatever the previous month missed. Beating a target only clears the
// carry — a surplus never banks credit against future months.
export function computeFrameRollover(kpiState: KpiState, location: KpiLocation, startMonth = FRAME_ROLLOVER_START): FrameRollover[] {
  const months = getWindowsByType(kpiState.windows, 'monthly')
    .filter(w => w.periodStart >= startMonth)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const rows: FrameRollover[] = [];
  let carry = 0;
  for (const w of months) {
    const planned = selectPlanned(w, location, 'goal');
    const goal    = planned ? selectDept(planned, 'design').production : 0;
    const actual  = selectDept(selectLocation(w, location), 'design').production;
    const carriedOut = Math.max(0, goal + carry - actual);
    rows.push({ monthLabel: w.label, goal, carriedIn: carry, actual, carriedOut });
    carry = carriedOut;
  }
  return rows;
}

function MonthlyFrameGoalBar({ kpiState, location }: { kpiState: KpiState; location: KpiLocation }) {
  const mtdWindow  = getWindowsByType(kpiState.windows, 'mtd')[0];
  const actual     = mtdWindow ? selectDept(selectLocation(mtdWindow, location), 'design').production : 0;
  const goalPeriod = selectEstimated(kpiState.estimated?.current, location, 'goal');
  const monthGoal  = goalPeriod ? selectDept(goalPeriod, 'design').production : 0;
  const history    = computeFrameRollover(kpiState, location);
  const last       = history[history.length - 1];
  const carriedIn  = last?.carriedOut ?? 0;
  const target     = monthGoal + carriedIn;

  const monthStart = kpiState.estimated?.current?.monthStart ?? mtdWindow?.periodStart;
  const elapsed    = monthStart ? monthElapsedFraction(monthStart, new Date()) : 0;
  const paceTarget = target * elapsed;

  // Ahead of (or on) where we should be by today → green; within 10% of it →
  // yellow; further behind → red.
  const status: Status = target <= 0 ? 'none'
    : actual >= paceTarget ? 'green'
    : actual >= paceTarget * 0.9 ? 'yellow'
    : 'red';
  const s = STATUS_STYLE[status];
  const scale = Math.max(target, actual) || 1;
  const pct = (n: number) => Math.min(100, (n / scale) * 100);
  const goalPct = pct(monthGoal);
  const remaining = Math.max(0, Math.round(target - actual));
  const pacingGap = Math.round(actual - paceTarget);

  return (
    <div className="flex-1 min-w-[280px]">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Frames · {kpiState.estimated?.current?.label.replace(/^Est\.\s*/, '') ?? 'this month'} goal
        </span>
        <span className={`text-[10px] font-semibold rounded px-1.5 py-px ${s.chip}`}>
          {status === 'none' ? s.label : pacingGap >= 0 ? `${fmtUnits(pacingGap)} ahead of pace` : `${fmtUnits(-pacingGap)} behind pace`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold tabular-nums text-slate-800">
          {fmtUnits(actual)}<span className="text-xs font-normal text-slate-400"> / {fmtUnits(target)}</span>
        </span>
        <div className="relative flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
          {/* Rolled-over frames sit on top of this month's own goal */}
          {carriedIn > 0 && (
            <div className="absolute inset-y-0 bg-red-100" style={{ left: `${goalPct}%`, width: `${pct(target) - goalPct}%` }} />
          )}
          <div className={`absolute inset-y-0 left-0 rounded-full ${s.bar}`} style={{ width: `${pct(actual)}%` }} />
          {target > 0 && <Tick pct={pct(paceTarget)} label={`Pace today: ${fmtUnits(paceTarget)}`} color="bg-slate-700" />}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 mt-1 text-[10px] text-slate-400">
        <span>Goal {fmtUnits(monthGoal)}</span>
        {carriedIn > 0 && (
          <span className="text-red-500" title={history.filter(h => h.carriedOut > 0).map(h => `${h.monthLabel}: ${fmtUnits(h.actual)} of ${fmtUnits(h.goal + h.carriedIn)} → ${fmtUnits(h.carriedOut)} carried`).join('\n')}>
            + {fmtUnits(carriedIn)} rolled over from {last.monthLabel}
          </span>
        )}
        <span><span className="inline-block w-0.5 h-2 bg-slate-700 mr-1 align-middle" />Pace today {fmtUnits(paceTarget)}</span>
        <span>{fmtUnits(remaining)} to go</span>
      </div>
    </div>
  );
}

// Design tab header: month-to-date Ratio/CPO shown as red/yellow/green pace
// bars against Goal and Expected, plus frames vs. the monthly frame goal
// (with any missed frames from last month rolled in). Same useKpiMetrics data
// as the All KPIs tab.
export function DesignKpiBars({ location, kpiState, showCPO }: {
  location: KpiLocation;
  kpiState: KpiState;
  showCPO:  boolean;
}) {
  if (kpiState.loading) return null;
  const mtdWindow = getWindowsByType(kpiState.windows, 'mtd')[0];
  const actual    = mtdWindow ? selectDept(selectLocation(mtdWindow, location), 'design') : null;
  const expectedP = selectEstimated(kpiState.estimated?.current, location, 'expected');
  const goalP     = selectEstimated(kpiState.estimated?.current, location, 'goal');
  const expected  = expectedP ? selectDept(expectedP, 'design') : null;
  const goal      = goalP ? selectDept(goalP, 'design') : null;

  return (
    <div className="bg-white border border-slate-100 rounded-xl px-5 py-4">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Design · {location} · Monthly KPIs</p>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <MetricPaceBar label="Ratio" actual={actual?.ratio ?? null} goal={goal?.ratio ?? null} expected={expected?.ratio ?? null}
          fmt={n => fmtRatio(n)} />
        {showCPO && (
          <MetricPaceBar label="CPO" actual={actual?.cpo ?? null} goal={goal?.cpo ?? null} expected={expected?.cpo ?? null}
            fmt={n => fmtCPO(n)} />
        )}
        <MonthlyFrameGoalBar kpiState={kpiState} location={location} />
      </div>
    </div>
  );
}
