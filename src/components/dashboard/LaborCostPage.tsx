'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { MonthForecast, DeptForecast, LocationMonthActual, InferredDate } from '@/app/api/labor-forecast/route';
import type { MemberCostLine } from '@/lib/scheduleProjection';

// Admin-only: monthly labor cost per department (see /api/labor-forecast).
//  - Forecast: projected from the Scheduling rosters/schedules and each
//    person's pay, for this month and ahead.
//  - Planned vs actual: past months' projection next to what payroll
//    actually paid, with the variance, per department and per person.

type LocFilter = 'All' | 'Utah' | 'Georgia';
const DEPTS = ['Design', 'Preservation', 'Fulfillment', 'Resin'] as const;
type RowKey = typeof DEPTS[number] | 'GM';

const DEPT_BAR: Record<RowKey, string> = {
  Design:       'bg-indigo-400',
  Preservation: 'bg-green-400',
  Fulfillment:  'bg-amber-400',
  Resin:        'bg-purple-400',
  GM:           'bg-slate-400',
};

const fmt$ = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtH = (n: number) => `${Math.round(n).toLocaleString('en-US')}h`;

const BASIS_NOTE: Record<MemberCostLine['basis'], string> = {
  hourly:         'hourly',
  salary:         'salary',
  'fixed-salary': 'salaried manager (fixed)',
  elsewhere:      'manager — paid in home dept',
  none:           'no pay rate on roster',
};

function locationsFor(filter: LocFilter): ('Utah' | 'Georgia')[] {
  return filter === 'All' ? ['Utah', 'Georgia'] : [filter];
}

// One department's forecast for a month across the selected location(s),
// with members from both locations merged under "Name (UT)"/"Name (GA)" when
// viewing All so two same-named people never collapse into one row.
function deptFor(month: MonthForecast, dept: typeof DEPTS[number], filter: LocFilter): DeptForecast {
  const out: DeptForecast = { cost: 0, hours: 0, members: [] };
  for (const loc of locationsFor(filter)) {
    const d = month.locations[loc].depts[dept];
    out.cost  += d.cost;
    out.hours += d.hours;
    for (const m of d.members) {
      out.members.push(filter === 'All' ? { ...m, name: `${m.name} (${loc === 'Utah' ? 'UT' : 'GA'})` } : m);
    }
  }
  return out;
}

function gmFor(month: MonthForecast, filter: LocFilter): { cost: number; names: string[] } {
  const locs = locationsFor(filter);
  return {
    cost:  locs.reduce((s, l) => s + month.locations[l].gm.cost, 0),
    names: locs.flatMap(l => month.locations[l].gm.names),
  };
}

