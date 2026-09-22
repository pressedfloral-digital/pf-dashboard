'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { RATIO_TARGETS } from '@/lib/ratioTargets';
import { MemberTierBadges } from './MemberTierBadge';

// ── Types ─────────────────────────────────────────────────────────────────────

type Location = 'Utah' | 'Georgia';
type Dept = 'Design' | 'Preservation' | 'Fulfillment' | 'G&A' | 'Resin';
type DeptOrBlended = Dept | 'Blended';

interface MemberRatio {
  name:       string;
  department: string;
  hours:      number;
  orders:     number;
  ratio:      number | null;
}

interface MonthData {
  laborByDept:      Record<string, number>;
  productionByDept: Record<string, number>;
  hoursByDept:      Record<string, number>;
  deptCPO:          Record<string, number | null>;
  blendedCPO:       number | null;
  combinedRatio:    number | null;
  blendedCost:      number;
  blendedOrders:    number;
  memberRatios:     MemberRatio[];
  hasData:          boolean;
}

interface ScorecardGoal {
  month_key:  string;
  location:   string;
  department: string;
  goal_cpo:   number | null;
  min_cpo:    number | null;
  notes:      string | null;
}

interface ScorecardData {
  months:       string[];
  targetMonth:  string;
  currentMonth: string;
  byLocation:   Record<string, Record<string, MonthData>>;
  blended:      Record<string, { blendedCPO: number | null; combinedRatio: number | null; totalOrders: number }>;
  goals:        ScorecardGoal[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CPO_DEPTS: Dept[] = ['Design', 'Preservation', 'Fulfillment', 'G&A', 'Resin'];
const BLENDED_DEPTS: Dept[] = ['Design', 'Preservation', 'Fulfillment', 'G&A'];
const PROD_DEPTS: Dept[] = ['Design', 'Preservation', 'Fulfillment', 'Resin'];

const DEPT_LABELS: Record<string, string> = {
  Design: 'Design', Preservation: 'Preservation', Fulfillment: 'Fulfillment',
  'G&A': 'G&A', Resin: 'Resin', Blended: 'Blended',
};

const PROD_LABEL: Record<string, string> = {
  Design: 'frames', Preservation: 'bouquets', Fulfillment: 'orders', Resin: 'pieces',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string { return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`; }

function monthLabel(key: string): string {
  // "2026-03" → "Mar 2026"
  const [y, m] = key.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m) - 1]} ${y}`;
}

function avg(vals: (number | null)[]): number | null {
  const valid = vals.filter((v): v is number => v !== null && !isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function pctChange(current: number | null, reference: number | null): number | null {
  if (current == null || reference == null || reference === 0) return null;
  return (current - reference) / reference;
}

// ── Goal suggestion engine ────────────────────────────────────────────────────

function suggestGoal(
  actuals: (number | null)[],
  mode: 'last3' | 'ytd' | 'plus10' | 'minus10' | 'minus5',
): number | null {
  const base = mode === 'last3'
    ? avg(actuals.slice(-3))
    : mode === 'ytd'
    ? avg(actuals)
    : avg(actuals.slice(-3));

  if (base == null) return null;
  if (mode === 'plus10')  return base * 1.10;
  if (mode === 'minus10') return base * 0.90;
  if (mode === 'minus5')  return base * 0.95;
  return base;
}

// ── What-If Engine ────────────────────────────────────────────────────────────

interface WhatIfConfig {
  dept:          Dept;
  targetRatio:   number;
  memberCount:   number;
  avgHoursPerWeek: number;
  weeksInMonth:  number;
  laborCostPerHour: number;
}

function computeWhatIfCPO(config: WhatIfConfig): { newOrders: number; newCost: number; newCPO: number } | null {
  if (config.targetRatio <= 0) return null;
  const totalHours  = config.memberCount * config.avgHoursPerWeek * config.weeksInMonth;
  const newOrders   = totalHours / config.targetRatio;
  const newCost     = totalHours * config.laborCostPerHour;
  const newCPO      = newCost / newOrders;
  return { newOrders, newCost, newCPO };
}

// ── Inline editable goal cell ─────────────────────────────────────────────────

function GoalCell({
  value, onChange, placeholder,
}: { value: number | null; onChange: (v: number | null) => void; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw]         = useState('');

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        step="0.01"
        inputMode="decimal"
        className="w-20 border border-indigo-300 rounded px-1.5 py-2 sm:py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-indigo-400"
        value={raw}
        placeholder={placeholder ?? '0.00'}
        onChange={e => setRaw(e.target.value)}
        onBlur={() => {
          const v = parseFloat(raw);
          onChange(isNaN(v) ? null : v);
          setEditing(false);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setEditing(false); }
        }}
      />
    );
  }

  return (
    <button
      onClick={() => { setRaw(value != null ? String(value) : ''); setEditing(true); }}
      className={`w-20 text-xs rounded px-1.5 py-2 sm:py-1 border transition-colors text-center ${
        value != null
          ? 'border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 active:bg-indigo-200'
          : 'border-dashed border-slate-300 text-slate-400 hover:border-indigo-300 hover:text-indigo-500 bg-transparent active:bg-slate-100'
      }`}
    >
      {value != null ? fmt$(value) : '+ set'}
    </button>
  );
}

// ── Quick-apply control ───────────────────────────────────────────────────────
// Native <select> on mobile gives a real tap target (and the OS picker UI);
// pill buttons remain on desktop where the original layout works fine.
function QuickApply({
  options, onApply, variant = 'indigo',
}: {
  options: { label: string; val: number | null }[];
  onApply: (val: number) => void;
  variant?: 'indigo' | 'amber';
}) {
  const valid = options.filter((o): o is { label: string; val: number } => o.val != null);
  if (!valid.length) return null;

  const hoverClasses = variant === 'amber'
    ? 'hover:bg-amber-50 hover:border-amber-300 hover:text-amber-600'
    : 'hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-600';

  return (
    <>
      {/* Mobile: native select, ~40px tall tap target */}
      <select
        defaultValue=""
        onChange={e => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onApply(v);
          e.currentTarget.value = '';
        }}
        className="sm:hidden w-20 text-[10px] border border-slate-200 rounded px-1 py-2 text-slate-500 bg-white"
      >
        <option value="" disabled>Quick apply…</option>
        {valid.map(o => (
          <option key={o.label} value={o.val}>{o.label} · {fmt$(o.val)}</option>
        ))}
      </select>
      {/* Desktop: compact pill row */}
      <div className="hidden sm:flex gap-0.5 flex-wrap justify-center">
        {valid.map(o => (
          <button
            key={o.label}
            onClick={() => onApply(o.val)}
            className={`px-1 py-px text-[9px] bg-white border border-slate-200 rounded text-slate-500 transition-colors ${hoverClasses}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ScorecardTab() {
  const [data,        setData]        = useState<ScorecardData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [location,    setLocation]    = useState<Location>('Utah');
  const [activeView,  setActiveView]  = useState<'actuals' | 'goals' | 'ratios' | 'whatif'>('actuals');
  const [saving,      setSaving]      = useState<string | null>(null);

  // Goals local state (layered over fetched goals)
  const [localGoals, setLocalGoals] = useState<Record<string, ScorecardGoal>>({});

  // What-if state
  const [whatIfDept,    setWhatIfDept]    = useState<Dept>('Design');
  const [whatIfRole,    setWhatIfRole]    = useState<'specialist' | 'senior' | 'master'>('senior');
  const [whatIfMembers, setWhatIfMembers] = useState(4);
  const [whatIfHours,   setWhatIfHours]   = useState(32);
  const [whatIfWeeks,   setWhatIfWeeks]   = useState(4);
  const [whatIfRate,    setWhatIfRate]    = useState(18);
  const [whatIfCustomRatio, setWhatIfCustomRatio] = useState<string>('');

  // ── Fetch ───────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/scorecard?location=both&months=13');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as ScorecardData;
      setData(d);
      // Seed local goals
      const map: Record<string, ScorecardGoal> = {};
      for (const g of d.goals ?? []) {
        map[`${g.month_key}|${g.location}|${g.department}`] = g;
      }
      setLocalGoals(map);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const getGoal = useCallback((monthKey: string, loc: string, dept: string): ScorecardGoal | undefined => {
    return localGoals[`${monthKey}|${loc}|${dept}`];
  }, [localGoals]);

  const setGoal = useCallback((monthKey: string, loc: string, dept: string, field: 'goal_cpo' | 'min_cpo', value: number | null) => {
    const key = `${monthKey}|${loc}|${dept}`;
    setLocalGoals(prev => ({
      ...prev,
      [key]: {
        ...{ month_key: monthKey, location: loc, department: dept, goal_cpo: null, min_cpo: null, notes: null },
        ...prev[key],
        [field]: value,
      },
    }));
    // Debounced save
    const existing = localGoals[key] ?? { month_key: monthKey, location: loc, department: dept, goal_cpo: null, min_cpo: null, notes: null };
    const updated  = { ...existing, [field]: value };
    setSaving(key);
    fetch('/api/scorecard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthKey, location: loc, department: dept,
        goalCPO: updated.goal_cpo, minCPO: updated.min_cpo, notes: updated.notes,
      }),
    }).finally(() => setSaving(null));
  }, [localGoals]);

  // Actuals CPO series for a location+dept
  const getCPOSeries = useCallback((loc: string, dept: DeptOrBlended): (number | null)[] => {
    if (!data) return [];
    return (data.months ?? []).map(m => {
      if (dept === 'Blended') {
        if (loc === 'Company') return data.blended[m]?.blendedCPO ?? null;
        return (data.byLocation[loc]?.[m] as MonthData | undefined)?.blendedCPO ?? null;
      }
      return (data.byLocation[loc]?.[m] as MonthData | undefined)?.deptCPO?.[dept] ?? null;
    });
  }, [data]);

  // Past complete months (exclude current partial month for actuals)
  const pastMonths = useMemo(() => {
    if (!data) return [];
    return (data.months ?? []).filter(m => m < data.currentMonth);
  }, [data]);

  // ── Stats panel for a location+dept ─────────────────────────────────────────

  function StatsBar({ loc, dept }: { loc: Location; dept: DeptOrBlended }) {
    const series = getCPOSeries(loc, dept);
    const pastSeries = pastMonths.map((m, i) => series[(data?.months ?? []).indexOf(m)] ?? null);

    const last3  = avg(pastSeries.slice(-3));
    const ytd    = avg(pastSeries.filter(v => v !== null));
    const last   = pastSeries.filter(v => v !== null).slice(-1)[0] ?? null;
    const prev   = pastSeries.filter(v => v !== null).slice(-2, -1)[0] ?? null;
    const trend  = pctChange(last, prev);

    return (
      <div className="flex flex-wrap gap-4 text-xs">
        <div className="bg-slate-50 rounded-lg px-3 py-2 min-w-[90px]">
          <div className="text-slate-400 uppercase tracking-wide text-[10px] mb-0.5">Last month</div>
          <div className="font-semibold text-slate-800">{fmt$(last)}</div>
          {trend !== null && (
            <div className={`text-[10px] mt-0.5 ${trend < 0 ? 'text-green-600' : 'text-red-500'}`}>
              {fmtPct(trend)} vs prior
            </div>
          )}
        </div>
        <div className="bg-slate-50 rounded-lg px-3 py-2 min-w-[90px]">
          <div className="text-slate-400 uppercase tracking-wide text-[10px] mb-0.5">Last 3 mo avg</div>
          <div className="font-semibold text-slate-800">{fmt$(last3)}</div>
        </div>
        <div className="bg-slate-50 rounded-lg px-3 py-2 min-w-[90px]">
          <div className="text-slate-400 uppercase tracking-wide text-[10px] mb-0.5">YTD avg</div>
          <div className="font-semibold text-slate-800">{fmt$(ytd)}</div>
        </div>
        {last3 !== null && (
          <>
            <div className="bg-green-50 rounded-lg px-3 py-2 min-w-[90px]">
              <div className="text-green-600 uppercase tracking-wide text-[10px] mb-0.5">−10% of avg</div>
              <div className="font-semibold text-green-700">{fmt$(last3 * 0.90)}</div>
            </div>
            <div className="bg-amber-50 rounded-lg px-3 py-2 min-w-[90px]">
              <div className="text-amber-600 uppercase tracking-wide text-[10px] mb-0.5">−5% of avg</div>
              <div className="font-semibold text-amber-700">{fmt$(last3 * 0.95)}</div>
            </div>
            <div className="bg-red-50 rounded-lg px-3 py-2 min-w-[90px]">
              <div className="text-red-400 uppercase tracking-wide text-[10px] mb-0.5">+10% of avg</div>
              <div className="font-semibold text-red-500">{fmt$(last3 * 1.10)}</div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── CPO History table for a location ────────────────────────────────────────

  function CPOTable({ loc }: { loc: Location | 'Company' }) {
    const depts: DeptOrBlended[] = [...CPO_DEPTS, 'Blended'];
    const displayMonths = pastMonths.slice(-12); // last 12 complete months

    // Next month (the planning month)
    const nextMonth = (() => {
      const now = new Date();
      const d   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    return (
      <div>
        <div className="sm:hidden flex items-center gap-1 text-[10px] text-slate-400 px-4 pt-2 pb-1.5">
          <span>Swipe to see more</span>
          <span aria-hidden>→</span>
        </div>
        <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="sticky left-0 bg-slate-50 px-4 py-2.5 text-left font-medium text-slate-500 min-w-[120px]">
                Dept
              </th>
              {displayMonths.map(m => (
                <th key={m} className="px-3 py-2.5 text-center font-medium text-slate-500 min-w-[80px] whitespace-nowrap">
                  {monthLabel(m)}
                </th>
              ))}
              <th className="px-3 py-2.5 text-center font-medium text-slate-400 min-w-[70px]">L3 avg</th>
              <th className="px-3 py-2.5 text-center font-medium text-slate-400 min-w-[70px]">YTD avg</th>
              <th className="px-3 py-2.5 text-center font-semibold text-indigo-600 min-w-[110px] bg-indigo-50/50 border-l border-indigo-100">
                {monthLabel(nextMonth)} goal
              </th>
              <th className="px-3 py-2.5 text-center font-semibold text-slate-600 min-w-[110px] bg-slate-50 border-l border-slate-200">
                Minimum
              </th>
            </tr>
          </thead>
          <tbody>
            {depts.map((dept, di) => {
              const isSeparator = dept === 'Blended';
              const series = displayMonths.map(m => {
                const idx = (data?.months ?? []).indexOf(m);
                if (idx === -1) return null;
                if (dept === 'Blended') {
                  if (loc === 'Company') return data?.blended[m]?.blendedCPO ?? null;
                  return (data?.byLocation[loc as string]?.[m] as MonthData | undefined)?.blendedCPO ?? null;
                }
                return (data?.byLocation[loc as string]?.[m] as MonthData | undefined)?.deptCPO?.[dept] ?? null;
              });
              const l3  = avg(series.slice(-3));
              const ytd = avg(series.filter((v): v is number => v !== null));

              const goalLoc = loc === 'Company' ? 'Company' : loc;
              const goal    = getGoal(nextMonth, goalLoc, dept);
              const savingThis = saving === `${nextMonth}|${goalLoc}|${dept}`;

              return (
                <tr key={dept} className={`border-b border-slate-50 ${
                  isSeparator ? 'border-t-2 border-t-slate-200 bg-indigo-50/20 font-semibold' :
                  di % 2 === 0 ? '' : 'bg-slate-50/30'
                }`}>
                  <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700">
                    {DEPT_LABELS[dept]}
                    {dept === 'Resin' && (
                      <span className="ml-1.5 text-[10px] bg-purple-100 text-purple-600 rounded px-1">own CPO</span>
                    )}
                    {dept === 'Blended' && (
                      <span className="ml-1.5 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1">
                        sum of dept CPOs, excl. Resin
                      </span>
                    )}
                  </td>
                  {series.map((v, i) => {
                    const m = displayMonths[i];
                    const g = getGoal(m, goalLoc, dept);
                    const status = v != null && g?.goal_cpo != null
                      ? v <= g.goal_cpo ? 'good'
                      : g.min_cpo != null && v <= g.min_cpo ? 'ok'
                      : 'over'
                      : null;
                    return (
                      <td key={m} className="px-3 py-2 text-center">
                        <span className={
                          status === 'good' ? 'text-green-700 font-semibold' :
                          status === 'ok'   ? 'text-amber-600 font-medium'  :
                          status === 'over' ? 'text-red-600 font-semibold'  :
                          'text-slate-600'
                        }>
                          {fmt$(v)}
                        </span>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center text-slate-500 font-medium">{fmt$(l3)}</td>
                  <td className="px-3 py-2 text-center text-slate-500 font-medium">{fmt$(ytd)}</td>
                  {/* Goal cell */}
                  <td className="px-3 py-2 text-center bg-indigo-50/30 border-l border-indigo-100">
                    <div className="flex flex-col items-center gap-1">
                      <GoalCell
                        value={goal?.goal_cpo ?? null}
                        onChange={v => setGoal(nextMonth, goalLoc, dept, 'goal_cpo', v)}
                      />
                      {savingThis && <span className="text-[10px] text-slate-400">saving…</span>}
                      {/* Quick-apply: native select on mobile, pills on desktop */}
                      <QuickApply
                        options={[
                          { label: 'L3',   val: l3 },
                          { label: 'YTD',  val: ytd },
                          { label: '−5%',  val: l3 != null ? l3 * 0.95 : null },
                          { label: '−10%', val: l3 != null ? l3 * 0.90 : null },
                        ]}
                        onApply={v => setGoal(nextMonth, goalLoc, dept, 'goal_cpo', parseFloat(v.toFixed(4)))}
                      />
                    </div>
                  </td>
                  {/* Min cell */}
                  <td className="px-3 py-2 text-center bg-slate-50/50 border-l border-slate-200">
                    <div className="flex flex-col items-center gap-1">
                      <GoalCell
                        value={goal?.min_cpo ?? null}
                        onChange={v => setGoal(nextMonth, goalLoc, dept, 'min_cpo', v)}
                        placeholder="max"
                      />
                      <QuickApply
                        variant="amber"
                        options={[
                          { label: 'L3',   val: l3 },
                          { label: '+5%',  val: l3 != null ? l3 * 1.05 : null },
                          { label: '+10%', val: l3 != null ? l3 * 1.10 : null },
                        ]}
                        onApply={v => setGoal(nextMonth, goalLoc, dept, 'min_cpo', parseFloat(v.toFixed(4)))}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    );
  }

  // ── Ratio history table ──────────────────────────────────────────────────────

  function RatioTable({ loc }: { loc: Location }) {
    const displayMonths = pastMonths.slice(-6);
    const depts: Dept[] = ['Design', 'Preservation', 'Fulfillment'];

    return (
      <div className="space-y-6">
        {depts.map(dept => {
          // All members who worked in this dept+loc across displayed months
          const memberSet = new Set<string>();
          for (const m of displayMonths) {
            const monthData = data?.byLocation[loc]?.[m] as MonthData | undefined;
            (monthData?.memberRatios ?? [])
              .filter(r => r.department === dept)
              .forEach(r => memberSet.add(r.name));
          }
          const members = [...memberSet].sort();
          if (!members.length) return null;

          const targets = RATIO_TARGETS[dept];

          return (
            <div key={dept} className="bg-white border border-slate-100 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-3 flex-wrap">
                <h3 className="text-sm font-semibold text-slate-700">{dept} — Actual Ratios</h3>
                <span className="text-xs text-slate-400">hours ÷ {PROD_LABEL[dept] ?? 'orders'} · lower is better</span>
                <div className="flex gap-3 ml-auto text-[10px] text-slate-500">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" />
                    Master ≤{targets.master}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
                    Senior ≤{targets.senior}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full bg-slate-300 inline-block" />
                    Specialist ≤{targets.specialist}
                  </span>
                </div>
              </div>
              <div className="sm:hidden flex items-center gap-1 text-[10px] text-slate-400 px-4 pt-2 pb-1.5">
                <span>Swipe to see more</span>
                <span aria-hidden>→</span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[140px]">Member</th>
                      {displayMonths.map(m => (
                        <th key={m} className="px-3 py-2 text-center font-medium text-slate-500 min-w-[90px] whitespace-nowrap">
                          {monthLabel(m)}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-center font-medium text-slate-400 min-w-[80px]">L3 avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((name, ni) => {
                      const ratioSeries = displayMonths.map(m => {
                        const monthData = data?.byLocation[loc]?.[m] as MonthData | undefined;
                        return monthData?.memberRatios?.find(r => r.name === name && r.department === dept)?.ratio ?? null;
                      });
                      const l3 = avg(ratioSeries.slice(-3));

                      return (
                        <tr key={name} className={`border-b border-slate-50 ${ni % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                          <td className={`sticky left-0 z-10 ${ni % 2 === 0 ? 'bg-white' : 'bg-slate-50'} px-4 py-2`}>
                            <div className="font-medium text-slate-700 whitespace-nowrap">{name}</div>
                            <MemberTierBadges name={name} location={loc} dept={dept} />
                          </td>
                          {ratioSeries.map((ratio, i) => {
                            if (ratio === null) return <td key={i} className="px-3 py-2 text-center text-slate-200">—</td>;
                            const tier =
                              ratio <= targets.master     ? 'master'
                              : ratio <= targets.senior   ? 'senior'
                              : ratio <= targets.specialist ? 'specialist'
                              : 'over';
                            return (
                              <td key={i} className="px-3 py-2 text-center">
                                <span className={`font-semibold ${
                                  tier === 'master'     ? 'text-green-700'  :
                                  tier === 'senior'     ? 'text-amber-600'  :
                                  tier === 'specialist' ? 'text-slate-600'  :
                                  'text-red-600'
                                }`}>
                                  {ratio.toFixed(2)}
                                </span>
                                <div className={`text-[9px] mt-0.5 ${
                                  tier === 'master'     ? 'text-green-500'  :
                                  tier === 'senior'     ? 'text-amber-400'  :
                                  tier === 'specialist' ? 'text-slate-400'  :
                                  'text-red-400'
                                }`}>
                                  {tier === 'over' ? 'above spec' : tier}
                                </div>
                              </td>
                            );
                          })}
                          <td className="px-3 py-2 text-center font-medium text-slate-600">
                            {l3 !== null ? l3.toFixed(2) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                    {/* Team avg row */}
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                      <td className="sticky left-0 bg-slate-50 px-4 py-2 text-slate-600">Team avg</td>
                      {displayMonths.map(m => {
                        const monthData = data?.byLocation[loc]?.[m] as MonthData | undefined;
                        const deptHours  = monthData?.hoursByDept?.[dept]      ?? 0;
                        const deptOrders = monthData?.productionByDept?.[dept] ?? 0;
                        const teamRatio  = (deptHours > 0 && deptOrders > 0) ? deptHours / deptOrders : null;
                        const tier =
                          teamRatio == null ? null :
                          teamRatio <= targets.master     ? 'master'     :
                          teamRatio <= targets.senior     ? 'senior'     :
                          teamRatio <= targets.specialist ? 'specialist' : 'over';
                        return (
                          <td key={m} className="px-3 py-2 text-center">
                            <span className={
                              tier === 'master'     ? 'text-green-700'  :
                              tier === 'senior'     ? 'text-amber-600'  :
                              tier === 'specialist' ? 'text-slate-600'  :
                              tier === 'over'       ? 'text-red-600'    : 'text-slate-400'
                            }>
                              {teamRatio !== null ? teamRatio.toFixed(2) : '—'}
                            </span>
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-center" />
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Production totals row */}
              <div className="px-5 py-2 bg-slate-50/50 border-t border-slate-100 flex gap-4 flex-wrap">
                <span className="text-[10px] text-slate-400 uppercase tracking-wide font-medium">
                  {PROD_LABEL[dept] ?? 'orders'} completed:
                </span>
                {displayMonths.map(m => {
                  const monthData = data?.byLocation[loc]?.[m] as MonthData | undefined;
                  const prod = monthData?.productionByDept?.[dept] ?? null;
                  return (
                    <span key={m} className="text-[10px] text-slate-600">
                      <span className="text-slate-400">{monthLabel(m)}:</span>{' '}
                      <span className="font-semibold">{prod != null ? prod.toLocaleString() : '—'}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── What-If panel ────────────────────────────────────────────────────────────

  function WhatIfPanel() {
    const targetRatio = whatIfCustomRatio !== ''
      ? parseFloat(whatIfCustomRatio)
      : RATIO_TARGETS[whatIfDept]?.[whatIfRole] ?? 0;

    const result = computeWhatIfCPO({
      dept: whatIfDept, targetRatio,
      memberCount: whatIfMembers,
      avgHoursPerWeek: whatIfHours,
      weeksInMonth: whatIfWeeks,
      laborCostPerHour: whatIfRate,
    });

    // Current actuals for context
    const lastMonth = pastMonths[pastMonths.length - 1];
    const currentCPO = lastMonth
      ? (data?.byLocation[location]?.[lastMonth] as MonthData | undefined)?.deptCPO?.[whatIfDept] ?? null
      : null;
    const currentOrders = lastMonth
      ? (data?.byLocation[location]?.[lastMonth] as MonthData | undefined)?.productionByDept?.[whatIfDept] ?? null
      : null;

    return (
      <div className="space-y-5">
        <div className="bg-white border border-slate-100 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-700 mb-1">What-If: CPO Impact of Ratio Changes</h3>
          <p className="text-xs text-slate-400 mb-5">
            See how hitting a target ratio for a group of team members would change CPO.
            All inputs are editable — this is a scratch pad.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wide block mb-1">Department</label>
              <select
                value={whatIfDept}
                onChange={e => setWhatIfDept(e.target.value as Dept)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              >
                {(['Design', 'Preservation', 'Fulfillment'] as Dept[]).map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wide block mb-1">Role tier</label>
              <select
                value={whatIfRole}
                onChange={e => { setWhatIfRole(e.target.value as 'specialist' | 'senior' | 'master'); setWhatIfCustomRatio(''); }}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              >
                <option value="specialist">Specialist ({RATIO_TARGETS[whatIfDept]?.specialist})</option>
                <option value="senior">Senior ({RATIO_TARGETS[whatIfDept]?.senior})</option>
                <option value="master">Master ({RATIO_TARGETS[whatIfDept]?.master})</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wide block mb-1">Custom ratio</label>
              <input
                type="number" step="0.05" min="0.1" placeholder={String(targetRatio)}
                value={whatIfCustomRatio}
                onChange={e => setWhatIfCustomRatio(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wide block mb-1">Members</label>
              <input
                type="number" min="1" value={whatIfMembers}
                onChange={e => setWhatIfMembers(parseInt(e.target.value) || 1)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wide block mb-1">Hrs/person/wk</label>
              <input
                type="number" min="1" step="0.5" value={whatIfHours}
                onChange={e => setWhatIfHours(parseFloat(e.target.value) || 0)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 uppercase tracking-wide block mb-1">Avg $/hr</label>
              <input
                type="number" min="0" step="0.50" value={whatIfRate}
                onChange={e => setWhatIfRate(parseFloat(e.target.value) || 0)}
                className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-slate-50 rounded-xl p-4">
              <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Target ratio</div>
              <div className="text-2xl font-bold text-indigo-700">{targetRatio.toFixed(2)}</div>
              <div className="text-[10px] text-slate-400 mt-1">hrs per {PROD_LABEL[whatIfDept] ?? 'order'}</div>
            </div>
            <div className="bg-slate-50 rounded-xl p-4">
              <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Est. monthly output</div>
              <div className="text-2xl font-bold text-slate-800">
                {result ? Math.round(result.newOrders).toLocaleString() : '—'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">{PROD_LABEL[whatIfDept] ?? 'orders'}</div>
            </div>
            <div className="bg-slate-50 rounded-xl p-4">
              <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Est. labor cost</div>
              <div className="text-2xl font-bold text-slate-800">
                {result ? fmt$(result.newCost) : '—'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                {whatIfMembers}p × {whatIfHours}h × {whatIfWeeks}wk
              </div>
            </div>
            <div className={`rounded-xl p-4 ${
              result && currentCPO
                ? result.newCPO < currentCPO ? 'bg-green-50' : 'bg-red-50'
                : 'bg-indigo-50'
            }`}>
              <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Projected CPO</div>
              <div className={`text-2xl font-bold ${
                result && currentCPO
                  ? result.newCPO < currentCPO ? 'text-green-700' : 'text-red-600'
                  : 'text-indigo-700'
              }`}>
                {result ? fmt$(result.newCPO) : '—'}
              </div>
              {result && currentCPO && (
                <div className={`text-[10px] mt-1 font-medium ${result.newCPO < currentCPO ? 'text-green-600' : 'text-red-500'}`}>
                  {fmtPct((result.newCPO - currentCPO) / currentCPO)} vs last month actual
                </div>
              )}
            </div>
          </div>

          {currentCPO !== null && (
            <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap gap-6 text-xs text-slate-500">
              <span>
                Last month actual ({lastMonth ? monthLabel(lastMonth) : '—'}) —{' '}
                <strong className="text-slate-700">{whatIfDept} CPO:</strong> {fmt$(currentCPO)}
              </span>
              {currentOrders !== null && (
                <span>
                  <strong className="text-slate-700">Production:</strong>{' '}
                  {currentOrders.toLocaleString()} {PROD_LABEL[whatIfDept] ?? 'orders'}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Ratio reference table */}
        <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">Ratio targets by role</h3>
            <p className="text-xs text-slate-400">Hours per order completed. Lower = more efficient.</p>
          </div>
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-5 py-2 text-left font-medium text-slate-500">Department</th>
                <th className="px-4 py-2 text-center font-medium text-slate-500">Specialist</th>
                <th className="px-4 py-2 text-center font-medium text-amber-600">Senior</th>
                <th className="px-4 py-2 text-center font-medium text-green-600 bg-green-50/50">Master</th>
              </tr>
            </thead>
            <tbody>
              {(['Preservation', 'Design', 'Fulfillment'] as Dept[]).map((d, i) => (
                <tr key={d} className={`border-b border-slate-50 ${i % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                  <td className="px-5 py-2.5 font-medium text-slate-700">{d}</td>
                  <td className="px-4 py-2.5 text-center text-slate-600">{RATIO_TARGETS[d].specialist.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-center text-amber-600 font-medium">{RATIO_TARGETS[d].senior.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-center text-green-700 font-semibold bg-green-50/30">{RATIO_TARGETS[d].master.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
        Loading scorecard data…
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-5 text-sm text-red-700">
        Error loading scorecard: {error}
        <button onClick={fetchData} className="ml-3 underline text-red-600 hover:text-red-800">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Header bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Scorecards</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Monthly KPI actuals, goals, and individual ratios. CPO = labor cost ÷ production.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          {(['Utah', 'Georgia'] as Location[]).map(loc => (
            <button key={loc} onClick={() => setLocation(loc)}
              className={`px-5 py-2 transition-colors ${
                location === loc ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}>
              {loc}
            </button>
          ))}
        </div>
      </div>

      {/* ── View tabs ───────────────────────────────────────────────────────── */}
      <div className="flex overflow-x-auto border-b border-slate-200">
        {([
          ['actuals', 'CPO Actuals & Goals'],
          ['ratios',  'Individual Ratios'],
          ['whatif',  'What-If'],
        ] as const).map(([id, label]) => (
          <button key={id} onClick={() => setActiveView(id)}
            className={`shrink-0 px-4 sm:px-5 py-3 sm:py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              activeView === id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700 active:text-slate-800'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── CPO Actuals & Goals ─────────────────────────────────────────────── */}
      {activeView === 'actuals' && (
        <div className="space-y-6">

          {/* Stats bar for quick reference */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              {location} · Blended CPO — quick stats
            </p>
            <StatsBar loc={location} dept="Blended" />
          </div>

          {/* Combined ratio quick stats */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              {location} · Combined Ratio — last 6 months
            </p>
            <div className="flex flex-wrap gap-3">
              {pastMonths.slice(-6).map(m => {
                const ratio = (data?.byLocation[location]?.[m] as MonthData | undefined)?.combinedRatio ?? null;
                return (
                  <div key={m} className="bg-slate-50 rounded-lg px-3 py-2 min-w-[90px]">
                    <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">{monthLabel(m)}</div>
                    <div className="font-semibold text-amber-700">{ratio != null ? ratio.toFixed(2) : '—'}</div>
                    <div className="text-[10px] text-slate-400">combined ratio</div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-400">
              = (Pres hrs÷Pres orders) + (Design hrs÷Design orders) + (FF hrs÷FF orders) + (G&A hrs÷all orders)
            </p>
          </div>

          {/* Per-location table */}
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-700">{location} — CPO by Department</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Click any goal/minimum cell to edit. Quick-apply buttons use last-3-month average.
                Green = at or below goal. Amber = between goal and minimum. Red = above minimum.
              </p>
            </div>
            <CPOTable loc={location} />
          </div>

          {/* Company-wide blended */}
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-700">Company-Wide — Blended CPO</h3>
              <p className="text-xs text-slate-400 mt-0.5">Utah + Georgia combined. Excludes Resin.</p>
            </div>
            <div className="sm:hidden flex items-center gap-1 text-[10px] text-slate-400 px-4 pt-2 pb-1.5">
              <span>Swipe to see more</span>
              <span aria-hidden>→</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="px-4 py-2.5 text-left font-medium text-slate-500 min-w-[100px]">Metric</th>
                    {pastMonths.slice(-6).map(m => (
                      <th key={m} className="px-3 py-2.5 text-center font-medium text-slate-500 min-w-[80px] whitespace-nowrap">
                        {monthLabel(m)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Utah CPO',        fn: (m: string) => (data?.byLocation['Utah']?.[m] as MonthData | undefined)?.blendedCPO ?? null },
                    { label: 'Georgia CPO',     fn: (m: string) => (data?.byLocation['Georgia']?.[m] as MonthData | undefined)?.blendedCPO ?? null },
                    { label: 'Blended CPO',     fn: (m: string) => data?.blended[m]?.blendedCPO ?? null, bold: true },
                    { label: 'Utah ratio',      fn: (m: string) => (data?.byLocation['Utah']?.[m] as MonthData | undefined)?.combinedRatio ?? null, isRatio: true },
                    { label: 'Georgia ratio',   fn: (m: string) => (data?.byLocation['Georgia']?.[m] as MonthData | undefined)?.combinedRatio ?? null, isRatio: true },
                    { label: 'Combined ratio',  fn: (m: string) => data?.blended[m]?.combinedRatio ?? null, bold: true, isRatio: true },
                  ].map(({ label, fn, bold, isRatio }, ri) => (
                    <tr key={label} className={`border-b border-slate-50 ${
                      ri === 2 ? 'bg-indigo-50/20 border-t-2 border-t-slate-200' :
                      ri === 5 ? 'bg-amber-50/20 border-t-2 border-t-slate-200' :
                      ri % 2 === 0 ? '' : 'bg-slate-50/30'
                    }`}>
                      <td className={`px-4 py-2 text-slate-700 ${bold ? 'font-semibold' : ''}`}>{label}</td>
                      {pastMonths.slice(-6).map(m => (
                        <td key={m} className={`px-3 py-2 text-center ${
                          bold && !isRatio ? 'font-semibold text-indigo-700' :
                          bold && isRatio  ? 'font-semibold text-amber-700' :
                          isRatio ? 'text-slate-600' : 'text-slate-600'
                        }`}>
                          {isRatio
                            ? (fn(m) != null ? (fn(m) as number).toFixed(2) : <span className="text-slate-300">—</span>)
                            : fmt$(fn(m))
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Production totals summary */}
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-700">{location} — Production Completed</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Design = frames · Preservation = bouquets · Fulfillment = orders shipped · Resin = pieces
              </p>
            </div>
            <div className="sm:hidden flex items-center gap-1 text-[10px] text-slate-400 px-4 pt-2 pb-1.5">
              <span>Swipe to see more</span>
              <span aria-hidden>→</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="sticky left-0 bg-slate-50 px-4 py-2.5 text-left font-medium text-slate-500 min-w-[120px]">Dept</th>
                    {pastMonths.slice(-6).map(m => (
                      <th key={m} className="px-3 py-2.5 text-center font-medium text-slate-500 min-w-[80px] whitespace-nowrap">{monthLabel(m)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PROD_DEPTS.map((dept, di) => (
                    <tr key={dept} className={`border-b border-slate-50 ${di % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                      <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700">{dept}</td>
                      {pastMonths.slice(-6).map(m => {
                        const val = (data?.byLocation[location]?.[m] as MonthData | undefined)?.productionByDept?.[dept] ?? null;
                        return (
                          <td key={m} className="px-3 py-2 text-center text-slate-700 font-medium">
                            {val != null ? val.toLocaleString() : <span className="text-slate-200">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Individual Ratios ────────────────────────────────────────────────── */}
      {activeView === 'ratios' && <RatioTable loc={location} />}

      {/* ── What-If ─────────────────────────────────────────────────────────── */}
      {activeView === 'whatif' && <WhatIfPanel />}

    </div>
  );
}
