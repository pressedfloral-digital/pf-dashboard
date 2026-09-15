import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

// GET /api/state-routing
// Returns every state's current planning location as a flat array.
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('state_location_routing')
    .select('state_code, state_name, location')
    .order('state_name');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ states: data ?? [] });
}

// POST /api/state-routing
// Body: { state_code, location } — upserts one state's planning location.
// This only changes Sarah's own planning record (see the migration's
// header comment) — it does not touch live Shopify/PF order routing.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { state_code: string; location: 'Utah' | 'Georgia' };
  const { state_code, location } = body;

  if (!state_code || !location) {
    return NextResponse.json({ error: 'state_code and location required' }, { status: 400 });
  }
  if (location !== 'Utah' && location !== 'Georgia') {
    return NextResponse.json({ error: 'location must be Utah or Georgia' }, { status: 400 });
  }

  const { error } = await supabase
    .from('state_location_routing')
    .update({ location, updated_by: userId, updated_at: new Date().toISOString() })
    .eq('state_code', state_code);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