export default function LaborCostPage() {
  const [months, setMonths]   = useState<MonthForecast[] | null>(null);
  const [inferredDates, setInferredDates] = useState<InferredDate[]>([]);
  const [error, setError]     = useState<string | null>(null);
  const [view, setView]       = useState<'forecast' | 'history'>('forecast');
  const [horizon, setHorizon] = useState<6 | 12>(6);
  const [range, setRange]     = useState<3 | 6 | 12>(6);
  const [loc, setLoc]         = useState<LocFilter>('All');
  const [includeGm, setIncludeGm] = useState(true);
  const [expanded, setExpanded]   = useState<Set<RowKey>>(new Set());

  useEffect(() => {
    fetch('/api/labor-forecast?back=12&months=12')
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'Failed to load labor forecast');
        setMonths(d.months);
        setInferredDates(d.inferredDates ?? []);
      })
      .catch(e => setError(e.message));
  }, []);

  const visible = useMemo(() => (months ?? []).filter(m => m.when !== 'past').slice(0, horizon), [months, horizon]);

  // Per-row, per-month cost + per-member rollup across the visible months.
  const table = useMemo(() => {
    const rows = DEPTS.map(dept => {
      const perMonth = visible.map(m => deptFor(m, dept, loc));
      const memberNames = [...new Set(perMonth.flatMap(p => p.members.map(x => x.name)))];
      const members = memberNames.map(name => {
        const cells = perMonth.map(p => p.members.find(x => x.name === name) ?? null);
        return { name, cells, total: cells.reduce((s, c) => s + (c?.cost ?? 0), 0) };
      }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      return {
        key: dept as RowKey,
        perMonth: perMonth.map(p => p.cost),
        hours: perMonth.map(p => p.hours),
        total: perMonth.reduce((s, p) => s + p.cost, 0),
        members,
      };
    });
    const gm = visible.map(m => gmFor(m, loc));
    const gmRow = {
      key: 'GM' as RowKey,
      perMonth: gm.map(g => g.cost),
      total: gm.reduce((s, g) => s + g.cost, 0),
      names: [...new Set(gm.flatMap(g => g.names))],
    };
    const monthTotals = visible.map((_, i) => rows.reduce((s, r) => s + r.perMonth[i], 0) + (includeGm ? gmRow.perMonth[i] : 0));
    const grandTotal = monthTotals.reduce((s, v) => s + v, 0);
    // Anyone scheduled but with no pay rate on the roster — their hours are
    // costed at $0, so the totals above are understated by that much.
    const missingRates = [...new Set(rows.flatMap(r =>
      r.members.filter(m => m.cells.some(c => c?.basis === 'none' && c.hours > 0)).map(m => `${m.name} — ${r.key}`)
    ))];
    return { rows, gmRow, monthTotals, grandTotal, missingRates };
  }, [visible, loc, includeGm]);

  const maxMonthTotal = Math.max(1, ...table.monthTotals);

  function toggle(key: RowKey) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if (error) return <div className="py-16 text-center text-sm text-rose-600">{error}</div>;
  if (!months) return <div className="py-16 text-center text-sm text-slate-500">Projecting labor cost from the schedule…</div>;

  const avgMonthly = visible.length > 0 ? table.grandTotal / visible.length : 0;

  return (
    <div className="space-y-5">
      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
          {([['forecast', 'Forecast'], ['history', 'Planned vs actual']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setView(id)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                view === id ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {(['All', 'Utah', 'Georgia'] as const).map(l => (
            <button key={l} onClick={() => setLoc(l)}
              className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                loc === l ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}>
              {l === 'All' ? 'Both locations' : l}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {view === 'forecast'
            ? ([6, 12] as const).map(h => (
              <button key={h} onClick={() => setHorizon(h)}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  horizon === h ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                Next {h} months
              </button>
            ))
            : ([3, 6, 12] as const).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                  range === r ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}>
                Last {r} months
              </button>
            ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={includeGm} onChange={e => setIncludeGm(e.target.checked)} className="accent-indigo-600" />
          Include general managers in totals
        </label>
      </div>

      {view === 'history' ? <PlannedVsActual months={months} loc={loc} range={range} includeGm={includeGm} inferredDates={inferredDates} /> : (<>
      {/* ── Summary tiles ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['This month', table.monthTotals[0] ?? 0, visible[0]?.label],
          ['Next month', table.monthTotals[1] ?? 0, visible[1]?.label],
          ['Avg / month', avgMonthly, `${visible.length}-month average`],
          [`${visible.length}-month total`, table.grandTotal, `${visible[0]?.label} – ${visible[visible.length - 1]?.label}`],
        ].map(([label, value, sub]) => (
          <div key={label as string} className="bg-white border border-slate-100 rounded-xl px-4 py-3">
            <div className="text-xs text-slate-500">{label}</div>
            <div className="text-xl font-semibold text-slate-800 tabular-nums mt-0.5">{fmt$(value as number)}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>
          </div>
        ))}
      </div>

      {table.missingRates.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-800">
          <span className="font-semibold">Understated:</span> these people are scheduled but have no pay rate on their Scheduling roster, so their hours are counted as $0 —{' '}
          {table.missingRates.join(', ')}.
        </div>
      )}

      {/* ── Department × month table ─────────────────────────────────────── */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="sticky left-0 z-10 bg-slate-50 text-left px-4 py-2.5 font-semibold text-slate-600 min-w-[180px]">Department</th>
                {visible.map(m => (
                  <th key={m.monthStart} className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">
                    {m.label}
                    <div className="text-[10px] font-normal text-slate-400">
                      {m.weeks} wks{m.isSnapshot ? ' · snapshot' : ''}
                    </div>
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right font-semibold text-slate-700 bg-slate-100">Total</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map(row => {
                const isOpen = expanded.has(row.key);
                if (row.total === 0 && row.members.length === 0) return null;
                return (
                  <Fragment key={row.key}>
                    <tr className="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer" onClick={() => toggle(row.key)}>
                      <td className="sticky left-0 z-10 bg-white px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">
                        <span className="inline-block w-3 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${DEPT_BAR[row.key]}`} />
                        {row.key}
                        <span className="ml-1.5 text-[10px] text-slate-400">{row.members.length} people</span>
                      </td>
                      {row.perMonth.map((v, i) => (
                        <td key={i} className="px-3 py-2.5 text-right tabular-nums text-slate-700" title={`${fmtH(row.hours[i])} scheduled production`}>
                          {v > 0 ? fmt$(v) : <span className="text-slate-300">—</span>}
                        </td>
                      ))}
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-800 bg-slate-50">{fmt$(row.total)}</td>
                    </tr>
                    {isOpen && row.members.map(mem => (
                      <tr key={mem.name} className="border-b border-slate-50 bg-slate-50/40">
                        <td className="sticky left-0 z-10 bg-slate-50 pl-11 pr-4 py-1.5 text-slate-600 whitespace-nowrap">{mem.name}</td>
                        {mem.cells.map((c, i) => (
                          <td key={i} className="px-3 py-1.5 text-right tabular-nums"
                            title={c ? `${BASIS_NOTE[c.basis]}${c.basis === 'hourly' ? ` · ${fmtH(c.payHours)} paid × $${c.rate.toFixed(2)}/h` : ''}${c.hours > 0 ? ` · ${fmtH(c.hours)} production` : ''}` : ''}>
                            {!c ? <span className="text-slate-200">—</span>
                              : c.basis === 'none' ? <span className="text-amber-600">no rate</span>
                              : c.basis === 'elsewhere' ? <span className="text-slate-400 italic">home dept</span>
                              : <span className="text-slate-600">{fmt$(c.cost)}</span>}
                          </td>
                        ))}
                        <td className="px-4 py-1.5 text-right tabular-nums text-slate-600 bg-slate-100/60">{mem.total > 0 ? fmt$(mem.total) : '—'}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}

              {/* General managers — location-wide salary, not tied to one department */}
              <tr className={`border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer ${includeGm ? '' : 'opacity-50'}`} onClick={() => toggle('GM')}>
                <td className="sticky left-0 z-10 bg-white px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">
                  <span className="inline-block w-3 text-slate-400">{expanded.has('GM') ? '▾' : '▸'}</span>
                  <span className={`inline-block w-2 h-2 rounded-full mr-2 ${DEPT_BAR.GM}`} />
                  General managers
                  {!includeGm && <span className="ml-1.5 text-[10px] text-slate-400">excluded</span>}
                </td>
                {table.gmRow.perMonth.map((v, i) => (
                  <td key={i} className="px-3 py-2.5 text-right tabular-nums text-slate-700">{v > 0 ? fmt$(v) : <span className="text-slate-300">—</span>}</td>
                ))}
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-800 bg-slate-50">{fmt$(table.gmRow.total)}</td>
              </tr>
              {expanded.has('GM') && (
                <tr className="border-b border-slate-50 bg-slate-50/40">
                  <td colSpan={visible.length + 2} className="pl-11 pr-4 py-1.5 text-slate-500">
                    {table.gmRow.names.join(', ') || 'None'} — fixed annual salary ÷ 52 per week, from src/lib/managers.ts
                  </td>
                </tr>
              )}

              {/* Month totals + relative bar */}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-slate-700">Total labor</td>
                {table.monthTotals.map((v, i) => (
                  <td key={i} className="px-3 py-2.5 text-right tabular-nums text-indigo-700">
                    {fmt$(v)}
                    <div className="mt-1 h-1 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${(v / maxMonthTotal) * 100}%` }} />
                    </div>
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right tabular-nums text-indigo-800 bg-slate-100">{fmt$(table.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        Same math as the Est. months in All KPIs, plus Preservation&apos;s check/unboxing hours. Hours come from each person&apos;s Scheduling standard weekly template plus any This Week
        overrides, limited to their employment dates. Hourly pay = paid hours × roster rate, where paid holidays are still paid and hourly managers are
        paid for their total schedule. Salaried pay = annual ÷ 52 per week. A week counts toward the month its Monday falls in, so 5-Monday months cost more.
        Excludes G&amp;A, bonuses, payroll taxes, and benefits. Click a department to see each person.
      </p>
      </>)}
    </div>
  );
}

// ─── Planned vs actual ─────────────────────────────────────────────────────────

const ACTUAL_ONLY = ['G&A', 'Other'] as const;

// Payroll (Rippling) and roster names are usually identical, but match
// loosely so case/punctuation/extra spaces never split one person in two.
const normName = (n: string) => n.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();

interface HistMember { name: string; planned: (number | null)[]; actual: number[] }
interface HistRow    { key: string; planned: (number | null)[]; actual: number[]; members: HistMember[] }

const sum = (xs: (number | null)[]) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

function Variance({ planned, actual, className = '' }: { planned: number | null; actual: number; className?: string }) {
  if (planned === null) return null;
  const diff = actual - planned;
  if (Math.abs(diff) < 0.5) return <div className={`text-[10px] text-slate-400 ${className}`}>on plan</div>;
  const pct = planned > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / planned) * 100)}%)` : '';
  // Over plan = paid more than scheduled.
  return (
    <div className={`text-[10px] font-medium ${diff > 0 ? 'text-rose-600' : 'text-emerald-600'} ${className}`}>
      {diff > 0 ? '+' : '−'}{fmt$(Math.abs(diff))}{pct}
    </div>
  );
}

function PlannedVsActual({ months, loc, range, includeGm, inferredDates }: {
  months: MonthForecast[]; loc: LocFilter; range: 3 | 6 | 12; includeGm: boolean; inferredDates: InferredDate[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const locs = locationsFor(loc);

  // Past + current months with any payroll for the selected location(s).
  const hist = useMemo(() => months
    .filter(m => m.actual && locationsFor(loc).some(l => m.actual![l].paidWeeks > 0))
    .slice(-range), [months, range, loc]);

  const table = useMemo(() => {
    const tag = (name: string, l: string) => loc === 'All' ? `${name} (${l === 'Utah' ? 'UT' : 'GA'})` : name;
    const acts = (m: MonthForecast): [string, LocationMonthActual][] => locationsFor(loc).map(l => [l, m.actual![l]]);

    function buildRow(key: string, withPlan: boolean): HistRow {
      // key -> display name + per-month planned/actual
      const people = new Map<string, HistMember>();
      const person = (id: string, name: string) => {
        if (!people.has(id)) people.set(id, { name, planned: hist.map(() => withPlan ? 0 : null), actual: hist.map(() => 0) });
        return people.get(id)!;
      };
      const planned = hist.map(() => withPlan ? 0 : null) as (number | null)[];
      const actual  = hist.map(() => 0);
      hist.forEach((m, i) => {
        for (const [l, a] of acts(m)) {
          const ad = a.depts[key];
          if (ad) {
            actual[i] += ad.cost;
            for (const p of ad.members) person(`${l}|${normName(p.name)}`, tag(p.name, l)).actual[i] += p.cost;
          }
          if (withPlan) {
            const pd = a.plannedForPaidWeeks.depts[key as typeof DEPTS[number]];
            planned[i] = (planned[i] ?? 0) + pd.cost;
            for (const p of pd.members) {
              if (p.cost <= 0) continue;
              const rec = person(`${l}|${normName(p.name)}`, tag(p.name, l));
              rec.planned[i] = (rec.planned[i] ?? 0) + p.cost;
            }
          }
        }
      });
      const members = [...people.values()].sort((a, b) =>
        Math.abs(sum(b.actual) - sum(b.planned)) - Math.abs(sum(a.actual) - sum(a.planned)) || a.name.localeCompare(b.name));
      return { key, planned, actual, members };
    }

    const deptRows = DEPTS.map(d => buildRow(d, true));
    const gm = hist.map(m => acts(m).reduce((s, [, a]) => s + a.gm.cost, 0));
    const otherRows = ACTUAL_ONLY.map(d => buildRow(d, false)).filter(r => sum(r.actual) > 0);

    const schedPlanned = hist.map((_, i) => deptRows.reduce((s, r) => s + (r.planned[i] ?? 0), 0) + (includeGm ? gm[i] : 0));
    const schedActual  = hist.map((_, i) => deptRows.reduce((s, r) => s + r.actual[i], 0) + (includeGm ? gm[i] : 0));
    const totalPaid    = hist.map((_, i) => schedActual[i] + otherRows.reduce((s, r) => s + r.actual[i], 0));
    return { deptRows, gm, otherRows, schedPlanned, schedActual, totalPaid };
  }, [hist, loc, includeGm]);

  function toggle(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  if (hist.length === 0) {
    return <div className="py-16 text-center text-sm text-slate-500">No payroll uploaded yet for these months.</div>;
  }

  // Only dates inside the shown range changed anything visible here.
  const shownDates = inferredDates.filter(s =>
    locs.includes(s.location as 'Utah' | 'Georgia') && s.week >= hist[0].monthStart);
  const fmtDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const plannedTotal = sum(table.schedPlanned);
  const actualTotal  = sum(table.schedActual);
  const worst = [...table.deptRows]
    .map(r => ({ key: r.key, diff: sum(r.actual) - sum(r.planned) }))
    .sort((a, b) => b.diff - a.diff)[0];
  const rangeLabel = `${hist[0].label} – ${hist[hist.length - 1].label}`;

  // "3/4 wks paid" when a month's payroll isn't all uploaded yet.
  function paidNote(m: MonthForecast): string | null {
    const paid = locs.map(l => m.actual![l].paidWeeks);
    if (paid.every(p => p === m.weeks)) return null;
    if (locs.length === 1 || paid[0] === paid[1]) return `${paid[0]}/${m.weeks} wks paid`;
    return `UT ${paid[0]}/${m.weeks} · GA ${paid[1]}/${m.weeks} wks paid`;
  }

  const cell = (planned: number | null, actual: number, strong = false) => (
    <>
      <div className={`tabular-nums ${strong ? 'font-semibold text-slate-800' : 'text-slate-700'}`}>{actual > 0 ? fmt$(actual) : <span className="text-slate-300">—</span>}</div>
      {planned !== null && <div className="text-[10px] text-slate-400 tabular-nums">plan {fmt$(planned)}</div>}
      <Variance planned={planned} actual={actual} />
    </>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-100 rounded-xl px-4 py-3">
          <div className="text-xs text-slate-500">Actually paid</div>
          <div className="text-xl font-semibold text-slate-800 tabular-nums mt-0.5">{fmt$(actualTotal)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{rangeLabel} · scheduled depts{includeGm ? ' + GMs' : ''}</div>
        </div>
        <div className="bg-white border border-slate-100 rounded-xl px-4 py-3">
          <div className="text-xs text-slate-500">Planned by the schedule</div>
          <div className="text-xl font-semibold text-slate-800 tabular-nums mt-0.5">{fmt$(plannedTotal)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">same weeks</div>
        </div>
        <div className="bg-white border border-slate-100 rounded-xl px-4 py-3">
          <div className="text-xs text-slate-500">Difference</div>
          <div className={`text-xl font-semibold tabular-nums mt-0.5 ${actualTotal > plannedTotal ? 'text-rose-600' : 'text-emerald-600'}`}>
            {actualTotal >= plannedTotal ? '+' : '−'}{fmt$(Math.abs(actualTotal - plannedTotal))}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            {plannedTotal > 0 ? `${actualTotal >= plannedTotal ? '+' : ''}${Math.round(((actualTotal - plannedTotal) / plannedTotal) * 100)}% vs plan` : ''}
            {actualTotal > plannedTotal ? ' · paid more than scheduled' : ' · paid less than scheduled'}
          </div>
        </div>
        <div className="bg-white border border-slate-100 rounded-xl px-4 py-3">
          <div className="text-xs text-slate-500">Most over plan</div>
          <div className="text-xl font-semibold text-slate-800 mt-0.5">{worst && worst.diff > 0 ? worst.key : 'None'}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{worst && worst.diff > 0 ? `+${fmt$(worst.diff)} over ${hist.length} months` : 'every department at or under plan'}</div>
        </div>
      </div>

      {shownDates.length > 0 && (
        <details className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-800">
          <summary className="cursor-pointer">
            <span className="font-semibold">{shownDates.length} start/end dates here come from payroll, not the roster.</span>{' '}
            When someone has no start date, their plan starts at their first paycheck. When someone has been removed from the roster, they&apos;re planned up to
            their last paycheck. Set real dates on the Scheduling roster to make this exact.
          </summary>
          <ul className="mt-2 grid sm:grid-cols-2 gap-x-6 gap-y-0.5">
            {shownDates.map(s => (
              <li key={`${s.location}|${s.dept}|${s.name}|${s.kind}`}>
                {s.name} <span className="text-amber-600">— {s.location} {s.dept}, {s.kind === 'start' ? 'first paid' : 'removed; last paid'} week of {fmtDate(s.week)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="sticky left-0 z-10 bg-slate-50 text-left px-4 py-2.5 font-semibold text-slate-600 min-w-[180px]">Department</th>
                {hist.map(m => (
                  <th key={m.monthStart} className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">
                    {m.label}
                    <div className="text-[10px] font-normal text-slate-400">
                      {paidNote(m) ?? `${m.weeks} wks`}{m.when === 'current' ? ' · this month' : ''}
                    </div>
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right font-semibold text-slate-700 bg-slate-100">Total</th>
              </tr>
            </thead>
            <tbody>
              {table.deptRows.map(row => {
                if (sum(row.actual) === 0 && sum(row.planned) === 0) return null;
                const isOpen = expanded.has(row.key);
                return (
                  <Fragment key={row.key}>
                    <tr className="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer align-top" onClick={() => toggle(row.key)}>
                      <td className="sticky left-0 z-10 bg-white px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">
                        <span className="inline-block w-3 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                        <span className={`inline-block w-2 h-2 rounded-full mr-2 ${DEPT_BAR[row.key as RowKey]}`} />
                        {row.key}
                        <span className="ml-1.5 text-[10px] text-slate-400">{row.members.length} people</span>
                      </td>
                      {hist.map((_, i) => <td key={i} className="px-3 py-2 text-right">{cell(row.planned[i], row.actual[i])}</td>)}
                      <td className="px-4 py-2 text-right bg-slate-50">{cell(sum(row.planned), sum(row.actual), true)}</td>
                    </tr>
                    {isOpen && row.members.map(mem => (
                      <tr key={mem.name} className="border-b border-slate-50 bg-slate-50/40 align-top">
                        <td className="sticky left-0 z-10 bg-slate-50 pl-11 pr-4 py-1.5 text-slate-600 whitespace-nowrap">
                          {mem.name}
                          {sum(mem.planned) === 0 && sum(mem.actual) > 0 && <div className="text-[10px] text-amber-600">paid, not on schedule</div>}
                          {sum(mem.actual) === 0 && sum(mem.planned) > 0 && <div className="text-[10px] text-slate-400">scheduled, no payroll here</div>}
                        </td>
                        {hist.map((_, i) => <td key={i} className="px-3 py-1.5 text-right">{cell(mem.planned[i], mem.actual[i])}</td>)}
                        <td className="px-4 py-1.5 text-right bg-slate-100/60">{cell(sum(mem.planned), sum(mem.actual))}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}

              <tr className={`border-b border-slate-50 align-top ${includeGm ? '' : 'opacity-50'}`}>
                <td className="sticky left-0 z-10 bg-white px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">
                  <span className="inline-block w-3" />
                  <span className={`inline-block w-2 h-2 rounded-full mr-2 ${DEPT_BAR.GM}`} />
                  General managers
                  <div className="pl-5 text-[10px] font-normal text-slate-400">fixed salary — always on plan</div>
                </td>
                {table.gm.map((v, i) => <td key={i} className="px-3 py-2 text-right tabular-nums text-slate-700">{v > 0 ? fmt$(v) : <span className="text-slate-300">—</span>}</td>)}
                <td className="px-4 py-2 text-right tabular-nums font-semibold text-slate-800 bg-slate-50">{fmt$(sum(table.gm))}</td>
              </tr>

              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold align-top">
                <td className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-slate-700">Scheduled departments{includeGm ? ' + GMs' : ''}</td>
                {hist.map((_, i) => <td key={i} className="px-3 py-2 text-right">{cell(table.schedPlanned[i], table.schedActual[i], true)}</td>)}
                <td className="px-4 py-2 text-right bg-slate-100">{cell(plannedTotal, actualTotal, true)}</td>
              </tr>

              {table.otherRows.map(row => {
                const isOpen = expanded.has(row.key);
                return (
                  <Fragment key={row.key}>
                    <tr className="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer" onClick={() => toggle(row.key)}>
                      <td className="sticky left-0 z-10 bg-white px-4 py-2.5 font-medium text-slate-600 whitespace-nowrap">
                        <span className="inline-block w-3 text-slate-400">{isOpen ? '▾' : '▸'}</span>
                        {row.key === 'G&A' ? 'G&A' : 'Other payroll departments'}
                        <span className="ml-1.5 text-[10px] text-slate-400">not scheduled</span>
                      </td>
                      {row.actual.map((v, i) => <td key={i} className="px-3 py-2.5 text-right tabular-nums text-slate-600">{v > 0 ? fmt$(v) : <span className="text-slate-300">—</span>}</td>)}
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 bg-slate-50">{fmt$(sum(row.actual))}</td>
                    </tr>
                    {isOpen && row.members.map(mem => (
                      <tr key={mem.name} className="border-b border-slate-50 bg-slate-50/40">
                        <td className="sticky left-0 z-10 bg-slate-50 pl-11 pr-4 py-1.5 text-slate-600 whitespace-nowrap">{mem.name}</td>
                        {mem.actual.map((v, i) => <td key={i} className="px-3 py-1.5 text-right tabular-nums text-slate-600">{v > 0 ? fmt$(v) : <span className="text-slate-200">—</span>}</td>)}
                        <td className="px-4 py-1.5 text-right tabular-nums text-slate-600 bg-slate-100/60">{fmt$(sum(mem.actual))}</td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}

              <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                <td className="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-slate-700">Total paid</td>
                {table.totalPaid.map((v, i) => <td key={i} className="px-3 py-2.5 text-right tabular-nums text-indigo-700">{fmt$(v)}</td>)}
                <td className="px-4 py-2.5 text-right tabular-nums text-indigo-800 bg-slate-100">{fmt$(sum(table.totalPaid))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        <span className="font-medium text-slate-500">Actual</span> is payroll from the weekly labor upload (gross pay, Checks &amp; Unboxing counted as Preservation), plus
        salaried managers&apos; pay. <span className="font-medium text-slate-500">Plan</span> is what the Scheduling page&apos;s saved hours for those weeks cost at each
        person&apos;s pay rate on the roster. Past months use <em>today&apos;s</em> rates, since past rates aren&apos;t saved, so a raise since then
        shows up in the plan too. A month still waiting on payroll is compared only for the weeks already paid.
        <span className="text-rose-600"> Red</span> = paid more than scheduled; <span className="text-emerald-600">green</span> = paid less. Click a department to see each person, sorted by largest difference.
      </p>
    </div>
  );
}
