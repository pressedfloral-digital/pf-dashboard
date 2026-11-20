'use client';

import { Fragment, useMemo, useState } from 'react';
import { NOT_ON_ORDER, ADDONS_UNKNOWN, type QueueLine } from '@/lib/designInventory';
import type { UsedSummary } from '@/lib/katanaPlan';
import { MATERIALS, STATUS_LABELS, materialClass, itemFor, tally } from './inventoryTally';
import { HelpTip } from './HelpTip';

function fmtQty(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Production order of the designed statuses, for the filter chips.
const STATUS_ORDER = [
  'frameCompleted', 'disapproved', 'frameDisapproved', 'approved', 'frameApproved',
  'glued', 'readyToSeal', 'readyToPackage', 'readyToShip', 'readyToFulfill', 'preparingToBeShipped',
];

function downloadCsv(location: string, lines: QueueLine[]) {
  const esc = (v: string | number) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = [['Order #', 'Customer', 'Product', 'Shape', 'Size', 'Moulding / Color', 'Other options', 'Backing', 'Glass', 'Current status']];
  lines.forEach(l => rows.push([
    l.orderNumber, l.customer, l.product, l.shape, l.materials?.sizeLabel ?? l.size, l.finish, l.options,
    l.materials?.backing ?? 'N/A', l.materials?.glass ?? 'N/A', STATUS_LABELS[l.status] ?? l.status,
  ]));
  const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `designed-not-shipped-${location.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function DesignedStockView({ location, lines, used, katanaError }: {
  location:    string;
  lines?:      QueueLine[];
  used?:       UsedSummary;
  katanaError: string | null;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [showOrders, setShowOrders] = useState(false);

  const all = useMemo(() => lines ?? [], [lines]);
  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    all.forEach(l => counts.set(l.status, (counts.get(l.status) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a[0]), ib = STATUS_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [all]);
  const shown = useMemo(() => status ? all.filter(l => l.status === status) : all, [all, status]);
  const summary = useMemo(() => MATERIALS.map(m => ({
    ...m,
    rows: tally([{ weekOf: 'designed', lines: shown }], m.id),
    total: shown.filter(l => itemFor(l, m.id)).length,
  })), [shown]);
  const orders = useMemo(() => {
    const map = new Map<string, QueueLine[]>();
    shown.forEach(l => map.set(l.orderNumber, [...(map.get(l.orderNumber) ?? []), l]));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [shown]);

  if (!lines) {
    return (
      <div className="py-12 text-center text-sm text-slate-500">
        This saved copy is from before designed pieces were tracked. It&apos;ll show once the refresh finishes.
      </div>
    );
  }

  const unknownLines = all.filter(l => l.materials?.addOnsUnknown).length;
  const orderCount = new Set(all.map(l => l.orderNumber)).size;
  const overUsed = used?.rows.filter(r => r.overUsed > 0) ?? [];
  const unmatchedLines = used?.unmatched.reduce((s, u) => s + u.count, 0) ?? 0;
  const categories = [...new Set((used?.rows ?? []).map(r => r.category))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">
            <HelpTip id="inv.view.designed">Already designed — materials in pieces that haven&apos;t shipped</HelpTip>
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-3xl">
            Orders that are past Design (No Response, Approved, Disapproved, Glued, Ready to Seal, Ready to Package, Ready to Fulfill)
            but not fulfilled yet. Their frames, backing and glass are built into a piece and can&apos;t be used again, but Katana keeps
            counting them in {location}&apos;s stock until the order ships. What to order subtracts everything below from Katana stock.
          </p>
        </div>
        <button
          onClick={() => downloadCsv(location, shown)}
          className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        >
          Download CSV
        </button>
      </div>

      <div className="text-xs text-slate-500">
        <span className="font-semibold text-slate-700">{all.length.toLocaleString()} pieces</span> in {orderCount.toLocaleString()} orders
        {unknownLines > 0 && (
          <> · <span className="text-rose-600 font-medium">{unknownLines} whose backing &amp; glass couldn&apos;t be loaded yet</span> — not
            subtracted until they load (the refresh job fills them in over the next few runs)</>
        )}
        {unmatchedLines > 0 && <> · {unmatchedLines} products with no Katana recipe, not subtracted</>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setStatus(null)}
          className={`px-3 py-1 text-xs rounded-full font-medium ${status === null ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
        >
          All · {all.length}
        </button>
        {statuses.map(([s, n]) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1 text-xs rounded-full font-medium ${status === s ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
          >
            {STATUS_LABELS[s] ?? s} · {n}
          </button>
        ))}
      </div>

      {/* ── Frames / backing / glass in designed pieces ── */}
      <div className="grid gap-3 md:grid-cols-3">
        {summary.map(m => (
          <div key={m.id} className="rounded-xl border border-slate-200 bg-white">
            <div className="px-4 py-2 border-b border-slate-100 flex justify-between text-sm font-semibold text-slate-700">
              <span>{m.label}</span>
              <span>{m.total}</span>
            </div>
            <ul className="px-4 py-2 text-xs divide-y divide-slate-50 max-h-96 overflow-y-auto">
              {m.rows.map(r => (
                <li key={`${r.size}|${r.shape}|${r.type}`} className="flex justify-between py-1">
                  <span className={materialClass(r.type)}>
                    {r.size} {r.type}{m.id === 'backing' && r.type !== NOT_ON_ORDER && r.type !== ADDONS_UNKNOWN ? ' backing' : ''}
                    {r.shape !== 'Rectangle' && r.shape !== '—' && <span className="text-slate-400"> ({r.shape})</span>}
                  </span>
                  <span className="font-semibold text-slate-800">{r.total}</span>
                </li>
              ))}
              {m.rows.length === 0 && <li className="py-2 text-slate-400">None</li>}
            </ul>
          </div>
        ))}
      </div>

      {/* ── Katana components: stock vs. what's in designs ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Katana components taken out of stock</h3>
        {!used ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
            Couldn&apos;t load Katana{katanaError ? `: ${katanaError}` : ''}, so these pieces can&apos;t be broken into components.
          </div>
        ) : <>
          {overUsed.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <span className="font-semibold">{overUsed.length} component{overUsed.length === 1 ? '' : 's'} show more in designs than Katana has on hand.</span>{' '}
              Katana may have already taken some out, or the stock count is off. Available is counted as 0 for these.
            </div>
          )}
          <p className="text-xs text-slate-500">
            All {location} pieces, whatever status is selected above.
          </p>
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium">Component</th>
                  <th className="px-3 py-2 text-right font-medium"><HelpTip id="inv.col.inStock">In stock</HelpTip></th>
                  <th className="px-3 py-2 text-right font-medium"><HelpTip id="inv.col.inDesigns">In designs</HelpTip></th>
                  <th className="px-3 py-2 text-right font-medium"><HelpTip id="inv.col.available">Available</HelpTip></th>
                  <th className="px-3 py-2 text-right font-medium">Pieces</th>
                </tr>
              </thead>
              <tbody>
                {used.rows.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-500">No designed pieces matched a Katana recipe.</td></tr>
                )}
                {categories.map(cat => (
                  <Fragment key={cat}>
                    <tr className="bg-slate-50/60">
                      <td colSpan={5} className="sticky left-0 px-3 py-1 font-semibold text-slate-600">{cat}</td>
                    </tr>
                    {used.rows.filter(r => r.category === cat).map(r => (
                      <tr key={r.variantId} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="sticky left-0 bg-white px-3 py-1.5 text-slate-700 whitespace-nowrap">
                          {r.name}{r.options && <span className="text-slate-500"> · {r.options}</span>}
                          {r.uom && r.uom !== 'each' && r.uom !== 'pcs' && <span className="text-slate-400"> ({r.uom})</span>}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right ${r.negativeStock !== null ? 'text-amber-600' : 'text-slate-700'}`}
                          title={r.negativeStock !== null ? `Katana shows ${fmtQty(r.negativeStock)}, counted as 0` : undefined}
                        >
                          {fmtQty(r.katanaStock)}{r.negativeStock !== null && '*'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-violet-700">−{fmtQty(r.used)}</td>
                        <td
                          className={`px-3 py-1.5 text-right font-semibold ${r.overUsed > 0 ? 'text-amber-600' : 'text-slate-800'}`}
                          title={r.overUsed > 0 ? `${fmtQty(r.overUsed)} more in designs than Katana has` : undefined}
                        >
                          {fmtQty(r.available)}{r.overUsed > 0 && '†'}
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{r.lines}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">
            * Katana shows negative stock; counted as 0. † More in designs than Katana has on hand; Available counted as 0.
          </p>
        </>}
      </div>

      {/* ── Orders ── */}
      <div className="space-y-2">
        <button onClick={() => setShowOrders(s => !s)} className="text-sm font-semibold text-indigo-700 underline">
          {showOrders ? 'Hide' : 'Show'} the {orders.length.toLocaleString()} orders{status ? ` in ${STATUS_LABELS[status] ?? status}` : ''}
        </button>
        {showOrders && (
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Order #</th>
                  <th className="px-3 py-2 text-left font-medium">Customer</th>
                  <th className="px-3 py-2 text-left font-medium">Frame</th>
                  <th className="px-3 py-2 text-left font-medium">Backing</th>
                  <th className="px-3 py-2 text-left font-medium">Glass</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.map(([num, ls]) => (
                  <tr key={num} className="align-top">
                    <td className="px-3 py-2 font-medium text-slate-800">{num}</td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{ls[0].customer}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {ls.map((l, i) => (
                        <div key={i} className="whitespace-nowrap">
                          {l.product}
                          <span className="text-slate-500">{[l.shape, l.size, l.finish, l.options].filter(Boolean).map(p => ` · ${p}`).join('')}</span>
                        </div>
                      ))}
                    </td>
                    {(['backing', 'glass'] as const).map(k => (
                      <td key={k} className="px-3 py-2 whitespace-nowrap">
                        {ls.map((l, i) => {
                          const v = l.materials?.[k];
                          return <div key={i} className={materialClass(v)}>{v ?? '—'}</div>;
                        })}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                      {ls.map((l, i) => <div key={i}>{STATUS_LABELS[l.status] ?? l.status}</div>)}
                    </td>
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
