'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { isoMonday, getWeekLabel, getISOWeekNumber } from '@/lib/weekDates';
import {
  addDays, computeActualIntakeByWeek, computeCombinedIntakeByWeek, computeRollingMultiplier,
  EARLIEST_HISTORICAL_WEEK, type TeamActualRow,
} from '@/lib/intakeHistory';
import { useGrowthSettings } from '@/hooks/useGrowthSettings';
import { useDistributionEstimate } from '@/hooks/useDistributionEstimate';
import { useKpiMetrics, getWindowsByType, selectLocation, fmtCPO } from '@/hooks/useKpiMetrics';
import { estimateShippingCost } from '@/lib/shippingCost';

function weeksBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(toIso + 'T12:00:00').getTime() - new Date(fromIso + 'T12:00:00').getTime()) / (7 * 24 * 60 * 60 * 1000));
}

// Same forward look-ahead as Queue & Turnaround's own WEEKS constant
// (SchedulePage.tsx) — this week through 51 weeks out.
const FORWARD_WEEKS = 52;

// Weeks shown on the Company Total table: every week we have real intake
// history for (computed from EARLIEST_HISTORICAL_WEEK, not a fixed trailing
// window, so "actual" data isn't cut off), through the same 52-week
// look-ahead Queue & Turnaround uses.
function buildWeekOffsets(): number[] {
  const start = -weeksBetween(EARLIEST_HISTORICAL_WEEK, isoMonday(0));
  const end = FORWARD_WEEKS - 1;
  return Array.from({ length: end - start + 1 }, (_, i) => i + start);
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}
function fmtPct(n: number | undefined | null, decimals = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return `${n.toFixed(decimals)}%`;
}
function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtSigned(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  const s = Math.round(n);
  return s > 0 ? `+${s}` : `${s}`;
}
function fmtMoney(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── Per-location intake fetch (team actuals + preservation actuals) ───────────
function useLocationIntake(location: 'Utah' | 'Georgia') {
  const [teamActuals, setTeamActuals] = useState<TeamActualRow[]>([]);
  const [presActuals, setPresActuals] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch(`/api/actuals?location=${location}&type=team&weeks=110`)
      .then(r => r.json())
      .then((d: { teamActuals?: TeamActualRow[] }) => setTeamActuals(d.teamActuals ?? []))
      .catch(() => {});
    fetch(`/api/actuals?location=${location}&type=preservation&weeks=110`)
      .then(r => r.json())
      .then((d: { preservationActuals?: { week_of: string; received: number }[] }) => {
        const map: Record<string, number> = {};
        (d.preservationActuals ?? []).forEach(row => { map[row.week_of] = row.received; });
        setPresActuals(map);
      })
      .catch(() => {});
  }, [location]);

  return useMemo(() => computeActualIntakeByWeek(location, teamActuals, presActuals), [location, teamActuals, presActuals]);
}

interface StateRow { state_code: string; state_name: string; location: 'Utah' | 'Georgia' }
interface PlannedMove { id: number; state_code: string; new_location: 'Utah' | 'Georgia'; effective_date: string; note: string | null; implemented_at: string | null }

