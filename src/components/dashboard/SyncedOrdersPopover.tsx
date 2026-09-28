'use client';

import { useEffect, useState } from 'react';
import type { AssignedOrderProduct } from '@/lib/assignment-counts';

interface SyncedOrdersPopoverProps {
  name:         string;
  department:   'design' | 'preservation' | 'fulfillment';
  start:        string;
  end:          string;
  syncedCount:  number;
  /** Wording for the stored number, e.g. "synced count" or "actual". */
  countLabel?:  string;
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
export function SyncedOrdersPopover({ name, department, start, end, syncedCount, countLabel = 'synced count', onClose }: SyncedOrdersPopoverProps) {
  const [items, setItems] = useState<AssignedOrderProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const single = items?.filter(p => p.otherStages.length === 0) ?? [];
  const multi = items?.filter(p => p.otherStages.length > 0) ?? [];
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
      counted = items;
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
            <p className="text-xs text-slate-400 mt-0.5">{fmtRange(start, end)} · {countLabel} {syncedCount}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">×</button>
        </div>

        <div className="overflow-y-auto px-5 py-3 text-xs">
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
              <OrderList products={counted} />
              {possible.length > 0 && (
                <Section
                  title={`Possibly counted — ${needed} of these ${possible.length}`}
                  note={`${name} also did another stage of these. The production app only says one of the two stage dates falls in this ${period}, not which — so ${needed} of them count here for ${department} and the rest belong to another ${period}.`}
                  products={possible}
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

function OrderList({ products }: { products: AssignedOrderProduct[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {groupByOrder(products).map(g => {
        // Products in one order almost always share an event date; list each
        // distinct one just in case they don't.
        const dates = [...new Set(g.products.map(p => p.eventDate).filter((d): d is string => !!d))].sort();
        const other = [...new Set(g.products.flatMap(p => p.otherStages))];
        return (
          <li key={g.orderName} className="py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-slate-700">
                {g.orderName}
                {g.products.length > 1 && <span className="ml-1 text-slate-400 font-normal">×{g.products.length}</span>}
              </span>
              {g.clientName && <span className="text-slate-400 truncate">{g.clientName}</span>}
            </div>
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

function Section({ title, note, products, open = false }: { title: string; note: string; products: AssignedOrderProduct[]; open?: boolean }) {
  return (
    <details open={open} className="mt-3 rounded-lg border border-amber-200 bg-amber-50/40">
      <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-semibold text-amber-700">{title}</summary>
      <div className="px-3 pb-2">
        <p className="text-[11px] text-amber-700/80 mb-1">{note}</p>
        <OrderList products={products} />
      </div>
    </details>
  );
}
