import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { weekMonday } from '@/lib/pf-api';
import { computeProductionCounts, type StaffRow } from '@/lib/production-counts';

export const maxDuration = 300;

// Weekly: auto-fills team_member_week_actuals.actual_orders from the Pressed
// Floral app's own production events (bouquetReceived / frameCompleted /
// readyToPackage — see src/lib/production-counts.ts), so managers no longer
// have to hand-type these counts. Runs for the most recently completed
// Mon–Sun week. Any row a manager has edited via the Historicals UI is
// marked orders_source='manual' (src/app/api/actuals/route.ts) and is never
// touched again here. actual_hours is always preserved as-is.
//
// ?dryRun=1 computes and reports what would change without writing anything.

const DEPT_KEYS = ['Preservation', 'Design', 'Fulfillment'] as const;
const ACTUALS_DEPT: Record<(typeof DEPT_KEYS)[number], string> = {
  Preservation: 'preservation',
  Design:       'design',
  Fulfillment:  'fulfillment',
};

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

interface PlannedWrite {
  location: string;
  department: string;
  member: string;
  weekOf: string;
  computedOrders: number;
  previousOrders: number | null;
  action: 'write' | 'skip_locked' | 'skip_unresolved_location';
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

  try {
    // Most recently completed Mon–Sun week.
    const lastWeekMonday = new Date(weekMonday(new Date()));
    lastWeekMonday.setDate(lastWeekMonday.getDate() - 7);
    const weekStart = isoDate(lastWeekMonday);
    const weekEndDate = new Date(lastWeekMonday);
    weekEndDate.setDate(weekEndDate.getDate() + 6);
    const weekEnd = isoDate(weekEndDate);

    const computed = await computeProductionCounts(weekStart, weekEnd);

    const { data: staffRows, error: staffErr } = await supabase
      .from('staff_locations')
      .select('name, location');
    if (staffErr) throw staffErr;
    const staffLocationMap: Record<string, string> = {};
    staffRows?.forEach(r => { staffLocationMap[r.name] = r.location; });

    const { data: existingRows, error: existingErr } = await supabase
      .from('team_member_week_actuals')
      .select('location, department, member_name, actual_hours, actual_orders, orders_source')
      .eq('week_of', weekStart);
    if (existingErr) throw existingErr;

    const planned: PlannedWrite[] = [];
    const toUpsert: Record<string, unknown>[] = [];

    for (const dept of DEPT_KEYS) {
      const actualsDept = ACTUALS_DEPT[dept];
      const rows: StaffRow[] = computed[dept];

      for (const row of rows) {
        if (!row.staff || row.staff === 'Unassigned') continue;

        const location = staffLocationMap[row.staff];
        if (!location) {
          planned.push({
            location: '(unresolved)', department: actualsDept, member: row.staff,
            weekOf: weekStart, computedOrders: row.count, previousOrders: null,
            action: 'skip_unresolved_location',
          });
          continue;
        }

        const existing = existingRows?.find(r =>
          r.location === location && r.department === actualsDept && r.member_name === row.staff
        );

        if (existing?.orders_source === 'manual') {
          planned.push({
            location, department: actualsDept, member: row.staff, weekOf: weekStart,
            computedOrders: row.count, previousOrders: existing.actual_orders,
            action: 'skip_locked',
          });
          continue;
        }

        planned.push({
          location, department: actualsDept, member: row.staff, weekOf: weekStart,
          computedOrders: row.count, previousOrders: existing?.actual_orders ?? null,
          action: 'write',
        });

        toUpsert.push({
          location, department: actualsDept, week_of: weekStart,
          member_name: row.staff,
          actual_hours: existing?.actual_hours ?? 0,
          actual_orders: row.count,
          orders_source: 'auto',
          updated_at: new Date().toISOString(),
        });
      }
    }

    if (!dryRun && toUpsert.length) {
      const { error: upsertErr } = await supabase
        .from('team_member_week_actuals')
        .upsert(toUpsert, { onConflict: 'location,department,week_of,member_name' });
      if (upsertErr) throw upsertErr;
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      weekOf: weekStart,
      weekEnd,
      written:  planned.filter(p => p.action === 'write').length,
      skippedLocked: planned.filter(p => p.action === 'skip_locked').length,
      skippedUnresolved: planned.filter(p => p.action === 'skip_unresolved_location').length,
      planned,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
