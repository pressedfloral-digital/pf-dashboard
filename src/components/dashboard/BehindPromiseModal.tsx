'use client';

import { useEffect, useState } from 'react';
import type { BehindPromiseOrder } from '@/app/api/behind-promise-orders/route';

// Opened from a Queue & Turnaround row's "behind promise" flag: how far that
// intake week is trending past the date promised to clients, what it would
// take to get back on it, and the actual orders still waiting. The numbers
// are computed by SchedulePage from the same queue walk and Must design math
// the table uses; only the order list is fetched here.

export interface BehindPromiseSummary {
  weekOf:          string;
  promisedByDate:  string;
  promisedWeeks:   number;
  lastConfirmedAt: string;
  projectedDate:   string;   // when the live schedule finishes this week's bouquets
  framesLeft:      number;   // this intake week's frames not designed yet
  framesAhead:     number;   // frames ahead of it in the queue (older weeks)
  capacityByPromise: number; // frames scheduled from this week through the promised week
  hoursPerFrame:   number;
}

function fmtDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function daysBetween(a: string, b: string) {
  return Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000);
}
function lateText(days: number) {
  if (days < 7) return `${days} day${days === 1 ? '' : 's'}`;
  const w = Math.round(days / 7);
  return `${w} week${w === 1 ? '' : 's'}`;
}

