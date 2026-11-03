import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { netAdjustment, normalizeOrderName, type OrderAdjustment } from '@/lib/orderAdjustments';

// Add or remove order numbers from an auto-synced Historicals order count
// (see src/lib/orderAdjustments.ts). Admins can adjust any location; general
// managers and managers only their own.

const DEPARTMENTS = ['design', 'preservation', 'fulfillment'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Same edit window /api/actuals enforces for everyone; admins are exempt
// here so older weeks can still be corrected.
const EDIT_WINDOW_DAYS = 31;

interface Editor {
  userId:   string;
  role:     string;
  name:     string | null;
  location: string | null;
}

async function loadEditor(): Promise<Editor | NextResponse> {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data } = await supabase
    .from('user_profiles')
    .select('role, location, full_name')
    .eq('clerk_user_id', userId)
    .maybeSingle();
  return { userId, role: data?.role ?? '', name: data?.full_name ?? null, location: data?.location ?? null };
}

function permissionError(editor: Editor, location: string, weekOf: string): NextResponse | null {
  if (editor.role === 'admin') return null;
  if (editor.role !== 'manager' && editor.role !== 'general_manager') {
    return NextResponse.json({ error: 'Only admins and managers can adjust order counts' }, { status: 403 });
  }
  if (editor.location !== location) {
    return NextResponse.json({ error: `You can only adjust ${editor.location ?? 'your own location'}'s order counts` }, { status: 403 });
  }
  const daysAgo = (Date.now() - new Date(`${weekOf}T12:00:00`).getTime()) / 86_400_000;
  if (daysAgo > EDIT_WINDOW_DAYS) {
    return NextResponse.json({ error: `Cannot adjust weeks older than ${EDIT_WINDOW_DAYS} days — ask an admin` }, { status: 403 });
  }
  return null;
}

// Re-derives the row's actual_orders from its synced count plus every
// adjustment. Creates the row (synced 0) if the sync never wrote one.
async function applyAdjustments(location: string, department: string, weekOf: string, memberName: string) {
  const [{ data: row, error: rowErr }, { data: adjustments, error: adjErr }] = await Promise.all([
    supabase
      .from('team_member_week_actuals')
      .select('actual_hours, actual_orders, synced_orders, orders_source')
      .eq('location', location).eq('department', department).eq('week_of', weekOf).eq('member_name', memberName)
      .maybeSingle(),
    supabase
      .from('order_count_adjustments')
      .select('action, products')
      .eq('location', location).eq('department', department).eq('week_of', weekOf).eq('member_name', memberName),
  ]);
  if (rowErr) throw rowErr;
  if (adjErr) throw adjErr;
  const synced = Number(row?.synced_orders ?? row?.actual_orders ?? 0);
  const { error } = await supabase
    .from('team_member_week_actuals')
    .upsert({
      location, department, week_of: weekOf, member_name: memberName,
      actual_hours: row?.actual_hours ?? 0,
      synced_orders: synced,
      actual_orders: Math.max(0, synced + netAdjustment((adjustments ?? []) as OrderAdjustment[])),
      orders_source: 'auto',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'location,department,week_of,member_name' });
  if (error) throw error;
}

// ── GET /api/order-adjustments?location=Utah ─────────────────────────────────
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const location = req.nextUrl.searchParams.get('location') ?? 'Utah';
  const { data, error } = await supabase
    .from('order_count_adjustments')
    .select('id, location, department, week_of, member_name, order_name, action, products, note, created_by_name, created_at')
    .eq('location', location)
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ adjustments: data ?? [] });
}

// ── POST /api/order-adjustments ──────────────────────────────────────────────
// Body: { location, department, weekOf, memberName, orderName, action, products?, note? }
export async function POST(req: NextRequest) {
  const editor = await loadEditor();
  if (editor instanceof NextResponse) return editor;

  const body = await req.json() as {
    location?: string; department?: string; weekOf?: string; memberName?: string;
    orderName?: string; action?: string; products?: number; note?: string;
  };
  const location = body.location ?? '';
  const department = body.department ?? '';
  const weekOf = body.weekOf ?? '';
  const memberName = body.memberName?.trim() ?? '';
  const orderName = normalizeOrderName(body.orderName ?? '');
  const products = Number(body.products ?? 1);

  if (!['Utah', 'Georgia'].includes(location)) return NextResponse.json({ error: 'Unknown location' }, { status: 400 });
  if (!DEPARTMENTS.includes(department)) return NextResponse.json({ error: 'department must be design, preservation, or fulfillment' }, { status: 400 });
  if (!ISO_DATE.test(weekOf) || new Date(`${weekOf}T12:00:00`).getDay() !== 1) return NextResponse.json({ error: 'weekOf must be a Monday (YYYY-MM-DD)' }, { status: 400 });
  if (!memberName) return NextResponse.json({ error: 'memberName is required' }, { status: 400 });
  if (!orderName) return NextResponse.json({ error: 'Order number is required' }, { status: 400 });
  if (body.action !== 'add' && body.action !== 'remove') return NextResponse.json({ error: 'action must be add or remove' }, { status: 400 });
  if (!(products > 0)) return NextResponse.json({ error: 'products must be greater than 0' }, { status: 400 });

  const denied = permissionError(editor, location, weekOf);
  if (denied) return denied;

  try {
    const { data: row, error: rowErr } = await supabase
      .from('team_member_week_actuals')
      .select('orders_source')
      .eq('location', location).eq('department', department).eq('week_of', weekOf).eq('member_name', memberName)
      .maybeSingle();
    if (rowErr) throw rowErr;
    // A typed count replaces the sync entirely, so there's nothing to adjust.
    if (row?.orders_source === 'manual') {
      return NextResponse.json({ error: `${memberName}'s count for this week was typed in by hand, so it isn't synced — adjust the typed number instead` }, { status: 409 });
    }

    const { error } = await supabase.from('order_count_adjustments').insert({
      location, department, week_of: weekOf, member_name: memberName,
      order_name: orderName, action: body.action, products,
      note: body.note?.trim() || null,
      created_by: editor.userId, created_by_name: editor.name,
    });
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: `${orderName} is already adjusted for ${memberName} this week — undo that first` }, { status: 409 });
      }
      throw error;
    }
    await applyAdjustments(location, department, weekOf, memberName);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── DELETE /api/order-adjustments?id=… ───────────────────────────────────────
// Undoes an adjustment.
export async function DELETE(req: NextRequest) {
  const editor = await loadEditor();
  if (editor instanceof NextResponse) return editor;

  const id = req.nextUrl.searchParams.get('id') ?? '';
  const { data: adj, error: findErr } = await supabase
    .from('order_count_adjustments')
    .select('location, department, week_of, member_name')
    .eq('id', id)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!adj) return NextResponse.json({ error: 'Adjustment not found' }, { status: 404 });

  const denied = permissionError(editor, adj.location, adj.week_of);
  if (denied) return denied;

  try {
    const { error } = await supabase.from('order_count_adjustments').delete().eq('id', id);
    if (error) throw error;
    await applyAdjustments(adj.location, adj.department, adj.week_of, adj.member_name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
