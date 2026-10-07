import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { mondayOf } from '@/lib/designInventory';

// Manual additions to / removals from the Inventory tab's order list
// (inventory_order_adjustments). Admins and that location's GM/manager only,
// the same rule as creating Katana purchase orders.

async function canEdit(userId: string, location: string): Promise<boolean> {
  const { data: profile } = await supabase.from('user_profiles').select('role, location').eq('clerk_user_id', userId).single();
  return profile?.role === 'admin'
    || ((profile?.role === 'general_manager' || profile?.role === 'manager') && profile?.location === location);
}

interface Body {
  location:  string;
  kind:      'add' | 'remove';
  variantId: number;
  quantity?: number;
  needBy?:   string;
  note?:     string;
}

// ── POST /api/inventory-adjustments ──────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const location = body.location === 'Georgia' ? 'Georgia' : body.location === 'Utah' ? 'Utah' : null;
  if (!location) return NextResponse.json({ error: 'location must be Utah or Georgia' }, { status: 400 });
  if (body.kind !== 'add' && body.kind !== 'remove') return NextResponse.json({ error: 'kind must be add or remove' }, { status: 400 });
  if (!Number.isInteger(body.variantId)) return NextResponse.json({ error: 'Pick a Katana component' }, { status: 400 });
  const quantity = Number(body.quantity);
  if (body.kind === 'add') {
    if (!(quantity > 0)) return NextResponse.json({ error: 'Quantity must be more than 0' }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.needBy ?? '')) return NextResponse.json({ error: 'Pick the week it’s needed' }, { status: 400 });
  }
  if (!await canEdit(userId, location)) {
    return NextResponse.json({ error: `You don't have permission to change ${location}'s order list` }, { status: 403 });
  }

  const user = await currentUser();
  const { data, error } = await supabase
    .from('inventory_order_adjustments')
    .insert({
      location,
      kind: body.kind,
      variant_id: body.variantId,
      quantity: body.kind === 'add' ? quantity : null,
      need_by: body.kind === 'add' ? mondayOf(body.needBy!) : null,
      note: body.note?.trim() || null,
      created_by: user?.fullName || user?.primaryEmailAddress?.emailAddress || null,
    })
    .select()
    .single();
  if (error) {
    const msg = error.code === '23505' ? 'That item is already removed from the list'
      : error.code === '42P01' ? 'Manual changes aren’t set up yet — run the inventory_order_adjustments migration in Supabase'
      : error.message;
    return NextResponse.json({ error: msg }, { status: error.code === '23505' ? 409 : 500 });
  }
  return NextResponse.json(data);
}

// ── DELETE /api/inventory-adjustments?id=… ───────────────────────────────────
// Undoes a manual change.
export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data: row } = await supabase.from('inventory_order_adjustments').select('location').eq('id', id).single();
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!await canEdit(userId, row.location)) {
    return NextResponse.json({ error: `You don't have permission to change ${row.location}'s order list` }, { status: 403 });
  }
  const { error } = await supabase.from('inventory_order_adjustments').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
