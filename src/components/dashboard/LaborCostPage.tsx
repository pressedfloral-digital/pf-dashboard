'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { MonthForecast, DeptForecast } from '@/app/api/labor-forecast/route';
import type { MemberCostLine } from '@/lib/scheduleProjection';

// Admin-only: estimated monthly labor cost per department, projected from the
// Scheduling rosters/schedules and each person's pay (see /api/labor-forecast).

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
  const [error, setError]     = useState<string | null>(null);
  const [horizon, setHorizon] = useState<6 | 12>(6);
  const [loc, setLoc]         = useState<LocFilter>('All');
  const [includeGm, setIncludeGm] = useState(true);
  const [expanded, setExpanded]   = useState<Set<RowKey>>(new Set());

  useEffect(() => {
    fetch('/api/labor-forecast?months=12')
      .then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'Failed to load labor forecast');
        setMonths(d.months);
      })
      .catch(e => setError(e.message));
  }, []);

  const visible = useMemo(() => (months ?? []).slice(0, horizon), [months, horizon]);

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
          {([6, 12] as const).map(h => (
            <button key={h} onClick={() => setHorizon(h)}
              className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                horizon === h ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}>
              {h} months
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={includeGm} onChange={e => setIncludeGm(e.target.checked)} className="accent-indigo-600" />
          Include general managers in totals
        </label>
      </div>

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
        Uses the same math as the Est. months in All KPIs. Hours come from each person&apos;s Scheduling standard weekly template plus any This Week
        overrides, limited to their employment dates. Hourly pay = paid hours × roster rate, where paid holidays are still paid and hourly managers are
        paid for their total schedule. Salaried pay = annual ÷ 52 per week. A week counts toward the month its Monday falls in, so 5-Monday months cost more.
        Excludes G&amp;A, bonuses, payroll taxes, and benefits. Click a department to see each person.
      </p>
    </div>
  );
}
