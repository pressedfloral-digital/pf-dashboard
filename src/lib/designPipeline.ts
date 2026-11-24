/**
 * Every order line in Preservation or Design, plus every line already
 * designed but not yet shipped, from the PF API's monthly WeeklyReport. Shared by /api/design-inventory (one location's schedule) and
 * the order add-on refresh cron (every location's orders).
 */
import { pfGet, fmtDate } from '@/lib/pf-api';
import { DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES, DESIGNED_STATUSES, isNonDesignProduct } from '@/lib/designInventory';

/** Every status loadPipelineLines keeps — for looking up order UUIDs. */
export const PIPELINE_STATUSES = [...DESIGN_QUEUE_STATUSES, ...PRESERVATION_STATUSES, ...DESIGNED_STATUSES];

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
  // Same as order_status_history.order_product_key (see status-snapshot.ts):
  // `${orderNumber}|${variantTitle}`, with `|1`, `|2`… appended for the 2nd,
  // 3rd… identical line on the same order in the same status.
  key:     string;
  baseKey: string;  // `${orderNumber}|${variantTitle}` without the counter
  num:     string;  // Shopify order number
  item: WeeklyReportItem;
}

// If another request (another viewer, or the add-on cron) holds the API's one
// WeeklyReport slot, wait out its Retry-After before trying the month again.
const BUSY_WAIT_MS = 10_000;
const MONTH_ATTEMPTS = 3;

/** One month's report, or null if it still fails after MONTH_ATTEMPTS. */
async function fetchMonth(path: string): Promise<WeeklyReportItem[] | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pfGet<WeeklyReportItem[]>(path);
    } catch {
      if (attempt >= MONTH_ATTEMPTS) return null;
      await new Promise(r => setTimeout(r, BUSY_WAIT_MS));
    }
  }
}

/** Preservation, Design and designed-not-shipped lines across all
 *  locations. Identical lines on one order (two of the same boutonniere)
 *  are separate items and each kept.
 *  `failedMonths` > 0 means some months' orders are missing from `lines`. */
export async function loadPipelineLines(): Promise<{ lines: PipelineLine[]; failedMonths: number; totalMonths: number }> {
  const today = new Date();
  const paths = Array.from({ length: ORDER_LOOKBACK_MONTHS }, (_, m) => {
    const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
    return `/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}`;
  });
  // One month at a time: the PF API serves only one WeeklyReport at once and
  // turns the rest away with 503 (Retry-After 10s), so a parallel burst of 15
  // always lost a month or two.
  const reports: (WeeklyReportItem[] | null)[] = [];
  for (const path of paths) reports.push(await fetchMonth(path));

  // WeeklyReport has no line-item id, so identical lines are told apart by a
  // counter, numbered the same way status-snapshot.ts numbers them.
  const counter = new Map<string, number>();
  const lines: PipelineLine[] = [];
  for (const items of reports) {
    for (const item of items ?? []) {
      const status = item.status ?? '';
      if (!DESIGN_QUEUE_STATUSES.has(status) && !PRESERVATION_STATUSES.has(status) && !DESIGNED_STATUSES.has(status)) continue;
      if (isNonDesignProduct(item.productTitle ?? '')) continue;
      const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
      if (!num) continue;
      const baseKey = `${num}|${item.variantTitle ?? ''}`;
      const cKey = `${baseKey}|${status}`;
      const cnt = counter.get(cKey) ?? 0;
      counter.set(cKey, cnt + 1);
      lines.push({ key: cnt === 0 ? baseKey : `${baseKey}|${cnt}`, baseKey, num, item });
    }
  }
  return { lines, failedMonths: reports.filter(r => r === null).length, totalMonths: paths.length };
}
