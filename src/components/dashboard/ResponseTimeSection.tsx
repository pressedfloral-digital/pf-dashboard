'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ResponseTimeResult } from '@/types/dashboard';
import { HelpTip } from './HelpTip';

function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

function speedColor(minutes: number): string {
  if (minutes <= 60)  return 'text-emerald-600';
  if (minutes <= 240) return 'text-amber-600';
  return 'text-red-600';
}

function lastWeekRange(): { start: string; end: string } {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - ((dayOfWeek + 6) % 7) - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  return {
    start: lastMonday.toISOString().split('T')[0],
    end:   lastSunday.toISOString().split('T')[0],
  };
}

export function ResponseTimeSection({ location = 'Utah' }: { location?: string }) {
  const defaultRange = lastWeekRange();
  const [start,   setStart]   = useState(defaultRange.start);
  const [end,     setEnd]     = useState(defaultRange.end);
  const [result,  setResult]  = useState<ResponseTimeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function calculate() {
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await fetch('/api/response-times', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end, location }),
      });
      const data = await res.json() as ResponseTimeResult & { error?: string };
      if (data.error) { setError(data.error); return; }
      setResult(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const designerRows = result
    ? Object.entries(result.byDesigner)
        .filter(([, v]) => v.sampleSize > 0)
        .sort((a, b) => a[1].avgMinutes - b[1].avgMinutes)
    : [];

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        <HelpTip id="response.title">Response Times</HelpTip>
      </h2>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-sm font-semibold text-slate-700">
              <HelpTip id="response.title">Client Message → First Designer Reply</HelpTip>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs text-slate-500 flex items-center gap-1">
                From
                <input
                  type="date"
                  value={start}
                  onChange={e => setStart(e.target.value)}
                  className="ml-1 border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300"
                />
              </label>
              <label className="text-xs text-slate-500 flex items-center gap-1">
                To
                <input
                  type="date"
                  value={end}
                  onChange={e => setEnd(e.target.value)}
                  className="ml-1 border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300"
                />
              </label>
              <button
                onClick={calculate}
                disabled={loading}
                className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Calculating…' : result ? 'Recalculate' : 'Calculate Response Times'}
              </button>
            </div>
          </div>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </CardHeader>
        <CardContent>
          {!result && !loading && (
            <p className="text-sm text-slate-400 py-6 text-center">
              Select a date range and click &ldquo;Calculate Response Times&rdquo; to analyze designer reply speed.
            </p>
          )}
          {loading && (
            <p className="text-sm text-slate-400 py-6 text-center">
              Fetching conversations… this may take a moment.
            </p>
          )}
          {result && !loading && (
            <>
              {result.overall.sampleSize > 0 && (
                <div className="mb-4 p-3 bg-slate-50 rounded-lg flex items-center gap-4">
                  <div>
                    <HelpTip id="response.average" className="text-xs text-slate-500 uppercase tracking-wide">Team Average</HelpTip>
                    <p className={`text-2xl font-bold ${speedColor(result.overall.avgMinutes)}`}>
                      {fmtDuration(result.overall.avgMinutes)}
                    </p>
                  </div>
                  <p className="text-xs text-slate-400">
                    across {result.overall.sampleSize} responses
                  </p>
                </div>
              )}
              {designerRows.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">
                  No response data found. The API account may need Admin or Manager access to read conversations.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-2 pr-4 font-medium text-slate-600">Designer</th>
                      <th className="text-center py-2 px-4 font-medium text-slate-600">Avg Response</th>
                      <th className="text-center py-2 pl-4 font-medium text-slate-400 text-xs">Responses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {designerRows.map(([name, stats]) => (
                      <tr key={name} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-2 pr-4 text-slate-700 font-medium">{name}</td>
                        <td className={`text-center py-2 px-4 font-semibold ${speedColor(stats.avgMinutes)}`}>
                          {fmtDuration(stats.avgMinutes)}
                        </td>
                        <td className="text-center py-2 pl-4 text-slate-400 text-xs">
                          {stats.sampleSize}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
