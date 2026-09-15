import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

// GET /api/planned-state-moves — every planned reassignment, upcoming and past.
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('planned_state_moves')
    .select('id, state_code, new_location, effective_date, note, created_at, implemented_at')
    .order('effective_date', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ moves: data ?? [] });
}

// POST /api/planned-state-moves — body: { state_code, new_location, effective_date, note? }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { state_code: string; new_location: 'Utah' | 'Georgia'; effective_date: string; note?: string };
  const { state_code, new_location, effective_date, note } = body;

  if (!state_code || !effective_date) {
    return NextResponse.json({ error: 'state_code and effective_date required' }, { status: 400 });
  }
  if (new_location !== 'Utah' && new_location !== 'Georgia') {
    return NextResponse.json({ error: 'new_location must be Utah or Georgia' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('planned_state_moves')
    .insert({ state_code, new_location, effective_date, note: note ?? null, created_by: userId })
    .select('id, state_code, new_location, effective_date, note, created_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ move: data });
}

// DELETE /api/planned-state-moves?id=123
export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase.from('planned_state_moves').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
