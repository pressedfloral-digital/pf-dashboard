import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfGetAll, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { isoMonday, getWeekMondays } from '@/lib/weekDates';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import { projectDept, buildManagerHomeDept, type DesignRosterEntry, type HoursMap, type DailyHoursMap } from '@/lib/scheduleProjection';
import {
  DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES, NON_DESIGN_PRODUCTS, PRESERVATION_WEEKS,
  parseVariant, mondayOf, addWeeks, scheduleLines, type QueueLine,
} from '@/lib/designInventory';

export const maxDuration = 120;

// Orders are placed around the event date, so anything still in
// Preservation or Design was ordered within roughly this many months.
const ORDER_LOOKBACK_MONTHS = 15;

interface WeeklyReportItem {
  orderNumber?: string | number;
  shopifyOrderNumber?: string | number;
  orderName?: string;
  status?: string;
  location?: string;
  eventDate?: string;
  originalOrderDate?: string;
  productTitle?: string;
  variantTitle?: string;
}

// ── GET /api/design-inventory?location=Utah&through=2026-12-31 ───────────────
// Every order line Design is scheduled to work on each week from this week
// through `through` (default: Dec 31 of this year), filled oldest-intake-first
// against the saved Design schedule's capacity.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') === 'Georgia' ? 'Georgia' : 'Utah';
  const thisWeek = isoMonday(0);
  const through  = req.nextUrl.searchParams.get('through') ?? `${thisWeek.slice(0, 4)}-12-31`;

  try {
    // ── 1. Order lines in Preservation or Design ───────────────────────────
    const today = new Date();
    const paths = Array.from({ length: ORDER_LOOKBACK_MONTHS }, (_, m) => {
      const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
      return `/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}`;
    });
    const reports = await pfGetAll<WeeklyReportItem[]>(paths);

    const seen = new Set<string>();
    const raw: { key: string; item: WeeklyReportItem; num: string }[] = [];
    let missingLocation = 0;
    for (const items of reports) {
      for (const item of items ?? []) {
        const status = item.status ?? '';
        if (!DESIGN_QUEUE_STATUSES.has(status) && !PRESERVATION_STATUSES.has(status)) continue;
        if (NON_DESIGN_PRODUCTS.has(item.productTitle ?? '')) continue;
        const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
        if (!num) continue;
        const key = `${num}|${item.variantTitle ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!item.location) { missingLocation++; continue; }
        if (item.location !== location) continue;
        raw.push({ key, item, num });
      }
    }

    // ── 2. Bouquet-received dates (intake week) ────────────────────────────
    const receivedAt: Record<string, string> = {};
    const keys = raw.map(r => r.key);
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await supabase
        .from('order_status_history')
        .select('order_product_key, entered_at')
        .eq('status', 'bouquetReceived')
        .in('order_product_key', keys.slice(i, i + 200));
      if (error) throw error;
      (data ?? []).forEach(r => {
        const d = r.entered_at?.slice(0, 10);
        if (d && (!receivedAt[r.order_product_key] || d < receivedAt[r.order_product_key])) receivedAt[r.order_product_key] = d;
      });
    }

    const lines: QueueLine[] = raw.map(({ key, item, num }) => {
      const received = receivedAt[key];
      const intakeDate = received ?? item.eventDate?.slice(0, 10) ?? item.originalOrderDate?.slice(0, 10) ?? thisWeek;
      const status = item.status ?? '';
      return {
        orderNumber:  num,
        customer:     item.orderName ?? '',
        product:      item.productTitle ?? '',
        variant:      item.variantTitle ?? '',
        ...parseVariant(item.variantTitle),
        status,
        intakeDate,
        intakeSource: received ? 'bouquetReceived' : 'eventDate',
        designableWeek: DESIGN_QUEUE_STATUSES.has(status) ? thisWeek : addWeeks(mondayOf(intakeDate), PRESERVATION_WEEKS),
      };
    });

    // ── 3. Design capacity per week (same projection as /api/kpis) ─────────
    const [{ data: settingsData, error: settingsError }, { data: managerEmpRows }, actualRows] = await Promise.all([
      supabase.from('schedule_settings').select('location,key,value'),
      supabase.from('rippling_employees').select('full_name,location,department,title').eq('active', true),
      fetchAllRows<{ member_name: string; actual_orders: number | null }>((from, to) =>
        supabase
          .from('team_member_week_actuals')
          .select('member_name, actual_orders')
          .eq('location', location)
          .eq('department', 'design')
          .eq('week_of', thisWeek)
          .range(from, to)
      ),
    ]);
    if (settingsError) throw settingsError;
    const settings = settingsData ?? [];
    const get = (key: string) => settings.find(r => r.location === location && r.key === key)?.value ?? {};
    const paidHolidays = (settings.find(r => r.location === 'Global' && r.key === 'paidHolidays')?.value as string[]) ?? [];
    const designRoster = Object.fromEntries(
      Object.entries(get('designRoster') as Record<string, DesignRosterEntry>).filter(([, m]) => !isNonProductionStaff(m.name))
    );
    const managerHomeDept = buildManagerHomeDept(managerEmpRows ?? []);

    const weekOfs = getWeekMondays(thisWeek, through);
    // This week is partly done — whatever Design already logged has left
    // Ready to Frame, so only the rest of the week's capacity is still open.
    const designedThisWeek = actualRows
      .filter(r => !isNonProductionStaff(r.member_name))
      .reduce((s, r) => s + (r.actual_orders ?? 0), 0);
    const capacityWeeks = weekOfs.map(weekOf => {
      const scheduled = projectDept(
        designRoster, get('designHours') as HoursMap, get('designDailyHours') as DailyHoursMap,
        [weekOf], location, 'Design', new Set(paidHolidays), 'estimate', get('mgrTotalHours') as HoursMap, managerHomeDept,
      ).production;
      return { weekOf, scheduled, capacity: weekOf === thisWeek ? Math.max(0, scheduled - designedThisWeek) : scheduled };
    });

    const { weeks, unscheduled } = scheduleLines(lines, capacityWeeks);

    return NextResponse.json({
      location,
      generatedAt: new Date().toISOString(),
      designedThisWeek,
      weeks: weeks.map((w, i) => ({ ...w, scheduled: Math.round(capacityWeeks[i].scheduled) })),
      unscheduledCount: unscheduled.length,
      totals: {
        lines: lines.length,
        inDesignQueue: lines.filter(l => DESIGN_QUEUE_STATUSES.has(l.status)).length,
        inPreservation: lines.filter(l => PRESERVATION_STATUSES.has(l.status)).length,
        intakeFromEventDate: lines.filter(l => l.intakeSource === 'eventDate').length,
        missingLocation,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
