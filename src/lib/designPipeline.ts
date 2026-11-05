/**
 * Every order line in Preservation or Design, from the PF API's monthly
 * WeeklyReport. Shared by /api/design-inventory (one location's schedule) and
 * the order add-on refresh cron (every location's orders).
 */
import { pfGet, fmtDate } from '@/lib/pf-api';
import { DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES, isNonDesignProduct } from '@/lib/designInventory';

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

/** Design/Preservation lines across all locations, deduped by key.
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
