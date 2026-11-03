'use client';

import { useState, useMemo } from 'react';
import { useDisapprovalStats } from './useDisapprovalStats';
import { HelpTip } from './HelpTip';

// ── Name normalization (PF API name → roster name) ───────────────────────────
const PF_NAME_MAP: Record<string, string> = {
  'Chloe Leonard':  'Chloe Jensen',
  'Mia Legas':      'Mia Legas Boots',
  'Kathryn Hill':   'Kathryn Sonntag',
};

function normalizeDesignerName(name: string): string {
  return PF_NAME_MAP[name] ?? name;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

function rateColor(rate: number | null): string {
  if (rate === null) return 'text-slate-300';
  if (rate === 0)    return 'text-green-600';
  if (rate <= 0.15)  return 'text-green-600';
  if (rate <= 0.30)  return 'text-amber-600';
  return 'text-red-600';
}

function fmtWeek(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m) - 1]}`;
}

function getMonthKey(weekOf: string): string {
  return weekOf.slice(0, 7);
}

// ── AI Theme Analysis ─────────────────────────────────────────────────────────

function ThemePanel({ designerName, comments }: { designerName: string; comments: string[] }) {
  const [open,     setOpen]     = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function runAnalysis() {
    if (analysis) { setOpen(o => !o); return; }
    setOpen(true);
    setLoading(true);
    setError(null);
    try {
      const prompt = `You are analyzing client disapproval comments for a floral preservation framing designer named ${designerName}.

Here are the client disapproval comments (${comments.length} total):
${comments.map((c, i) => `${i + 1}. "${c}"`).join('\n')}

Please:
1. Identify the top 2-4 recurring themes (e.g. "color correction requests", "greenery balance", "flower placement")
2. For each theme, give a brief actionable coaching note for the designer
3. Note any one-off comments that don't fit a pattern

