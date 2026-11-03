/**
 * Shopify order number → PF API order UUID, for fetching /Orders/{uuid}.
 *
 * UUIDs never change, so they're kept in Supabase (pf_order_uuids) and only
 * numbers not seen before hit the PF API: one /OrderProducts/Search per new
 * order, or one paged search over every in-progress order when there are too
 * many new ones (the first load, or after the table is cleared). If the table
 * isn't there yet, every load falls back to the paged search.
 */
import { pfPost } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';

const TABLE = 'pf_order_uuids';
// Above this many unknown orders, one paged search (~90 requests) is cheaper
// than a search per order.
const MAX_SINGLE_LOOKUPS = 60;
const SINGLE_LOOKUP_BATCH = 5;
// PF API caps /OrderProducts/Search at 50 per page.
const SEARCH_PAGE_SIZE = 50;
const SEARCH_PAGE_BATCH = 5;

type SearchPage = { totalPages: number; items: { orderUuid: string; shopifyOrderNumber: string | number }[] };

const search = (body: Record<string, unknown>) =>
  pfPost<SearchPage>('/OrderProducts/Search', { searchTerm: '', pageSize: SEARCH_PAGE_SIZE, ...body });

/** Every order with a line in one of `statuses`, paged through 50 at a time. */
async function searchAllByStatus(statuses: string[]): Promise<Record<string, string>> {
  const page = (pageNumber: number) => search({ pageNumber, orderProductStatusFilter: statuses });
  const first = await page(1);
  const pages = [first];
  for (let p = 2; p <= first.totalPages; p += SEARCH_PAGE_BATCH) {
    const batch = Array.from({ length: Math.min(SEARCH_PAGE_BATCH, first.totalPages - p + 1) }, (_, k) => page(p + k));
    pages.push(...await Promise.all(batch));
  }
  const out: Record<string, string> = {};
  pages.forEach(pg => pg.items.forEach(it => {
    if (it.orderUuid) out[String(it.shopifyOrderNumber)] = it.orderUuid;
  }));
  return out;
}

/** One order by number. The search term is a substring match, so keep only
 *  the exact number. */
async function searchOne(num: string): Promise<string | undefined> {
  const { items } = await search({ searchTerm: num, pageNumber: 1 });
  return items.find(it => String(it.shopifyOrderNumber) === num && it.orderUuid)?.orderUuid;
}

/** UUIDs for `nums`. `statuses` are what the orders are in, for the paged
 *  fallback. Orders the PF API doesn't return are left out. */
export async function resolveOrderUuids(nums: string[], statuses: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let tableOk = true;
  for (let i = 0; i < nums.length && tableOk; i += 200) {
    const { data, error } = await supabase.from(TABLE).select('order_number, order_uuid').in('order_number', nums.slice(i, i + 200));
    if (error) { tableOk = false; console.warn(`${TABLE} unavailable, using paged search:`, error.message); break; }
    (data ?? []).forEach(r => { out[r.order_number] = r.order_uuid; });
  }

  const missing = tableOk ? nums.filter(n => !out[n]) : nums;
  if (missing.length === 0) return out;

  const found: Record<string, string> = {};
  if (!tableOk || missing.length > MAX_SINGLE_LOOKUPS) {
    const all = await searchAllByStatus(statuses);
    missing.forEach(n => { if (all[n]) found[n] = all[n]; });
  } else {
    for (let i = 0; i < missing.length; i += SINGLE_LOOKUP_BATCH) {
      const batch = missing.slice(i, i + SINGLE_LOOKUP_BATCH);
      const uuids = await Promise.all(batch.map(searchOne));
      batch.forEach((n, j) => { if (uuids[j]) found[n] = uuids[j]!; });
    }
  }
  Object.assign(out, found);

  if (tableOk) {
    const rows = Object.entries(found).map(([order_number, order_uuid]) => ({ order_number, order_uuid }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from(TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'order_number', ignoreDuplicates: true });
      if (error) { console.warn(`${TABLE} save failed:`, error.message); break; }
    }
  }
  return out;
}
