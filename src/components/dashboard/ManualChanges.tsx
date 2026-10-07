'use client';

import { useMemo, useState } from 'react';
import type { CatalogItem, OrderAdjustment } from '@/lib/katanaPlan';
import { addWeeks } from '@/lib/designInventory';
import { fmtWeek, label } from './SupplierPoCard';

// How far ahead the "needed by" week picker goes.
const PICKER_WEEKS = 26;

function itemText(c: CatalogItem): string {
  return `${label(c)}${c.sku ? ` · ${c.sku}` : ''}${c.supplier ? ` (${c.supplier})` : ''}`;
}

export default function ManualChanges({ location, catalog, adjustments, thisWeek, canEdit, ready, onAdded, onUndo }: {
  location:    string;
  catalog:     CatalogItem[];
  adjustments: OrderAdjustment[];
  thisWeek:    string;
  canEdit:     boolean;
  ready:       boolean;   // false until the inventory_order_adjustments migration is run
  onAdded:     (a: OrderAdjustment) => void;
  onUndo:      (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [quantity, setQuantity] = useState('');
  const [needBy, setNeedBy] = useState(thisWeek);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byText = useMemo(() => new Map(catalog.map(c => [itemText(c), c])), [catalog]);
  const byId = useMemo(() => new Map(catalog.map(c => [c.variantId, c])), [catalog]);
  const picked = byText.get(search) ?? null;
  const weeks = useMemo(() => Array.from({ length: PICKER_WEEKS }, (_, i) => addWeeks(thisWeek, i)), [thisWeek]);

  async function add() {
    if (!picked) { setError('Pick a component from the list'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory-adjustments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, kind: 'add', variantId: picked.variantId, quantity: Number(quantity), needBy, note }),
      });
      const json = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      if (!res.ok) throw new Error(json.error ?? `Server returned ${res.status}`);
      onAdded(json);
      setSearch(''); setQuantity(''); setNote(''); setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: string) {
    const res = await fetch(`/api/inventory-adjustments?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) onUndo(id);
    else setError((await res.json().catch(() => ({}))).error ?? `Couldn’t undo (${res.status})`);
  }

  const describe = (a: OrderAdjustment) => {
    const c = byId.get(a.variant_id);
    return c ? label(c) : `Katana variant ${a.variant_id}`;
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="px-4 py-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-slate-700">Manual changes</div>
          <div className="text-[11px] text-slate-400">
            {adjustments.length
              ? `${adjustments.filter(a => a.kind === 'add').length} added · ${adjustments.filter(a => a.kind === 'remove').length} removed`
              : 'Add something the recipes don’t cover, or use × on an item to take it off the list.'}
          </div>
        </div>
        {ready && canEdit && !open && (
          <button onClick={() => setOpen(true)} className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">
            + Add item
          </button>
        )}
      </div>

      {!ready && (
        <div className="px-4 pb-3 text-xs text-amber-700">
          Manual changes aren&apos;t set up yet. Run the <code>inventory_order_adjustments</code> migration in Supabase.
        </div>
      )}
      {ready && !canEdit && (
        <div className="px-4 pb-3 text-xs text-slate-400">Only admins and {location} managers can change the list.</div>
      )}

      {open && (
        <div className="px-4 py-3 border-t border-slate-100 grid gap-2 md:grid-cols-[minmax(0,2fr)_auto_auto_minmax(0,1fr)_auto] md:items-end text-xs">
          <label className="block">
            <span className="text-slate-500">Component</span>
            <input
              list="katana-components"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search Katana components…"
              className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5"
            />
            <datalist id="katana-components">
              {catalog.map(c => <option key={c.variantId} value={itemText(c)} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="text-slate-500">Quantity{picked?.uom ? ` (${picked.uom})` : ''}</span>
            <input
              type="number" min={0} step="any" value={quantity}
              onChange={e => setQuantity(e.target.value)}
              className="mt-0.5 w-24 rounded border border-slate-200 px-2 py-1.5 text-right"
            />
          </label>
          <label className="block">
            <span className="text-slate-500">Needed by week of</span>
            <select value={needBy} onChange={e => setNeedBy(e.target.value)} className="mt-0.5 block rounded border border-slate-200 px-2 py-1.5">
              {weeks.map(w => <option key={w} value={w}>{fmtWeek(w)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-slate-500">Note (optional)</span>
            <input value={note} onChange={e => setNote(e.target.value)} className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5" />
          </label>
          <div className="flex gap-2">
            <button onClick={add} disabled={busy} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:bg-slate-200">
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => { setOpen(false); setError(null); }} className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600">Cancel</button>
          </div>
          {picked && (
            <div className="md:col-span-5 text-slate-500">
              {picked.supplier ?? 'No default supplier'} · {picked.leadWeeks}-week lead time · {picked.inStock} in stock
              {picked.onOrder ? `, ${picked.onOrder} on order` : ''}
              {picked.purchaseUom && picked.purchaseConversion ? ` · bought by the ${picked.purchaseUom} (${picked.purchaseConversion} ${picked.uom})` : ''}
              <span className="text-slate-400"> · Added items go straight on the order list; they aren&apos;t netted against stock.</span>
            </div>
          )}
        </div>
      )}

      {error && <div className="px-4 pb-2 text-xs text-rose-600">{error}</div>}

      {adjustments.length > 0 && (
        <ul className="px-4 py-2 border-t border-slate-100 text-xs divide-y divide-slate-50">
          {adjustments.map(a => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-2 py-1">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${a.kind === 'add' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-200 text-slate-700'}`}>
                {a.kind === 'add' ? 'Added' : 'Removed'}
              </span>
              <span className="text-slate-700">
                {a.kind === 'add' && <>{Number(a.quantity).toLocaleString()} × </>}{describe(a)}
                {a.kind === 'add' && a.need_by && <span className="text-slate-500">, needed week of {fmtWeek(a.need_by)}</span>}
              </span>
              {a.note && <span className="text-slate-400">· {a.note}</span>}
              <span className="text-slate-400">· {a.created_by ?? 'someone'}, {new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              {canEdit && (
                <button onClick={() => undo(a.id)} className="ml-auto text-slate-500 underline hover:text-slate-700">Undo</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