Keep your response concise and practical — this will be read by a studio manager. Use plain text with short bullet points.`;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json() as { content: { type: string; text: string }[] };
      const text = data.content?.find(b => b.type === 'text')?.text ?? 'No analysis returned.';
      setAnalysis(text);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  if (comments.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        onClick={runAnalysis}
        className="text-[10px] text-indigo-500 hover:text-indigo-700 underline underline-offset-2 transition-colors"
      >
        {open ? 'hide' : `analyze ${comments.length} comment${comments.length === 1 ? '' : 's'} →`}
      </button>

      {open && (
        <div className="mt-2 bg-indigo-50 border border-indigo-100 rounded-lg p-3 text-xs text-slate-700 max-w-sm">
          {loading && <span className="text-slate-400 italic">Analyzing themes…</span>}
          {error   && <span className="text-red-500">Error: {error}</span>}
          {analysis && (
            <div className="whitespace-pre-wrap leading-relaxed">{analysis}</div>
          )}

          {/* Raw comments expandable */}
          <details className="mt-2">
            <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-600">
              View raw comments ({comments.length})
            </summary>
            <ul className="mt-1.5 space-y-1">
              {comments.map((c, i) => (
                <li key={i} className="text-[10px] text-slate-600 bg-white rounded px-2 py-1 border border-slate-100">
                  "{c}"
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface DisapprovalRateSectionProps {
  location: 'Utah' | 'Georgia';
  memberNames: string[]; // roster names to show (in order)
}

export function DisapprovalRateSection({ location, memberNames }: DisapprovalRateSectionProps) {
  const { data, loading, error } = useDisapprovalStats(location);
  const [showPast, setShowPast] = useState(false);

  const allWeeks = data?.weeks ?? [];
  const allMonths = data?.months ?? [];

  // Only show weeks from 2025-12-29 onward (matches HistoricalsSection start)
  const START_WEEK = '2025-12-29';
  const displayWeeks  = useMemo(() => allWeeks.filter(w => w >= START_WEEK), [allWeeks]);
  const displayMonths = useMemo(() => {
    const monthsInDisplay = new Set(displayWeeks.map(getMonthKey));
    return allMonths.filter(m => monthsInDisplay.has(m));
  }, [allWeeks, allMonths, displayWeeks]);

  // Normalize all PF API names to roster names before display
  const normalizedDesigners = useMemo(() => {
    if (!data) return data;
    const normalized: typeof data.designers = {};
    for (const [name, stats] of Object.entries(data.designers)) {
      const rosterName = normalizeDesignerName(name);
      if (normalized[rosterName]) {
        // Merge if both the PF name and roster name exist (shouldn't happen but safe)
        const existing = normalized[rosterName];
        existing.ytdApprovals    += stats.ytdApprovals;
        existing.ytdDisapprovals += stats.ytdDisapprovals;
        existing.ytdDisapprovalRate = existing.ytdApprovals > 0
          ? existing.ytdDisapprovals / existing.ytdApprovals : null;
        existing.allComments = [...existing.allComments, ...stats.allComments];
        for (const [wk, wkStats] of Object.entries(stats.weekly)) {
          if (existing.weekly[wk]) {
            existing.weekly[wk].approvals    += wkStats.approvals;
            existing.weekly[wk].disapprovals += wkStats.disapprovals;
            existing.weekly[wk].comments      = [...existing.weekly[wk].comments, ...wkStats.comments];
            existing.weekly[wk].disapprovalRate = existing.weekly[wk].approvals > 0
              ? existing.weekly[wk].disapprovals / existing.weekly[wk].approvals : null;
          } else {
            existing.weekly[wk] = { ...wkStats };
          }
        }
        for (const [mon, monStats] of Object.entries(stats.monthly)) {
          if (existing.monthly[mon]) {
            existing.monthly[mon].approvals    += monStats.approvals;
            existing.monthly[mon].disapprovals += monStats.disapprovals;
            existing.monthly[mon].comments      = [...existing.monthly[mon].comments, ...monStats.comments];
            existing.monthly[mon].disapprovalRate = existing.monthly[mon].approvals > 0
              ? existing.monthly[mon].disapprovals / existing.monthly[mon].approvals : null;
          } else {
            existing.monthly[mon] = { ...monStats };
          }
        }
      } else {
        normalized[rosterName] = { ...stats };
      }
    }
    return normalized;
  }, [data]);

  // All designers to show: roster first, then active extras, then past (if toggled)
  const allDisplayNames = useMemo(() => {
    if (!normalizedDesigners) return memberNames;
    const rosterSet = new Set(memberNames);
    const extras = Object.keys(normalizedDesigners).filter(n => !rosterSet.has(n));
    const activeExtras = extras.filter(n => normalizedDesigners[n]?.isActive !== false);
    const pastExtras   = extras.filter(n => normalizedDesigners[n]?.isActive === false);
    return [...memberNames, ...activeExtras, ...(showPast ? pastExtras : [])];
  }, [memberNames, normalizedDesigners, showPast]);

  // Count past employees for toggle label
  const pastCount = useMemo(() => {
    if (!normalizedDesigners) return 0;
    const rosterSet = new Set(memberNames);
    return Object.entries(normalizedDesigners)
      .filter(([n, s]) => !rosterSet.has(n) && s.isActive === false).length;
  }, [memberNames, normalizedDesigners]);

  if (loading) return (
    <div className="text-xs text-slate-400 p-4 animate-pulse">Loading disapproval rates…</div>
  );
  if (error) return (
    <div className="text-xs text-red-500 p-4">Error loading disapproval data: {error}</div>
  );
  if (!data) return null;

  return (
    <div className="space-y-6">

      {/* ── WEEKLY TABLE ── */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="sched.disapproval">Disapproval Rate — Weekly · {location}</HelpTip></h3>
            <p className="text-xs text-slate-400 mt-0.5">
              disapprovals ÷ approvals per week.{' '}
              <span className="text-green-600 font-medium">Green ≤15%</span>{' '}
              <span className="text-amber-600 font-medium">Amber ≤30%</span>{' '}
              <span className="text-red-600 font-medium">Red &gt;30%</span>
            </p>
          </div>
          {pastCount > 0 && (
            <button
              onClick={() => setShowPast(p => !p)}
              className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 transition-colors whitespace-nowrap shrink-0"
            >
              {showPast ? `Hide past employees` : `Show ${pastCount} past employee${pastCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[160px] border-b border-r border-slate-200">
                  Designer
                </th>
                {displayWeeks.map(w => {
                  const mk = getMonthKey(w);
                  const isFirst = displayWeeks.filter(x => getMonthKey(x) === mk)[0] === w;
                  return (
                    <th key={w} className={`px-2 py-1.5 text-center whitespace-nowrap min-w-[60px] border-b border-slate-200 ${isFirst ? 'border-l-2 border-l-slate-300' : 'border-l border-l-slate-100'}`}>
                      <div className="font-medium text-slate-600">{fmtWeek(w)}</div>
                      {isFirst && <div className="text-[9px] text-indigo-500 font-semibold">{mk.split('-')[1] ? monthLabel(mk) : ''}</div>}
                    </th>
                  );
                })}
                <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[70px] border-b border-l-2 border-l-slate-300">
                  YTD
                </th>
              </tr>
            </thead>
            <tbody>
              {allDisplayNames.map((name, ni) => {
                const stats = normalizedDesigners?.[name];
                const isExtra = !memberNames.includes(name);
                return (
                  <tr key={name} className={`${ni % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'} ${isExtra ? 'border-t border-dashed border-slate-200' : ''}`}>
                    <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap border-r border-slate-200 border-b border-b-slate-100">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-700">{name}</span>
                        {isExtra && <span className="text-[9px] bg-indigo-50 text-indigo-500 rounded px-1 py-px">flex</span>}
                      </div>
                      {/* YTD summary under name */}
                      {stats && (
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {stats.ytdDisapprovals}↓ / {stats.ytdApprovals}✓ YTD
                        </div>
                      )}
                    </td>
                    {displayWeeks.map(w => {
                      const wkStats = stats?.weekly[w];
                      const rate    = wkStats?.disapprovalRate ?? null;
                      const hasData = wkStats && (wkStats.approvals > 0 || wkStats.disapprovals > 0);
                      const mk = getMonthKey(w);
                      const isFirst = displayWeeks.filter(x => getMonthKey(x) === mk)[0] === w;
                      return (
                        <td key={w} className={`px-1 py-1.5 text-center border-b border-b-slate-100 ${isFirst ? 'border-l-2 border-l-slate-200' : 'border-l border-l-slate-100'}`}>
                          {hasData ? (
                            <div>
                              <div className={`font-semibold text-[11px] ${rateColor(rate)}`}>
                                {fmtRate(rate)}
                              </div>
                              <div className="text-[9px] text-slate-300">
                                {wkStats.disapprovals}/{wkStats.approvals}
                              </div>
                            </div>
                          ) : (
                            <span className="text-slate-200 text-[10px]">—</span>
                          )}
                        </td>
                      );
                    })}
                    {/* YTD column */}
                    <td className="px-3 py-2 text-center border-b border-b-slate-100 border-l-2 border-l-slate-300">
                      {stats ? (
                        <div>
                          <div className={`font-semibold text-[11px] ${rateColor(stats.ytdDisapprovalRate)}`}>
                            {fmtRate(stats.ytdDisapprovalRate)}
                          </div>
                          <div className="text-[9px] text-slate-400">
                            {stats.ytdDisapprovals}/{stats.ytdApprovals}
                          </div>
                          <ThemePanel designerName={name} comments={stats.allComments} />
                        </div>
                      ) : (
                        <span className="text-slate-200 text-[10px]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── MONTHLY SUMMARY ── */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="sched.disapproval">Disapproval Rate — Monthly Summary · {location}</HelpTip></h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Monthly disapproval rate per designer with raw counts and AI theme analysis.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[160px] border-r border-slate-200">
                  Designer
                </th>
                {displayMonths.map(mk => (
                  <th key={mk} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px] border-l border-slate-100">
                    {monthLabel(mk)}
                  </th>
                ))}
                <th className="px-3 py-2 text-center font-semibold text-indigo-600 whitespace-nowrap min-w-[80px] border-l-2 border-l-slate-300">
                  YTD
                </th>
              </tr>
            </thead>
            <tbody>
              {allDisplayNames.map((name, ni) => {
                const stats  = data.designers[name];
                const isExtra = !memberNames.includes(name);
                return (
                  <tr key={name} className={`border-b border-slate-100 ${ni % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'} ${isExtra ? 'border-t border-dashed border-slate-200' : ''}`}>
                    <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap border-r border-slate-200">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-700">{name}</span>
                        {isExtra && <span className="text-[9px] bg-indigo-50 text-indigo-500 rounded px-1 py-px">flex</span>}
                      </div>
                    </td>
                    {displayMonths.map(mk => {
                      const monStats = stats?.monthly[mk];
                      const rate     = monStats?.disapprovalRate ?? null;
                      const hasData  = monStats && (monStats.approvals > 0 || monStats.disapprovals > 0);
                      return (
                        <td key={mk} className="px-3 py-2 text-center border-l border-slate-100">
                          {hasData ? (
                            <div>
                              <div className={`font-semibold ${rateColor(rate)}`}>
                                {fmtRate(rate)}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {monStats.disapprovals}↓ / {monStats.approvals}✓
                              </div>
                              {monStats.comments.length > 0 && (
                                <ThemePanel
                                  designerName={name}
                                  comments={monStats.comments}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-200">—</span>
                          )}
                        </td>
                      );
                    })}
                    {/* YTD column */}
                    <td className="px-3 py-2 text-center border-l-2 border-l-slate-300">
                      {stats ? (
                        <div>
                          <div className={`font-semibold text-indigo-700`}>
                            {fmtRate(stats.ytdDisapprovalRate)}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {stats.ytdDisapprovals}↓ / {stats.ytdApprovals}✓
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-200">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}

              {/* Team totals row */}
              <tr className="border-t-2 border-slate-200 bg-indigo-50/30 font-semibold">
                <td className="sticky left-0 bg-indigo-50/30 px-4 py-2 text-slate-700 border-r border-slate-200">
                  Team total
                </td>
                {displayMonths.map(mk => {
                  let totalApprovals    = 0;
                  let totalDisapprovals = 0;
                  for (const name of allDisplayNames) {
                    const m = data.designers[name]?.monthly[mk];
                    if (m) { totalApprovals += m.approvals; totalDisapprovals += m.disapprovals; }
                  }
                  const rate = totalApprovals > 0 ? totalDisapprovals / totalApprovals : null;
                  return (
                    <td key={mk} className="px-3 py-2 text-center border-l border-slate-100">
                      {totalApprovals > 0 ? (
                        <div>
                          <div className={`font-semibold ${rateColor(rate)}`}>{fmtRate(rate)}</div>
                          <div className="text-[10px] text-slate-400">{totalDisapprovals}↓ / {totalApprovals}✓</div>
                        </div>
                      ) : <span className="text-slate-200">—</span>}
                    </td>
                  );
                })}
                {/* YTD team total */}
                <td className="px-3 py-2 text-center border-l-2 border-l-slate-300">
                  {(() => {
                    let tot_a = 0, tot_d = 0;
                    for (const name of allDisplayNames) {
                      const s = normalizedDesigners?.[name];
                      if (s) { tot_a += s.ytdApprovals; tot_d += s.ytdDisapprovals; }
                    }
                    const rate = tot_a > 0 ? tot_d / tot_a : null;
                    return tot_a > 0 ? (
                      <div>
                        <div className={`font-semibold ${rateColor(rate)}`}>{fmtRate(rate)}</div>
                        <div className="text-[10px] text-slate-400">{tot_d}↓ / {tot_a}✓</div>
                      </div>
                    ) : <span className="text-slate-200">—</span>;
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
