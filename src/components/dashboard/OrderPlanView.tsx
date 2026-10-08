'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { applyEdits, type OrderEdits, type OrderPlan, type PlanRow } from '@/lib/katanaPlan';
import { mondayOf, addWeeks as addWeeksIso } from '@/lib/designInventory';
import SupplierPoCard, { OrderByBadge, fmtWeek, label, urgency, weeksUntilShort, type EditAction } from './SupplierPoCard';

function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// "12 inches (≈ 1 Roll)" when Katana has a purchase unit to convert to.
function withPurchaseUnit(r: PlanRow, qty: number): string {
  const base = `${fmtQty(qty)}${r.uom && r.uom !== 'each' && r.uom !== 'pcs' ? ` ${r.uom}` : ''}`;
  if (!r.purchaseUom || !r.purchaseConversion) return base;
  const units = Math.ceil(qty / r.purchaseConversion);
  return `${base} (≈ ${units} ${r.purchaseUom}${units === 1 ? '' : 's'})`;
}

const NO_SUPPLIER = 'No default supplier in Katana';

function bySupplierThenName(a: PlanRow, b: PlanRow): number {
  return (a.supplier ?? '~').localeCompare(b.supplier ?? '~') || label(a).localeCompare(label(b), undefined, { numeric: true });
}

