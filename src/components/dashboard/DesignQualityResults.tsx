'use client';

// Design Quality results — laid out like the All KPIs tab (AllKpisPage.tsx):
// the same Location / Breakdown / Time window control bars, MTD/QTD/YTD
// rolling cards, and heat-shaded weekly/monthly/quarterly tables. The rubric
// sections stand in for All KPIs' department columns. Higher is better here,
// so the heat scale runs the other way: green at a column's best (highest).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  aggregate, byDesigner, forLocation, inPeriod, missedLines, periodsFor, pieceScore, SECTION_TITLES,
  type Period, type QualityAgg, type ReportLocation, type ReportPiece, type ReportWindowType, type ScoreAgg,
} from '@/lib/designQualityReport';
import { RUBRIC, RUBRIC_MAX } from '@/lib/designQualityRubric';

type Breakdown = 'category' | 'designer';

const LOCATIONS: { id: ReportLocation; label: string }[] = [
  { id: 'Utah', label: 'Utah' },
  { id: 'Georgia', label: 'Georgia' },
  { id: 'Combined', label: 'Combined' },
];

const TIME_WINDOWS: { id: ReportWindowType; label: string }[] = [
  { id: 'mtd', label: 'Month to date' },
  { id: 'qtd', label: 'Quarter to date' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
];

// Columns: Overall, then each rubric section (like Combined + departments).
const COLUMNS = ['Overall', ...SECTION_TITLES];

// How many periods the designer × period table shows at once.
const DESIGNER_PERIOD_COLS: Record<'weekly' | 'monthly' | 'quarterly', number> = { weekly: 8, monthly: 6, quarterly: 4 };

const isRolling = (w: ReportWindowType) => w === 'mtd' || w === 'qtd' || w === 'ytd';

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtPct(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(1)}%`;
}

function fmtPts(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtTime(seconds: number | null): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtWeek(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function columnAgg(agg: QualityAgg, column: string): ScoreAgg {
  return column === 'Overall' ? agg.overall : agg.sections[column];
}

// ── Heatmap (same three-stop scale as All KPIs, reversed: high = green) ───────

interface HeatStats { min: number; max: number; median: number }

const HEAT_GREEN: [number, number, number] = [87, 187, 138];
const HEAT_YELLOW: [number, number, number] = [255, 214, 102];
const HEAT_RED: [number, number, number] = [230, 124, 115];

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  return `rgb(${a[0] + (b[0] - a[0]) * t}, ${a[1] + (b[1] - a[1]) * t}, ${a[2] + (b[2] - a[2]) * t})`;
}

function heatStats(values: (number | null)[]): HeatStats | undefined {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (v.length < 2) return undefined; // one value has nothing to be compared to
  const mid = Math.floor(v.length / 2);
  return { min: v[0], max: v[v.length - 1], median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2 };
}

function heatBackground(value: number | null, stats: HeatStats | undefined): string | undefined {
  if (value == null || !stats) return undefined;
  const { min, max, median } = stats;
  if (value >= median) {
    const t = max > median ? (value - median) / (max - median) : 0;
    return lerpRgb(HEAT_YELLOW, HEAT_GREEN, t);
  }
  const t = median > min ? (median - value) / (median - min) : 0;
  return lerpRgb(HEAT_YELLOW, HEAT_RED, t);
}

function HeatLegend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
      <span>Best</span>
      <div className="w-16 h-2 rounded-full" style={{ background: `linear-gradient(to right, rgb(${HEAT_GREEN.join(',')}), rgb(${HEAT_YELLOW.join(',')}), rgb(${HEAT_RED.join(',')}))` }} />
      <span>Worst</span>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function TabBar<T extends string>({ tabs, active, onChange }: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:gap-1">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3.5 py-2.5 sm:px-3 sm:py-1.5 rounded-md font-medium transition-colors text-xs ${
            active === t.id
              ? 'bg-indigo-600 text-white'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 active:bg-slate-100'
          }`}
        >{t.label}</button>
      ))}
    </div>
  );
}

function ControlLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{children}</div>;
}

// Single score cell — the KpiCell of this page.
function ScoreCell({ score, frames, heatShaded = false }: { score: ScoreAgg; frames: number; heatShaded?: boolean }) {
  if (!frames) return <span className="text-slate-300 text-sm">—</span>;
  return (
    <div className="space-y-0.5">
      <div className="text-lg font-semibold tabular-nums text-slate-800">{fmtPct(score.pct)}</div>
      <div className={`text-xs tabular-nums ${heatShaded ? 'text-slate-800' : 'text-slate-400'}`}>
        {fmtPts(score.earned)} / {fmtPts(score.possible)} pts
      </div>
    </div>
  );
}

function TimeCell({ agg }: { agg: QualityAgg }) {
  if (!agg.frames) return <span className="text-slate-300 text-sm">—</span>;
  return (
    <div className="space-y-0.5">
      <div className="text-lg font-semibold tabular-nums text-slate-800">{fmtTime(agg.avgSeconds)}</div>
      <div className="text-xs tabular-nums text-slate-400">{agg.frames} frame{agg.frames === 1 ? '' : 's'} · {agg.designers} designer{agg.designers === 1 ? '' : 's'}</div>
    </div>
  );
}

const TH = 'py-3 px-4 text-xs font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap';

// ── Category views ────────────────────────────────────────────────────────────

function RollingCard({ period, pieces }: { period: Period; pieces: ReportPiece[] }) {
  const agg = aggregate(pieces.filter(p => inPeriod(p, period)));
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-4">{period.label}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {COLUMNS.map(col => (
          <div key={col} className="space-y-1">
            <div className="text-xs text-slate-500 font-medium">{col}</div>
            <ScoreCell score={columnAgg(agg, col)} frames={agg.frames} />
          </div>
        ))}
        <div className="space-y-1">
          <div className="text-xs text-slate-500 font-medium">Avg time to grade</div>
          <TimeCell agg={agg} />
        </div>
      </div>
    </div>
  );
}

