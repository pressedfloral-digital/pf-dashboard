/**
 * Every order line in Preservation or Design, from the PF API's monthly
 * WeeklyReport. Shared by /api/design-inventory (one location's schedule) and
 * the order add-on refresh cron (every location's orders).
 */
import { pfGetAll, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { getWeekMondays } from '@/lib/weekDates';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import { projectDept, buildManagerHomeDept, type DesignRosterEntry, type HoursMap, type DailyHoursMap } from '@/lib/scheduleProjection';
import {
  DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES, PRESERVATION_WEEKS, isNonDesignProduct,
  parseVariant, mondayOf, addWeeks, type QueueLine,
} from '@/lib/designInventory';

// Orders are placed around the event date, so anything still in
// Preservation or Design was ordered within roughly this many months.
const ORDER_LOOKBACK_MONTHS = 15;

export interface WeeklyReportItem {
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

export interface PipelineLine {
  key:  string;   // `${orderNumber}|${variantTitle}`, same as order_status_history.order_product_key
  num:  string;   // Shopify order number
  item: WeeklyReportItem;
}

/** Design/Preservation lines across all locations, deduped by key.
 *  `failedMonths` > 0 means some months' orders are missing from `lines`. */
export async function loadPipelineLines(): Promise<{ lines: PipelineLine[]; failedMonths: number; totalMonths: number }> {
  const today = new Date();
  const paths = Array.from({ length: ORDER_LOOKBACK_MONTHS }, (_, m) => {
    const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
    return `/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}`;
  });
  const reports = await pfGetAll<WeeklyReportItem[]>(paths);

  const seen = new Set<string>();
  const lines: PipelineLine[] = [];
  for (const items of reports) {
    for (const item of items ?? []) {
      const status = item.status ?? '';
      if (!DESIGN_QUEUE_STATUSES.has(status) && !PRESERVATION_STATUSES.has(status)) continue;
      if (isNonDesignProduct(item.productTitle ?? '')) continue;
      const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
      if (!num) continue;
      const key = `${num}|${item.variantTitle ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ key, num, item });
    }
  }
  return { lines, failedMonths: reports.filter(r => r === null).length, totalMonths: paths.length };
}

/** One location's Design/Preservation lines with their intake (bouquet
 *  received) dates. Shared by /api/design-inventory and
 *  /api/behind-promise-orders so both group orders into intake weeks the
 *  same way. Lines with no received date fall back to the event date. */
export async function loadLocationQueueLines(location: string, thisWeek: string): Promise<{
  lines: QueueLine[]; missingLocation: number; failedMonths: number; totalMonths: number;
}> {
  const pipeline = await loadPipelineLines();
  let missingLocation = 0;
  const raw = pipeline.lines.filter(({ item }) => {
    if (!item.location) { missingLocation++; return false; }
    return item.location === location;
  });

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
  return { lines, missingLocation, failedMonths: pipeline.failedMonths, totalMonths: pipeline.totalMonths };
}

/** Design's frame capacity for each week from `thisWeek` through `through`,
 *  from the saved schedule (same projection as /api/kpis). This week's
 *  capacity is only what's left after frames already logged this week.
 *  Shared by /api/design-inventory and /api/design-week-orders. */
export async function loadDesignCapacityWeeks(location: string, thisWeek: string, through: string): Promise<{
  capacityWeeks:    { weekOf: string; scheduled: number; capacity: number }[];
  designedThisWeek: number;
  settings:         { location: string; key: string; value: unknown }[];
}> {
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
  const settings = (settingsData ?? []) as { location: string; key: string; value: unknown }[];
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
  return { capacityWeeks, designedThisWeek, settings };
}
