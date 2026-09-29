'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { PRESERVATION_WEEKS, NOT_ON_ORDER, sizeLabel, type QueueLine } from '@/lib/designInventory';

interface InventoryWeek {
  weekOf:    string;
  capacity:  number;
  scheduled: number;
  lines:     QueueLine[];
}

interface InventoryResponse {
  location:         string;
  generatedAt:      string;
  designedThisWeek: number;
  weeks:            InventoryWeek[];
  unscheduledCount: number;
  totals: {
    lines: number; inDesignQueue: number; inPreservation: number;
    intakeFromEventDate: number; missingLocation: number; missingOrderDetail: number;
  };
  error?: string;
}

type Material = 'frame' | 'backing' | 'glass';

const MATERIALS: { id: Material; label: string; typeLabel: string }[] = [
  { id: 'frame',   label: 'Frames',  typeLabel: 'Moulding / Color' },
  { id: 'backing', label: 'Backing', typeLabel: 'Backing' },
  { id: 'glass',   label: 'Glass',   typeLabel: 'Glass type' },
];

const STATUS_LABELS: Record<string, string> = {
  readyToFrame:       'Ready to Frame',
  readyToDesign:      'Ready to Design',
  bouquetReceived:    'Bouquet Received',
  checkedOn:          'Checked On',
  progress:           'In Progress',
  almostReadyToFrame: 'Almost Ready to Frame',
};

