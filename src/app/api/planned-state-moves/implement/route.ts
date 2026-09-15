import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

// POST /api/planned-state-moves/implement — body: { id }
// Confirms a planned reassignment actually happened: flips
// state_location_routing.location to the plan's new_location (making it
// the live "currently" everywhere else on the tab) and stamps the plan
// implemented_at so the Growth & Distribution tab can show it as done
// instead of still-pending.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { id: number };
  const { id } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: move, error: fetchErr } = await supabase
    .from('planned_state_moves')
    .select('state_code, new_location')
    .eq('id', id)
    .single();
  if (fetchErr || !move) return NextResponse.json({ error: fetchErr?.message ?? 'Planned move not found' }, { status: 404 });

  const { error: routingErr } = await supabase
    .from('state_location_routing')
    .update({ location: move.new_location, updated_by: userId, updated_at: new Date().toISOString() })
    .eq('state_code', move.state_code);
  if (routingErr) return NextResponse.json({ error: routingErr.message }, { status: 500 });

  const { error: moveErr } = await supabase
    .from('planned_state_moves')
    .update({ implemented_at: new Date().toISOString() })
    .eq('id', id);
  if (moveErr) return NextResponse.json({ error: moveErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
