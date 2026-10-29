'use client';

import { useMemo, useState } from 'react';
import { applyEdits, type OrderEdits, type OrderPlan, type PlanRow } from '@/lib/katanaPlan';
import { mondayOf } from '@/lib/designInventory';
import { fmtWeek, label } from './SupplierPoCard';
import { HelpTip } from './HelpTip';

// A sheet to send a supplier: when each of their items has to arrive, as far
// ahead as the Design schedule reaches. Our own stock levels stay off it.

const NO_SUPPLIER = 'No default supplier in Katana';

type Mode = 'deliveries' | 'usage';
type Grouping = 'week' | 'month';

interface Period { key: string; label: string; weeks: string[] }

interface SheetRow {
  row:     PlanRow;
  unit:    string;                  // purchase unit when Katana has one, else the stock unit
  byPeriod: Record<string, number>;
  total:   number;
  firstNeeded: string | null;       // first week with a quantity
}

function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtMonth(key: string): string {
  return new Date(key + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function periodsFor(weeks: string[], grouping: Grouping): Period[] {
  if (grouping === 'week') return weeks.map(w => ({ key: w, label: fmtWeek(w), weeks: [w] }));
  const map = new Map<string, string[]>();
  weeks.forEach(w => map.set(w.slice(0, 7), [...(map.get(w.slice(0, 7)) ?? []), w]));
  return [...map.entries()].map(([key, ws]) => ({ key, label: fmtMonth(key), weeks: ws }));
}

function unitName(r: PlanRow, plural: boolean): string {
  const u = r.purchaseUom && r.purchaseConversion ? r.purchaseUom : r.uom;
  if (!u || /^(pcs?|each|ea)$/i.test(u)) return 'each';
  return plural && !/s$/i.test(u) ? `${u}s` : u;
}

// Per-period quantities, in purchase units when Katana has a conversion.
// Rounds the running total up rather than each period, so a roll split across
// three weeks isn't counted as three rolls.
function sheetRow(r: PlanRow, periods: Period[], mode: Mode): SheetRow {
  const src = mode === 'deliveries' ? r.toOrder : r.needed;
  const conv = r.purchaseUom && r.purchaseConversion ? r.purchaseConversion : null;
  const byPeriod: Record<string, number> = {};
  let cum = 0, shown = 0;
  let firstNeeded: string | null = null;
  for (const p of periods) {
    const raw = p.weeks.reduce((s, w) => s + (src[w] ?? 0), 0);
    if (raw > 0) firstNeeded ??= p.weeks.find(w => src[w]) ?? null;
    cum += raw;
    const upTo = conv ? Math.ceil(Math.round(cum / conv * 1000) / 1000) : Math.round(cum * 100) / 100;
    const q = upTo - shown;
    if (q > 0) byPeriod[p.key] = q;
    shown = upTo;
  }
  return { row: r, unit: unitName(r, shown !== 1), byPeriod, total: shown, firstNeeded };
}

function downloadCsv(supplier: string, location: string, mode: Mode, periods: Period[], rows: SheetRow[], generatedAt: string) {
  const esc = (v: string | number) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines: (string | number)[][] = [
    [`Pressed Floral ${location} — projected ${mode === 'deliveries' ? 'deliveries needed' : 'usage'} from ${supplier}`],
    [`Generated ${generatedAt.slice(0, 10)}. ${mode === 'deliveries' ? 'Quantity needed on hand by the Monday of each week.' : 'Quantity we expect to use each week.'}`],
    [],
    ['Item', 'SKU', 'Unit', 'First needed', ...periods.map(p => p.weeks.length === 1 ? `Week of ${p.key}` : p.label), 'Total'],
  ];
  rows.forEach(s => lines.push([
    label(s.row), s.row.sku ?? '', s.unit, s.firstNeeded ?? '',
    ...periods.map(p => s.byPeriod[p.key] ?? ''), s.total,
  ]));
  const blob = new Blob([lines.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  a.download = `${slug}-forecast-${location.toLowerCase()}-${generatedAt.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function SupplierForecastView({ plan: basePlan, generatedAt, edits }: {
  plan:        OrderPlan;
  generatedAt: string;
  edits:       OrderEdits;
}) {
  const thisWeek = mondayOf(new Date().toISOString());
  const plan = useMemo(() => applyEdits(basePlan, edits, thisWeek), [basePlan, edits, thisWeek]);

  // Suppliers with something to order first (soonest order-by), then the rest by name.
  const suppliers = useMemo(() => {
    const map = new Map<string, PlanRow[]>();
    plan.rows.filter(r => !r.removed).forEach(r => {
      const k = r.supplier ?? NO_SUPPLIER;
      map.set(k, [...(map.get(k) ?? []), r]);
    });
    return [...map.entries()]
      .map(([name, rows]) => {
        const dates = rows.filter(r => r.totalToOrder > 0 && r.orderBy).map(r => r.orderBy!).sort();
        return { name, rows, shortCount: rows.filter(r => r.totalToOrder > 0).length, orderBy: dates[0] ?? null, leadWeeks: rows[0].leadWeeks };
      })
      .sort((a, b) => (a.orderBy ?? '~') < (b.orderBy ?? '~') ? -1 : (a.orderBy ?? '~') > (b.orderBy ?? '~') ? 1 : a.name.localeCompare(b.name));
  }, [plan.rows]);

  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('deliveries');
  const [grouping, setGrouping] = useState<Grouping>('week');
  const supplier = suppliers.find(s => s.name === picked) ?? suppliers[0];

  const periods = useMemo(() => periodsFor(plan.weeks, grouping), [plan.weeks, grouping]);
  const rows = useMemo(() => (supplier?.rows ?? [])
    .map(r => sheetRow(r, periods, mode))
    .filter(s => s.total > 0)
    .sort((a, b) => label(a.row).localeCompare(label(b.row), undefined, { numeric: true })), [supplier, periods, mode]);
  const shownPeriods = periods.filter(p => rows.some(s => s.byPeriod[p.key]));
  const firstNeeded = rows.map(s => s.firstNeeded).filter((w): w is string => !!w).sort()[0] ?? null;
  const pastYearEnd = !!plan.through && plan.through.slice(0, 4) > (plan.weeks[0] ?? '').slice(0, 4);

  if (!supplier) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        The schedule doesn&apos;t use any Katana components yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Printing shows only the sheet. */}
      <style>{`
        @media print {
          @page { size: landscape; margin: 0.5in; }
          body * { visibility: hidden; }
          .supplier-sheet, .supplier-sheet * { visibility: visible; }
          .supplier-sheet { position: absolute; left: 0; top: 0; width: 100%; border: 0 !important; }
          .supplier-sheet .overflow-x-auto { overflow: visible !important; }
        }
      `}</style>

      <div>
        <h2 className="text-sm font-semibold text-slate-700"><HelpTip id="inv.view.supplier">Supplier forecast — what each supplier needs to send, and when</HelpTip></h2>
        <p className="text-xs text-slate-500 mt-1 max-w-3xl">
          Pick a supplier to get a sheet you can print, save as PDF or download as a spreadsheet and send them.
          &ldquo;Deliveries needed&rdquo; is what has to arrive by each Monday beyond {plan.location}&apos;s Katana stock and open purchase
          orders (the same numbers as What to order, including manager edits). &ldquo;Full usage&rdquo; is everything Design expects to use, for
          suppliers who plan from total demand. Stock levels and prices are left off the sheet.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={supplier.name}
          onChange={e => setPicked(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700"
        >
          {suppliers.map(s => (
            <option key={s.name} value={s.name}>
              {s.name}{s.shortCount ? ` — ${s.shortCount} to order${s.orderBy ? `, order by ${fmtWeek(s.orderBy)}` : ''}` : ' — covered'}
            </option>
          ))}
        </select>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {([['deliveries', 'Deliveries needed'], ['usage', 'Full usage']] as const).map(([id, name]) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={`px-3 py-1.5 text-xs font-medium ${mode === id ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {([['week', 'By week'], ['month', 'By month']] as const).map(([id, name]) => (
            <button
              key={id}
              onClick={() => setGrouping(id)}
              className={`px-3 py-1.5 text-xs font-medium ${grouping === id ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => window.print()}
            disabled={!rows.length}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Print / Save PDF
          </button>
          <button
            onClick={() => downloadCsv(supplier.name, plan.location, mode, shownPeriods, rows, generatedAt)}
            disabled={!rows.length}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Download CSV
          </button>
        </div>
      </div>

      <div className="supplier-sheet rounded-xl border border-slate-200 bg-white">
        <div className="px-5 py-4 border-b border-slate-100">
          <div className="text-xs uppercase tracking-wide text-slate-400">Pressed Floral · {plan.location}</div>
          <div className="text-lg font-semibold text-slate-800">
            {mode === 'deliveries' ? 'Projected deliveries needed' : 'Projected usage'} — {supplier.name}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Prepared {fmtWeek(generatedAt.slice(0, 10))} · covers {fmtWeek(plan.weeks[0] ?? thisWeek)} through {pastYearEnd ? `the week of ${fmtWeek(plan.through)}` : 'year end'}
            {mode === 'deliveries' && firstNeeded && <> · first delivery needed by <span className="font-semibold text-slate-700">{fmtWeek(firstNeeded)}</span></>}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {mode === 'deliveries'
              ? <>Quantities are what we need on hand by the Monday of each {grouping === 'week' ? 'week' : 'month’s first scheduled week'}. Anything already on order with you is accounted for.</>
              : <>Quantities are what we expect to use each {grouping}, before stock on hand or open orders.</>}
            {' '}This is a forecast from our current production schedule and may change.
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-emerald-700">
            {mode === 'deliveries'
              ? `Nothing more needed from ${supplier.name}. Stock and open orders cover the schedule.`
              : `The schedule doesn't use anything from ${supplier.name}.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-left font-medium">SKU</th>
                  <th className="px-3 py-2 text-left font-medium">Unit</th>
                  {shownPeriods.map(p => (
                    <th key={p.key} className="px-2 py-2 text-center font-medium whitespace-nowrap">
                      {grouping === 'week' && <div className="text-[10px] font-normal text-slate-400">{mode === 'deliveries' ? 'by' : 'wk of'}</div>}
                      {p.label}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-center font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(s => (
                  <tr key={s.row.variantId}>
                    <td className="px-4 py-1.5 text-slate-700 min-w-56">{label(s.row)}</td>
                    <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{s.row.sku ?? ''}</td>
                    <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{s.unit}</td>
                    {shownPeriods.map(p => (
                      <td key={p.key} className={`px-2 py-1.5 text-center ${s.byPeriod[p.key] ? 'font-semibold text-slate-800' : 'text-slate-300'}`}>
                        {s.byPeriod[p.key] ? fmtQty(s.byPeriod[p.key]) : ''}
                      </td>
                    ))}
                    <td className="px-4 py-1.5 text-center font-semibold text-slate-800">{fmtQty(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