function CategoryHistoricalTable({ periods, pieces }: { periods: Period[]; pieces: ReportPiece[] }) {
  const rows = useMemo(
    () => [...periods].reverse().map(period => ({ period, agg: aggregate(pieces.filter(p => inPeriod(p, period))) })),
    [periods, pieces],
  );
  if (!rows.some(r => r.agg.frames)) return <div className="text-sm text-slate-400 py-8 text-center">No graded frames for this period</div>;
  const stats = Object.fromEntries(COLUMNS.map(col => [col, heatStats(rows.filter(r => r.agg.frames).map(r => columnAgg(r.agg, col).pct))]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200">
            <th className={TH}>Period</th>
            {COLUMNS.map(col => <th key={col} className={TH}>{col}</th>)}
            <th className={TH}>Avg time to grade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ period, agg }) => (
            <tr key={period.start} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="py-3 px-4 text-sm text-slate-600 font-medium whitespace-nowrap">{period.label}</td>
              {COLUMNS.map(col => {
                const score = columnAgg(agg, col);
                const bg = agg.frames ? heatBackground(score.pct, stats[col]) : undefined;
                return (
                  <td key={col} className="py-3 px-4" style={bg ? { backgroundColor: bg } : undefined}>
                    <ScoreCell score={score} frames={agg.frames} heatShaded={bg != null} />
                  </td>
                );
              })}
              <td className="py-3 px-4"><TimeCell agg={agg} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Designer views ────────────────────────────────────────────────────────────

function DesignerTable({ pieces, showLocation, selected, onSelect }: {
  pieces: ReportPiece[];
  showLocation: boolean;
  selected: string | null;
  onSelect: (designer: string) => void;
}) {
  const rows = useMemo(() => byDesigner(pieces), [pieces]);
  if (!rows.length) return <div className="text-sm text-slate-400 py-8 text-center">No graded frames for this period</div>;
  const stats = Object.fromEntries(COLUMNS.map(col => [col, heatStats(rows.map(r => columnAgg(r.agg, col).pct))]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200">
            <th className={TH}>Designer</th>
            {COLUMNS.map(col => <th key={col} className={TH}>{col}</th>)}
            <th className={TH}>Avg time to grade</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ designer, location, agg }) => (
            <tr
              key={designer}
              onClick={() => onSelect(designer)}
              className={`border-t border-slate-100 cursor-pointer ${selected === designer ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
            >
              <td className="py-3 px-4 text-sm text-slate-700 font-medium whitespace-nowrap">
                {designer}
                {showLocation && location && <div className="text-[11px] font-normal text-slate-400">{location}</div>}
              </td>
              {COLUMNS.map(col => {
                const score = columnAgg(agg, col);
                const bg = heatBackground(score.pct, stats[col]);
                return (
                  <td key={col} className="py-3 px-4" style={bg ? { backgroundColor: bg } : undefined}>
                    <ScoreCell score={score} frames={agg.frames} heatShaded={bg != null} />
                  </td>
                );
              })}
              <td className="py-3 px-4"><TimeCell agg={agg} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DesignerByPeriodTable({ periods, pieces, showLocation, selected, onSelect }: {
  periods: Period[];
  pieces: ReportPiece[];
  showLocation: boolean;
  selected: string | null;
  onSelect: (designer: string) => void;
}) {
  const cols = useMemo(() => [...periods].reverse(), [periods]);
  const designers = useMemo(() => byDesigner(pieces), [pieces]);
  const cells = useMemo(() => new Map(designers.map(d => [
    d.designer,
    cols.map(period => aggregate(pieces.filter(p => p.designer === d.designer && inPeriod(p, period)))),
  ])), [designers, cols, pieces]);
  if (!designers.length) return <div className="text-sm text-slate-400 py-8 text-center">No graded frames for this period</div>;
  const stats = cols.map((_, i) => heatStats(designers.map(d => cells.get(d.designer)![i]).filter(a => a.frames).map(a => a.overall.pct)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200">
            <th className={TH}>Designer</th>
            <th className={TH}>All shown</th>
            {cols.map(p => <th key={p.start} className={TH}>{p.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {designers.map(({ designer, location, agg }) => (
            <tr
              key={designer}
              onClick={() => onSelect(designer)}
              className={`border-t border-slate-100 cursor-pointer ${selected === designer ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
            >
              <td className="py-3 px-4 text-sm text-slate-700 font-medium whitespace-nowrap">
                {designer}
                {showLocation && location && <div className="text-[11px] font-normal text-slate-400">{location}</div>}
              </td>
              <td className="py-3 px-4 border-r border-slate-100">
                <ScoreCell score={agg.overall} frames={agg.frames} />
              </td>
              {cells.get(designer)!.map((a, i) => {
                const bg = a.frames ? heatBackground(a.overall.pct, stats[i]) : undefined;
                return (
                  <td key={cols[i].start} className="py-3 px-4" style={bg ? { backgroundColor: bg } : undefined}>
                    {a.frames ? (
                      <div className="space-y-0.5">
                        <div className="text-lg font-semibold tabular-nums text-slate-800">{fmtPct(a.overall.pct)}</div>
                        <div className={`text-xs tabular-nums ${bg ? 'text-slate-800' : 'text-slate-400'}`}>{a.frames} frame{a.frames === 1 ? '' : 's'}</div>
                      </div>
                    ) : <span className="text-slate-300 text-sm">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Every graded frame for one designer, with the lines they lost points on.
function DesignerDrilldown({ designer, pieces, onClose }: { designer: string; pieces: ReportPiece[]; onClose: () => void }) {
  const frames = useMemo(
    () => pieces.filter(p => p.designer === designer).sort((a, b) => b.weekOf.localeCompare(a.weekOf) || a.orderNum.localeCompare(b.orderNum)),
    [designer, pieces],
  );
  const agg = aggregate(frames);
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-sm font-medium text-slate-700">{designer} — {frames.length} graded frame{frames.length === 1 ? '' : 's'}</div>
          <div className="text-xs text-slate-400">
            {fmtPct(agg.overall.pct)} overall · {SECTION_TITLES.map(t => `${t} ${fmtPct(agg.sections[t].pct)}`).join(' · ')}
          </div>
        </div>
        <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 px-3 py-1.5 rounded-md bg-white hover:bg-slate-50">Close</button>
      </div>
      <ul className="divide-y divide-slate-100">
        {frames.map(p => {
          const missed = missedLines(p);
          const score = pieceScore(p);
          return (
            <li key={p.id} className="px-5 py-4 space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm text-slate-700">
                  <span className="font-medium">Order #{p.orderNum}</span>
                  {p.variantTitle && <span className="ml-2 text-slate-400">{p.variantTitle}</span>}
                  <span className="ml-2 text-xs text-slate-400">W/C {fmtWeek(p.weekOf)}</span>
                </div>
                <div className="text-sm tabular-nums">
                  <span className="font-semibold text-slate-800">{fmtPts(score)} / {RUBRIC_MAX}</span>
                  <span className="ml-1 text-slate-400">({((score / RUBRIC_MAX) * 100).toFixed(1)}%)</span>
                  <span className="ml-3 text-xs text-slate-400">{fmtTime(p.seconds || null)}{p.gradedBy ? ` · ${p.gradedBy}` : ''}</span>
                </div>
              </div>
              {missed.length > 0 ? (
                <ul className="space-y-1.5">
                  {missed.map(m => (
                    <li key={m.text} className="flex gap-3 text-sm">
                      <span className={`shrink-0 w-7 text-center rounded text-xs font-semibold py-0.5 ${m.score === 0.5 ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-700'}`}>
                        {m.score === 0.5 ? '½' : '0'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-slate-700"><span className="text-slate-400">{m.section}:</span> {m.text}</div>
                        {m.note && <div className="text-slate-500 italic">{m.note}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-emerald-700">Full marks on every line.</div>
              )}
              {p.notes && <div className="text-sm text-slate-600 bg-slate-50 rounded-md px-3 py-2">{p.notes}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DesignQualityResults() {
  const [pieces, setPieces] = useState<ReportPiece[]>([]);
  const [today, setToday] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [location, setLocation] = useState<ReportLocation>('Utah');
  const [breakdown, setBreakdown] = useState<Breakdown>('category');
  const [timeWindow, setTimeWindow] = useState<ReportWindowType>('mtd');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/design-quality/report');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setPieces(json.pieces);
      setToday(json.today);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const locPieces = useMemo(() => forLocation(pieces, location), [pieces, location]);
  const earliest = useMemo(() => pieces.reduce<string | null>((m, p) => (m == null || p.weekOf < m ? p.weekOf : m), null), [pieces]);
  const periods = useMemo(() => (today ? periodsFor(timeWindow, today, earliest) : []), [timeWindow, today, earliest]);

  // Designer views: the frames inside the window being shown.
  const shownPeriods = useMemo(
    () => (isRolling(timeWindow) ? periods : periods.slice(-DESIGNER_PERIOD_COLS[timeWindow as 'weekly' | 'monthly' | 'quarterly'])),
    [periods, timeWindow],
  );
  const windowPieces = useMemo(
    () => locPieces.filter(p => shownPeriods.some(period => inPeriod(p, period))),
    [locPieces, shownPeriods],
  );
  const selectedVisible = selected && windowPieces.some(p => p.designer === selected) ? selected : null;

  const windowTitle = TIME_WINDOWS.find(t => t.id === timeWindow)!.label;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Design Quality</h2>
          <p className="text-sm text-slate-500 mt-0.5">Quality score on graded frames, by rubric category and designer</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs text-slate-500 hover:text-slate-700 border border-slate-200 px-3 py-1.5 rounded-md bg-white hover:bg-slate-50 transition-colors disabled:opacity-40"
        >{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* ── Controls row ── */}
      <div className="flex flex-wrap gap-4 items-start">
        <div className="space-y-1.5">
          <ControlLabel>Location</ControlLabel>
          <TabBar tabs={LOCATIONS} active={location} onChange={l => { setLocation(l); setSelected(null); }} />
        </div>
        <div className="space-y-1.5">
          <ControlLabel>Breakdown</ControlLabel>
          <TabBar
            tabs={[{ id: 'category' as Breakdown, label: 'By category' }, { id: 'designer' as Breakdown, label: 'By designer' }]}
            active={breakdown}
            onChange={setBreakdown}
          />
        </div>
        <div className="space-y-1.5">
          <ControlLabel>Time window</ControlLabel>
          <TabBar tabs={TIME_WINDOWS} active={timeWindow} onChange={setTimeWindow} />
        </div>
      </div>

      {/* ── Column legend ── */}
      <div className="flex flex-wrap gap-3">
        {COLUMNS.map(col => (
          <div key={col} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-indigo-400" />
            <span className="text-xs text-slate-500">
              {col}
              <span className="text-slate-300 ml-1">
                ({col === 'Overall' ? RUBRIC_MAX : sectionSize(col)} pts/frame)
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* ── Content area ── */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {breakdown === 'category' && isRolling(timeWindow) && periods.map(period => (
            <RollingCard key={period.label} period={period} pieces={locPieces} />
          ))}

          {breakdown === 'category' && !isRolling(timeWindow) && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-medium text-slate-700">{windowTitle} — {periods.length} {periodNoun(timeWindow, periods.length)}</div>
                <HeatLegend />
              </div>
              <CategoryHistoricalTable periods={periods} pieces={locPieces} />
            </div>
          )}

          {breakdown === 'designer' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-sm font-medium text-slate-700">
                  {isRolling(timeWindow)
                    ? `${periods[0]?.label ?? windowTitle} — by designer`
                    : `${windowTitle} — last ${shownPeriods.length} ${periodNoun(timeWindow, shownPeriods.length)}, by designer`}
                  <span className="ml-2 text-xs font-normal text-slate-400">Click a designer to see each graded frame</span>
                </div>
                <HeatLegend />
              </div>
              {isRolling(timeWindow) ? (
                <DesignerTable pieces={windowPieces} showLocation={location === 'Combined'} selected={selectedVisible} onSelect={setSelected} />
              ) : (
                <DesignerByPeriodTable periods={shownPeriods} pieces={windowPieces} showLocation={location === 'Combined'} selected={selectedVisible} onSelect={setSelected} />
              )}
            </div>
          )}

          {breakdown === 'designer' && selectedVisible && (
            <DesignerDrilldown designer={selectedVisible} pieces={windowPieces} onClose={() => setSelected(null)} />
          )}
        </div>
      )}

      {/* ── Formula footnote ── */}
      <div className="text-xs text-slate-400 border-t border-slate-100 pt-4 space-y-1">
        <p><strong>Quality score</strong> = points earned ÷ points possible across every graded frame in the period. Each frame is scored on the {RUBRIC_MAX}-point rubric, 0 / ½ / 1 per line. Higher is better.</p>
        <p><strong>Category</strong> columns use the same math on just that section&apos;s lines ({SECTION_TITLES.map(t => `${t} ${sectionSize(t)}`).join(', ')} pts).</p>
        <p>Frames count toward the period their graded week starts in. Only frames marked <strong>graded</strong> count, and designers skipped for a week are left out.</p>
        <p><strong>Avg time to grade</strong> = time the grader had each frame open, averaged per frame.</p>
        {(breakdown === 'designer' || !isRolling(timeWindow)) && (
          <p>Shading compares each column against the other rows in it: green at the best score shown, yellow at the median, red at the lowest.</p>
        )}
      </div>
    </div>
  );
}

function sectionSize(title: string): number {
  return RUBRIC.find(s => s.title === title)?.criteria.length ?? 0;
}

function periodNoun(w: ReportWindowType, n: number): string {
  const base = w === 'weekly' ? 'week' : w === 'monthly' ? 'month' : 'quarter';
  return n === 1 ? base : `${base}s`;
}
