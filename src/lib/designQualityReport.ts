/**
 * Design Quality results: rolls graded frames up into the same period
 * windows the All KPIs tab uses (MTD / QTD / YTD, weekly, monthly,
 * quarterly). Pure — no I/O — so it runs in the browser and in tests.
 *
 * A frame belongs to the period its graded week starts in (week_of, the
 * Monday), matching how the old sheets were labeled by week. Only frames
 * marked graded count, and designers skipped for a week are left out.
 */
import { RUBRIC, RUBRIC_MAX } from './designQualityRubric.ts';

export interface ReportPiece {
  id: number;
  weekOf: string;
  designer: string;
  location: string | null;
  orderNum: string;
  variantTitle: string | null;
  scores: Record<string, number>;
  criterionNotes: Record<string, string>;
  notes: string | null;
  seconds: number;
  gradedBy: string | null;
}

export type ReportLocation = 'Utah' | 'Georgia' | 'Combined';
export type ReportWindowType = 'mtd' | 'qtd' | 'ytd' | 'weekly' | 'monthly' | 'quarterly';

export interface Period {
  label: string;
  start: string; // inclusive, YYYY-MM-DD (compared against week_of)
  end: string;   // inclusive
}

export interface ScoreAgg {
  earned: number;
  possible: number;
  pct: number | null; // 0–100
}

export interface QualityAgg {
  frames: number;
  designers: number;
  overall: ScoreAgg;
  sections: Record<string, ScoreAgg>; // keyed by RUBRIC section title
  avgSeconds: number | null;          // per frame, over frames with time recorded
}

export const SECTION_TITLES = RUBRIC.map(s => s.title);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function iso(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayOf(isoDate: string): string {
  const dow = new Date(isoDate + 'T12:00:00Z').getUTCDay();
  return addDays(isoDate, dow === 0 ? -6 : 1 - dow);
}

function fmtShort(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Periods of one window type, newest last (like All KPIs' windows).
 * `today` is a YYYY-MM-DD date; `earliest` is the first graded week, so
 * weekly/monthly/quarterly lists start where the data does.
 */
export function periodsFor(type: ReportWindowType, today: string, earliest: string | null): Period[] {
  const [y, m] = today.split('-').map(Number);
  const m0 = m - 1;
  const q0 = Math.floor(m0 / 3) * 3;
  switch (type) {
    case 'mtd': return [{ label: `${MONTHS[m0]} ${y} MTD`, start: iso(y, m0, 1), end: today }];
    case 'qtd': return [{ label: `Q${q0 / 3 + 1} ${y} QTD`, start: iso(y, q0, 1), end: today }];
    case 'ytd': return [{ label: `${y} YTD`, start: iso(y, 0, 1), end: today }];
  }
  if (!earliest) return [];
  const out: Period[] = [];
  if (type === 'weekly') {
    // Only finished weeks — a week isn't picked or graded until it's over.
    for (let wk = mondayOf(earliest); addDays(wk, 6) < today; wk = addDays(wk, 7)) {
      out.push({ label: `W/C ${fmtShort(wk)}`, start: wk, end: wk });
    }
    return out.slice(-26);
  }
  const [ey, em] = earliest.split('-').map(Number);
  if (type === 'monthly') {
    for (let yy = ey, mm = em - 1; yy < y || (yy === y && mm <= m0); mm === 11 ? (yy++, mm = 0) : mm++) {
      out.push({ label: `${MONTHS[mm]} ${yy}`, start: iso(yy, mm, 1), end: iso(yy, mm + 1, 0) });
    }
    return out.slice(-12);
  }
  // quarterly
  for (let yy = ey, qq = Math.floor((em - 1) / 3); yy < y || (yy === y && qq <= q0 / 3); qq === 3 ? (yy++, qq = 0) : qq++) {
    out.push({ label: `Q${qq + 1} ${yy}`, start: iso(yy, qq * 3, 1), end: iso(yy, qq * 3 + 3, 0) });
  }
  return out.slice(-8);
}

export function inPeriod(p: ReportPiece, period: Period): boolean {
  return p.weekOf >= period.start && p.weekOf <= period.end;
}

export function forLocation(pieces: ReportPiece[], location: ReportLocation): ReportPiece[] {
  return location === 'Combined' ? pieces : pieces.filter(p => p.location === location);
}

function scoreAgg(earned: number, possible: number): ScoreAgg {
  return { earned, possible, pct: possible > 0 ? (earned / possible) * 100 : null };
}

export function aggregate(pieces: ReportPiece[]): QualityAgg {
  const sections: Record<string, ScoreAgg> = {};
  for (const s of RUBRIC) {
    let earned = 0;
    for (const p of pieces) for (const c of s.criteria) earned += p.scores[c.key] ?? 0;
    sections[s.title] = scoreAgg(earned, pieces.length * s.criteria.length);
  }
  const earned = Object.values(sections).reduce((t, s) => t + s.earned, 0);
  const timed = pieces.filter(p => p.seconds > 0);
  return {
    frames: pieces.length,
    designers: new Set(pieces.map(p => p.designer)).size,
    overall: scoreAgg(earned, pieces.length * RUBRIC_MAX),
    sections,
    avgSeconds: timed.length ? timed.reduce((t, p) => t + p.seconds, 0) / timed.length : null,
  };
}

/** Per-designer rollup for one period, sorted by overall score (best first). */
export function byDesigner(pieces: ReportPiece[]): { designer: string; location: string | null; agg: QualityAgg }[] {
  const groups = new Map<string, ReportPiece[]>();
  for (const p of pieces) groups.set(p.designer, [...(groups.get(p.designer) ?? []), p]);
  return [...groups.entries()]
    .map(([designer, ps]) => ({ designer, location: ps[0].location, agg: aggregate(ps) }))
    .sort((a, b) => (b.agg.overall.pct ?? -1) - (a.agg.overall.pct ?? -1) || a.designer.localeCompare(b.designer));
}

/** The rubric lines a frame lost points on, for the drill-down. */
export function missedLines(p: ReportPiece): { section: string; text: string; score: number; note: string | null }[] {
  return RUBRIC.flatMap(s => s.criteria
    .filter(c => (p.scores[c.key] ?? 0) < 1)
    .map(c => ({ section: s.title, text: c.text, score: p.scores[c.key] ?? 0, note: p.criterionNotes[c.key] ?? null })));
}

export function pieceScore(p: ReportPiece): number {
  return RUBRIC.reduce((t, s) => t + s.criteria.reduce((u, c) => u + (p.scores[c.key] ?? 0), 0), 0);
}
