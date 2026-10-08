import { NextRequest, NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { ORDER_EDITS_KEY, type OrderEdits } from '@/lib/katanaPlan';

// Hand edits to the Inventory tab's order list, stored per location in
// schedule_settings under ORDER_EDITS_KEY. Each request changes one item and
// re-reads the saved edits first, so two people editing different items
// don't overwrite each other. Admins and that location's GM/manager only —
// the same rule as creating Katana purchase orders.

interface Body {
  location:  string;
  variantId: number;
  action:    'setQty' | 'remove' | 'reset';
  qty?:      number;   // total to order, in the component's Katana stock unit
}

// ── POST /api/inventory-order-edits ──────────────────────────────────────────
// Returns the location's full, updated edits.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const location = body.location === 'Georgia' ? 'Georgia' : body.location === 'Utah' ? 'Utah' : null;
  if (!location) return NextResponse.json({ error: 'location must be Utah or Georgia' }, { status: 400 });
  if (!Number.isInteger(body.variantId)) return NextResponse.json({ error: 'variantId is required' }, { status: 400 });
  if (!['setQty', 'remove', 'reset'].includes(body.action)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  const qty = Number(body.qty);
  if (body.action === 'setQty' && !(qty >= 0)) return NextResponse.json({ error: 'Quantity must be 0 or more' }, { status: 400 });

  const { data: profile } = await supabase.from('user_profiles').select('role, location').eq('clerk_user_id', userId).single();
  const canEdit = profile?.role === 'admin'
    || ((profile?.role === 'general_manager' || profile?.role === 'manager') && profile?.location === location);
  if (!canEdit) return NextResponse.json({ error: `You don't have permission to edit ${location}'s order list` }, { status: 403 });

  const { data: row, error: readError } = await supabase
    .from('schedule_settings')
    .select('value')
    .eq('location', location)
    .eq('key', ORDER_EDITS_KEY)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  const edits: OrderEdits = { ...((row?.value as OrderEdits | null) ?? {}) };
  const key = String(body.variantId);
  if (body.action === 'reset') {
    delete edits[key];
  } else {
    const user = await currentUser();
    const by = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'dashboard user';
    edits[key] = body.action === 'remove'
      ? { removed: true, by, at: new Date().toISOString() }
      : { qty: Math.round(qty * 10000) / 10000, by, at: new Date().toISOString() };
  }

  const { error } = await supabase
    .from('schedule_settings')
    .upsert(
      { location, key: ORDER_EDITS_KEY, value: edits, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'location,key' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(edits);
}