function fmtWeek(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// One countable item per line for a material, or null when the line's
// product doesn't use it (ornaments have no backing/glass).
function itemFor(l: QueueLine, m: Material): { size: string; shape: string; type: string } | null {
  const size = l.materials?.sizeLabel ?? sizeLabel(l);
  const shape = l.shape || '—';
  if (m === 'frame') return { size, shape, type: l.finish || '—' };
  const type = m === 'backing' ? l.materials?.backing : l.materials?.glass;
  if (type === null) return null;
  return { size, shape, type: type ?? NOT_ON_ORDER };
}

// Smallest frame first, then non-sized products (Boutonniere, Custom…) by name.
function sizeOrder(s: string): [number, number, string] {
  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  return m ? [0, Number(m[1]) * Number(m[2]), s] : [1, 0, s];
}
function bySize(a: string, b: string): number {
  const [ga, na, sa] = sizeOrder(a), [gb, nb, sb] = sizeOrder(b);
  return ga - gb || na - nb || sa.localeCompare(sb);
}

interface Row { size: string; shape: string; type: string; byWeek: Record<string, number>; total: number }

function tally(weeks: InventoryWeek[], m: Material): Row[] {
  const map = new Map<string, Row>();
  weeks.forEach(w => w.lines.forEach(l => {
    const it = itemFor(l, m);
    if (!it) return;
    const k = `${it.size}|${it.shape}|${it.type}`;
    const row = map.get(k) ?? { ...it, byWeek: {}, total: 0 };
    row.byWeek[w.weekOf] = (row.byWeek[w.weekOf] ?? 0) + 1;
    row.total++;
    map.set(k, row);
  }));
  return [...map.values()].sort((a, b) => bySize(a.size, b.size) || b.total - a.total || a.type.localeCompare(b.type));
}

function downloadCsv(data: InventoryResponse) {
  const esc = (v: string | number) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = [['Design week', 'Order #', 'Customer', 'Product', 'Shape', 'Size', 'Moulding / Color', 'Other options', 'Backing', 'Glass', 'Current status', 'Intake date', 'Intake date source']];
  data.weeks.forEach(w => w.lines.forEach(l => rows.push([
    w.weekOf, l.orderNumber, l.customer, l.product, l.shape, l.materials?.sizeLabel ?? sizeLabel(l), l.finish, l.options,
    l.materials?.backing ?? 'N/A', l.materials?.glass ?? 'N/A',
    STATUS_LABELS[l.status] ?? l.status, l.intakeDate, l.intakeSource === 'bouquetReceived' ? 'Bouquet received' : 'Event date (est.)',
  ])));
  const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `design-inventory-${data.location.toLowerCase()}-${data.generatedAt.slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function InventoryPage() {
  const [location, setLocation] = useState<'Utah' | 'Georgia'>('Utah');
  // Keyed by location so switching locations shows loading instead of the
  // other location's numbers, and a slow earlier response can't overwrite a
  // newer one.
  const [loaded, setLoaded] = useState<{ location: string; data: InventoryResponse } | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const [material, setMaterial] = useState<Material>('frame');
  const data = loaded?.location === location ? loaded.data : null;
  const loading = !data;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/design-inventory?location=${location}`)
      .then(r => r.json())
      .then((d: InventoryResponse) => {
        if (cancelled) return;
        setLoaded({ location, data: d });
        setSelectedWeek(d.weeks?.find(w => w.lines.length > 0)?.weekOf ?? null);
      })
      .catch(e => { if (!cancelled) setLoaded({ location, data: { error: String(e) } as InventoryResponse }); });
    return () => { cancelled = true; };
  }, [location]);

  const weeks = useMemo(() => (data?.weeks ?? []).filter(w => w.lines.length > 0), [data]);
  const rows = useMemo(() => tally(weeks, material), [weeks, material]);
  const week = weeks.find(w => w.weekOf === selectedWeek);

  // Selected week's totals, one list per material ("16x20 Walnut Brown — 19").
  const weekSummary = useMemo(() => week
    ? MATERIALS.map(m => ({ ...m, rows: tally([week], m.id), total: week.lines.filter(l => itemFor(l, m.id)).length }))
    : [], [week]);

  // Selected week's lines grouped by order.
  const selectedOrders = useMemo(() => {
    const map = new Map<string, QueueLine[]>();
    week?.lines.forEach(l => map.set(l.orderNumber, [...(map.get(l.orderNumber) ?? []), l]));
    return [...map.entries()];
  }, [week]);

  const typeLabel = MATERIALS.find(m => m.id === material)!.typeLabel;
  const sizes = [...new Set(rows.map(r => r.size))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          {(['Utah', 'Georgia'] as const).map(loc => (
            <button
              key={loc}
              onClick={() => setLocation(loc)}
              className={`px-4 py-1.5 text-sm font-medium ${location === loc ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {loc}
            </button>
          ))}
        </div>
        {data && !data.error && (
          <button
            onClick={() => downloadCsv(data)}
            className="ml-auto px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            Download CSV
          </button>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-700">Design inventory — frames, backing &amp; glass needed each week</h2>
        <p className="text-xs text-slate-500 mt-1 max-w-3xl">
          Orders in Ready to Frame, plus orders still in Preservation once they&apos;re {PRESERVATION_WEEKS} weeks past bouquet received,
          scheduled oldest intake first against each week&apos;s Design capacity from the Weekly Schedule. Backing and glass come from
          each order&apos;s Backing/Glass add-ons, matched to the frame by shape and size.
          Weeks with spare capacity after today&apos;s orders run out will fill with bouquets not yet received.
        </p>
      </div>

      {loading && <div className="py-12 text-center text-sm text-slate-500">Loading orders from the production app… this can take up to a minute.</div>}
      {data?.error && <div className="py-12 text-center text-sm text-rose-600">Couldn&apos;t load inventory: {data.error}</div>}

      {data && !data.error && (
        <>
          <div className="text-xs text-slate-500">
            {data.totals.lines.toLocaleString()} order lines ({data.totals.inDesignQueue} in Design queue, {data.totals.inPreservation} in Preservation)
            {data.designedThisWeek > 0 && <> · {Math.round(data.designedThisWeek)} already designed this week</>}
            {data.totals.intakeFromEventDate > 0 && <> · {data.totals.intakeFromEventDate} with no bouquet-received date (event date used)</>}
            {data.totals.missingLocation > 0 && <> · {data.totals.missingLocation} lines with no location skipped</>}
            {data.totals.missingOrderDetail > 0 && <> · {data.totals.missingOrderDetail} lines whose order details couldn&apos;t be loaded (backing/glass show as {NOT_ON_ORDER})</>}
            {data.unscheduledCount > 0 && <> · {data.unscheduledCount} not scheduled before year end</>}
          </div>

          {/* ── Materials × week ── */}
          <div className="space-y-2">
            <div className="flex gap-1.5">
              {MATERIALS.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMaterial(m.id)}
                  className={`px-3 py-1 text-xs rounded-full font-medium ${
                    material === m.id ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium">Size</th>
                    <th className="px-3 py-2 text-left font-medium">Shape</th>
                    <th className="px-3 py-2 text-left font-medium">{typeLabel}</th>
                    {weeks.map(w => (
                      <th key={w.weekOf} className="px-2 py-2 text-center font-medium whitespace-nowrap">{fmtWeek(w.weekOf)}</th>
                    ))}
                    <th className="px-3 py-2 text-center font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {sizes.map(size => {
                    const sizeRows = rows.filter(r => r.size === size);
                    return (
                      <Fragment key={size}>
                        {sizeRows.map(r => (
                          <tr key={`${r.size}|${r.shape}|${r.type}`} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="sticky left-0 bg-white px-3 py-1.5 text-slate-700 whitespace-nowrap">{r.size}</td>
                            <td className="px-3 py-1.5 text-slate-600">{r.shape}</td>
                            <td className={`px-3 py-1.5 whitespace-nowrap ${r.type === NOT_ON_ORDER ? 'text-amber-600' : 'text-slate-700'}`}>{r.type}</td>
                            {weeks.map(w => (
                              <td key={w.weekOf} className="px-2 py-1.5 text-center text-slate-700">{r.byWeek[w.weekOf] ?? ''}</td>
                            ))}
                            <td className="px-3 py-1.5 text-center font-semibold text-slate-800">{r.total}</td>
                          </tr>
                        ))}
                        <tr className="bg-slate-50 text-slate-600 font-medium">
                          <td className="sticky left-0 bg-slate-50 px-3 py-1" colSpan={3}>{size} subtotal</td>
                          {weeks.map(w => (
                            <td key={w.weekOf} className="px-2 py-1 text-center">{sizeRows.reduce((s, r) => s + (r.byWeek[w.weekOf] ?? 0), 0) || ''}</td>
                          ))}
                          <td className="px-3 py-1 text-center">{sizeRows.reduce((s, r) => s + r.total, 0)}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-100 font-semibold text-slate-700">
                  <tr>
                    <td className="sticky left-0 bg-slate-100 px-3 py-2" colSpan={3}>Total {MATERIALS.find(m => m.id === material)!.label.toLowerCase()}</td>
                    {weeks.map(w => (
                      <td key={w.weekOf} className="px-2 py-2 text-center">
                        {rows.reduce((s, r) => s + (r.byWeek[w.weekOf] ?? 0), 0)}
                        {material === 'frame' && <div className="font-normal text-[10px] text-slate-400">of {w.capacity}</div>}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-center">{rows.reduce((s, r) => s + r.total, 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* ── One week: totals + orders ── */}
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {weeks.map(w => (
                <button
                  key={w.weekOf}
                  onClick={() => setSelectedWeek(w.weekOf)}
                  className={`px-3 py-1 text-xs rounded-full font-medium ${
                    selectedWeek === w.weekOf ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {fmtWeek(w.weekOf)} · {w.lines.length}
                </button>
              ))}
            </div>

            {week && (
              <>
                <div className="grid gap-3 md:grid-cols-3">
                  {weekSummary.map(m => (
                    <div key={m.id} className="rounded-xl border border-slate-200 bg-white">
                      <div className="px-4 py-2 border-b border-slate-100 flex justify-between text-sm font-semibold text-slate-700">
                        <span>{m.label} — week of {fmtWeek(week.weekOf)}</span>
                        <span>{m.total}</span>
                      </div>
                      <ul className="px-4 py-2 text-xs divide-y divide-slate-50">
                        {m.rows.map(r => (
                          <li key={`${r.size}|${r.shape}|${r.type}`} className="flex justify-between py-1">
                            <span className={r.type === NOT_ON_ORDER ? 'text-amber-600' : 'text-slate-700'}>
                              {r.size} {r.type}{m.id === 'backing' && r.type !== NOT_ON_ORDER ? ' backing' : ''}
                              {r.shape !== 'Rectangle' && r.shape !== '—' && <span className="text-slate-400"> ({r.shape})</span>}
                            </span>
                            <span className="font-semibold text-slate-800">{r.total}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
                  <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">
                    Week of {fmtWeek(week.weekOf)} — {selectedOrders.length} orders
                  </div>
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Order #</th>
                        <th className="px-3 py-2 text-left font-medium">Customer</th>
                        <th className="px-3 py-2 text-left font-medium">Frame</th>
                        <th className="px-3 py-2 text-left font-medium">Backing</th>
                        <th className="px-3 py-2 text-left font-medium">Glass</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                        <th className="px-3 py-2 text-left font-medium">Intake</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedOrders.map(([num, lines]) => (
                        <tr key={num} className="align-top">
                          <td className="px-3 py-2 font-medium text-slate-800">{num}</td>
                          <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{lines[0].customer}</td>
                          <td className="px-3 py-2 text-slate-700">
                            {lines.map((l, i) => (
                              <div key={i} className="whitespace-nowrap">
                                {l.product}
                                <span className="text-slate-500">{[l.shape, l.size, l.finish, l.options].filter(Boolean).map(p => ` · ${p}`).join('')}</span>
                              </div>
                            ))}
                          </td>
                          {(['backing', 'glass'] as const).map(k => (
                            <td key={k} className="px-3 py-2 whitespace-nowrap">
                              {lines.map((l, i) => {
                                const v = l.materials?.[k];
                                return <div key={i} className={v === NOT_ON_ORDER ? 'text-amber-600' : 'text-slate-700'}>{v ?? '—'}</div>;
                              })}
                            </td>
                          ))}
                          <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{STATUS_LABELS[lines[0].status] ?? lines[0].status}</td>
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap" title={lines[0].intakeSource === 'eventDate' ? 'No bouquet-received date on record — event date used' : 'Bouquet received'}>
                            {fmtWeek(lines[0].intakeDate)}{lines[0].intakeSource === 'eventDate' ? '*' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
