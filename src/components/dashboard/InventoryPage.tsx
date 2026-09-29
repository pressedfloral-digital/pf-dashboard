'use client';

import { useEffect, useMemo, useState } from 'react';
import { PRESERVATION_WEEKS, type QueueLine } from '@/lib/designInventory';

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
    intakeFromEventDate: number; missingLocation: number;
  };
  error?: string;
}

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

const skuKey = (l: QueueLine) => [l.product, l.shape, l.size, l.finish, l.options].join('|');

function downloadCsv(data: InventoryResponse) {
  const esc = (v: string | number) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = [['Design week', 'Order #', 'Customer', 'Product', 'Shape', 'Size', 'Finish / Moulding', 'Other options', 'Current status', 'Intake date', 'Intake date source']];
  data.weeks.forEach(w => w.lines.forEach(l => rows.push([
    w.weekOf, l.orderNumber, l.customer, l.product, l.shape, l.size, l.finish, l.options,
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

  // SKU × week counts, most-needed first.
  const skuRows = useMemo(() => {
    const map = new Map<string, { line: QueueLine; byWeek: Record<string, number>; total: number }>();
    weeks.forEach(w => w.lines.forEach(l => {
      const k = skuKey(l);
      const row = map.get(k) ?? { line: l, byWeek: {}, total: 0 };
      row.byWeek[w.weekOf] = (row.byWeek[w.weekOf] ?? 0) + 1;
      row.total++;
      map.set(k, row);
    }));
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [weeks]);

  // Selected week's lines grouped by order.
  const selectedOrders = useMemo(() => {
    const week = weeks.find(w => w.weekOf === selectedWeek);
    const map = new Map<string, QueueLine[]>();
    week?.lines.forEach(l => map.set(l.orderNumber, [...(map.get(l.orderNumber) ?? []), l]));
    return [...map.entries()];
  }, [weeks, selectedWeek]);

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
        <h2 className="text-sm font-semibold text-slate-700">Design inventory — what each week&apos;s orders need</h2>
        <p className="text-xs text-slate-500 mt-1 max-w-3xl">
          Orders in Ready to Frame, plus orders still in Preservation once they&apos;re {PRESERVATION_WEEKS} weeks past bouquet received,
          scheduled oldest intake first against each week&apos;s Design capacity from the Weekly Schedule.
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
            {data.unscheduledCount > 0 && <> · {data.unscheduledCount} not scheduled before year end</>}
          </div>

          {/* ── Inventory totals: SKU × week ── */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium">Product</th>
                  <th className="px-3 py-2 text-left font-medium">Shape</th>
                  <th className="px-3 py-2 text-left font-medium">Size</th>
                  <th className="px-3 py-2 text-left font-medium">Finish / Moulding</th>
                  <th className="px-3 py-2 text-left font-medium">Other options</th>
                  {weeks.map(w => (
                    <th key={w.weekOf} className="px-2 py-2 text-center font-medium whitespace-nowrap">{fmtWeek(w.weekOf)}</th>
                  ))}
                  <th className="px-3 py-2 text-center font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {skuRows.map(r => (
                  <tr key={skuKey(r.line)} className="hover:bg-slate-50">
                    <td className="sticky left-0 bg-white px-3 py-1.5 text-slate-700 whitespace-nowrap">{r.line.product}</td>
                    <td className="px-3 py-1.5 text-slate-600">{r.line.shape || '—'}</td>
                    <td className="px-3 py-1.5 text-slate-600">{r.line.size || '—'}</td>
                    <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{r.line.finish || '—'}</td>
                    <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{r.line.options || '—'}</td>
                    {weeks.map(w => (
                      <td key={w.weekOf} className="px-2 py-1.5 text-center text-slate-700">{r.byWeek[w.weekOf] ?? ''}</td>
                    ))}
                    <td className="px-3 py-1.5 text-center font-semibold text-slate-800">{r.total}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 font-semibold text-slate-700">
                <tr>
                  <td className="sticky left-0 bg-slate-50 px-3 py-2" colSpan={5}>Total frames</td>
                  {weeks.map(w => (
                    <td key={w.weekOf} className="px-2 py-2 text-center">
                      {w.lines.length}
                      <div className="font-normal text-[10px] text-slate-400">of {w.capacity}</div>
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center">{weeks.reduce((s, w) => s + w.lines.length, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* ── Orders for one week ── */}
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

            {selectedWeek && (
              <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
                <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">
                  Week of {fmtWeek(selectedWeek)} — {selectedOrders.length} orders
                </div>
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Order #</th>
                      <th className="px-3 py-2 text-left font-medium">Customer</th>
                      <th className="px-3 py-2 text-left font-medium">Needs</th>
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
                            <div key={i}>
                              {l.product}
                              <span className="text-slate-500">{[l.shape, l.size, l.finish, l.options].filter(Boolean).map(p => ` · ${p}`).join('')}</span>
                            </div>
                          ))}
                        </td>
                        <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{STATUS_LABELS[lines[0].status] ?? lines[0].status}</td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap" title={lines[0].intakeSource === 'eventDate' ? 'No bouquet-received date on record — event date used' : 'Bouquet received'}>
                          {fmtWeek(lines[0].intakeDate)}{lines[0].intakeSource === 'eventDate' ? '*' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
