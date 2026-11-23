'use client';

import { Fragment, useMemo, useState } from 'react';
import { applyEdits, type OrderEdits, type OrderPlan, type PlanRow } from '@/lib/katanaPlan';
import { mondayOf, addWeeks as addWeeksIso } from '@/lib/designInventory';
import SupplierPoCard, { availableTitle, OrderByBadge, fmtWeek, label, urgency, weeksUntilShort, type EditAction } from './SupplierPoCard';
import { HelpTip } from './HelpTip';
import { useCurrentUser } from '@/hooks/useCurrentUser';

function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "12 due Jan 5 (PO-300) · 4 no date" for the On order cell's hover.
// Units on POs past their arrival date, and the week stock runs short if
// they don't come (before the next on-time PO arrives). Counted as here now
// in the plan itself, so this only flags them.
interface OverdueInfo { qty: number; pos: NonNullable<PlanRow['arrivals']>; shortFrom: string | null }
function overdueInfo(r: PlanRow, weeks: string[]): OverdueInfo | null {
  const pos = r.arrivals?.filter(a => a.overdue) ?? [];
  if (!pos.length) return null;
  const later = r.arrivals!.filter(a => !a.overdue);
  let cum = 0, shortFrom: string | null = null;
  for (const w of weeks) {
    const use = r.needed[w] ?? 0;
    if (!use) continue;
    cum += use;
    const arrived = (r.undatedOnOrder ?? 0) + later.filter(a => a.date <= w).reduce((t, a) => t + a.qty, 0);
    if (cum > r.inStock + arrived + 1e-9) { shortFrom = w; break; }
  }
  return { qty: pos.reduce((t, a) => t + a.qty, 0), pos, shortFrom };
}

