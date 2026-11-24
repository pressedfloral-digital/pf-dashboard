import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { requireGrader, loadWeek, fillPieces, type DesignerRow, type PieceRow } from '@/lib/designQuality';
import { isMondayIso, lastCompletedWeekOf, loadDesignerWeeks } from '@/lib/designQualitySelection';
import { MAX_PIECES, piecesForHours } from '@/lib/designQualityRubric';

export const maxDuration = 300;

async function generatedWeeks(): Promise<string[]> {
  const { data, error } = await supabase
    .from('design_quality_designers')
    .select('week_of')
    .order('week_of', { ascending: false })
    .limit(2000);
  if (error) throw error;
  return [...new Set((data ?? []).map(r => r.week_of as string))].slice(0, 26);
}

// GET /api/design-quality?week=YYYY-MM-DD (a Monday; defaults to last full week)
export async function GET(req: NextRequest) {
  const grader = await requireGrader();
  if (grader instanceof NextResponse) return grader;

  const weekOf = req.nextUrl.searchParams.get('week') ?? lastCompletedWeekOf();
  if (!isMondayIso(weekOf)) return NextResponse.json({ error: 'week must be a Monday (YYYY-MM-DD)' }, { status: 400 });

  try {
    const [week, weeks] = await Promise.all([loadWeek(weekOf), generatedWeeks()]);
    return NextResponse.json({ ...week, defaultWeek: lastCompletedWeekOf(), generatedWeeks: weeks });
  } catch (e) {
    return NextResponse.json({ error: String((e as { message?: string })?.message ?? e) }, { status: 500 });
  }
}

// POST /api/design-quality { weekOf }
// Picks this week's frames. Safe to run again: designers already set up for
// the week (and their grades) are left alone — a re-run only adds designers
// who weren't there yet (e.g. hours uploaded late, a straggler upload) and
// refreshes the candidate list for re-picks.
export async function POST(req: NextRequest) {
  const grader = await requireGrader();
  if (grader instanceof NextResponse) return grader;

  const { weekOf } = (await req.json().catch(() => ({}))) as { weekOf?: string };
  if (!weekOf || !isMondayIso(weekOf)) return NextResponse.json({ error: 'weekOf must be a Monday (YYYY-MM-DD)' }, { status: 400 });
  if (weekOf > lastCompletedWeekOf()) {
    return NextResponse.json({ error: 'That week isn’t over yet — frames can be picked once it ends on Sunday.' }, { status: 400 });
  }

  try {
    const found = await loadDesignerWeeks(weekOf);

    const { data: existingRows, error: existingErr } = await supabase
      .from('design_quality_designers')
      .select('*')
      .eq('week_of', weekOf);
    if (existingErr) throw existingErr;
    const existingByName = new Map((existingRows as DesignerRow[]).map(d => [d.designer_name, d]));

    let added = 0;
    let refreshed = 0;
    for (const d of found) {
      const existing = existingByName.get(d.designerName);
      if (existing) {
        // Keep the grader's choices (count, skip) — just refresh what can be re-picked.
        const { error } = await supabase
          .from('design_quality_designers')
          .update({ candidate_frames: d.frames, frames_available: d.frames.length, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
        if (error) throw error;
        refreshed++;
        continue;
      }
      const target = Math.min(MAX_PIECES, piecesForHours(d.hours ?? 0), d.frames.length);
      const { data: inserted, error } = await supabase
        .from('design_quality_designers')
        .insert({
          week_of: weekOf,
          designer_name: d.designerName,
          location: d.location,
          hours: d.hours,
          frames_available: d.frames.length,
          candidate_frames: d.frames,
          target_count: target,
          created_by: grader.userId,
        })
        .select('*')
        .single();
      if (error) throw error;
      await fillPieces(inserted as DesignerRow, [] as PieceRow[]);
      added++;
    }

    const week = await loadWeek(weekOf);
    return NextResponse.json({ ...week, added, refreshed, generatedWeeks: await generatedWeeks(), defaultWeek: lastCompletedWeekOf() });
  } catch (e) {
    return NextResponse.json({ error: String((e as { message?: string })?.message ?? e) }, { status: 500 });
  }
}
