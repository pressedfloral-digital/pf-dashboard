import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { canEditLocation } from '@/lib/permissions';
import { isoMonday } from '@/lib/weekDates';

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

interface PromiseRow {
  week_of:              string;
  promised_by_date:     string;
  promised_weeks:       number;
  last_confirmed_weeks: number;
  first_promised_at:    string;
  last_confirmed_at:    string;
}

// ── GET /api/design-promises?location=Utah ─────────────────────────────────────
// Returns every locked-in "weeks until designed" promise for a location.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') ?? 'Utah';

  try {
    const { data, error } = await supabase
      .from('design_delivery_promises')
      .select('week_of, promised_by_date, promised_weeks, last_confirmed_weeks, first_promised_at, last_confirmed_at')
      .eq('location', location);
    if (error) throw error;
    return NextResponse.json({ promises: (data ?? []) as PromiseRow[] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/design-promises ───────────────────────────────────────────────────
// Snapshots the live "weeks until designed" for every active cohort as a
// client-facing promise. A promise's date can only get earlier over time —
// once we've told a client a date, a later recalculation showing things have
// slipped must never quietly push that date back.
// Body: { location, cohorts: { weekOf: string; weeksFromNow: number }[] }
export async function POST(req: NextRequest) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  const { userId } = access;

  const body = await req.json() as { location: string; cohorts: { weekOf: string; weeksFromNow: number }[] };
  const { location, cohorts } = body;
  if (!location || !Array.isArray(cohorts) || cohorts.length === 0) {
    return NextResponse.json({ error: 'location and cohorts are required' }, { status: 400 });
  }
  if (!canEditLocation(access.permissions, location)) {
    return forbidden(`You can't lock in design promises for ${location}`);
  }

  try {
    const { data: existingRows, error: fetchError } = await supabase
      .from('design_delivery_promises')
      .select('week_of, promised_by_date, promised_weeks, first_promised_at')
      .eq('location', location);
    if (fetchError) throw fetchError;

    const existingByWeek = new Map((existingRows ?? []).map(r => [r.week_of as string, r]));
    const today = isoMonday(0);
    const nowIso = new Date().toISOString();

    const upserts = cohorts.map(({ weekOf, weeksFromNow }) => {
      const candidateDate = addDays(today, weeksFromNow * 7);
      const existing = existingByWeek.get(weekOf);
      // Ratchet: only move the promise earlier, never later.
      const tightened = !existing || candidateDate < existing.promised_by_date;
      return {
        location,
        week_of: weekOf,
        promised_by_date: tightened ? candidateDate : existing!.promised_by_date,
        promised_weeks: tightened ? weeksFromNow : existing!.promised_weeks,
        last_confirmed_weeks: weeksFromNow,
        first_promised_at: existing?.first_promised_at ?? nowIso,
        last_confirmed_at: nowIso,
        created_by: userId,
      };
    });

    const { error: upsertError } = await supabase
      .from('design_delivery_promises')
      .upsert(upserts, { onConflict: 'location,week_of' });
    if (upsertError) throw upsertError;

    return NextResponse.json({ ok: true, count: upserts.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
