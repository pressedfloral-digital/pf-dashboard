/** Server helpers shared by the /api/design-quality routes. */
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import type { QualifyingFrame } from '@/lib/designQualitySelection';
import { choosePicks } from '@/lib/designQualityPick';

// Design Quality grades are visible to, and entered by, admins, general
// managers and managers. Designers ('user' role) and viewers never see them.
const GRADER_ROLES = new Set(['admin', 'general_manager', 'manager']);

export interface Grader {
  userId: string;
  name: string;
  role: string;
}

export async function requireGrader(): Promise<Grader | NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabase
    .from('user_profiles')
    .select('role, full_name, email')
    .eq('clerk_user_id', userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data || !GRADER_ROLES.has(data.role)) {
    return NextResponse.json({ error: 'Design Quality is limited to managers and admins' }, { status: 403 });
  }
  return { userId, name: data.full_name || data.email || 'Unknown', role: data.role };
}

/** Error text for the API response — plain English when the tables aren't set up yet. */
export function errorMessage(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e);
  if (/design_quality_(designers|pieces)/.test(msg) && /schema cache|does not exist/.test(msg)) {
    return 'Design Quality isn’t set up in the database yet — run supabase/migrations/20261124000000_design_quality_grading.sql in Supabase first.';
  }
  return msg;
}

export interface DesignerRow {
  id: number;
  week_of: string;
  designer_name: string;
  location: string | null;
  hours: number | null;
  frames_available: number;
  candidate_frames: QualifyingFrame[];
  target_count: number;
  excluded: boolean;
}

export interface PieceRow {
  id: number;
  designer_id: number;
  week_of: string;
  slot: number;
  order_num: string;
  order_product_uuid: string;
  variant_title: string | null;
  first_no_response_at: string;
  rubric_version: string;
  scores: Record<string, number>;
  criterion_notes: Record<string, string>;
  notes: string | null;
  seconds_spent: number;
  completed_at: string | null;
  graded_by_name: string | null;
  updated_at: string;
}

export function isGraded(p: Pick<PieceRow, 'completed_at' | 'scores'>): boolean {
  return !!p.completed_at || Object.keys(p.scores ?? {}).length > 0;
}

/**
 * Brings a designer's picked pieces up to target_count by drawing random,
 * not-yet-picked frames from their candidates (preferring orders not already
 * picked — see choosePicks) into the lowest free slots.
 * Returns how many were added.
 */
export async function fillPieces(designer: DesignerRow, existing: PieceRow[]): Promise<number> {
  const need = designer.target_count - existing.length;
  if (need <= 0) return 0;
  const picks = choosePicks(
    designer.candidate_frames,
    existing.map(p => ({ orderNum: p.order_num, orderProductUuid: p.order_product_uuid })),
    need,
  );
  if (!picks.length) return 0;
  const usedSlots = new Set(existing.map(p => p.slot));
  const freeSlots: number[] = [];
  for (let s = 1; freeSlots.length < picks.length; s++) if (!usedSlots.has(s)) freeSlots.push(s);
  const { error } = await supabase.from('design_quality_pieces').insert(
    picks.map((f, i) => ({
      designer_id: designer.id,
      week_of: designer.week_of,
      slot: freeSlots[i],
      order_num: f.orderNum,
      order_product_uuid: f.orderProductUuid,
      variant_title: f.variantTitle,
      first_no_response_at: f.firstNoResponseAt,
    })),
  );
  if (error) throw error;
  return picks.length;
}

/** Everything the grading page needs for one week. */
export async function loadWeek(weekOf: string) {
  const [designersRes, piecesRes] = await Promise.all([
    supabase.from('design_quality_designers').select('*').eq('week_of', weekOf),
    supabase.from('design_quality_pieces').select('*').eq('week_of', weekOf).order('slot'),
  ]);
  if (designersRes.error) throw designersRes.error;
  if (piecesRes.error) throw piecesRes.error;
  const pieces = (piecesRes.data ?? []) as PieceRow[];
  const designers = ((designersRes.data ?? []) as DesignerRow[])
    .map(({ candidate_frames, ...d }) => ({
      ...d,
      hours: d.hours === null ? null : Number(d.hours),
      unpicked_count: Math.max(0, (candidate_frames?.length ?? 0) - pieces.filter(p => p.designer_id === d.id).length),
      pieces: pieces.filter(p => p.designer_id === d.id),
    }))
    .sort((a, b) =>
      Number(a.excluded) - Number(b.excluded)
      || (a.location ?? '~').localeCompare(b.location ?? '~')
      || a.designer_name.localeCompare(b.designer_name));
  return { weekOf, generated: designers.length > 0, designers };
}
