'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from './HelpTip';

type DayResult = { count: number; orders: { name: string; customer: string }[] };

function getMonday(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return mon;
}

function fmtDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

const PRESETS = [
  { label: 'This Week',   getRange: () => { const mon = getMonday(new Date()); return { start: fmtDate(mon), end: fmtDate(addDays(mon, 6)) }; } },
  { label: 'Next Week',   getRange: () => { const mon = getMonday(addDays(new Date(), 7)); return { start: fmtDate(mon), end: fmtDate(addDays(mon, 6)) }; } },
  { label: 'Next 2 Wks', getRange: () => { const mon = getMonday(new Date()); return { start: fmtDate(mon), end: fmtDate(addDays(mon, 13)) }; } },
  { label: 'This Month',  getRange: () => { const t = new Date(); return { start: fmtDate(new Date(t.getFullYear(), t.getMonth(), 1)), end: fmtDate(new Date(t.getFullYear(), t.getMonth() + 1, 0)) }; } },
  { label: 'Next Month',  getRange: () => { const t = new Date(); return { start: fmtDate(new Date(t.getFullYear(), t.getMonth() + 1, 1)), end: fmtDate(new Date(t.getFullYear(), t.getMonth() + 2, 0)) }; } },
];

export function EventDateSection() {
  const defaultRange = PRESETS[0].getRange();
  const [start, setStart]         = useState(defaultRange.start);
  const [end, setEnd]             = useState(defaultRange.end);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [result, setResult]       = useState<{ byDate: Record<string, DayResult>; total: number } | null>(null);
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState('This Week');

  function applyPreset(preset: typeof PRESETS[0]) {
    const range = preset.getRange();
    setStart(range.start);
    setEnd(range.end);
    setActivePreset(preset.label);
    setResult(null);
    setExpanded(null);
  }

  async function load() {
    if (!start || !end || start > end) { setError('Invalid date range'); return; }
    setLoading(true);
    setError(null);
    setExpanded(null);
    try {
      const res = await fetch(`/api/event-date-orders?start=${start}&end=${end}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
    setLoading(false);
  }

  // Sort dates ascending
  const sortedDates = result
    ? Object.entries(result.byDate)
        .filter(([, d]) => d.count > 0)
        .sort(([a], [b]) => a.localeCompare(b))
    : [];

  const formatDisplayDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  return (
    <section>
      <div className="flex items-baseline gap-4 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          <HelpTip id="event.title">Orders by Event Date</HelpTip>
        </h2>
        <span className="text-xs text-slate-400">pulled from Shopify order tags</span>
      </div>

      <Card className="border border-rose-200 bg-rose-50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-rose-800"><HelpTip id="event.title">Event Date Lookup</HelpTip></CardTitle>

          {/* Preset buttons */}
          <div className="flex gap-1.5 flex-wrap mt-1">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  activePreset === p.label
                    ? 'bg-rose-700 text-white'
                    : 'bg-white border border-rose-200 text-rose-700 hover:bg-rose-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Date range inputs */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <input
              type="date"
              value={start}
              onChange={e => { setStart(e.target.value); setActivePreset(''); setResult(null); }}
              className="border border-rose-200 rounded px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-rose-300"
            />
            <span className="text-xs text-slate-400">to</span>
            <input
              type="date"
              value={end}
              onChange={e => { setEnd(e.target.value); setActivePreset(''); setResult(null); }}
              className="border border-rose-200 rounded px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-rose-300"
            />
            <button
              onClick={load}
              disabled={loading}
              className="px-3 py-1 text-xs font-medium rounded bg-rose-700 text-white hover:bg-rose-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Loading…' : 'Load'}
            </button>
            {result && (
              <span className="text-xs font-semibold text-rose-800">
                {result.total.toLocaleString()} total order{result.total !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </CardHeader>

        <CardContent>
          {error && <p className="text-sm text-red-500 mb-2">{error}</p>}

          {result && sortedDates.length === 0 && (
            <p className="text-sm text-rose-600 italic">No orders found with event dates in this range.</p>
          )}

          {sortedDates.length > 0 && (
            <div className="space-y-1">
              {sortedDates.map(([date, day]) => (
                <div key={date}>
                  <button
                    onClick={() => setExpanded(e => e === date ? null : date)}
                    className="w-full flex items-center justify-between px-3 py-1.5 rounded bg-white border border-rose-100 hover:bg-rose-50 transition-colors text-left"
                  >
                    <span className="text-sm text-slate-700">{formatDisplayDate(date)}</span>
                    <span className="text-xs font-semibold bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">
                      {day.count} order{day.count !== 1 ? 's' : ''} {expanded === date ? '▲' : '▼'}
                    </span>
                  </button>

                  {expanded === date && (
                    <div className="ml-2 mt-0.5 mb-1 rounded border border-rose-100 bg-white overflow-auto max-h-48">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="bg-rose-50 border-b border-rose-100 text-left">
                            <th className="px-3 py-1.5 font-medium text-rose-700">Order</th>
                            <th className="px-3 py-1.5 font-medium text-rose-700">Customer</th>
                          </tr>
                        </thead>
                        <tbody>
                          {day.orders.map(o => (
                            <tr key={o.name} className="border-b border-rose-50 last:border-0 hover:bg-rose-50">
                              <td className="px-3 py-1.5 font-mono text-rose-700">{o.name}</td>
                              <td className="px-3 py-1.5 text-slate-600">{o.customer}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
