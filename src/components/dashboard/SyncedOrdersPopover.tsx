'use client';

import { useEffect, useState } from 'react';
import type { AssignedOrderProduct } from '@/lib/assignment-counts';
import type { OrderAdjustment } from '@/lib/orderAdjustments';

/** Order-number adjustments for one Historicals week — see orderAdjustments.ts. */
export interface OrderAdjustProps {
  location:     string;
  weekOf:       string;
  /** This row's adjustments (department/week/member already matched). */
  adjustments:  OrderAdjustment[];
  /** The count after adjustments — what Historicals shows. */
  adjustedCount: number;
  canAdjust:    boolean;
  onChanged:    () => void;
}

interface SyncedOrdersPopoverProps {
  name:         string;
  department:   'design' | 'preservation' | 'fulfillment';
  start:        string;
  end:          string;
  syncedCount:  number;
  /** Wording for the stored number, e.g. "synced count" or "actual". */
  countLabel?:  string;
  /** Historicals weeks only: add/remove order numbers from the count. */
  adjust?:      OrderAdjustProps;
  onClose:      () => void;
}

function fmtRange(start: string, end: string): string {
  const f = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: start === end ? 'short' : undefined, month: 'short', day: 'numeric' });
  return start === end ? f(start) : `Week of ${f(start)} – ${f(end)}`;
}

function fmtEventDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Lists the order products behind a production-app assignment count — the
// auto-synced Historicals weeks and This Week's per-day Actuals. Fetched live,
// so reassignments since the count was taken can make the list differ from
// the shown number — that's called out rather than hidden.
export function SyncedOrdersPopover({ name, department, start, end, syncedCount, countLabel = 'synced count', adjust, onClose }: SyncedOrdersPopoverProps) {
  const [items, setItems] = useState<AssignedOrderProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const removedByOrder = new Map((adjust?.adjustments ?? []).filter(a => a.action === 'remove').map(a => [a.order_name, a]));
  const added = (adjust?.adjustments ?? []).filter(a => a.action === 'add');

  async function saveAdjustment(action: 'add' | 'remove', orderName: string, products: number, note?: string): Promise<boolean> {
    if (!adjust) return false;
    setBusy(true);
    setAdjustError(null);
    try {
      const res = await fetch('/api/order-adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location: adjust.location, department, weekOf: adjust.weekOf, memberName: name, orderName, action, products, note }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      adjust.onChanged();
      return true;
    } catch (e) {
      setAdjustError(String((e as Error).message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function undoAdjustment(id: string) {
    if (!adjust) return;
    setBusy(true);
    setAdjustError(null);
    try {
      const res = await fetch(`/api/order-adjustments?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      adjust.onChanged();
    } catch (e) {
      setAdjustError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  // Passed to each order list so a manager can take an order out of (or put
  // it back into) the count without losing sight of it.
  const orderActions: OrderActions | undefined = adjust ? {
    removedByOrder,
    canAdjust: adjust.canAdjust,
    busy,
    onRemove: (orderName, products) => saveAdjustment('remove', orderName, products),
    onRestore: id => undoAdjustment(id),
  } : undefined;

  useEffect(() => {
    const params = new URLSearchParams({ name, department, start, end });
    let cancelled = false;
    fetch(`/api/assigned-orders?${params}`)
      .then(async res => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!json.matched) throw new Error(`No production-app account found for ${name}.`);
        return json.items as AssignedOrderProduct[];
      })
      .then(list => { if (!cancelled) setItems(list); })
      .catch(e => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [name, department, start, end]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const period = start === end ? 'day' : 'week';

  // The count is authoritative (it's what Historicals and the ratios use); the
  // list can only over-include. Every product the count covers is in the list,
  // and the only possible extras are "multi-stage" products — ones this person
  // also holds another stage of, which the API lists if EITHER stage's date is
  // in range (see fetchAssignedOrderProducts). Comparing the count with the
  // single-stage products often settles exactly which multi-stage ones count.
  // Excluded products (e.g. Bloom Arrangement Recreation) are already taken
  // out of the count, so set them aside before reconciling.
  const notCountable = items?.filter(p => p.excluded) ?? [];
  const countable = items?.filter(p => !p.excluded) ?? [];
  const single = countable.filter(p => p.otherStages.length === 0);
  const multi = countable.filter(p => p.otherStages.length > 0);
  const needed = syncedCount - single.length; // multi-stage products in the count
  let counted: AssignedOrderProduct[] = single;
  let possible: AssignedOrderProduct[] = [];
  let excluded: AssignedOrderProduct[] = [];
  let unexplained = false;
  if (items) {
    if (needed <= 0) {
      excluded = multi;
      unexplained = needed < 0;
    } else if (needed >= multi.length) {
      counted = countable;
      unexplained = needed > multi.length;
    } else {
      possible = multi;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[80vh] flex flex-col rounded-xl bg-white shadow-xl border border-slate-200" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">{name} · <span className="capitalize">{department}</span></h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {fmtRange(start, end)} · {countLabel} {syncedCount}
              {adjust && adjust.adjustedCount !== syncedCount && (
                <span className="text-violet-600 font-medium"> · counted {adjust.adjustedCount} after adjustments</span>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">×</button>
        </div>

        <div className="overflow-y-auto px-5 py-3 text-xs">
          {adjust && (
            <AdjustmentsPanel
              adjust={adjust}
              added={added}
              removed={[...removedByOrder.values()]}
              busy={busy}
              error={adjustError}
              onAdd={(orderName, products, note) => saveAdjustment('add', orderName, products, note)}
              onUndo={undoAdjustment}
            />
          )}
          {error && <p className="text-red-600">{error}</p>}
          {!error && !items && <p className="text-slate-400 italic">Loading orders…</p>}
          {items && (
            <>
              <p className="text-slate-500 mb-2">
                {possible.length === 0
                  ? <>All {syncedCount} counted order product{syncedCount === 1 ? '' : 's'} identified below.</>
                  : <>{counted.length} of the {syncedCount} counted order products identified; the other {needed} {needed === 1 ? 'is' : 'are'} among the {possible.length} under &ldquo;Possibly counted&rdquo;.</>}
                {unexplained && (
                  <span className="block mt-1 text-amber-600">
                    The orders below don&apos;t add up to the {countLabel} of {syncedCount} — orders were likely reassigned in the production app since it was counted.
                  </span>
                )}
              </p>
              <OrderList products={counted} actions={orderActions} />
              {possible.length > 0 && (
                <Section
                  title={`Possibly counted — ${needed} of these ${possible.length}`}
                  note={`${name} also did another stage of these. The production app only says one of the two stage dates falls in this ${period}, not which — so ${needed} of them count here for ${department} and the rest belong to another ${period}.`}
                  products={possible}
                  actions={orderActions}
                  open
                />
              )}
              {excluded.length > 0 && (
                <Section
                  title={`Not in this count (${excluded.length})`}
                  note={`${name} also did another stage of these during this ${period}; their ${department} work on them was on a different ${period}, so they're counted there instead.`}
                  products={excluded}
                />
              )}
              {notCountable.length > 0 && (
                <Section
                  title={`Excluded product — never counted (${notCountable.length})`}
                  note="These products don't count toward order counts, ratios or CPO."
                  products={notCountable}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function groupByOrder(products: AssignedOrderProduct[]) {
  // One line per order; an order with several products shows a ×N count.
  const m = new Map<string, { orderName: string; clientName: string | null; products: AssignedOrderProduct[] }>();
  products.forEach(p => {
    const g = m.get(p.orderName) ?? { orderName: p.orderName, clientName: p.clientName, products: [] };
    g.products.push(p);
    m.set(p.orderName, g);
  });
  return [...m.values()];
}

interface OrderActions {
  removedByOrder: Map<string, OrderAdjustment>;
  canAdjust:      boolean;
  busy:           boolean;
  onRemove:       (orderName: string, products: number) => void;
  onRestore:      (adjustmentId: string) => void;
}

function OrderList({ products, actions }: { products: AssignedOrderProduct[]; actions?: OrderActions }) {
  return (
    <ul className="divide-y divide-slate-100">
      {groupByOrder(products).map(g => {
        const removed = actions?.removedByOrder.get(g.orderName);
        // Products in one order almost always share an event date; list each
        // distinct one just in case they don't.
        const dates = [...new Set(g.products.map(p => p.eventDate).filter((d): d is string => !!d))].sort();
        const other = [...new Set(g.products.flatMap(p => p.otherStages))];
        return (
          <li key={g.orderName} className={`py-1.5 ${removed ? 'opacity-60' : ''}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`font-semibold text-slate-700 ${removed ? 'line-through' : ''}`}>
                {g.orderName}
                {g.products.length > 1 && <span className="ml-1 text-slate-400 font-normal">×{g.products.length}</span>}
              </span>
              <span className="flex items-baseline gap-2 min-w-0">
                {g.clientName && <span className="text-slate-400 truncate">{g.clientName}</span>}
                {actions?.canAdjust && g.orderName !== '—' && (
                  removed ? (
                    <button type="button" disabled={actions.busy} onClick={() => actions.onRestore(removed.id)}
                      className="shrink-0 text-[10px] text-violet-600 hover:text-violet-800 underline disabled:opacity-50">Restore</button>
                  ) : (
                    <button type="button" disabled={actions.busy}
                      onClick={() => actions.onRemove(g.orderName, g.products.filter(p => !p.excluded).length || g.products.length)}
                      className="shrink-0 text-[10px] text-red-500 hover:text-red-700 underline disabled:opacity-50">Remove</button>
                  )
                )}
              </span>
            </div>
            {removed && (
              <div className="text-[10px] text-violet-600">
                Removed from the count{removed.created_by_name ? ` by ${removed.created_by_name}` : ''}{removed.note ? ` — ${removed.note}` : ''}
              </div>
            )}
            <div className="text-[11px] text-indigo-600">Event: {dates.length ? dates.map(fmtEventDate).join(', ') : '—'}</div>
            <div className="text-[11px] text-slate-500">
              {g.products.map(p => [p.productTitle, p.variantTitle].filter(Boolean).join(' — ') || 'Product').join(' · ')}
            </div>
            {other.length > 0 && <div className="text-[10px] text-slate-400">Also their {other.join(' & ')}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function Section({ title, note, products, actions, open = false }: { title: string; note: string; products: AssignedOrderProduct[]; actions?: OrderActions; open?: boolean }) {
  return (
    <details open={open} className="mt-3 rounded-lg border border-amber-200 bg-amber-50/40">
      <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-semibold text-amber-700">{title}</summary>
      <div className="px-3 pb-2">
        <p className="text-[11px] text-amber-700/80 mb-1">{note}</p>
        <OrderList products={products} actions={actions} />
      </div>
    </details>
  );
}

// Manager adjustments for this week: orders added on top of the sync, orders
// taken out of it, and a form to add another.
function AdjustmentsPanel({ adjust, added, removed, busy, error, onAdd, onUndo }: {
  adjust:  OrderAdjustProps;
  added:   OrderAdjustment[];
  removed: OrderAdjustment[];
  busy:    boolean;
  error:   string | null;
  onAdd:   (orderName: string, products: number, note?: string) => Promise<boolean>;
  onUndo:  (id: string) => void;
}) {
  const [orderName, setOrderName] = useState('');
  const [products, setProducts] = useState('1');
  const [note, setNote] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!orderName.trim()) return;
    if (await onAdd(orderName, parseFloat(products) || 1, note)) {
      setOrderName('');
      setProducts('1');
      setNote('');
    }
  }

  if (!adjust.canAdjust && added.length === 0 && removed.length === 0) return null;
  const fmtProducts = (n: number) => (Number(n) === 1 ? '' : ` (${Number(n)} products)`);

  return (
    <div className="mb-3 rounded-lg border border-violet-200 bg-violet-50/50 px-3 py-2">
      <p className="text-[11px] font-semibold text-violet-700">Manager adjustments</p>
      {added.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {added.map(a => (
            <li key={a.id} className="flex items-baseline justify-between gap-2">
              <span className="text-slate-700">
                <span className="font-semibold text-violet-700">+ {a.order_name}</span>{fmtProducts(a.products)}
                <span className="text-slate-400">{a.created_by_name ? ` · ${a.created_by_name}` : ''}{a.note ? ` — ${a.note}` : ''}</span>
              </span>
              {adjust.canAdjust && (
                <button type="button" disabled={busy} onClick={() => onUndo(a.id)}
                  className="shrink-0 text-[10px] text-violet-600 hover:text-violet-800 underline disabled:opacity-50">Undo</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {removed.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {removed.map(a => (
            <li key={a.id} className="flex items-baseline justify-between gap-2">
              <span className="text-slate-700">
                <span className="font-semibold text-red-600">− {a.order_name}</span>{fmtProducts(a.products)}
                <span className="text-slate-400">{a.created_by_name ? ` · ${a.created_by_name}` : ''}{a.note ? ` — ${a.note}` : ''}</span>
              </span>
              {adjust.canAdjust && (
                <button type="button" disabled={busy} onClick={() => onUndo(a.id)}
                  className="shrink-0 text-[10px] text-violet-600 hover:text-violet-800 underline disabled:opacity-50">Undo</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adjust.canAdjust && (
        <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-1.5">
          <input value={orderName} onChange={e => setOrderName(e.target.value)} placeholder="Order #"
            className="w-20 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]" />
          <input type="number" min="0.5" step="0.5" value={products} onChange={e => setProducts(e.target.value)}
            title="Order products this order is worth in the count"
            className="w-12 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]" />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)"
            className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]" />
          <button type="submit" disabled={busy || !orderName.trim()}
            className="rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-700 disabled:opacity-50">Add order</button>
        </form>
      )}
      {adjust.canAdjust && (
        <p className="mt-1 text-[10px] text-slate-400">Use “Remove” next to an order below to take it out of the count. The number box is how many order products it counts as.</p>
      )}
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
