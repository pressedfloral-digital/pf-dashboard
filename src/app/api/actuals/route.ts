import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

// Admin/manager Clerk user IDs — add yours here
// You can also use Clerk organizations or roles; this is the simple approach
const ADMIN_IDS = (process.env.ADMIN_CLERK_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(userId: string): boolean {
  // If no admin IDs are configured, allow any authenticated user (dev mode)
  if (ADMIN_IDS.length === 0) return true;
  return ADMIN_IDS.includes(userId);
}

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
      const { data, error } = await supabase
        .from('team_member_week_actuals')
        .select('department, week_of, member_name, actual_hours, actual_orders, hours_source, orders_source')
        .eq('location', location)
        .gte('week_of', sinceIso)
        .order('week_of', { ascending: true });
      if (error) throw error;
      result.teamActuals = data ?? [];
    }

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/actuals ─────────────────────────────────────────────────────────
// Upserts actuals. Body: { type, location, weekOf, ...fields }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isAdmin(userId)) return NextResponse.json({ error: 'Admin only' }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  const { type, location, weekOf } = body as { type: string; location: string; weekOf: string };
  const department = (body as { department?: string }).department;

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
      const { error } = await supabase
        .from('team_member_week_actuals')
        .upsert({
          location, department, week_of: weekOf,
          member_name: memberName,
          actual_hours: actualHours,
          actual_orders: actualOrders,
          // A manager typing a number here always locks it — the automated
          // production sync (src/app/api/cron/sync-production-actuals) skips
          // any row not marked 'auto', so this edit will never be silently
          // overwritten by the next sync.
          orders_source: 'manual',
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