function arrivalsTitle(r: PlanRow): string | undefined {
  if (!r.arrivals) return r.onOrder ? 'Arrival dates unknown' : undefined;
  const parts = r.arrivals.map(a => `${fmtQty(a.qty)} due ${fmtDate(a.date)}${a.overdue ? ' (overdue, counted as here now)' : ''} — ${a.poNo.trim()}`);
  if (r.undatedOnOrder) parts.push(`${fmtQty(r.undatedOnOrder)} with no PO arrival date (counted as here now)`);
  return parts.join('\n') || undefined;
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
    'Supplier', 'Lead time (weeks)', 'Order by', 'Need by', 'To order now', 'Component', 'Options', 'SKU', 'Category', 'Unit', 'In stock (Katana)', 'In designs not shipped', 'Available', 'On order', 'On order arrives', 'On overdue POs', 'Short from if overdue POs don\'t come', 'Expedite qty', 'Expedite by', 'Needed through end of plan',
    ...weeks.map(w => `To order — week of ${w}`), 'Total to order', 'Purchase unit', 'Total to order (purchase units)',
  ]];
  [...plan.rows].sort(bySupplierThenName).forEach(r => rows.push([
    r.supplier ?? '', r.leadWeeks, r.orderBy ?? '', r.firstShortWeek ?? '', r.orderNowQty || '', r.name, r.options, r.sku ?? '', r.category, r.uom, r.katanaStock ?? r.inStock, r.alreadyUsed ?? 0, r.inStock, r.onOrder,
    (r.arrivals ?? []).map(a => `${fmtQty(a.qty)} ${a.date} ${a.poNo}`).join('; '),
    overdueInfo(r, plan.weeks)?.qty ?? '', overdueInfo(r, plan.weeks)?.shortFrom ?? '', r.expedite?.qty ?? '', r.expedite?.needBy ?? '', r.totalNeeded,
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

export default function OrderPlanView({ plan: basePlan, generatedAt, edits: savedEdits, onEditsChange }: {
  plan:        OrderPlan;
  generatedAt: string;
  edits:       OrderEdits;
  onEditsChange?: (edits: OrderEdits) => void;
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
    onEditsChange?.(json as OrderEdits);
  }

  // Design weeks that have scheduled work, this week through the last week any
  // known order is scheduled (never earlier than year end).
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
  // The real signed-in user, as before: the order API checks their access.
  const { realUser } = useCurrentUser();
  const canOrder = !!realUser?.permissions[plan.location === 'Georgia' ? 'canEditGeorgia' : 'canEditUtah'];
  const week = picked ?? firstShort;

  const dueNow = short.filter(r => r.orderNowQty > 0);
  // On order but arriving after the schedule needs it, soonest need first.
  const expedites = useMemo(() => plan.rows.filter(r => r.expedite && !r.removed)
    .sort((a, b) => a.expedite!.needBy.localeCompare(b.expedite!.needBy) || (a.supplier ?? '~').localeCompare(b.supplier ?? '~')), [plan.rows]);
  const arrivalsKnown = plan.rows.some(r => r.arrivals !== undefined);
  // Waiting on overdue POs: soonest-needed first, then ones stock covers anyway.
  const overdue = useMemo(() => plan.rows
    .filter(r => !r.removed)
    .map(r => ({ r, o: overdueInfo(r, weeks) }))
    .filter((x): x is { r: PlanRow; o: OverdueInfo } => !!x.o)
    .sort((a, b) => (a.o.shortFrom ?? '~').localeCompare(b.o.shortFrom ?? '~') || (a.r.supplier ?? '~').localeCompare(b.r.supplier ?? '~')),
  [plan.rows, weeks]);
  const overdueById = useMemo(() => new Map(overdue.map(x => [x.r.variantId, x.o])), [overdue]);
  const [showOverdue, setShowOverdue] = useState(false);
  const overdueNeeded = overdue.filter(x => x.o.shortFrom);
  const overdueShown = showOverdue ? overdue : overdueNeeded;
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
          <h2 className="text-sm font-semibold text-slate-700"><HelpTip id="inv.plan.title">What to order — Katana stock vs. the Design schedule</HelpTip></h2>
          <p className="text-xs text-slate-500 mt-1 max-w-3xl">
            Each scheduled order (frame, backing and glass) is broken into its Katana recipe. Each week&apos;s components are
            taken out of {plan.location}&apos;s available stock plus what&apos;s already on order, in schedule order.
            Available is Katana stock minus the frames, backing and glass already built into designed pieces that haven&apos;t
            shipped (Katana only removes them at fulfillment). The number shown
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

      {(plan.unknownAddOnLines ?? 0) > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <span className="font-semibold">
            Backing &amp; glass couldn&apos;t be loaded for {plan.unknownAddOnLines} scheduled frame{plan.unknownAddOnLines === 1 ? '' : 's'}.
          </span>{' '}
          <span className="text-xs">
            Their backing and glass aren&apos;t included in the quantities below, so actual needs may be higher. They&apos;re marked
            &ldquo;Couldn&apos;t load&rdquo; under Frames, backing &amp; glass and fill in as the production app returns them.
          </span>
        </div>
      )}

      {dueNow.length > 0 && (
        <div className={`rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-1 ${
          lateCount ? 'border-rose-200 bg-rose-50 text-rose-900' : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}>
          <span className="font-semibold">
            <HelpTip id="inv.orderNow">Order now: {dueNow.length} item{dueNow.length === 1 ? '' : 's'}</HelpTip>
            {lateCount > 0 && <> ({lateCount} already past their order-by date{shortNowCount > 0 ? `, ${shortNowCount} short now` : ''})</>}
          </span>
          <span className="text-xs">from {dueSuppliers.join(', ')}</span>
          <span className="text-xs opacity-75">
            Lead times: Border and Square 6 wks, InLine Ovals 8 wks, everyone else 6 wks before the Monday it&apos;s needed. Ernest Packaging items aren&apos;t counted.
          </span>
          {groupBy !== 'supplier' && (
            <button onClick={() => setGroupBy('supplier')} className="ml-auto text-xs underline"><HelpTip id="inv.createPos">Create POs by supplier</HelpTip></button>
          )}
        </div>
      )}

      {expedites.length > 0 && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-950">
          <div className="font-semibold">
            <HelpTip id="inv.expedite">Expedite: {expedites.length} item{expedites.length === 1 ? '' : 's'} on order but arriving too late</HelpTip>
          </div>
          <p className="text-xs mt-0.5 mb-2 text-orange-900">
            Enough is on order, but its Katana arrival date is after Design needs it. Ask the supplier to send at least this many by that Monday.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-orange-800/70">
                <tr>
                  <th className="py-1 pr-3 text-left font-medium">Supplier</th>
                  <th className="py-1 pr-3 text-left font-medium">Component</th>
                  <th className="py-1 pr-3 text-right font-medium">Send at least</th>
                  <th className="py-1 pr-3 text-left font-medium">By</th>
                  <th className="py-1 text-left font-medium">Currently due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {expedites.map(r => (
                  <tr key={r.variantId}>
                    <td className="py-1 pr-3 whitespace-nowrap">{r.supplier ?? NO_SUPPLIER}</td>
                    <td className="py-1 pr-3">{label(r)}{r.sku && <span className="text-orange-800/60"> · {r.sku}</span>}</td>
                    <td className="py-1 pr-3 text-right font-semibold whitespace-nowrap">{withPurchaseUnit(r, r.expedite!.qty)}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">
                      {r.expedite!.needBy <= thisWeek ? <span className="font-semibold text-rose-700">this week</span> : `wk of ${fmtWeek(r.expedite!.needBy)}`}
                    </td>
                    <td className="py-1 whitespace-nowrap">
                      {r.expedite!.pos.map((a, i) => <div key={i}>{fmtQty(a.qty)} on {a.poNo}, {fmtDate(a.date)}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {expedites.some(r => r.totalToOrder > 0) && (
            <p className="text-[11px] mt-2 text-orange-900">Some of these also need more ordered; that&apos;s in the order list below, separately.</p>
          )}
        </div>
      )}
      {overdue.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="font-semibold">
            <HelpTip id="inv.overdue">
              On overdue POs: {overdue.length} item{overdue.length === 1 ? '' : 's'}
              {overdueNeeded.length > 0 && <>, {overdueNeeded.length} that run short without them</>}
            </HelpTip>
          </div>
          <p className="text-xs mt-0.5 mb-2 text-amber-900">
            Part of what&apos;s on order is on a PO past its Katana arrival date. The plan still counts it as arriving now; these are
            the ones to chase with the supplier, or to mark received in Katana if they&apos;ve already come in.
          </p>
          {overdueShown.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="text-amber-800/70">
                  <tr>
                    <th className="py-1 pr-3 text-left font-medium">Supplier</th>
                    <th className="py-1 pr-3 text-left font-medium">Component</th>
                    <th className="py-1 pr-3 text-right font-medium">Available</th>
                    <th className="py-1 pr-3 text-left font-medium">Overdue</th>
                    <th className="py-1 text-left font-medium">Short without them</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {overdueShown.map(({ r, o }) => (
                    <tr key={r.variantId}>
                      <td className="py-1 pr-3 whitespace-nowrap">{r.supplier ?? NO_SUPPLIER}</td>
                      <td className="py-1 pr-3">{label(r)}{r.sku && <span className="text-amber-800/60"> · {r.sku}</span>}</td>
                      <td className="py-1 pr-3 text-right whitespace-nowrap">{fmtQty(r.inStock)}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">
                        {o.pos.map((a, i) => <div key={i}>{fmtQty(a.qty)} on {a.poNo.trim()}, due {fmtDate(a.date)}</div>)}
                      </td>
                      <td className="py-1 whitespace-nowrap">
                        {!o.shortFrom ? <span className="text-amber-800/60">covered</span>
                          : o.shortFrom <= thisWeek ? <span className="font-semibold text-rose-700">this week</span>
                          : <span className="font-semibold">wk of {fmtWeek(o.shortFrom)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {overdue.length > overdueNeeded.length && (
            <button onClick={() => setShowOverdue(s => !s)} className="mt-2 text-xs underline">
              {showOverdue ? 'Only show ones that run short' : `Show all ${overdue.length}, including ${overdue.length - overdueNeeded.length} stock covers anyway`}
            </button>
          )}
        </div>
      )}
      {!arrivalsKnown && plan.rows.some(r => r.onOrder > 0) && (
        <div className="text-xs text-slate-500">
          Katana purchase order dates couldn&apos;t be loaded, so on-order stock is counted as arriving now and late orders aren&apos;t flagged.
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
                        <th className="px-2 py-1.5 text-right font-medium"><HelpTip id="inv.col.neededWk">Needed this wk</HelpTip></th>
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
                <th className="px-3 py-2 text-left font-medium"><HelpTip id="inv.col.supplier">Supplier</HelpTip></th>
                <th className="px-2 py-2 text-left font-medium"><HelpTip id="inv.col.orderBy">Order by</HelpTip></th>
                <th className="px-2 py-2 text-right font-medium"><HelpTip id="inv.col.inStock">In stock</HelpTip></th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap"><HelpTip id="inv.col.inDesigns">In designs</HelpTip></th>
                <th className="px-2 py-2 text-right font-medium"><HelpTip id="inv.col.available">Available</HelpTip></th>
                <th className="px-2 py-2 text-right font-medium"><HelpTip id="inv.col.onOrder">On order</HelpTip></th>
                <th className="px-2 py-2 text-right font-medium whitespace-nowrap"><HelpTip id="inv.col.neededThru">Needed thru {thruShort}</HelpTip></th>
                {weeks.map(w => (
                  <th key={w} className="px-2 py-2 text-center font-medium whitespace-nowrap">{fmtWeek(w)}</th>
                ))}
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap"><HelpTip id="inv.col.toOrder">To order</HelpTip></th>
              </tr>
            </thead>
            <tbody>
              {gridRows.length === 0 && (
                <tr><td colSpan={9 + weeks.length} className="px-3 py-6 text-center text-slate-500">Nothing to order.</td></tr>
              )}
              {categories.map(cat => (
                <Fragment key={cat}>
                  <tr className="bg-slate-50/60">
                    <td colSpan={9 + weeks.length} className="sticky left-0 px-3 py-1 font-semibold text-slate-600">{cat}</td>
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
                        {fmtQty(r.katanaStock ?? r.inStock)}{r.negativeStock !== null && '*'}
                      </td>
                      <td className="px-2 py-1.5 text-right text-violet-700">{r.alreadyUsed ? `−${fmtQty(r.alreadyUsed)}` : ''}</td>
                      <td className="px-2 py-1.5 text-right font-medium text-slate-800" title={availableTitle(r)}>{fmtQty(r.inStock)}</td>
                      <td className={`px-2 py-1.5 text-right whitespace-nowrap ${r.expedite ? 'font-semibold text-orange-700' : 'text-slate-500'}`} title={arrivalsTitle(r)}>
                        {r.onOrder ? fmtQty(r.onOrder) : ''}{r.expedite && ' ⚑'}
                        {overdueById.has(r.variantId) && (
                          <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800">
                            {fmtQty(overdueById.get(r.variantId)!.qty)} late
                          </span>
                        )}
                      </td>
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
