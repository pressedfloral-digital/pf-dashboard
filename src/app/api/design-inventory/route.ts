import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfGetAll, pfPost, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { isoMonday, getWeekMondays } from '@/lib/weekDates';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import { projectDept, buildManagerHomeDept, type DesignRosterEntry, type HoursMap, type DailyHoursMap } from '@/lib/scheduleProjection';
import {
  DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES, isNonDesignProduct, PRESERVATION_WEEKS,
  parseVariant, mondayOf, addWeeks, scheduleLines, matchMaterials, type QueueLine, type OrderAddOn,
} from '@/lib/designInventory';
import { loadKatana } from '@/lib/katana';
import { buildOrderPlan, type OrderPlan } from '@/lib/katanaPlan';
import { MAX_LEAD_WEEKS } from '@/lib/supplierLeadTimes';

export const maxDuration = 120;

// Orders are placed around the event date, so anything still in
// Preservation or Design was ordered within roughly this many months.
const ORDER_LOOKBACK_MONTHS = 15;
// PF API caps /OrderProducts/Search at 50 per page.
const SEARCH_PAGE_SIZE = 50;
const SEARCH_PAGE_BATCH = 10;
// Concurrent /Orders/{uuid} requests (each cached 5 min by pfGetAll).
const ORDER_DETAIL_BATCH = 20;

// WeeklyReport has order numbers but not order UUIDs, which /Orders/{uuid}
// (the only endpoint returning backing/glass add-ons) needs. Page through
// every Preservation/Design line once — ~80 pages — rather than one search
// per order.
async function findOrderUuids(): Promise<Record<string, string>> {
  const statuses = [...DESIGN_QUEUE_STATUSES, ...PRESERVATION_STATUSES];
  type SearchPage = { totalPages: number; items: { orderUuid: string; shopifyOrderNumber: string | number }[] };
  const search = (pageNumber: number) => pfPost<SearchPage>('/OrderProducts/Search', {
    searchTerm: '', pageNumber, pageSize: SEARCH_PAGE_SIZE, orderProductStatusFilter: statuses,
  });
  const first = await search(1);
  const pages = [first];
  for (let p = 2; p <= first.totalPages; p += SEARCH_PAGE_BATCH) {
    const batch = Array.from({ length: Math.min(SEARCH_PAGE_BATCH, first.totalPages - p + 1) }, (_, k) => search(p + k));
    pages.push(...await Promise.all(batch));
  }
  const out: Record<string, string> = {};
  pages.forEach(pg => pg.items.forEach(it => {
    if (it.orderUuid) out[String(it.shopifyOrderNumber)] = it.orderUuid;
  }));
  return out;
}

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
// through `through` (default: Dec 31 of this year, or the longest supplier
// lead time from now if that's later, so it reaches into next year from about
// November on), filled oldest-intake-first
// against the saved Design schedule's capacity.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') === 'Georgia' ? 'Georgia' : 'Utah';
  const thisWeek = isoMonday(0);
  const leadHorizon = addWeeks(thisWeek, MAX_LEAD_WEEKS);
  const yearEnd = `${thisWeek.slice(0, 4)}-12-31`;
  const through  = req.nextUrl.searchParams.get('through') ?? (leadHorizon > yearEnd ? leadHorizon : yearEnd);

  try {
    // ── 1. Order lines in Preservation or Design ───────────────────────────
    const today = new Date();
    const paths = Array.from({ length: ORDER_LOOKBACK_MONTHS }, (_, m) => {
      const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
      return `/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}`;
    });
    // Started now so its ~80 search pages overlap the report pull below.
    const orderUuidsPromise = findOrderUuids();
    orderUuidsPromise.catch(() => {}); // awaited (and surfaced) in step 4
    // Katana recipes + stock load alongside; a Katana failure only drops the
    // order list, not the schedule.
    const katanaPromise = loadKatana(location);
    katanaPromise.catch(() => {}); // awaited in step 5
    const reports = await pfGetAll<WeeklyReportItem[]>(paths);

    const seen = new Set<string>();
    const raw: { key: string; item: WeeklyReportItem; num: string }[] = [];
    let missingLocation = 0;
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

    // ── 4. Backing & glass for every scheduled order ───────────────────────
    const scheduledNums = new Set(weeks.flatMap(w => w.lines.map(l => l.orderNumber)));
    const orderUuids = await orderUuidsPromise;
    const addOnsByOrder: Record<string, OrderAddOn[]> = {};
    const nums = [...scheduledNums].filter(n => orderUuids[n]);
    for (let i = 0; i < nums.length; i += ORDER_DETAIL_BATCH) {
      const batch = nums.slice(i, i + ORDER_DETAIL_BATCH);
      const details = await pfGetAll<{ nonStatusOrderProducts?: OrderAddOn[] }>(batch.map(n => `/Orders/${orderUuids[n]}`));
      details.forEach((d, j) => { if (d) addOnsByOrder[batch[j]] = d.nonStatusOrderProducts ?? []; });
    }
    const usedAddOns = new Set<string>();
    let missingOrderDetail = 0;
    for (const w of weeks) {
      for (const line of w.lines) {
        if (!addOnsByOrder[line.orderNumber]) missingOrderDetail++;
        line.materials = matchMaterials(line, addOnsByOrder[line.orderNumber] ?? [], usedAddOns);
      }
    }

    // ── 5. What to order: recipes × schedule vs Katana stock ───────────────
    let orderPlan: OrderPlan | null = null;
    let katanaError: string | null = null;
    try {
      orderPlan = buildOrderPlan(await katanaPromise, location, weeks, thisWeek);
    } catch (e) {
      katanaError = String(e);
    }

    return NextResponse.json({
      location,
      orderPlan,
      katanaError,
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
        missingOrderDetail,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
