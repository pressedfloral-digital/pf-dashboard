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

// Whole weeks from this week to the week stock runs short (0 or less = this week).
export function weeksUntilShort(needBy: string, thisWeek: string): number {
  return Math.round((Date.parse(needBy + 'T12:00:00Z') - Date.parse(thisWeek + 'T12:00:00Z')) / (7 * 864e5));
}

// Late means the order-by date has passed — an order placed now arrives after
// stock runs short. needBy (the week it runs short) says how soon: "short now"
// means stock already doesn't cover this week; "short in 4 wks" means there's
// still stock on hand, just not enough to last until a new order arrives.
export function OrderByBadge({ orderBy, needBy, thisWeek }: { orderBy: string | null; needBy?: string | null; thisWeek: string }) {
  if (!orderBy) return null;
  const u = urgency(orderBy, thisWeek);
  if (u === 'late') {
    const wks = needBy ? weeksUntilShort(needBy, thisWeek) : null;
    const shortNow = wks !== null && wks <= 0;
    const text = wks === null ? `Late: was due ${fmtWeek(orderBy)}`
      : shortNow ? 'Late · short now'
      : `Late · short in ${wks} wk${wks === 1 ? '' : 's'}`;
    const title = `Should have been ordered by ${fmtWeek(orderBy)}`
      + (needBy ? (shortNow ? ' — stock doesn’t cover this week' : ` — stock runs short the week of ${fmtWeek(needBy)}`) : '');
    return (
      <span title={title} className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${shortNow ? 'bg-rose-800 text-white' : URGENCY_STYLE.late}`}>
        {text}
      </span>
    );
  }
  const text = u === 'now' ? 'Order this week' : `Order by ${fmtWeek(orderBy)}`;
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
function fromPoQty(r: PlanRow, poQty: number): number {
  return r.purchaseUom && r.purchaseConversion ? poQty * r.purchaseConversion : poQty;
}

export type EditAction = 'setQty' | 'remove' | 'reset';

interface Created { orderNo: string; total: number }

export default function SupplierPoCard({ supplier, supplierId, rows: allRows, location, weeks, thisWeek, canOrder, thruText, thruShort, onEdit }: {
  supplier:   string;
  supplierId: number | null;
  rows:       PlanRow[];        // every item from this supplier the schedule uses
  location:   string;
  weeks:      string[];
  thisWeek:   string;
  canOrder:   boolean;
  thruText:   string;   // "through year end" / "through the week of Jan 4"
  thruShort:  string;   // "YE" / "Jan 4"
  // Saves a hand edit (qty in stock units); omitted when edits can't be saved.
  onEdit?:    (variantId: number, action: EditAction, qty?: number) => Promise<void>;
}) {
  // Items edited by hand stay in the list even at 0, so the edit can be seen and reset.
  const rows = allRows.filter(r => !r.removed && (r.totalToOrder > 0 || r.computedToOrder !== undefined));
  const removed = allRows.filter(r => r.removed);
  const covered = allRows.filter(r => !r.removed && !rows.includes(r));
  const [showCovered, setShowCovered] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [editing, setEditing] = useState<Record<number, string>>({});   // variantId → draft qty (purchase units)
  const [saving, setSaving] = useState<number | null>(null);
  const canEdit = !!onEdit && canOrder;

  async function save(r: PlanRow, action: EditAction, qty?: number) {
    if (!onEdit) return;
    setSaving(r.variantId);
    setError(null);
    try {
      await onEdit(r.variantId, action, qty);
      setEditing(e => { const { [r.variantId]: _, ...rest } = e; return rest; });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

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
  const soonest = rows.filter(r => r.orderBy).sort((a, b) => (a.orderBy! < b.orderBy! ? -1 : a.orderBy! > b.orderBy! ? 1 : 0))[0];
  const earliest = soonest?.orderBy ?? null;
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
            {removed.length > 0 && <> · {removed.length} deleted</>}
          </div>
        </div>
        {rows.length
          ? <OrderByBadge orderBy={earliest} needBy={soonest?.firstShortWeek} thisWeek={thisWeek} />
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
                  Needed: {weeks.filter(w => r.toOrder[w]).map(w => `${fmtWeek(w)} ${fmtQty(r.toOrder[w])}`).join(' · ') || 'nothing'}
                  {r.orderNowQty > 0 && r.orderNowQty < r.totalToOrder && <> · {fmtQty(r.orderNowQty)} due now</>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  {editing[r.variantId] !== undefined ? (
                    <>
                      <span className="text-slate-500">To order:</span>
                      <input
                        type="number" min={0} step="any" autoFocus
                        value={editing[r.variantId]}
                        onChange={e => setEditing(d => ({ ...d, [r.variantId]: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && editing[r.variantId] !== '') save(r, 'setQty', fromPoQty(r, Number(editing[r.variantId])));
                          if (e.key === 'Escape') setEditing(({ [r.variantId]: _, ...rest }) => rest);
                        }}
                        className="w-16 rounded border border-indigo-300 px-1.5 py-0.5 text-right text-slate-800"
                      />
                      <span className="text-slate-400">{poUnit(r)}</span>
                      <button
                        onClick={() => save(r, 'setQty', fromPoQty(r, Number(editing[r.variantId])))}
                        disabled={saving === r.variantId || editing[r.variantId] === '' || Number(editing[r.variantId]) < 0}
                        className="rounded bg-indigo-600 px-2 py-0.5 font-medium text-white disabled:bg-slate-200"
                      >
                        {saving === r.variantId ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setEditing(({ [r.variantId]: _, ...rest }) => rest)} className="text-slate-500 underline">Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="text-slate-600">
                        To order: <span className="font-semibold">{fmtQty(toPoQty(r, r.totalToOrder))} {poUnit(r)}</span>
                      </span>
                      {r.computedToOrder !== undefined && (
                        <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 font-semibold text-indigo-800" title={r.edit ? `Edited by ${r.edit.by}, ${new Date(r.edit.at).toLocaleDateString()}` : undefined}>
                          edited (was {fmtQty(toPoQty(r, r.computedToOrder))})
                        </span>
                      )}
                      {canEdit && !created && (
                        <button onClick={() => setEditing(d => ({ ...d, [r.variantId]: String(toPoQty(r, r.totalToOrder)) }))} className="text-indigo-600 underline">
                          Edit
                        </button>
                      )}
                      {canEdit && !created && r.computedToOrder !== undefined && (
                        <button onClick={() => save(r, 'reset')} disabled={saving === r.variantId} className="text-slate-500 underline">Reset</button>
                      )}
                    </>
                  )}
                </div>
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <OrderByBadge orderBy={r.orderBy} needBy={r.firstShortWeek} thisWeek={thisWeek} />
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
                {canEdit && !created && (
                  <button
                    onClick={() => save(r, 'remove')}
                    disabled={saving === r.variantId}
                    title="Delete from the order list"
                    aria-label={`Delete ${label(r)} from the order list`}
                    className="ml-2 px-1 text-base leading-none text-slate-300 hover:text-rose-600"
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>}

      {removed.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-100 text-xs">
          <button onClick={() => setShowRemoved(s => !s)} className="text-slate-500 hover:text-slate-700">
            {showRemoved ? '▾' : '▸'} {removed.length} item{removed.length === 1 ? '' : 's'} deleted from the list
          </button>
          {error && !rows.length && <div className="mt-1 text-rose-600">{error}</div>}
          {showRemoved && (
            <ul className="mt-1 divide-y divide-slate-50">
              {removed.map(r => (
                <li key={r.variantId} className="flex flex-wrap items-center gap-x-2 py-1">
                  <span className="text-slate-500 line-through">{label(r)}</span>
                  {r.edit && <span className="text-slate-400">· {r.edit.by}, {new Date(r.edit.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
                  {canEdit && (
                    <button onClick={() => save(r, 'reset')} disabled={saving === r.variantId} className="ml-auto text-indigo-600 underline">
                      {saving === r.variantId ? 'Restoring…' : 'Restore'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
