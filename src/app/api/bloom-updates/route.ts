import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { canEditLocation } from '@/lib/permissions';

interface BloomUpdateRow {
  weekOf: string;
  weeksUntilDesigned: number;
}

// ── GET /api/bloom-updates?location=Utah ────────────────────────────────────────
// Returns every biweekly bloom update ever sent for a location, newest first —
// the client-facing communication record (distinct from design_delivery_promises,
// which drives the internal "must design"/"at risk" staffing checks).
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') ?? 'Utah';

  try {
    const { data, error } = await supabase
      .from('biweekly_bloom_updates')
      .select('id, sent_at, rows')
      .eq('location', location)
      .order('sent_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ updates: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/bloom-updates ───────────────────────────────────────────────────────
// Records a sent biweekly bloom update. Body: { location, rows }
export async function POST(req: NextRequest) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  const { userId } = access;

  const body = await req.json() as { location: string; rows: BloomUpdateRow[] };
  const { location, rows } = body;
  if (!location || !Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'location and rows are required' }, { status: 400 });
  }
  if (!canEditLocation(access.permissions, location)) {
    return forbidden(`You can't record bloom updates for ${location}`);
  }

  try {
    const { data, error } = await supabase
      .from('biweekly_bloom_updates')
      .insert({ location, rows, created_by: userId })
      .select('id, sent_at, rows')
      .single();
    if (error) throw error;
    return NextResponse.json({ update: data });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── DELETE /api/bloom-updates?id=123 ──────────────────────────────────────────────
// Removes an update from the sent history (e.g. a test send). Only the history
// record goes — locked-in design_delivery_promises are left as they are.
export async function DELETE(req: NextRequest) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;

  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    const { data: row, error: rowErr } = await supabase
      .from('biweekly_bloom_updates').select('location').eq('id', id).maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return NextResponse.json({ error: 'Update not found' }, { status: 404 });
    if (!canEditLocation(access.permissions, row.location as string)) {
      return forbidden(`You can't delete ${row.location}'s bloom updates`);
    }
    const { error } = await supabase.from('biweekly_bloom_updates').delete().eq('id', id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
