import { sharedReportSnapshot } from '@/lib/report-refresh-store';
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

/** Design/Preservation lines across all locations, deduped by key.
 *  `failedMonths` > 0 means some months' orders are missing from `lines`. */
async function scanPipelineLines(): Promise<{ lines: PipelineLine[]; failedMonths: number; totalMonths: number }> {
  const today = new Date();
  const paths = Array.from({ length: ORDER_LOOKBACK_MONTHS }, (_, m) => {
    const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
    return `/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}`;
  });
  const reports: WeeklyReportItem[][] = [];
  const deadline = Date.now() + 120_000;
  for (const path of paths) {
    if (Date.now() >= deadline) throw new Error('Complete report refresh exceeded its time budget.');
    const items = await pfGet<WeeklyReportItem[]>(path, { fresh: true });
    if (!Array.isArray(items)) throw new Error('Monthly report response is incomplete.');
    reports.push(items);
  }

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

// Shared across Vercel instances; only a complete 15-month scan is published.
// Failure leaves the previous snapshot intact and fails the refresh explicitly.
export async function loadPipelineLines() {
  const snapshot = await sharedReportSnapshot('design-pipeline-v1', scanPipelineLines);
  return { ...snapshot.value, refreshedAt: snapshot.completedAt };
}
