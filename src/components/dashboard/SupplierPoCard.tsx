'use client';

import { useState } from 'react';
import type { PlanRow } from '@/lib/katanaPlan';

export function fmtWeek(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function label(r: PlanRow): string {
  return r.options ? `${r.name} — ${r.options}` : r.name;
}

// ── Order-by flag ────────────────────────────────────────────────────────────

export type Urgency = 'late' | 'now' | 'soon' | 'later';

export function urgency(orderBy: string | null, thisWeek: string): Urgency {
  if (!orderBy) return 'later';
  if (orderBy < thisWeek) return 'late';
  if (orderBy === thisWeek) return 'now';
  const twoWeeksOut = new Date(thisWeek + 'T12:00:00Z');
  twoWeeksOut.setUTCDate(twoWeeksOut.getUTCDate() + 14);
  return orderBy <= twoWeeksOut.toISOString().slice(0, 10) ? 'soon' : 'later';
}

const URGENCY_STYLE: Record<Urgency, string> = {
  late:  'bg-rose-600 text-white',
  now:   'bg-amber-500 text-white',
  soon:  'bg-amber-100 text-amber-800',
  later: 'bg-slate-100 text-slate-600',
};

export function OrderByBadge({ orderBy, thisWeek }: { orderBy: string | null; thisWeek: string }) {
  if (!orderBy) return null;
  const u = urgency(orderBy, thisWeek);
  const text = u === 'late' ? `Late: was due ${fmtWeek(orderBy)}` : u === 'now' ? 'Order this week' : `Order by ${fmtWeek(orderBy)}`;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${URGENCY_STYLE[u]}`}>{text}</span>;
}

// ── PO quantities ────────────────────────────────────────────────────────────

// Katana POs are in the purchase unit (rolls of thread), stock is in the
// stock unit (yards) — round up to whole purchase units.
function poUnit(r: PlanRow): string {
  return r.purchaseUom && r.purchaseConversion ? r.purchaseUom : (r.uom || 'each');
}
function toPoQty(r: PlanRow, stockQty: number): number {
  return Math.ceil(r.purchaseUom && r.purchaseConversion ? stockQty / r.purchaseConversion : stockQty);
}

interface Created { orderNo: string; total: number }

export default function SupplierPoCard({ supplier, supplierId, rows: allRows, location, weeks, thisWeek, canOrder, thruText, thruShort }: {
  supplier:   string;
  supplierId: number | null;
  rows:       PlanRow[];        // every item from this supplier the schedule uses
  location:   string;
  weeks:      string[];
  thisWeek:   string;
  canOrder:   boolean;
  thruText:   string;   // "through year end" / "through the week of Jan 4"
  thruShort:  string;   // "YE" / "Jan 4"
}) {
  const rows = allRows.filter(r => r.totalToOrder > 0);
  const covered = allRows.filter(r => r.totalToOrder <= 0);
  const [showCovered, setShowCovered] = useState(false);

  // Pre-select what's due now (order-by this week or past) at the due-now
  // quantity; later items start unticked at their full year-end quantity.
  const [selected, setSelected] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(rows.map(r => [r.variantId, r.orderNowQty > 0])));
  const [qty, setQty] = useState<Record<number, string>>(() =>
    Object.fromEntries(rows.map(r => [r.variantId, String(toPoQty(r, r.orderNowQty > 0 ? r.orderNowQty : r.totalToOrder))])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const chosen = rows.filter(r => selected[r.variantId] && Number(qty[r.variantId]) > 0);
  const earliest = rows.map(r => r.orderBy).filter(Boolean).sort()[0] ?? null;
  const leadWeeks = allRows[0]?.leadWeeks;

  async function createPo() {
    if (!supplierId || !chosen.length) return;
    const needBy = chosen.map(r => r.firstShortWeek).filter(Boolean).sort()[0] ?? thisWeek;
    const lines = chosen.map(r => `• ${qty[r.variantId]} ${poUnit(r)} — ${label(r)}`).join('\n');
    if (!window.confirm(
      `Create a purchase order in Katana?\n\n${supplier} · ${location}\nNeeded by the week of ${fmtWeek(needBy)}\n\n${lines}\n\n` +
      `It's created as Not Received and isn't sent to the supplier. Check the prices in Katana before you send it.`,
    )) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/katana/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location, supplierId, needBy,
          rows: chosen.map(r => ({ variantId: r.variantId, quantity: Number(qty[r.variantId]) })),
        }),
      });
      const json = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      if (!res.ok) throw new Error(json.error ?? `Server returned ${res.status}`);
      setCreated({ orderNo: json.orderNo, total: json.total });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white flex flex-col">
      <div className="px-4 py-2 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">{supplier}</div>
          <div className="text-[11px] text-slate-400">
            {leadWeeks}-week lead time · {rows.length ? `${rows.length} to order` : 'nothing to order'}
            {covered.length > 0 && <> · {covered.length} covered by stock</>}
          </div>
        </div>
        {rows.length
          ? <OrderByBadge orderBy={earliest} thisWeek={thisWeek} />
          : <span className="inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-800">Covered {thruText}</span>}
      </div>

      {rows.length > 0 && <table className="min-w-full text-xs">
        <thead className="text-slate-400">
          <tr>
            <th className="w-6 pl-4 py-1.5" />
            <th className="px-2 py-1.5 text-left font-medium">Component</th>
            <th className="px-2 py-1.5 text-left font-medium">Order by</th>
            <th className="px-4 py-1.5 text-right font-medium">PO qty</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map(r => (
            <tr key={r.variantId} className="align-top">
              <td className="pl-4 py-1.5">
                <input
                  type="checkbox"
                  aria-label={`Include ${label(r)}`}
                  checked={!!selected[r.variantId]}
                  disabled={!!created}
                  onChange={e => setSelected(s => ({ ...s, [r.variantId]: e.target.checked }))}
                />
              </td>
              <td className="px-2 py-1.5 text-slate-700">
                {label(r)}
                {r.sku && <span className="text-slate-400"> · {r.sku}</span>}
                <div className="text-[11px] text-slate-400">
                  Needed: {weeks.filter(w => r.toOrder[w]).map(w => `${fmtWeek(w)} ${fmtQty(r.toOrder[w])}`).join(' · ')}
                  {r.orderNowQty > 0 && r.orderNowQty < r.totalToOrder && <> · {fmtQty(r.orderNowQty)} due now, {fmtQty(r.totalToOrder)} total</>}
                </div>
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <OrderByBadge orderBy={r.orderBy} thisWeek={thisWeek} />
                {r.firstShortWeek && <div className="text-[10px] text-slate-400 mt-0.5">need by {fmtWeek(r.firstShortWeek)}</div>}
              </td>
              <td className="px-4 py-1.5 text-right whitespace-nowrap">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={qty[r.variantId] ?? ''}
                  disabled={!!created}
                  onChange={e => setQty(q => ({ ...q, [r.variantId]: e.target.value }))}
                  className="w-16 rounded border border-slate-200 px-1.5 py-0.5 text-right text-slate-800"
                />
                <span className="ml-1 text-slate-400">{poUnit(r)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>}

      {covered.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-100 text-xs">
          <button onClick={() => setShowCovered(s => !s)} className="text-slate-500 hover:text-slate-700">
            {showCovered ? '▾' : '▸'} {covered.length} item{covered.length === 1 ? '' : 's'} covered by stock
          </button>
          {showCovered && (
            <table className="mt-1 min-w-full">
              <thead className="text-slate-400">
                <tr>
                  <th className="py-1 text-left font-medium">Component</th>
                  <th className="px-2 py-1 text-right font-medium">In stock</th>
                  <th className="px-2 py-1 text-right font-medium">On order</th>
                  <th className="px-2 py-1 text-right font-medium">Needed thru {thruShort}</th>
                  <th className="pl-2 py-1 text-right font-medium">Left over</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {covered.map(r => (
                  <tr key={r.variantId}>
                    <td className="py-1 text-slate-700">{label(r)}</td>
                    <td className="px-2 py-1 text-right text-slate-600">{fmtQty(r.inStock)}</td>
                    <td className="px-2 py-1 text-right text-slate-500">{r.onOrder ? fmtQty(r.onOrder) : ''}</td>
                    <td className="px-2 py-1 text-right text-slate-600">{fmtQty(r.totalNeeded)}</td>
                    <td className="pl-2 py-1 text-right font-medium text-emerald-700">{fmtQty(r.inStock + r.onOrder - r.totalNeeded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {rows.length > 0 && <div className="mt-auto px-4 py-2 border-t border-slate-100 flex flex-wrap items-center justify-end gap-2 text-xs">
        {created ? (
          <span className="text-emerald-700 font-medium">
            Created {created.orderNo} in Katana ({created.total.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}).
            It&apos;s in Purchasing as Not Received and hasn&apos;t been sent.
          </span>
        ) : (
          <>
            {error && <span className="text-rose-600 mr-auto">{error}</span>}
            {!supplierId && <span className="text-slate-400 mr-auto">Set a default supplier in Katana to create a PO.</span>}
            {supplierId && !canOrder && <span className="text-slate-400 mr-auto">Only admins and {location} managers can create POs.</span>}
            <button
              onClick={createPo}
              disabled={busy || !supplierId || !canOrder || chosen.length === 0}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {busy ? 'Creating…' : `Create PO in Katana${chosen.length ? ` (${chosen.length})` : ''}`}
            </button>
          </>
        )}
      </div>}
    </div>
  );
}