function downloadCsv(plan: OrderPlan, weeks: string[], generatedAt: string) {
  const esc = (v: string | number) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows: (string | number)[][] = [[
    'Supplier', 'Lead time (weeks)', 'Order by', 'Need by', 'To order now', 'Component', 'Options', 'SKU', 'Category', 'Unit', 'In stock', 'On order', 'Needed through end of plan',
    ...weeks.map(w => `To order — week of ${w}`), 'Total to order', 'Purchase unit', 'Total to order (purchase units)',
  ]];
  [...plan.rows].sort(bySupplierThenName).forEach(r => rows.push([
    r.supplier ?? '', r.leadWeeks, r.orderBy ?? '', r.firstShortWeek ?? '', r.orderNowQty || '', r.name, r.options, r.sku ?? '', r.category, r.uom, r.inStock, r.onOrder, r.totalNeeded,
    ...weeks.map(w => r.toOrder[w] ?? ''), r.totalToOrder,
    r.purchaseUom ?? '', r.purchaseConversion && r.totalToOrder ? Math.ceil(r.totalToOrder / r.purchaseConversion) : '',
  ]));
  const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `katana-order-list-${plan.location.toLowerCase()}-${generatedAt.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function OrderPlanView({ plan: basePlan, generatedAt, edits: savedEdits }: {
  plan:        OrderPlan;
  generatedAt: string;
  edits:       OrderEdits;
}) {
  const thisWeek = mondayOf(new Date().toISOString());
  // Hand edits (quantities, deletions), applied on top of the computed list
  // so a change shows immediately without rebuilding the schedule.
  const [edits, setEdits] = useState<OrderEdits>(savedEdits);
  const plan = useMemo(() => applyEdits(basePlan, edits, thisWeek), [basePlan, edits, thisWeek]);
  const editCount = Object.keys(edits).length;

  async function saveEdit(variantId: number, action: EditAction, qty?: number) {
    const res = await fetch('/api/inventory-order-edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: basePlan.location, variantId, action, qty }),
    });
    const json = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
    if (!res.ok) throw new Error(json.error ?? `Server returned ${res.status}`);
    setEdits(json as OrderEdits);
  }

  // Design weeks that have scheduled work, this week through year end — or a
  // little into next year once the longest lead time reaches past Dec 31.
  const weeks = plan.weeks;
  const pastYearEnd = !!plan.through && plan.through.slice(0, 4) > weeks[0]?.slice(0, 4);
  const thruText = pastYearEnd ? `through the week of ${fmtWeek(plan.through)}` : 'through year end';
  const thruShort = pastYearEnd ? fmtWeek(plan.through) : 'YE';
  const short = useMemo(() => plan.rows.filter(r => r.totalToOrder > 0), [plan]);
  const firstShort = weeks.find(w => short.some(r => r.toOrder[w])) ?? weeks[0] ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [showSubs, setShowSubs] = useState(false);
  const [groupBy, setGroupBy] = useState<'week' | 'supplier'>('supplier');
  const [canOrder, setCanOrder] = useState(false);
  const week = picked ?? firstShort;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled) setCanOrder(!!d?.permissions?.[plan.location === 'Georgia' ? 'canEditGeorgia' : 'canEditUtah']); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [plan.location]);

  const dueNow = short.filter(r => r.orderNowQty > 0);
  const lateCount = dueNow.filter(r => urgency(r.orderBy, thisWeek) === 'late').length;
  const shortNowCount = dueNow.filter(r => r.firstShortWeek && weeksUntilShort(r.firstShortWeek, thisWeek) <= 0).length;
  const dueSuppliers = [...new Set(dueNow.map(r => r.supplier ?? NO_SUPPLIER))];

  // Selected week's order list, grouped by supplier.
  const bySupplier = useMemo(() => {
    const map = new Map<string, PlanRow[]>();
    short.filter(r => week && r.toOrder[week]).forEach(r => {
      const k = r.supplier ?? NO_SUPPLIER;
      map.set(k, [...(map.get(k) ?? []), r]);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [short, week]);

  // Every supplier the schedule uses: ones with something to order first
  // (soonest order-by date first), then ones stock already covers.
  const allBySupplier = useMemo(() => {
    // Plain string compare: ISO dates sort before the '~' sentinel (localeCompare puts '~' first).
    const cmp = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
    const orderKey = (r: PlanRow) => (r.totalToOrder > 0 ? r.orderBy : null) ?? '~';
    const map = new Map<string, PlanRow[]>();
    [...plan.rows]
      .sort((a, b) => cmp(orderKey(a), orderKey(b)) || label(a).localeCompare(label(b), undefined, { numeric: true }))
      .forEach(r => {
        const k = r.supplier ?? NO_SUPPLIER;
        map.set(k, [...(map.get(k) ?? []), r]);
      });
    // Rows are already sorted, so each supplier's first row is its soonest order-by.
    return [...map.entries()].sort((a, b) => cmp(orderKey(a[1][0]), orderKey(b[1][0])) || a[0].localeCompare(b[0]));
  }, [plan.rows]);

  const gridRows = showAll ? plan.rows : short;
  const categories = [...new Set(gridRows.map(r => r.category))];
  const unmatchedLines = plan.unmatched.reduce((s, u) => s + u.count, 0);
  const substitutedLines = plan.substitutions.reduce((s, u) => s + u.count, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">What to order — Katana stock vs. the Design schedule</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-3xl">
            Each scheduled order (frame, backing and glass) is broken into its Katana recipe. Each week&apos;s components are
            taken out of {plan.location}&apos;s Katana stock plus what&apos;s already on order, in schedule order. The number shown
            for a week is how much more you need to order so it&apos;s on hand by that Monday. Katana&apos;s &ldquo;committed&rdquo;
            figure isn&apos;t subtracted, because these orders are the demand. Managers can edit any quantity
            or delete an item from the list; edits are shared and stay until someone resets them.
          </p>
        </div>
        <button
          onClick={() => downloadCsv(plan, weeks, generatedAt)}
          className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        >
          Download order list
        </button>
      </div>

      <div className="text-xs text-slate-500">
        {short.length === 0
          ? <span className="text-emerald-700 font-medium">Stock plus open orders covers every scheduled order {thruText}.</span>
          : <><span className="font-semibold text-slate-700">{short.length} components</span> need ordering {thruText}
              {firstShort && <> · first shortfall week of {fmtWeek(firstShort)}</>}</>}
        {editCount > 0 && <> · <span className="text-indigo-700">{editCount} item{editCount === 1 ? '' : 's'} edited or deleted by hand</span></>}
        {' · '}{plan.matchedLines.toLocaleString()} of {plan.totalLines.toLocaleString()} scheduled lines matched to a Katana recipe
        {unmatchedLines > 0 && (
          <> · <button onClick={() => setShowUnmatched(s => !s)} className="text-amber-700 underline">
            {unmatchedLines} products not counted
          </button></>
        )}
        {substitutedLines > 0 && (
          <> · <button onClick={() => setShowSubs(s => !s)} className="text-sky-700 underline">
            {substitutedLines} counted with a stand-in recipe
          </button></>
        )}
      </div>

      {dueNow.length > 0 && (
        <div className={`rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-1 ${
          lateCount ? 'border-rose-200 bg-rose-50 text-rose-900' : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}>
          <span className="font-semibold">
            Order now: {dueNow.length} item{dueNow.length === 1 ? '' : 's'}
            {lateCount > 0 && <> ({lateCount} already past their order-by date{shortNowCount > 0 ? `, ${shortNowCount} short now` : ''})</>}
          </span>
          <span className="text-xs">from {dueSuppliers.join(', ')}</span>
          <span className="text-xs opacity-75">
            Lead times: Border and Square 6 wks, InLine Ovals 8 wks, everyone else 6 wks before the Monday it&apos;s needed. Ernest Packaging items aren&apos;t counted.
          </span>
          {groupBy !== 'supplier' && (
            <button onClick={() => setGroupBy('supplier')} className="ml-auto text-xs underline">Create POs by supplier</button>
          )}
        </div>
      )}

      {showSubs && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
          <div className="font-semibold mb-1">Counted with a stand-in Katana recipe</div>
          <p className="mb-2 text-sky-800">
            Katana has no exact variant for these. Boutonniere pieces use the 6x8 recipe, and Antique Gold Floral
            square singles use the Antique Gold 8x8 recipe, because Katana has no Antique Gold Floral 8x8 frame.
          </p>
          <ul className="space-y-0.5">
            {plan.substitutions.map(u => (
              <li key={`${u.product}|${u.variant}`}>
                {u.count}× {u.product}{u.variant && u.variant !== 'Default Title' ? ` · ${u.variant}` : ''}
                <span className="text-sky-700"> → {u.katana}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showUnmatched && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <div className="font-semibold mb-1">Not counted: no matching Katana product or recipe</div>
          <p className="mb-2 text-amber-800">Add these variants and recipes in Katana to include them in the order list.</p>
          <ul className="space-y-0.5">
            {plan.unmatched.map(u => (
              <li key={`${u.product}|${u.variant}|${u.reason}`}>
                {u.count}× {u.product}{u.variant && u.variant !== 'Default Title' ? ` · ${u.variant}` : ''}
                <span className="text-amber-700"> ({u.reason})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Order list: one week, or every week by supplier ── */}
      <div className="space-y-3">
        <div className="flex gap-1.5">
          {([['week', 'By week'], ['supplier', 'By supplier (all weeks)']] as const).map(([id, name]) => (
            <button
              key={id}
              onClick={() => setGroupBy(id)}
              className={`px-3 py-1 text-xs rounded-full font-medium ${
                groupBy === id ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        {groupBy === 'supplier' && (
          allBySupplier.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-emerald-700">
              The schedule doesn&apos;t use any Katana components yet.
            </div>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {allBySupplier.map(([supplier, rows]) => (
                <SupplierPoCard
                  key={`${generatedAt}|${supplier}|${rows.map(r => r.edit?.at ?? '').join(',')}`}
                  supplier={supplier}
                  supplierId={rows[0].supplierId}
                  rows={rows}
                  location={plan.location}
                  weeks={weeks}
                  thisWeek={thisWeek}
                  canOrder={canOrder}
                  through={plan.through}
                  thruShort={thruShort}
                  onEdit={saveEdit}
                />
              ))}
            </div>
          )
        )}

        {groupBy === 'week' && <>
        <div className="flex flex-wrap gap-1.5">
          {weeks.map(w => {
            const n = short.filter(r => r.toOrder[w]).length;
            return (
              <button
                key={w}
                onClick={() => setPicked(w)}
                className={`px-3 py-1 text-xs rounded-full font-medium ${
                  week === w ? 'bg-indigo-600 text-white'
                    : n ? 'bg-white border border-rose-200 text-rose-700 hover:bg-rose-50'
                    : 'bg-white border border-slate-200 text-slate-400 hover:bg-slate-50'
                }`}
              >
                {fmtWeek(w)}{n ? ` · ${n}` : ''}
              </button>
            );
          })}
        </div>

        {week && (
          bySupplier.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-emerald-700">
              Nothing new to order for the week of {fmtWeek(week)}. Stock and open orders cover it.
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {bySupplier.map(([supplier, rows]) => (
                <div key={supplier} className="rounded-xl border border-slate-200 bg-white">
                  <div className="px-4 py-2 border-b border-slate-100 flex justify-between text-sm font-semibold text-slate-700">
                    <span>{supplier}</span>
                    <span className="text-xs font-normal text-slate-400">order for week of {fmtWeek(week)}</span>
                  </div>
                  <table className="min-w-full text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="px-4 py-1.5 text-left font-medium">Component</th>
                        <th className="px-2 py-1.5 text-right font-medium">Needed this wk</th>
                        <th className="px-4 py-1.5 text-right font-medium">Order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {rows.map(r => (
                        <tr key={r.variantId}>
                          <td className="px-4 py-1.5 text-slate-700">
                            {label(r)}
                            {r.sku && <span className="text-slate-400"> · {r.sku}</span>}
                            <div className="mt-0.5"><OrderByBadge orderBy={addWeeksIso(week, -r.leadWeeks)} needBy={week} thisWeek={thisWeek} /></div>
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-500 whitespace-nowrap">{fmtQty(r.needed[week] ?? 0)}</td>
                          <td className="px-4 py-1.5 text-right font-semibold text-rose-700 whitespace-nowrap">{withPurchaseUnit(r, r.toOrder[week])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )
        )}
        </>}
      </div>

      {/* ── Components × week ── */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
          Show every component the schedule uses, including ones stock covers ({plan.rows.length})
        </label>
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium">Component</th>
                <th className="px-3 py-2 text-left font-medium">Supplier</th>
                <th className="px-2 py-2 text-left font-medium">Order by</th>
                <th className="px-2 py-2 text-right font-medium">In stock</th>
                <th className="px-2 py-2 text-right font-medium">On order</th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap">Needed thru {thruShort}</th>
                {weeks.map(w => (
                  <th key={w} className="px-2 py-2 text-center font-medium whitespace-nowrap">{fmtWeek(w)}</th>
                ))}
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap">To order</th>
              </tr>
            </thead>
            <tbody>
              {gridRows.length === 0 && (
                <tr><td colSpan={7 + weeks.length} className="px-3 py-6 text-center text-slate-500">Nothing to order.</td></tr>
              )}
              {categories.map(cat => (
                <Fragment key={cat}>
                  <tr className="bg-slate-50/60">
                    <td colSpan={7 + weeks.length} className="sticky left-0 px-3 py-1 font-semibold text-slate-600">{cat}</td>
                  </tr>
                  {gridRows.filter(r => r.category === cat).map(r => (
                    <tr key={r.variantId} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="sticky left-0 bg-white px-3 py-1.5 text-slate-700 whitespace-nowrap">
                        {label(r)}
                        {r.uom && r.uom !== 'each' && r.uom !== 'pcs' && <span className="text-slate-400"> ({r.uom})</span>}
                      </td>
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{r.supplier ?? '—'}</td>
                      <td className="px-2 py-1.5"><OrderByBadge orderBy={r.totalToOrder ? r.orderBy : null} needBy={r.firstShortWeek} thisWeek={thisWeek} /></td>
                      <td
                        className={`px-2 py-1.5 text-right ${r.negativeStock !== null ? 'text-amber-600' : 'text-slate-700'}`}
                        title={r.negativeStock !== null ? `Katana shows ${fmtQty(r.negativeStock)}, counted as 0` : undefined}
                      >
                        {fmtQty(r.inStock)}{r.negativeStock !== null && '*'}
                      </td>
                      <td className="px-2 py-1.5 text-right text-slate-500">{r.onOrder ? fmtQty(r.onOrder) : ''}</td>
                      <td className="px-2 py-1.5 text-right text-slate-700">{fmtQty(r.totalNeeded)}</td>
                      {weeks.map(w => (
                        <td
                          key={w}
                          className={`px-2 py-1.5 text-center ${r.toOrder[w] ? 'bg-rose-50 font-semibold text-rose-700' : 'text-slate-300'}`}
                          title={`Uses ${fmtQty(r.needed[w] ?? 0)} this week`}
                        >
                          {r.toOrder[w] ? fmtQty(r.toOrder[w]) : r.needed[w] ? '·' : ''}
                        </td>
                      ))}
                      <td className={`px-3 py-1.5 text-center font-semibold whitespace-nowrap ${r.totalToOrder ? 'text-rose-700' : 'text-emerald-600'}`}>
                        {r.totalToOrder ? withPurchaseUnit(r, r.totalToOrder) : '✓'}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400">
          Red cells = how much more to order for that week. A dot means the week uses some, but stock covers it. Hover a cell to see the week&apos;s usage.
          * Katana shows negative stock for this item; it&apos;s counted as 0.
        </p>
      </div>
    </div>
  );
}
