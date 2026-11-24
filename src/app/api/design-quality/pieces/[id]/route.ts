import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireGrader, fillPieces, isGraded, type DesignerRow, type PieceRow, errorMessage } from '@/lib/designQuality';
import { RUBRIC_KEYS, isValidScore } from '@/lib/designQualityRubric';

const KEYS = new Set(RUBRIC_KEYS);

async function loadPiece(id: number): Promise<PieceRow | null> {
  const { data, error } = await supabase.from('design_quality_pieces').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data as PieceRow | null;
}

// PATCH /api/design-quality/pieces/:id
// Body (all optional): { scores, criterionNotes, notes, addSeconds, complete }
//   scores:         { criterionKey: 0 | 0.5 | 1 | null }  (null clears a score)
//   criterionNotes: { criterionKey: string }
//   complete:       true marks graded (every criterion must be scored), false reopens
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const grader = await requireGrader();
  if (grader instanceof NextResponse) return grader;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    scores?: Record<string, number | null>;
    criterionNotes?: Record<string, string>;
    notes?: string | null;
    addSeconds?: number;
    complete?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  try {
    const piece = await loadPiece(id);
    if (!piece) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const scores = { ...(piece.scores ?? {}) };
    for (const [k, v] of Object.entries(body.scores ?? {})) {
      if (!KEYS.has(k)) return NextResponse.json({ error: `Unknown criterion ${k}` }, { status: 400 });
      if (v === null) delete scores[k];
      else if (isValidScore(v)) scores[k] = v;
      else return NextResponse.json({ error: 'Scores must be 0, 0.5 or 1' }, { status: 400 });
    }

    const criterionNotes = { ...(piece.criterion_notes ?? {}) };
    for (const [k, v] of Object.entries(body.criterionNotes ?? {})) {
      if (!KEYS.has(k)) return NextResponse.json({ error: `Unknown criterion ${k}` }, { status: 400 });
      const text = String(v ?? '').slice(0, 4000);
      if (text.trim()) criterionNotes[k] = text;
      else delete criterionNotes[k];
    }

    const update: Record<string, unknown> = {
      scores,
      criterion_notes: criterionNotes,
      updated_at: new Date().toISOString(),
      graded_by: grader.userId,
      graded_by_name: grader.name,
    };
    if (body.notes !== undefined) update.notes = body.notes ? String(body.notes).slice(0, 8000) : null;
    if (typeof body.addSeconds === 'number' && body.addSeconds > 0) {
      // Cap a single save at 2h so a tab left open overnight doesn't skew time-to-grade.
      update.seconds_spent = piece.seconds_spent + Math.min(Math.round(body.addSeconds), 7200);
    }
    if (body.complete === true) {
      const missing = RUBRIC_KEYS.filter(k => !isValidScore(scores[k]));
      if (missing.length) {
        return NextResponse.json({ error: `Score every line before marking graded (${missing.length} left)` }, { status: 400 });
      }
      update.completed_at = piece.completed_at ?? new Date().toISOString();
    } else if (body.complete === false) {
      update.completed_at = null;
    }

    const { data, error } = await supabase.from('design_quality_pieces').update(update).eq('id', id).select('*').single();
    if (error) throw error;
    return NextResponse.json({ piece: data });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}

// POST /api/design-quality/pieces/:id  { action: 'repick' }
// Swaps an ungraded piece for a different random frame from the same designer
// and week (e.g. a bloom-stock print, or a frame with no usable photo).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const grader = await requireGrader();
  if (grader instanceof NextResponse) return grader;
  const id = Number((await ctx.params).id);
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action !== 'repick') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  try {
    const piece = await loadPiece(id);
    if (!piece) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (isGraded(piece)) return NextResponse.json({ error: 'This frame already has grades — clear them before re-picking.' }, { status: 400 });

    const [{ data: designer, error: dErr }, { data: siblings, error: sErr }] = await Promise.all([
      supabase.from('design_quality_designers').select('*').eq('id', piece.designer_id).single(),
      supabase.from('design_quality_pieces').select('*').eq('designer_id', piece.designer_id),
    ]);
    if (dErr) throw dErr;
    if (sErr) throw sErr;
    const d = designer as DesignerRow;
    const others = (siblings as PieceRow[]).filter(p => p.id !== id);
    const taken = new Set([...others.map(p => p.order_product_uuid), piece.order_product_uuid]);
    if (!d.candidate_frames.some(f => !taken.has(f.orderProductUuid))) {
      return NextResponse.json({ error: 'No other frames from this designer that week to pick from.' }, { status: 400 });
    }

    // Delete the old pick, then fill the freed slot — fillPieces never
    // re-picks a frame still in `others`, and we exclude the old one too.
    const { error: delErr } = await supabase.from('design_quality_pieces').delete().eq('id', id);
    if (delErr) throw delErr;
    await fillPieces({ ...d, candidate_frames: d.candidate_frames.filter(f => f.orderProductUuid !== piece.order_product_uuid) }, others);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
