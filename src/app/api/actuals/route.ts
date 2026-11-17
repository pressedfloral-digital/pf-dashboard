import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { canEditLocation } from '@/lib/permissions';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import { fetchAllRows } from '@/lib/fetchAllRows';

// ── GET /api/actuals?location=Utah&type=preservation&weeks=26 ─────────────────
// Returns preservation_week_actuals + team_member_week_actuals for a location
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location   = req.nextUrl.searchParams.get('location') ?? 'Utah';
  const type       = req.nextUrl.searchParams.get('type') ?? 'all';
  const weeks      = parseInt(req.nextUrl.searchParams.get('weeks') ?? '52');
  const since      = new Date();
  since.setDate(since.getDate() - Math.max(weeks, 52) * 7);
  // Always look back at least to start of 2026 data
  const hardFloor  = '2025-09-01';
  const sinceIso   = since.toISOString().split('T')[0] < hardFloor ? since.toISOString().split('T')[0] : hardFloor;

  try {
    const result: Record<string, unknown> = {};

    if (type === 'preservation' || type === 'all') {
      const { data, error } = await supabase
        .from('preservation_week_actuals')
        .select('week_of, received')
        .eq('location', location)
        .gte('week_of', sinceIso)
        .order('week_of', { ascending: true });
      if (error) throw error;
      result.preservationActuals = data ?? [];
    }

    if (type === 'team' || type === 'all') {
      // fetchAllRows, not a plain .select() — Utah alone is past Postgrest's
      // silent 1000-row cap, and with week_of ascending the rows that fell
      // off were the newest week's, so Historicals showed only part of it.
      // The id tiebreak keeps pages stable within a week.
      const data = await fetchAllRows<{
        department: string; week_of: string; member_name: string; actual_hours: number;
        actual_orders: number; synced_orders: number | null; hours_source: string; orders_source: string;
      }>((from, to) =>
        supabase
          .from('team_member_week_actuals')
          .select('department, week_of, member_name, actual_hours, actual_orders, synced_orders, hours_source, orders_source')
          .eq('location', location)
          .gte('week_of', sinceIso)
          .order('week_of', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      );
      // Orders credited to app/technology staff aren't production — hide them
      // from Historicals and every Scheduling view (see nonProductionStaff.ts).
      result.teamActuals = (data ?? []).filter(r => !isNonProductionStaff(r.member_name));
    }

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/actuals ─────────────────────────────────────────────────────────
// Upserts actuals. Body: { type, location, weekOf, ...fields }
export async function POST(req: NextRequest) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  const { userId } = access;

  const body = await req.json() as Record<string, unknown>;
  const { type, location, weekOf } = body as { type: string; location: string; weekOf: string };
  const department = (body as { department?: string }).department;

  // Admins edit both locations; GMs/managers only their own (canEditLocation).
  if (!access.permissions.canEditHistoricals || !canEditLocation(access.permissions, location)) {
    return forbidden(`You can't edit ${location ?? 'this location'}'s historicals`);
  }

  // Enforce edit window — Resin gets a longer window since its queue-based
  // turnaround means actuals often get entered further after the fact.
  const weekDate = new Date(weekOf + 'T12:00:00');
  const daysDiff = (Date.now() - weekDate.getTime()) / (1000 * 60 * 60 * 24);
  const editWindowDays = department === 'Resin' ? 62 : 31;
  if (daysDiff > editWindowDays) {
    return NextResponse.json({ error: `Cannot edit actuals older than ${editWindowDays} days` }, { status: 403 });
  }

  try {
    if (type === 'preservation') {
      const { received } = body as { received: number };
      const { error } = await supabase
        .from('preservation_week_actuals')
        .upsert({ location, week_of: weekOf, received, entered_by: userId, updated_at: new Date().toISOString() },
          { onConflict: 'location,week_of' });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (type === 'team') {
      const { department, memberName, actualHours, actualOrders } = body as {
        department: string; memberName: string; actualHours: number; actualOrders: number;
      };
      const { data: existing, error: existingErr } = await supabase
        .from('team_member_week_actuals')
        .select('actual_orders, orders_source')
        .eq('location', location)
        .eq('department', department)
        .eq('week_of', weekOf)
        .eq('member_name', memberName)
        .maybeSingle();
      if (existingErr) throw existingErr;
      const ordersChanged = Number(existing?.actual_orders ?? 0) !== Number(actualOrders);
      // Auto-synced order counts can only be overridden by an admin — everyone
      // else can see the orders behind them and ask an admin to correct it.
      if (existing?.orders_source === 'auto' && ordersChanged && access.role !== 'admin') {
        return NextResponse.json({ error: 'Only an admin can change an auto-synced order count' }, { status: 403 });
      }
      const { error } = await supabase
        .from('team_member_week_actuals')
        .upsert({
          location, department, week_of: weekOf,
          member_name: memberName,
          actual_hours: actualHours,
          actual_orders: actualOrders,
          // Typing an order count locks it — the automated production sync
          // (src/app/api/cron/sync-production-actuals) skips any row not
          // marked 'auto', so this edit will never be silently overwritten by
          // the next sync. An hours-only edit leaves the orders unlocked, so
          // entering hours never blocks (or freezes) the synced count.
          orders_source: ordersChanged ? 'manual' : (existing?.orders_source ?? 'auto'),
          entered_by: userId,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'location,department,week_of,member_name' });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown type' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
