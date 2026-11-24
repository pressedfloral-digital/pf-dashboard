import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireGrader, fillPieces, isGraded, type DesignerRow, type PieceRow } from '@/lib/designQuality';
import { MAX_PIECES } from '@/lib/designQualityRubric';

// PATCH /api/design-quality/designers/:id  { targetCount?, excluded? }
// targetCount up → picks more random frames; down → drops the last ungraded
// picks (never a graded one). excluded → skip this designer for the week
// (their picks are kept, so un-skipping restores them).
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const grader = await requireGrader();
  if (grader instanceof NextResponse) return grader;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { targetCount?: number; excluded?: boolean };

  try {
    const [{ data: designerData, error: dErr }, { data: piecesData, error: pErr }] = await Promise.all([
      supabase.from('design_quality_designers').select('*').eq('id', id).maybeSingle(),
      supabase.from('design_quality_pieces').select('*').eq('designer_id', id).order('slot'),
    ]);
    if (dErr) throw dErr;
    if (pErr) throw pErr;
    if (!designerData) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const designer = designerData as DesignerRow;
    const pieces = piecesData as PieceRow[];

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.excluded === 'boolean') update.excluded = body.excluded;

    if (body.targetCount !== undefined) {
      const target = Math.round(Number(body.targetCount));
      const max = Math.min(MAX_PIECES, designer.candidate_frames.length);
      if (!Number.isFinite(target) || target < 1 || target > max) {
        return NextResponse.json({ error: `Pick between 1 and ${max} frames` }, { status: 400 });
      }
      if (target < pieces.length) {
        const removable = [...pieces].reverse().filter(p => !isGraded(p)).slice(0, pieces.length - target);
        if (removable.length < pieces.length - target) {
          return NextResponse.json({ error: 'Can’t drop frames that already have grades.' }, { status: 400 });
        }
        const { error } = await supabase.from('design_quality_pieces').delete().in('id', removable.map(p => p.id));
        if (error) throw error;
      }
      update.target_count = target;
      const { error } = await supabase.from('design_quality_designers').update(update).eq('id', id);
      if (error) throw error;
      if (target > pieces.length) await fillPieces({ ...designer, target_count: target }, pieces);
      return NextResponse.json({ ok: true });
    }

    const { error } = await supabase.from('design_quality_designers').update(update).eq('id', id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as { message?: string })?.message ?? e) }, { status: 500 });
  }
}
