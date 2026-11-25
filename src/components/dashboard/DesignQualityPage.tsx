'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RUBRIC, RUBRIC_KEYS, RUBRIC_MAX, MAX_PIECES, pieceTotal, scoredCount, type CriterionScore,
} from '@/lib/designQualityRubric';
import DesignQualityResults from './DesignQualityResults';

// ── Types (mirror /api/design-quality) ────────────────────────────────────────

interface Piece {
  id: number;
  designer_id: number;
  slot: number;
  order_num: string;
  order_product_uuid: string;
  variant_title: string | null;
  first_no_response_at: string;
  scores: Record<string, number>;
  criterion_notes: Record<string, string>;
  notes: string | null;
  seconds_spent: number;
  completed_at: string | null;
  graded_by_name: string | null;
}

interface Designer {
  id: number;
  week_of: string;
  designer_name: string;
  location: string | null;
  hours: number | null;
  frames_available: number;
  unpicked_count: number;
  target_count: number;
  excluded: boolean;
  pieces: Piece[];
}

interface WeekData {
  weekOf: string;
  generated: boolean;
  designers: Designer[];
  defaultWeek: string;
  generatedWeeks: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDay(iso: string, withYear = false): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}

function weekLabel(weekOf: string): string {
  return `${fmtDay(weekOf)} – ${fmtDay(addDays(weekOf, 6), true)}`;
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s).padStart(2, '0')}`;
}

function scoreLabel(v: number): string {
  return v === 0.5 ? '½' : String(v);
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

const isPieceDone = (p: Piece) => !!p.completed_at;

// ── Page ──────────────────────────────────────────────────────────────────────

// Two sides: Results (the All KPIs-style view for leadership) and Grading
// (where the grader picks the week's frames and scores them).
export default function DesignQualityPage() {
  const [view, setView] = useState<'results' | 'grading'>('results');
  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 w-fit">
        {([['results', 'Results'], ['grading', 'Grading']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >{label}</button>
        ))}
      </div>
      {view === 'results' ? <DesignQualityResults /> : <GradingView />}
    </div>
  );
}

function GradingView() {
  const [weekOf, setWeekOf] = useState<string | null>(null);
  const [data, setData] = useState<WeekData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openDesignerId, setOpenDesignerId] = useState<number | null>(null);

  const load = useCallback(async (week: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<WeekData>(`/api/design-quality${week ? `?week=${week}` : ''}`);
      setData(d);
      setWeekOf(d.weekOf);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(null); }, [load]);

  // Silent refresh after a mutation that the server resolves (re-pick, count change).
  const refresh = useCallback(async () => {
    if (!weekOf) return;
    try {
      setData(await api<WeekData>(`/api/design-quality?week=${weekOf}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [weekOf]);

  const generate = async () => {
    if (!weekOf) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const d = await api<WeekData & { added: number; refreshed: number }>('/api/design-quality', {
        method: 'POST', body: JSON.stringify({ weekOf }),
      });
      setData(d);
      setNotice(d.added
        ? `Picked frames for ${d.added} designer${d.added === 1 ? '' : 's'}.`
        : 'No new designers this week — everyone already has their frames.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  // Local, optimistic piece update (the editor saves to the server itself).
  const patchPieceLocal = useCallback((piece: Piece) => {
    setData(prev => prev && {
      ...prev,
      designers: prev.designers.map(d => d.id !== piece.designer_id ? d : {
        ...d, pieces: d.pieces.map(p => p.id === piece.id ? piece : p),
      }),
    });
  }, []);

  const openDesigner = data?.designers.find(d => d.id === openDesignerId) ?? null;

  if (openDesigner && data) {
    return (
      <DesignerDetail
        designer={openDesigner}
        weekOf={data.weekOf}
        onBack={() => { setOpenDesignerId(null); refresh(); }}
        onPieceChange={patchPieceLocal}
        onServerChange={refresh}
      />
    );
  }

  const canGoForward = !!weekOf && !!data && weekOf < data.defaultWeek;
  const active = data?.designers.filter(d => !d.excluded) ?? [];
  const totalPieces = active.reduce((s, d) => s + d.pieces.length, 0);
  const donePieces = active.reduce((s, d) => s + d.pieces.filter(isPieceDone).length, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Design Quality grading</h2>
          <p className="text-sm text-slate-500">
            Frames are picked at random from each designer&apos;s designs that first reached <span className="font-medium">No Response</span> that week —
            1 frame under 20 hrs, 2 for 20–30 hrs, 3 for 30+ hrs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => weekOf && load(addDays(weekOf, -7))}
            disabled={!weekOf || loading}
            className="px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            aria-label="Previous week"
          >←</button>
          <select
            value={weekOf ?? ''}
            onChange={e => load(e.target.value)}
            className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-sm text-slate-700"
          >
            {weekOptions(data).map(w => (
              <option key={w} value={w}>
                {weekLabel(w)}{data?.generatedWeeks.includes(w) ? '' : ' (not picked)'}
              </option>
            ))}
          </select>
          <button
            onClick={() => weekOf && load(addDays(weekOf, 7))}
            disabled={!canGoForward || loading}
            className="px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            aria-label="Next week"
          >→</button>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{notice}</div>}

      {loading && !data ? (
        <div className="py-16 text-center text-sm text-slate-500">Loading…</div>
      ) : data && !data.generated ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <p className="text-sm text-slate-600">
            No frames picked yet for <span className="font-medium">{weekLabel(data.weekOf)}</span>.
          </p>
          <button
            onClick={generate}
            disabled={generating}
            className="mt-4 px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          >
            {generating ? 'Picking frames… (this can take a minute)' : 'Pick this week’s frames'}
          </button>
          <p className="mt-3 text-xs text-slate-400">
            Uses the hours from the Rippling upload — upload that week&apos;s hours first so piece counts are right.
          </p>
        </div>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center gap-4">
              <div className="text-sm text-slate-700">
                <span className="text-2xl font-semibold text-slate-900">{donePieces}</span>
                <span className="text-slate-500"> / {totalPieces} frames graded</span>
              </div>
              <div className="h-2 w-48 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full bg-emerald-500" style={{ width: `${totalPieces ? (donePieces / totalPieces) * 100 : 0}%` }} />
              </div>
            </div>
            <button
              onClick={generate}
              disabled={generating}
              title="Adds anyone missing (e.g. hours uploaded late). Existing picks and grades are kept."
              className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              {generating ? 'Checking…' : 'Check for missing designers'}
            </button>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {groupByLocation(data.designers).map(([loc, designers]) => (
              <section key={loc} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{loc}</h3>
                <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                  {designers.map(d => <DesignerRowButton key={d.id} designer={d} onOpen={() => setOpenDesignerId(d.id)} />)}
                </div>
              </section>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function weekOptions(data: WeekData | null): string[] {
  if (!data) return [];
  const set = new Set<string>(data.generatedWeeks);
  for (let i = 0; i < 8; i++) set.add(addDays(data.defaultWeek, -7 * i));
  set.add(data.weekOf);
  return [...set].filter(w => w <= data.defaultWeek).sort().reverse();
}

function groupByLocation(designers: Designer[]): [string, Designer[]][] {
  const groups = new Map<string, Designer[]>();
  for (const d of designers) {
    const loc = d.location ?? 'Unknown location';
    groups.set(loc, [...(groups.get(loc) ?? []), d]);
  }
  const order = (l: string) => (l === 'Utah' ? 0 : l === 'Georgia' ? 1 : 2);
  return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]));
}

function DesignerRowButton({ designer: d, onOpen }: { designer: Designer; onOpen: () => void }) {
  const done = d.pieces.filter(isPieceDone).length;
  const complete = d.pieces.length > 0 && done === d.pieces.length;
  return (
    <button onClick={onOpen} className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 ${d.excluded ? 'opacity-50' : ''}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900">{d.designer_name}</div>
        <div className="text-xs text-slate-500">
          {d.hours === null ? 'No hours uploaded' : `${d.hours.toFixed(1)} hrs`} · {d.frames_available} designed
          {d.excluded && ' · skipped this week'}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden sm:flex gap-1">
          {d.pieces.map(p => (
            <span key={p.id} className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${
              isPieceDone(p) ? 'bg-emerald-50 text-emerald-700' : Object.keys(p.scores).length ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
            }`}>#{p.order_num}</span>
          ))}
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          complete ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
        }`}>{done}/{d.pieces.length}</span>
        <span className="text-slate-400">›</span>
      </div>
    </button>
  );
}

// ── Designer detail ───────────────────────────────────────────────────────────

function DesignerDetail({
  designer, weekOf, onBack, onPieceChange, onServerChange,
}: {
  designer: Designer;
  weekOf: string;
  onBack: () => void;
  onPieceChange: (p: Piece) => void;
  onServerChange: () => Promise<void>;
}) {
  const [activeSlot, setActiveSlot] = useState<number>(designer.pieces[0]?.slot ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const piece = designer.pieces.find(p => p.slot === activeSlot) ?? designer.pieces[0] ?? null;
  const maxCount = Math.min(MAX_PIECES, designer.frames_available);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onServerChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setCount = (n: number) => run(() => api(`/api/design-quality/designers/${designer.id}`, {
    method: 'PATCH', body: JSON.stringify({ targetCount: n }),
  }));
  const toggleSkip = () => run(() => api(`/api/design-quality/designers/${designer.id}`, {
    method: 'PATCH', body: JSON.stringify({ excluded: !designer.excluded }),
  }));
  const repick = (p: Piece) => {
    if (!confirm(`Swap order #${p.order_num} for a different random frame from ${designer.designer_name}?`)) return;
    run(() => api(`/api/design-quality/pieces/${p.id}`, { method: 'POST', body: JSON.stringify({ action: 'repick' }) }));
  };

  const totals = designer.pieces.map(p => pieceTotal(p.scores));
  const graded = designer.pieces.filter(isPieceDone);
  const avg = graded.length ? graded.reduce((s, p) => s + pieceTotal(p.scores), 0) / graded.length : null;

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm text-indigo-600 hover:text-indigo-800">← All designers · {weekLabel(weekOf)}</button>

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{designer.designer_name}</h2>
          <p className="text-sm text-slate-500">
            {designer.location ?? 'Unknown location'} ·{' '}
            {designer.hours === null ? 'no hours uploaded' : `${designer.hours.toFixed(1)} hrs`} ·{' '}
            {designer.frames_available} frame{designer.frames_available === 1 ? '' : 's'} first hit No Response this week
          </p>
          {avg !== null && (
            <p className="mt-1 text-sm text-slate-700">
              Average so far: <span className="font-semibold">{avg.toFixed(2)} / {RUBRIC_MAX}</span>{' '}
              <span className="text-slate-500">({((avg / RUBRIC_MAX) * 100).toFixed(1)}%)</span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Frames to grade
            <select
              value={designer.target_count}
              disabled={busy || designer.excluded}
              onChange={e => setCount(Number(e.target.value))}
              className="px-2 py-1 rounded-md border border-slate-200 bg-white text-sm"
            >
              {Array.from({ length: maxCount }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button
            onClick={toggleSkip}
            disabled={busy}
            className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            {designer.excluded ? 'Include this week' : 'Skip this week'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {designer.excluded && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {designer.designer_name} is skipped this week — their frames won&apos;t count in the results.
        </div>
      )}

      {/* Piece tabs */}
      <div className="flex gap-2 border-b border-slate-200">
        {designer.pieces.map((p, i) => (
          <button
            key={p.id}
            onClick={() => setActiveSlot(p.slot)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              piece?.id === p.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            Piece {i + 1} · #{p.order_num}
            <span className={`ml-2 text-xs ${isPieceDone(p) ? 'text-emerald-600' : 'text-slate-400'}`}>
              {isPieceDone(p) ? `✓ ${scoreLabelTotal(totals[i])}` : `${scoredCount(p.scores)}/${RUBRIC_MAX}`}
            </span>
          </button>
        ))}
      </div>

      {piece ? (
        <PieceEditor
          key={piece.id}
          piece={piece}
          disabled={busy}
          onChange={onPieceChange}
          onRepick={() => repick(piece)}
          canRepick={designer.unpicked_count > 0}
        />
      ) : (
        <p className="text-sm text-slate-500">No frames picked for this designer.</p>
      )}
    </div>
  );
}

function scoreLabelTotal(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── Piece editor ──────────────────────────────────────────────────────────────

function PieceEditor({
  piece, disabled, onChange, onRepick, canRepick,
}: {
  piece: Piece;
  disabled: boolean;
  onChange: (p: Piece) => void;
  onRepick: () => void;
  canRepick: boolean;
}) {
  const [local, setLocal] = useState<Piece>(piece);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openNotes, setOpenNotes] = useState<Set<string>>(
    () => new Set(Object.keys(piece.criterion_notes ?? {})),
  );
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // Time-to-grade: seconds since the last save ride along with each save
  // (only while the page is visible, capped per save on the server).
  const visibleSince = useRef<number | null>(typeof document !== 'undefined' && document.visibilityState === 'visible' ? Date.now() : null);
  const banked = useRef(0);
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') visibleSince.current = Date.now();
      else if (visibleSince.current) { banked.current += Date.now() - visibleSince.current; visibleSince.current = null; }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const takeElapsedSeconds = () => {
    let ms = banked.current;
    if (visibleSince.current) { ms += Date.now() - visibleSince.current; visibleSince.current = Date.now(); }
    banked.current = 0;
    return Math.round(ms / 1000);
  };

  const save = useCallback((body: Record<string, unknown>) => {
    const addSeconds = takeElapsedSeconds();
    setSaving(true);
    // Serialize saves so a fast run of clicks lands in order.
    queue.current = queue.current.then(async () => {
      try {
        // keepalive lets a save started as the page closes still finish.
        const { piece: saved } = await api<{ piece: Piece }>(`/api/design-quality/pieces/${piece.id}`, {
          method: 'PATCH', body: JSON.stringify({ ...body, addSeconds }), keepalive: true,
        });
        setSaveError(null);
        setLocal(prev => ({ ...prev, seconds_spent: saved.seconds_spent, completed_at: saved.completed_at, graded_by_name: saved.graded_by_name }));
        onChange(saved);
      } catch (e) {
        setSaveError((e as Error).message);
      } finally {
        setSaving(false);
      }
    });
    return queue.current;
  }, [piece.id, onChange]);

  const setScore = (key: string, value: CriterionScore) => {
    const next = local.scores[key] === value ? null : value; // click again to clear
    const scores = { ...local.scores };
    if (next === null) delete scores[key]; else scores[key] = next;
    const updated = { ...local, scores, completed_at: next === null ? null : local.completed_at };
    setLocal(updated);
    onChange(updated);
    save({ scores: { [key]: next }, ...(next === null && local.completed_at ? { complete: false } : {}) });
  };

  // Notes save shortly after typing stops — and right away when the box
  // loses focus, the page is hidden/closed, or the grader leaves the frame —
  // so a note is never lost for want of clicking somewhere else first.
  const pendingNotes = useRef<{ notes?: string; criterionNotes: Record<string, string> }>({ criterionNotes: {} });
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushNotes = useCallback(() => {
    if (noteTimer.current) { clearTimeout(noteTimer.current); noteTimer.current = null; }
    const { notes, criterionNotes } = pendingNotes.current;
    const hasCriterion = Object.keys(criterionNotes).length > 0;
    if (notes === undefined && !hasCriterion) return;
    pendingNotes.current = { criterionNotes: {} };
    save({ ...(notes !== undefined ? { notes } : {}), ...(hasCriterion ? { criterionNotes } : {}) });
  }, [save]);
  const queueNote = (patch: { notes?: string; criterionKey?: string; text?: string }) => {
    if (patch.notes !== undefined) pendingNotes.current.notes = patch.notes;
    if (patch.criterionKey) pendingNotes.current.criterionNotes[patch.criterionKey] = patch.text ?? '';
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(flushNotes, 800);
  };
  const flushRef = useRef(flushNotes);
  useEffect(() => { flushRef.current = flushNotes; }, [flushNotes]);
  useEffect(() => {
    const onHide = () => flushRef.current();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      flushRef.current(); // leaving this frame (another piece, or back to the list)
    };
  }, []);

  const setCriterionNote = (key: string, text: string) => {
    setLocal(prev => ({ ...prev, criterion_notes: { ...prev.criterion_notes, [key]: text } }));
    queueNote({ criterionKey: key, text });
  };

  const total = pieceTotal(local.scores);
  const scored = scoredCount(local.scores);
  const allScored = scored === RUBRIC_MAX;
  const hasGrades = scored > 0 || !!local.completed_at;
  const done = !!local.completed_at;

  const markAllFull = () => {
    const unscored = RUBRIC_KEYS.filter(k => local.scores[k] === undefined);
    if (!unscored.length) return;
    const patch = Object.fromEntries(unscored.map(k => [k, 1]));
    const updated = { ...local, scores: { ...local.scores, ...patch } };
    setLocal(updated);
    onChange(updated);
    save({ scores: patch });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="text-sm">
          <div className="font-medium text-slate-900">
            Order #{local.order_num}
            {local.variant_title && <span className="ml-2 font-normal text-slate-500">{local.variant_title}</span>}
          </div>
          <div className="text-xs text-slate-500">
            First reached No Response {new Date(local.first_no_response_at).toLocaleString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })} · grade the first design uploaded
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!hasGrades && canRepick && (
            <button
              onClick={onRepick}
              disabled={disabled}
              className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              title="Swap for a different random frame from this designer (e.g. a print or a frame with no usable photo)"
            >Pick a different frame</button>
          )}
          <div className="text-right">
            <div className="text-2xl font-semibold text-slate-900">
              {scoreLabelTotal(total)}<span className="text-base font-normal text-slate-400"> / {RUBRIC_MAX}</span>
            </div>
            <div className="text-xs text-slate-500">{scored} of {RUBRIC_MAX} scored · {fmtDuration(local.seconds_spent)} spent</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Click a score to set it, click it again to clear it. Changes save automatically.</span>
        {!done && scored < RUBRIC_MAX && (
          <button onClick={markAllFull} disabled={disabled} className="text-indigo-600 hover:text-indigo-800 font-medium">
            Give full points to every unscored line
          </button>
        )}
      </div>

      {RUBRIC.map(section => {
        const sectionScore = section.criteria.reduce((s, c) => s + (local.scores[c.key] ?? 0), 0);
        return (
          <section key={section.title} className="rounded-lg border border-slate-200 bg-white">
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
              <h4 className="text-sm font-semibold text-slate-800">{section.title}</h4>
              <span className="text-xs text-slate-500">{scoreLabelTotal(sectionScore)} / {section.criteria.length}</span>
            </header>
            <ul className="divide-y divide-slate-100">
              {section.criteria.map(c => {
                const value = local.scores[c.key];
                const noteOpen = openNotes.has(c.key);
                return (
                  <li key={c.key} className="px-4 py-2.5">
                    <div className="flex items-start gap-4">
                      <p className="flex-1 text-sm text-slate-700">{c.text}</p>
                      <div className="flex shrink-0 items-center gap-1">
                        {([0, 0.5, 1] as const).map(v => (
                          <button
                            key={v}
                            onClick={() => setScore(c.key, v)}
                            disabled={disabled}
                            aria-pressed={value === v}
                            className={`w-9 h-8 rounded-md border text-sm font-medium transition-colors ${
                              value === v
                                ? v === 1 ? 'bg-emerald-600 border-emerald-600 text-white'
                                  : v === 0.5 ? 'bg-amber-500 border-amber-500 text-white'
                                  : 'bg-rose-600 border-rose-600 text-white'
                                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                            }`}
                          >{scoreLabel(v)}</button>
                        ))}
                        <button
                          onClick={() => setOpenNotes(prev => {
                            const next = new Set(prev);
                            if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                            return next;
                          })}
                          className={`ml-1 px-2 h-8 rounded-md text-xs ${
                            local.criterion_notes[c.key] ? 'text-indigo-700 bg-indigo-50' : 'text-slate-500 hover:bg-slate-50'
                          }`}
                          title="Add a note for this line"
                        >Note</button>
                      </div>
                    </div>
                    {noteOpen && (
                      <textarea
                        value={local.criterion_notes[c.key] ?? ''}
                        onChange={e => setCriterionNote(c.key, e.target.value)}
                        onBlur={flushNotes}
                        rows={2}
                        placeholder="What to improve (shown with the grade)…"
                        className="mt-2 w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section className="rounded-lg border border-slate-200 bg-white px-4 py-3 space-y-2">
        <label className="text-sm font-semibold text-slate-800" htmlFor={`notes-${piece.id}`}>Additional notes</label>
        <textarea
          id={`notes-${piece.id}`}
          value={local.notes ?? ''}
          onChange={e => { const notes = e.target.value; setLocal(prev => ({ ...prev, notes })); queueNote({ notes }); }}
          onBlur={flushNotes}
          rows={3}
          placeholder="Overall feedback for this frame…"
          className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
        />
      </section>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="text-xs text-slate-500">
          {saveError ? <span className="text-rose-600">{saveError}</span>
            : saving ? 'Saving…'
            : done ? `Graded${local.graded_by_name ? ` by ${local.graded_by_name}` : ''}`
            : scored ? 'Saved' : ''}
        </div>
        {done ? (
          <button
            onClick={() => { setLocal(p => ({ ...p, completed_at: null })); save({ complete: false }); }}
            disabled={disabled}
            className="px-4 py-2 rounded-md border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50"
          >Reopen</button>
        ) : (
          <button
            onClick={() => { flushNotes(); save({ complete: true }); }}
            disabled={disabled || !allScored || saving}
            title={allScored ? undefined : 'Score every line first'}
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          >Mark graded · {scoreLabelTotal(total)} / {RUBRIC_MAX}</button>
        )}
      </div>
    </div>
  );
}
