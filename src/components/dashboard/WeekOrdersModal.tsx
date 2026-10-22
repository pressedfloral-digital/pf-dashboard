'use client';

import { useEffect, useState } from 'react';
import type { WeekOrder } from '@/app/api/design-week-orders/route';

// Opened from a Weekly Schedule "Week total": the orders Design should work
// on that week, in the order to design them (oldest intake first), grouped by
// intake week. Fetched live from /api/design-week-orders.

interface WeekOrdersResponse {
  orders?:          WeekOrder[];
  scheduled?:       number;
  capacity?:        number;
  designedThisWeek?: number;
  error?:           string;
}

function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function mondayOf(iso: string) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function WeekOrdersModal({ location, weekOf, weekLabel, isThisWeek, onClose }: {
  location:   string;
  weekOf:     string;
  weekLabel:  string;
  isThisWeek: boolean;
  onClose:    () => void;
}) {
  const [data, setData] = useState<WeekOrdersResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/design-week-orders?location=${location}&weekOf=${weekOf}`)
      .then(r => r.json())
      .then((d: WeekOrdersResponse) => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setData({ error: String(e) }); });
    return () => { cancelled = true; };
  }, [location, weekOf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const orders = data?.orders ?? null;

  function copyOrderNumbers() {
    if (!orders) return;
    navigator.clipboard?.writeText(orders.map(o => o.orderNumber).filter((n, i, a) => a.indexOf(n) === i).join('\n'))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  }

  // Group consecutive orders by intake week for easy scanning.
  const groups: { intakeWeek: string; rows: { o: WeekOrder; n: number }[] }[] = [];
  orders?.forEach((o, i) => {
    const wk = mondayOf(o.intakeDate);
    const last = groups[groups.length - 1];
    if (last && last.intakeWeek === wk) last.rows.push({ o, n: i + 1 });
    else groups.push({ intakeWeek: wk, rows: [{ o, n: i + 1 }] });
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">Orders to design — week of {weekLabel}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{location} · oldest bouquets first · #1 is designed first</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">✕</button>
        </div>

        <div className="overflow-y-auto px-5 py-3">
          {!data && <p className="text-sm text-slate-400 py-8 text-center">Loading orders… this can take up to a minute.</p>}
          {data?.error && <p className="text-sm text-red-600 py-4">Couldn&apos;t load orders: {data.error}</p>}

          {orders && (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-slate-700">
                  {isThisWeek && (data?.designedThisWeek ?? 0) > 0
                    ? <><b>{data!.designedThisWeek}</b> frames already designed this week. Next up: <b>{orders.length}</b> order line{orders.length === 1 ? '' : 's'} to finish the {data!.scheduled} scheduled.</>
                    : <><b>{orders.length}</b> order line{orders.length === 1 ? '' : 's'} fill the {data!.scheduled} frames scheduled for the week.</>}
                </p>
                {orders.length > 0 && (
                  <button onClick={copyOrderNumbers} className="shrink-0 text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">
                    {copied ? '✓ Copied' : 'Copy order numbers'}
                  </button>
                )}
              </div>
              {orders.length === 0 && (
                <p className="text-sm text-slate-500 py-4">No orders are ready to design this week{(data?.scheduled ?? 0) > 0 ? ' — everything older is already assigned to earlier weeks or still drying.' : '.'}</p>
              )}
              {orders.length > 0 && (
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                      <th className="py-1.5 pr-2 font-medium w-10">#</th>
                      <th className="py-1.5 pr-3 font-medium">Order</th>
                      <th className="py-1.5 pr-3 font-medium">Customer</th>
                      <th className="py-1.5 pr-3 font-medium">Product</th>
                      <th className="py-1.5 font-medium">Received</th>
                    </tr>
                  </thead>
                  {groups.map(g => (
                    <tbody key={g.intakeWeek}>
                      <tr>
                        <td colSpan={5} className="pt-3 pb-1 text-xs font-semibold text-slate-500">
                          Intake week of {fmtDate(g.intakeWeek)} · {g.rows.length} order line{g.rows.length === 1 ? '' : 's'}
                        </td>
                      </tr>
                      {g.rows.map(({ o, n }) => (
                        <tr key={`${o.orderNumber}-${n}`} className="border-b border-slate-50 align-top">
                          <td className="py-1.5 pr-2 text-slate-400 tabular-nums">{n}</td>
                          <td className="py-1.5 pr-3 font-medium text-slate-800 whitespace-nowrap">#{o.orderNumber}</td>
                          <td className="py-1.5 pr-3 text-slate-700">{o.customer || '—'}</td>
                          <td className="py-1.5 pr-3 text-slate-600">
                            {o.product}
                            {o.variant && <div className="text-xs text-slate-400">{o.variant}</div>}
                          </td>
                          <td className="py-1.5 text-slate-600 whitespace-nowrap">
                            {fmtDate(o.intakeDate)}
                            {o.stage === 'drying' && <div className="text-[10px] text-green-700">still drying now</div>}
                            {o.intakeSource === 'eventDate' && <div className="text-[10px] text-amber-700" title="No bouquet-received date on record — placed by event date">event date</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              )}
              <p className="text-xs text-slate-400 mt-3">
                Live from the production app. Orders are placed oldest-received first into each week&apos;s scheduled capacity, the same way the Inventory tab plans backing and glass.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
