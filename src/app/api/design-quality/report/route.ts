import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { requireGrader, errorMessage } from '@/lib/designQuality';
import type { ReportPiece } from '@/lib/designQualityReport';

// GET /api/design-quality/report
// Every graded frame (marked graded, designer not skipped) since Jan 1 of
// last year — enough for YTD, 12 months and 8 quarters. The Results view
// rolls these up client-side (src/lib/designQualityReport.ts); a year is
// only ~2,000 frames.
export async function GET() {
  const grader = await requireGrader();
  if (grader instanceof NextResponse) return grader;

  const since = `${new Date().getUTCFullYear() - 1}-01-01`;
  try {
    const [designers, pieces] = await Promise.all([
      fetchAllRows<{ id: number; designer_name: string; location: string | null; excluded: boolean }>((from, to) =>
        supabase.from('design_quality_designers')
          .select('id, designer_name, location, excluded')
          .gte('week_of', since)
          .order('id')
          .range(from, to)),
      fetchAllRows<{
        id: number; designer_id: number; week_of: string; order_num: string; variant_title: string | null;
        scores: Record<string, number>; criterion_notes: Record<string, string>; notes: string | null;
        seconds_spent: number; graded_by_name: string | null;
      }>((from, to) =>
        supabase.from('design_quality_pieces')
          .select('id, designer_id, week_of, order_num, variant_title, scores, criterion_notes, notes, seconds_spent, graded_by_name')
          .gte('week_of', since)
          .not('completed_at', 'is', null)
          .order('id')
          .range(from, to)),
    ]);

    const byId = new Map(designers.map(d => [d.id, d]));
    const out: ReportPiece[] = [];
    for (const p of pieces) {
      const d = byId.get(p.designer_id);
      if (!d || d.excluded) continue;
      out.push({
        id: p.id,
        weekOf: p.week_of,
        designer: d.designer_name,
        location: d.location,
        orderNum: p.order_num,
        variantTitle: p.variant_title,
        scores: p.scores ?? {},
        criterionNotes: p.criterion_notes ?? {},
        notes: p.notes,
        seconds: p.seconds_spent ?? 0,
        gradedBy: p.graded_by_name,
      });
    }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    return NextResponse.json({ pieces: out, today });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