export function BehindPromiseModal({ location, summary: s, todayIso, onClose }: {
  location: string;
  summary:  BehindPromiseSummary;
  todayIso: string;
  onClose:  () => void;
}) {
  const [orders, setOrders] = useState<BehindPromiseOrder[] | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/behind-promise-orders?location=${location}&weekOf=${s.weekOf}`)
      .then(r => r.json())
      .then((d: { orders?: BehindPromiseOrder[]; incomplete?: boolean; error?: string }) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else { setOrders(d.orders ?? []); setIncomplete(!!d.incomplete); }
      })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [location, s.weekOf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const daysLate   = Math.max(0, daysBetween(s.promisedByDate, s.projectedDate));
  const overdue    = s.promisedByDate < todayIso;
  const daysPast   = overdue ? daysBetween(s.promisedByDate, todayIso) : 0;
  const needFrames = s.framesAhead + s.framesLeft;
  const shortFrames = Math.max(0, needFrames - s.capacityByPromise);
  const shortHours  = shortFrames * (s.hoursPerFrame || 1);

  const inQueue = orders?.filter(o => o.stage === 'design_queue') ?? [];
  const drying  = orders?.filter(o => o.stage === 'drying') ?? [];

  function copyOrderNumbers() {
    if (!orders) return;
    navigator.clipboard?.writeText(orders.map(o => o.orderNumber).filter((n, i, a) => a.indexOf(n) === i).join('\n'))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">
              Intake week of {fmtDate(s.weekOf)} <span className="ml-1 text-xs bg-red-100 text-red-700 rounded px-1.5 py-0.5 align-middle">behind promise</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">{location} · promise locked in with the bloom update sent {fmtDate(s.lastConfirmedAt.slice(0, 10))}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">✕</button>
        </div>

        <div className="overflow-y-auto">
          {/* How far behind */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 px-5 py-4">
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Promised by</p>
              <p className="text-lg font-bold text-slate-800">{fmtDate(s.promisedByDate)}</p>
              <p className="text-xs text-slate-500">{overdue ? `${lateText(daysPast)} ago` : `in ${lateText(daysBetween(todayIso, s.promisedByDate))}`}</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">On track to finish</p>
              <p className="text-lg font-bold text-slate-800">{fmtDate(s.projectedDate)}</p>
              <p className="text-xs text-slate-500">with the current schedule</p>
            </div>
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700">Behind by</p>
              <p className="text-lg font-bold text-red-700">✕ {lateText(daysLate)}</p>
              <p className="text-xs text-red-600">{s.framesLeft} frame{s.framesLeft === 1 ? '' : 's'} from this week not designed</p>
            </div>
          </div>

          {/* What it takes */}
          <div className="mx-5 mb-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700 space-y-1">
            <p className="font-semibold text-slate-800">What it would take to keep this promise</p>
            {overdue ? (
              <p>
                The promised date has already passed. To finish this week&apos;s bouquets, Design has to get through{' '}
                <b>{Math.round(needFrames)} frames</b> ({Math.round(s.framesAhead)} from older weeks first, then these {Math.round(s.framesLeft)}).
                {shortFrames > 0.5
                  ? <> This week&apos;s schedule covers {Math.round(s.capacityByPromise)}, so it&apos;s <b className="text-red-700">{Math.round(shortFrames)} frames (about {Math.round(shortHours)} hours) short</b> of catching up this week.</>
                  : <> This week&apos;s schedule covers that.</>}
              </p>
            ) : (
              <p>
                Between now and {fmtDate(s.promisedByDate)}, Design has to finish <b>{Math.round(needFrames)} frames</b>{' '}
                ({Math.round(s.framesAhead)} from older weeks first, then these {Math.round(s.framesLeft)}). The schedule covers {Math.round(s.capacityByPromise)}
                {shortFrames > 0.5
                  ? <>, so it&apos;s <b className="text-red-700">{Math.round(shortFrames)} frames (about {Math.round(shortHours)} hours) short</b>.</>
                  : <>, which is enough if the schedule holds.</>}
              </p>
            )}
          </div>

          {/* Orders */}
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-slate-800">
                Orders still waiting{orders ? ` (${orders.length})` : ''}
              </h4>
              {orders && orders.length > 0 && (
                <button onClick={copyOrderNumbers} className="text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">
                  {copied ? '✓ Copied' : 'Copy order numbers'}
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">Live from the production app: every order line received this week that isn&apos;t designed yet.</p>
            {incomplete && <p className="text-xs text-amber-700 mt-1">The production app didn&apos;t return every month of orders, so this list may be missing some.</p>}
            {error && <p className="text-xs text-red-600 mt-2">Couldn&apos;t load orders: {error}</p>}
            {!orders && !error && <p className="text-sm text-slate-400 py-6 text-center">Loading orders… this can take up to a minute.</p>}
            {orders && orders.length === 0 && (
              <p className="text-sm text-slate-500 py-4">No unfinished orders found for this intake week in the production app. The count above comes from logged intake and design totals, so it may need a Historicals correction.</p>
            )}
            {orders && orders.length > 0 && (
              <>
                {orders.length !== Math.round(s.framesLeft) && (
                  <p className="text-xs text-slate-500 mt-1">
                    The production app shows {orders.length} unfinished line{orders.length === 1 ? '' : 's'}; the dashboard&apos;s estimate is {Math.round(s.framesLeft)}. The estimate comes from logged intake and design totals, so the two can drift.
                  </p>
                )}
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                      <th className="py-1.5 pr-3 font-medium">Order</th>
                      <th className="py-1.5 pr-3 font-medium">Customer</th>
                      <th className="py-1.5 pr-3 font-medium">Product</th>
                      <th className="py-1.5 pr-3 font-medium">Where it is</th>
                      <th className="py-1.5 font-medium">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...inQueue, ...drying].map((o, i) => (
                      <tr key={`${o.orderNumber}-${i}`} className="border-b border-slate-50 align-top">
                        <td className="py-1.5 pr-3 font-medium text-slate-800 whitespace-nowrap">#{o.orderNumber}</td>
                        <td className="py-1.5 pr-3 text-slate-700">{o.customer || '—'}</td>
                        <td className="py-1.5 pr-3 text-slate-600">
                          {o.product}
                          {o.variant && <div className="text-xs text-slate-400">{o.variant}</div>}
                        </td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">
                          {o.stage === 'design_queue'
                            ? <span className="text-xs bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5">Waiting for design</span>
                            : <span className="text-xs bg-green-50 text-green-700 rounded px-1.5 py-0.5">Still drying</span>}
                        </td>
                        <td className="py-1.5 text-slate-600 whitespace-nowrap">
                          {fmtDate(o.intakeDate)}
                          {o.intakeSource === 'eventDate' && <div className="text-[10px] text-amber-700" title="No bouquet-received date on record — grouped by event date">event date</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