export function GrowthDistributionPage() {
  const utActualByWeek = useLocationIntake('Utah');
  const gaActualByWeek = useLocationIntake('Georgia');
  const { companyMultipliers, distributionPct, setMultiplier, setDistribution } = useGrowthSettings();
  const { estimates: distributionEstimates, yearsOfHistory, getSuggestedUtPct, refresh: refreshDistributionEstimate } = useDistributionEstimate(FORWARD_WEEKS);

  // The Company Total table now spans full history through a 52-week
  // look-ahead (see buildWeekOffsets) — scroll it to THIS week by default
  // (not the scroll-max, which would land on the 51-weeks-out column) so it
  // opens on "now," while still letting you scroll either direction.
  const companyTableScrollRef = useRef<HTMLDivElement>(null);
  const currentWeekRef = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    const container = companyTableScrollRef.current;
    const cell = currentWeekRef.current;
    if (!container || !cell) return;
    const stickyEl = container.querySelector('.sticky') as HTMLElement | null;
    const stickyWidth = stickyEl?.offsetWidth ?? 160;
    const cellLeft = cell.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft;
    container.scrollLeft = Math.max(0, cellLeft - stickyWidth - 24);
  }, []);

  const combinedActualByWeek = useMemo(
    () => computeCombinedIntakeByWeek(utActualByWeek, gaActualByWeek),
    [utActualByWeek, gaActualByWeek],
  );

  const rollingCompanyMultiplier = useMemo(
    () => computeRollingMultiplier(combinedActualByWeek, isoMonday),
    [combinedActualByWeek],
  );

  const weekOffsets = useMemo(() => buildWeekOffsets(), []);

  const weeklyRows = useMemo(() => weekOffsets.map(offset => {
    const weekOf = isoMonday(offset);
    const lastYearIso = addDays(weekOf, -364);
    const utLastYear = utActualByWeek[lastYearIso];
    const gaLastYear = gaActualByWeek[lastYearIso];
    const lastYear = (utLastYear !== undefined || gaLastYear !== undefined)
      ? (utLastYear ?? 0) + (gaLastYear ?? 0) : undefined;

    const multiplier = companyMultipliers[weekOf] ?? rollingCompanyMultiplier;
    const estimatedReceived = lastYear !== undefined ? Math.round(lastYear * multiplier) : undefined;

    const utActual = utActualByWeek[weekOf];
    const gaActual = gaActualByWeek[weekOf];
    const actualReceived = (utActual !== undefined || gaActual !== undefined) ? (utActual ?? 0) + (gaActual ?? 0) : undefined;
    const variance = (actualReceived !== undefined && estimatedReceived !== undefined) ? actualReceived - estimatedReceived : undefined;
    const actualMultiplier = (actualReceived !== undefined && lastYear !== undefined && lastYear > 0) ? actualReceived / lastYear : undefined;

    const utPctOverride = distributionPct[weekOf]?.ut;
    const utPct = utPctOverride ?? getSuggestedUtPct(weekOf);
    const gaPct = 100 - utPct;
    const utPctIsSuggested = utPctOverride === undefined && (distributionEstimates[weekOf]?.hasSeasonalData ?? false);
    const utEstimated = estimatedReceived !== undefined ? Math.round(estimatedReceived * utPct / 100) : undefined;
    const gaEstimated = estimatedReceived !== undefined && utEstimated !== undefined ? estimatedReceived - utEstimated : undefined;
    const utVariance = (utActual !== undefined && utEstimated !== undefined) ? utActual - utEstimated : undefined;
    const gaVariance = (gaActual !== undefined && gaEstimated !== undefined) ? gaActual - gaEstimated : undefined;
    const actualUtPct = (utActual !== undefined && gaActual !== undefined && (utActual + gaActual) > 0)
      ? (utActual / (utActual + gaActual)) * 100 : undefined;
    const actualGaPct = actualUtPct !== undefined ? 100 - actualUtPct : undefined;

    return {
      weekOf, lastYear, multiplier, estimatedReceived, actualReceived, variance, actualMultiplier,
      utPct, gaPct, utPctIsSuggested, utActual, gaActual, utEstimated, gaEstimated, utVariance, gaVariance, actualUtPct, actualGaPct,
      isFuture: actualReceived === undefined,
    };
  }), [weekOffsets, utActualByWeek, gaActualByWeek, companyMultipliers, distributionPct, rollingCompanyMultiplier, distributionEstimates]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── State routing ────────────────────────────────────────────────────────
  const [states, setStates] = useState<StateRow[]>([]);
  const [statesLoading, setStatesLoading] = useState(true);
  useEffect(() => {
    fetch('/api/state-routing')
      .then(r => r.json())
      .then((d: { states?: StateRow[] }) => setStates(d.states ?? []))
      .catch(() => {})
      .finally(() => setStatesLoading(false));
  }, []);

  const toggleStateLocation = useCallback((state_code: string, current: 'Utah' | 'Georgia') => {
    const next: 'Utah' | 'Georgia' = current === 'Utah' ? 'Georgia' : 'Utah';
    setStates(prev => prev.map(s => s.state_code === state_code ? { ...s, location: next } : s));
    fetch('/api/state-routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state_code, location: next }),
    }).catch(() => {});
  }, []);

  const utahStates    = states.filter(s => s.location === 'Utah');
  const georgiaStates = states.filter(s => s.location === 'Georgia');

  // ── Planned reassignments ("move X to Y starting <date>") ─────────────────
  // Only reshapes forward-looking estimates (via distribution-estimate) —
  // does NOT change a state's current location above. Making it official is
  // still the separate manual toggle in the State Routing list.
  const [plannedMoves, setPlannedMoves] = useState<PlannedMove[]>([]);
  const [movesLoading, setMovesLoading] = useState(true);
  const [newMoveState, setNewMoveState] = useState('');
  const [newMoveDate, setNewMoveDate] = useState(() => addDays(isoMonday(0), 1));
  const [addingMove, setAddingMove] = useState(false);

  const loadPlannedMoves = useCallback(() => {
    setMovesLoading(true);
    return fetch('/api/planned-state-moves')
      .then(r => r.json())
      .then((d: { moves?: PlannedMove[] }) => setPlannedMoves(d.moves ?? []))
      .catch(() => {})
      .finally(() => setMovesLoading(false));
  }, []);
  useEffect(() => { loadPlannedMoves(); }, [loadPlannedMoves]);

  const addPlannedMove = useCallback(async () => {
    if (!newMoveState || !newMoveDate) return;
    const current = states.find(s => s.state_code === newMoveState);
    if (!current) return;
    const new_location: 'Utah' | 'Georgia' = current.location === 'Utah' ? 'Georgia' : 'Utah';
    setAddingMove(true);
    try {
      await fetch('/api/planned-state-moves', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_code: newMoveState, new_location, effective_date: newMoveDate }),
      });
      setNewMoveState('');
      await Promise.all([loadPlannedMoves(), refreshDistributionEstimate()]);
    } finally {
      setAddingMove(false);
    }
  }, [newMoveState, newMoveDate, states, loadPlannedMoves, refreshDistributionEstimate]);

  const removePlannedMove = useCallback(async (id: number) => {
    setPlannedMoves(prev => prev.filter(m => m.id !== id));
    await fetch(`/api/planned-state-moves?id=${id}`, { method: 'DELETE' });
    refreshDistributionEstimate();
  }, [refreshDistributionEstimate]);

  // Confirms a plan actually happened: flips the state's current location
  // (so State Routing + Shipping & CPO Impact reflect it too, not just
  // projections) and marks the plan done.
  const [implementingId, setImplementingId] = useState<number | null>(null);
  const implementPlannedMove = useCallback(async (id: number) => {
    setImplementingId(id);
    try {
      await fetch('/api/planned-state-moves/implement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await Promise.all([
        fetch('/api/state-routing').then(r => r.json()).then((d: { states?: StateRow[] }) => setStates(d.states ?? [])),
        loadPlannedMoves(),
        refreshDistributionEstimate(),
      ]);
    } finally {
      setImplementingId(null);
    }
  }, [loadPlannedMoves, refreshDistributionEstimate]);

  const pendingMoveByState = useMemo(() => {
    const map: Record<string, PlannedMove> = {};
    plannedMoves.filter(m => !m.implemented_at).forEach(m => {
      // Keep the latest-effective pending move per state for the badge.
      if (!map[m.state_code] || m.effective_date > map[m.state_code].effective_date) map[m.state_code] = m;
    });
    return map;
  }, [plannedMoves]);

  // ── State sales (order count + revenue by shipping state, trailing 12mo) ──
  // Weights the shipping/CPO opportunity below by actual order volume — a
  // state that sends 2 orders/mo and one that sends 200/mo shouldn't look
  // like equally-sized opportunities. See src/app/api/cron/sync-state-sales.
  const [stateSales, setStateSales] = useState<Record<string, { order_count: number; revenue: number }>>({});
  const [salesMonthsWithData, setSalesMonthsWithData] = useState(0);
  useEffect(() => {
    fetch('/api/state-sales?months=12')
      .then(r => r.json())
      .then((d: { states?: Record<string, { order_count: number; revenue: number }>; monthsWithData?: number }) => {
        setStateSales(d.states ?? {});
        setSalesMonthsWithData(d.monthsWithData ?? 0);
      })
      .catch(() => {});
  }, []);

  // Current UT/GA order-volume split (trailing 12mo, from real Shopify sales
  // data — distinct from the bouquets-received split above) and what it
  // would become if one state moved, so a reassignment's effect on overall
  // distribution is visible, not just its per-order cost.
  const { totalUtahOrders, totalGaOrders } = useMemo(() => {
    let ut = 0, ga = 0;
    states.forEach(s => {
      const orders = stateSales[s.state_code]?.order_count ?? 0;
      if (s.location === 'Utah') ut += orders; else ga += orders;
    });
    return { totalUtahOrders: ut, totalGaOrders: ga };
  }, [states, stateSales]);
  const totalOrders = totalUtahOrders + totalGaOrders;
  const currentUtahSharePct = totalOrders > 0 ? (totalUtahOrders / totalOrders) * 100 : null;

  // ── CPO comparison (blended CPO incl. GM, Utah vs Georgia) ─────────────────
  // Average of the last 3 completed calendar months (same monthly CPO figures
  // All KPIs shows), not month-to-date — a single MTD/QTD snapshot is noisy
  // (a slow week can swing blended CPO a lot); averaging 3 real months
  // smooths that out while still reflecting recent cost structure, not a
  // full year. getWindowsByType(..., 'monthly') comes back oldest-first and
  // only ever includes fully-completed months (see kpis/route.ts's monthly
  // loop), so the last 3 entries are exactly that.
  // Positive cpoDeltaMoveToUtah = Georgia currently costs more per order in
  // labor than Utah, i.e. moving TO Utah saves that much per order.
  const { windows } = useKpiMetrics();
  const last3MonthWindows = getWindowsByType(windows, 'monthly').slice(-3);
  function avg3MoCPO(loc: 'Utah' | 'Georgia'): number | null {
    const vals = last3MonthWindows
      .map(w => selectLocation(w, loc).combined.cpoWithGM)
      .filter((v): v is number => v !== null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  }
  const utahCPO    = avg3MoCPO('Utah');
  const georgiaCPO = avg3MoCPO('Georgia');
  const cpoDeltaMoveToUtah = (utahCPO !== null && georgiaCPO !== null) ? georgiaCPO - utahCPO : null;

  return (
    <div className="space-y-10">

      {/* ── Company Total ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-3">Company Total &amp; Distribution</h2>
        <div ref={companyTableScrollRef} className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="text-sm border-collapse min-w-[900px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium text-slate-400 whitespace-nowrap">Week #</th>
                {weeklyRows.map(r => (
                  <th key={r.weekOf} className="px-3 py-1 text-right font-normal text-slate-400 whitespace-nowrap" title="ISO week number — a display label only; the last-year comparison below is a fixed 52-week offset, not tied to this numbering">
                    {getISOWeekNumber(r.weekOf)}
                  </th>
                ))}
              </tr>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium text-slate-500 whitespace-nowrap">Week of</th>
                {weeklyRows.map(r => (
                  <th key={r.weekOf} ref={r.weekOf === isoMonday(0) ? currentWeekRef : undefined}
                    className={`px-3 py-2 text-right font-medium whitespace-nowrap ${r.weekOf === isoMonday(0) ? 'text-indigo-600' : 'text-slate-500'}`}>
                    {fmtDate(r.weekOf)}
                    {r.weekOf === isoMonday(0) && <span className="ml-1 text-[9px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Last Year</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-600">{fmtNum(r.lastYear)}</td>)}
              </tr>
              <tr className="border-b border-slate-100 bg-amber-50/40">
                <td className="sticky left-0 bg-amber-50 px-3 py-2 font-medium text-slate-700 whitespace-nowrap">Est. Change Multiplier</td>
                {weeklyRows.map(r => (
                  <td key={r.weekOf} className="px-2 py-1.5 text-right">
                    <input
                      type="number" step="0.05" min="0" value={r.multiplier}
                      onChange={e => setMultiplier(r.weekOf, parseFloat(e.target.value) || rollingCompanyMultiplier)}
                      className="w-14 border border-slate-200 rounded px-1 py-0.5 text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300"
                      title="Company-wide growth multiplier applied to last year's same week"
                    />
                  </td>
                ))}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Estimated Received</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-600">{fmtNum(r.estimatedReceived)}</td>)}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Actual Received</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right font-medium text-indigo-600">{fmtNum(r.actualReceived)}</td>)}
              </tr>
              <tr className="border-b border-slate-200">
                <td className="sticky left-0 bg-white px-3 py-0.5 text-[10px] text-slate-400 whitespace-nowrap">Variance</td>
                {weeklyRows.map(r => (
                  <td key={r.weekOf} className={`px-3 py-0.5 text-[10px] text-right ${r.variance === undefined ? 'text-slate-300' : r.variance >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {fmtSigned(r.variance)}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-slate-200">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-400 whitespace-nowrap">Actual Change Multiplier</td>
                {weeklyRows.map(r => (
                  <td key={r.weekOf} className="px-3 py-2 text-right text-slate-400">{r.actualMultiplier !== undefined ? `×${r.actualMultiplier.toFixed(2)}` : '—'}</td>
                ))}
              </tr>

              <tr className="border-b border-indigo-100 bg-indigo-50/40">
                <td className="sticky left-0 bg-indigo-50 px-3 py-2 font-medium text-slate-700 whitespace-nowrap">Utah % Distribution</td>
                {weeklyRows.map(r => (
                  <td key={r.weekOf} className="px-2 py-1.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <input
                        type="number" step="5" min="0" max="100" value={Math.round(r.utPct * 10) / 10}
                        onChange={e => setDistribution(r.weekOf, Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)))}
                        className={`w-14 border rounded px-1 py-0.5 text-center bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${
                          r.utPctIsSuggested ? 'border-amber-200 text-amber-700 italic' : 'border-slate-200 text-slate-700'
                        }`}
                        title={r.utPctIsSuggested
                          ? 'Suggested from historical seasonality + any planned reassignment — not manually set. Type a value to override.'
                          : '% of estimated company total assumed to go to Utah'}
                      />
                      <span className="text-[10px] text-slate-400">%</span>
                    </div>
                  </td>
                ))}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-400 whitespace-nowrap">Georgia % Distribution</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-400">{fmtPct(r.gaPct)}</td>)}
              </tr>

              <tr>
                <td className="sticky left-0 bg-white px-3 py-2 pt-4 font-semibold text-blue-700 whitespace-nowrap">Utah</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 pt-4" />)}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Estimated Received</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-600">{fmtNum(r.utEstimated)}</td>)}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Actual Received</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right font-medium text-blue-600">{fmtNum(r.utActual)}</td>)}
              </tr>
              <tr className="border-b border-slate-200">
                <td className="sticky left-0 bg-white px-3 py-0.5 text-[10px] text-slate-400 whitespace-nowrap">Variance</td>
                {weeklyRows.map(r => (
                  <td key={r.weekOf} className={`px-3 py-0.5 text-[10px] text-right ${r.utVariance === undefined ? 'text-slate-300' : r.utVariance >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {fmtSigned(r.utVariance)}
                  </td>
                ))}
              </tr>

              <tr>
                <td className="sticky left-0 bg-white px-3 py-2 pt-4 font-semibold text-emerald-700 whitespace-nowrap">Georgia</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 pt-4" />)}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Estimated Received</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-600">{fmtNum(r.gaEstimated)}</td>)}
              </tr>
              <tr className="border-b border-slate-100">
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-500 whitespace-nowrap">Actual Received</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right font-medium text-emerald-600">{fmtNum(r.gaActual)}</td>)}
              </tr>
              <tr className="border-b border-slate-200">
                <td className="sticky left-0 bg-white px-3 py-0.5 text-[10px] text-slate-400 whitespace-nowrap">Variance</td>
                {weeklyRows.map(r => (
                  <td key={r.weekOf} className={`px-3 py-0.5 text-[10px] text-right ${r.gaVariance === undefined ? 'text-slate-300' : r.gaVariance >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {fmtSigned(r.gaVariance)}
                  </td>
                ))}
              </tr>

              <tr>
                <td className="sticky left-0 bg-white px-3 py-2 pt-4 font-medium text-slate-500 whitespace-nowrap">Actual Distribution</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 pt-4" />)}
              </tr>
              <tr>
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-400 whitespace-nowrap">Utah</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-400">{fmtPct(r.actualUtPct)}</td>)}
              </tr>
              <tr>
                <td className="sticky left-0 bg-white px-3 py-2 text-slate-400 whitespace-nowrap">Georgia</td>
                {weeklyRows.map(r => <td key={r.weekOf} className="px-3 py-2 text-right text-slate-400">{fmtPct(r.actualGaPct)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Week of {getWeekLabel(weekOffsets[0])} – {getWeekLabel(weekOffsets[weekOffsets.length - 1])} (full available history, scroll left for more). &quot;Estimated Received&quot; = Last Year × the growth multiplier (defaults to a rolling 4-week realized average, editable per week). Distribution % is editable per week and drives each location&apos;s estimate.
        </p>
      </div>

      {/* ── State Routing ──────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-1">State Routing</h2>
        <p className="text-xs text-slate-400 mb-3">
          Sarah&apos;s own planning record of which state currently routes to which location. Editing this here does <span className="font-medium">not</span> change live Shopify/PF order routing — it&apos;s for simulating a reassignment below.
        </p>
        {statesLoading ? <p className="text-sm text-slate-400">Loading…</p> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="border border-blue-100 rounded-lg p-3">
              <div className="text-xs font-semibold text-blue-700 mb-2">Utah ({utahStates.length} states)</div>
              <div className="flex flex-wrap gap-1.5">
                {utahStates.map(s => (
                  <button key={s.state_code} onClick={() => toggleStateLocation(s.state_code, s.location)}
                    className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-full px-2.5 py-1 transition-colors"
                    title={`Move ${s.state_name} to Georgia`}>
                    {s.state_name}
                    {pendingMoveByState[s.state_code] && (
                      <span className="ml-1 text-amber-600" title={`Planned → ${pendingMoveByState[s.state_code].new_location} on ${pendingMoveByState[s.state_code].effective_date}`}>→{pendingMoveByState[s.state_code].new_location === 'Utah' ? 'UT' : 'GA'}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="border border-emerald-100 rounded-lg p-3">
              <div className="text-xs font-semibold text-emerald-700 mb-2">Georgia ({georgiaStates.length} states)</div>
              <div className="flex flex-wrap gap-1.5">
                {georgiaStates.map(s => (
                  <button key={s.state_code} onClick={() => toggleStateLocation(s.state_code, s.location)}
                    className="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-full px-2.5 py-1 transition-colors"
                    title={`Move ${s.state_name} to Utah`}>
                    {s.state_name}
                    {pendingMoveByState[s.state_code] && (
                      <span className="ml-1 text-amber-600" title={`Planned → ${pendingMoveByState[s.state_code].new_location} on ${pendingMoveByState[s.state_code].effective_date}`}>→{pendingMoveByState[s.state_code].new_location === 'Utah' ? 'UT' : 'GA'}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Plan a Reassignment ──────────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-1">Plan a Reassignment</h2>
        <p className="text-xs text-slate-400 mb-3">
          Pick a state and a date it would start shipping from the other location. This reshapes the Company Total table&apos;s Estimated Received above for every week from that date forward (and, through the same numbers, Queue &amp; Turnaround&apos;s turnaround-time projections for each location) — using {yearsOfHistory > 0 ? `${yearsOfHistory} year${yearsOfHistory === 1 ? '' : 's'} of real Shopify seasonality (which states run heavier in which week/month of year)` : 'a flat 50/50 split until enough Shopify history is synced'} to guess that state&apos;s share, applied on top of wherever it moved to. It does <span className="font-medium">not</span> change the state&apos;s current location above — once the move is actually live, click <span className="font-medium">Mark implemented</span> below to flip the current location too and record it as done.
        </p>
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">State</label>
            <select value={newMoveState} onChange={e => setNewMoveState(e.target.value)}
              className="border border-slate-200 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
              <option value="">Select a state…</option>
              {states.slice().sort((a, b) => a.state_name.localeCompare(b.state_name)).map(s => (
                <option key={s.state_code} value={s.state_code}>{s.state_name} (currently {s.location})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Effective date</label>
            <input type="date" value={newMoveDate} onChange={e => setNewMoveDate(e.target.value)}
              className="border border-slate-200 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          </div>
          <button onClick={addPlannedMove} disabled={!newMoveState || !newMoveDate || addingMove}
            className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded transition-colors">
            {addingMove ? 'Adding…' : 'Add planned move'}
          </button>
        </div>
        {!movesLoading && plannedMoves.length > 0 && (
          <div className="space-y-1.5">
            {plannedMoves.map(m => {
              const stateName = states.find(s => s.state_code === m.state_code)?.state_name ?? m.state_code;
              const isPast = m.effective_date <= isoMonday(0);
              const isImplemented = !!m.implemented_at;
              return (
                <div key={m.id} className={`flex items-center gap-2 text-xs rounded px-2.5 py-1.5 ${
                  isImplemented ? 'bg-green-50 text-green-800' : isPast ? 'bg-slate-50 text-slate-400' : 'bg-amber-50 text-amber-800'
                }`}>
                  <span className="font-medium">{stateName}</span>
                  <span>→ {m.new_location}</span>
                  {isImplemented ? (
                    <span className="text-[10px]">✓ implemented {m.implemented_at!.slice(0, 10)} — now the current location</span>
                  ) : (
                    <>
                      <span>starting {m.effective_date}</span>
                      {isPast && <span className="text-[10px]">(in effect for projections — not yet marked implemented)</span>}
                    </>
                  )}
                  {!isImplemented && (
                    <button onClick={() => implementPlannedMove(m.id)} disabled={implementingId === m.id}
                      className="ml-auto text-[10px] bg-white border border-green-200 text-green-700 hover:bg-green-50 rounded px-2 py-0.5 disabled:opacity-50"
                      title="Confirm this move actually happened — updates the state's current location too">
                      {implementingId === m.id ? 'Implementing…' : 'Mark implemented'}
                    </button>
                  )}
                  <button onClick={() => removePlannedMove(m.id)} className={`${isImplemented ? 'ml-auto' : ''} text-slate-400 hover:text-red-500`} title="Remove this planned move">✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Shipping & CPO Impact ──────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-1">Shipping &amp; CPO Impact if Reassigned</h2>
        <p className="text-xs text-slate-400 mb-3">
          Estimated FedEx Standard Overnight cost (15lb DIM, {`your 78.44% discount`}) is a formula-based approximation, not a live rate lookup — see the code comment in <code className="text-[11px] bg-slate-100 rounded px-1">shippingCost.ts</code>. Net $/order nets that against the last 3 months&apos; average company-wide blended CPO gap (incl. GM) — currently {cpoDeltaMoveToUtah === null ? '—' : cpoDeltaMoveToUtah >= 0 ? `Utah is ${fmtCPO(cpoDeltaMoveToUtah)} cheaper per order` : `Georgia is ${fmtCPO(-cpoDeltaMoveToUtah)} cheaper per order`}, company-wide — not a state-specific figure, and it flips period to period. Order volume is real Shopify shipping-state data from {salesMonthsWithData > 0 ? `the last ${salesMonthsWithData} month${salesMonthsWithData === 1 ? '' : 's'}` : 'no data synced yet'}. Only the column for the location a state <span className="italic">isn&apos;t</span> currently at is shown — sorted by total $ opportunity (order-volume-weighted) so the biggest real, unrealized opportunities (green) are at the top; states already sitting at the cheaper location (gray) are at the bottom.
        </p>
        {totalOrders > 0 && (
          <p className="text-xs text-slate-500 mb-3">
            Current Shopify order-volume split: <span className="font-medium text-blue-700">Utah {fmtPct(currentUtahSharePct, 1)} ({fmtNum(totalUtahOrders)} orders)</span> · <span className="font-medium text-emerald-700">Georgia {fmtPct(100 - (currentUtahSharePct ?? 0), 1)} ({fmtNum(totalGaOrders)} orders)</span>
          </p>
        )}
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="text-sm border-collapse w-full">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="px-3 py-2 font-medium text-slate-500">State</th>
                <th className="px-3 py-2 font-medium text-slate-500">Currently</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Orders ({salesMonthsWithData}mo)</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Ship from UT</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Ship from GA</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Shipping Δ (UT−GA)</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Net $/order if moved to UT</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Net $/order if moved to GA</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">$ Opportunity ({salesMonthsWithData}mo)</th>
                <th className="px-3 py-2 font-medium text-slate-500 text-right">Utah share shift if moved</th>
              </tr>
            </thead>
            <tbody>
              {states
                .map(s => {
                  const ship = estimateShippingCost(s.state_code);
                  if (!ship) return null;
                  // netToUT = CPO savings from moving to Utah minus the extra shipping
                  // cost that move would add (ship.delta = UT cost − GA cost). Since
                  // there are only two locations, netToGA is exactly its negative —
                  // whatever's gained moving one way is given up moving the other.
                  const netToUT = cpoDeltaMoveToUtah !== null ? cpoDeltaMoveToUtah - ship.delta : null;
                  const netToGA = netToUT !== null ? -netToUT : null;
                  // The only number that matters for "are we leaving money on the
                  // table": the net of moving AWAY from wherever this state sits today.
                  const opportunity = s.location === 'Utah' ? netToGA : netToUT;
                  const orderCount = stateSales[s.state_code]?.order_count ?? 0;
                  const dollarOpportunity = opportunity !== null ? opportunity * orderCount : null;
                  const newUtahOrders = s.location === 'Utah' ? totalUtahOrders - orderCount : totalUtahOrders + orderCount;
                  const newUtahSharePct = totalOrders > 0 ? (newUtahOrders / totalOrders) * 100 : null;
                  const utahShareShiftPts = (newUtahSharePct !== null && currentUtahSharePct !== null) ? newUtahSharePct - currentUtahSharePct : null;
                  return { s, ship, netToUT, netToGA, opportunity, orderCount, dollarOpportunity, utahShareShiftPts };
                })
                .filter((row): row is NonNullable<typeof row> => row !== null)
                .sort((a, b) => {
                  // Primary: total $ opportunity (volume-weighted) — the number that
                  // actually answers "where are we leaving the most money on the table."
                  const av = a.dollarOpportunity ?? -Infinity;
                  const bv = b.dollarOpportunity ?? -Infinity;
                  if (bv !== av) return bv - av;
                  const apv = a.opportunity ?? -Infinity;
                  const bpv = b.opportunity ?? -Infinity;
                  return bpv !== apv ? bpv - apv : a.s.state_name.localeCompare(b.s.state_name);
                })
                .map(({ s, ship, netToUT, netToGA, opportunity, orderCount, dollarOpportunity, utahShareShiftPts }) => (
                  <tr key={s.state_code} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="px-3 py-1.5 text-slate-700">
                      {s.state_name}
                      {opportunity !== null && opportunity > 0 && (
                        <span className="ml-1.5 text-[10px] bg-green-100 text-green-700 rounded-full px-1.5 py-0.5" title="Unrealized savings opportunity">↑ opportunity</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`text-[10px] rounded-full px-2 py-0.5 ${s.location === 'Utah' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}`}>{s.location}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-600">{orderCount > 0 ? fmtNum(orderCount) : '—'}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600">{fmtMoney(ship.costUt)}</td>
                    <td className="px-3 py-1.5 text-right text-slate-600">{fmtMoney(ship.costGa)}</td>
                    <td className={`px-3 py-1.5 text-right ${ship.delta <= 0 ? 'text-green-600' : 'text-red-500'}`}>{fmtMoney(ship.delta)}</td>
                    <td className={`px-3 py-1.5 text-right ${s.location === 'Utah' ? 'text-slate-300' : (netToUT ?? 0) >= 0 ? 'text-green-600 font-medium' : 'text-slate-400'}`}>
                      {s.location === 'Utah' ? '— (already here)' : (netToUT === null ? '—' : fmtMoney(netToUT))}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${s.location === 'Georgia' ? 'text-slate-300' : (netToGA ?? 0) >= 0 ? 'text-green-600 font-medium' : 'text-slate-400'}`}>
                      {s.location === 'Georgia' ? '— (already here)' : (netToGA === null ? '—' : fmtMoney(netToGA))}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-medium ${dollarOpportunity === null ? 'text-slate-300' : dollarOpportunity > 0 ? 'text-green-600' : 'text-slate-400'}`}
                      title="Net $/order × orders in the trailing window — the order-volume-weighted total, not just a per-order rate">
                      {dollarOpportunity === null || orderCount === 0 ? '—' : fmtMoney(dollarOpportunity)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-slate-400"
                      title="How many points Utah's share of trailing 12mo order volume would shift if this state moved">
                      {utahShareShiftPts === null ? '—' : `${utahShareShiftPts >= 0 ? '+' : ''}${utahShareShiftPts.toFixed(1)} pts`}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
