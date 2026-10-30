/**
 * Each order's non-status add-ons (Backing, Glass, …) from /Orders/{uuid},
 * saved in Supabase (pf_order_addons) so a page load reads them instead of
 * making one PF API request per scheduled order.
 *
 * /api/cron/refresh-order-addons keeps them current: orders never fetched
 * first, then anything older than ADDONS_REFRESH_HOURS. A failed fetch only
 * records the error on the row — its last good add-ons and fetched_at stay.
 */
import { pfGet } from '@/lib/pf-api';
import { ReportingDeferredError } from '@/lib/pf-budget';
import { supabase } from '@/lib/supabase';
import type { OrderAddOn } from '@/lib/designInventory';

const TABLE = 'pf_order_addons';
export const ADDONS_REFRESH_HOURS = 4;

export interface SavedAddOns {
  addOns:    OrderAddOn[];
  fetchedAt: string;   // ISO time of the last successful fetch
}

/** Saved add-ons for `nums`. `tableOk` is false when the table can't be read
 *  (e.g. not created yet) — callers then fetch live and skip saving. */
export async function readSavedAddOns(nums: string[]): Promise<{ saved: Record<string, SavedAddOns>; tableOk: boolean }> {
  const saved: Record<string, SavedAddOns> = {};
  for (let i = 0; i < nums.length; i += 200) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('order_number, add_ons, fetched_at')
      .in('order_number', nums.slice(i, i + 200));
    if (error) {
      console.warn(`${TABLE} unavailable:`, error.message);
      return { saved: {}, tableOk: false };
    }
    (data ?? []).forEach(r => { saved[r.order_number] = { addOns: r.add_ons as OrderAddOn[], fetchedAt: r.fetched_at }; });
  }
  return { saved, tableOk: true };
}

/** Saved order numbers with when each was last fetched, oldest first. */
export async function listSavedAddOnTimes(): Promise<{ num: string; fetchedAt: string }[]> {
  const out: { num: string; fetchedAt: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('order_number, fetched_at')
      .order('fetched_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    (data ?? []).forEach(r => out.push({ num: r.order_number, fetchedAt: r.fetched_at }));
    if (!data || data.length < 1000) return out;
  }
}

/**
 * Fetches add-ons fresh for `orders`, `concurrency` at a time, starting no new
 * request after `deadline` (epoch ms). Successes are saved when `save` is set;
 * failures only get last_error recorded, never overwriting saved add-ons.
 */
export async function fetchAddOns(
  orders: { num: string; uuid: string }[],
  opts: { concurrency: number; deadline: number; save: boolean },
): Promise<{ fetched: Record<string, SavedAddOns>; failed: string[]; notTried: string[] }> {
  const fetched: Record<string, SavedAddOns> = {};
  const failed: string[] = [];
  const errors: Record<string, string> = {};
  let next = 0;
  let deferred = false;

  const worker = async () => {
    while (!deferred && next < orders.length && Date.now() < opts.deadline) {
      const { num, uuid } = orders[next++];
      try {
        const order = await pfGet<{ nonStatusOrderProducts?: OrderAddOn[] }>(`/Orders/${uuid}`, { fresh: true });
        fetched[num] = {
          addOns: (order.nonStatusOrderProducts ?? []).map(a => ({ uuid: a.uuid, productTitle: a.productTitle, variantTitle: a.variantTitle ?? null })),
          fetchedAt: new Date().toISOString(),
        };
      } catch (e) {
        if (e instanceof ReportingDeferredError) deferred = true;
        failed.push(num);
        errors[num] = e instanceof Error ? e.message : String(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, orders.length) }, worker));
  const notTried = orders.slice(next).map(o => o.num);

  if (opts.save) {
    const uuidOf = Object.fromEntries(orders.map(o => [o.num, o.uuid]));
    const now = new Date().toISOString();
    const rows = Object.entries(fetched).map(([num, s]) => ({
      order_number: num, order_uuid: uuidOf[num], add_ons: s.addOns,
      fetched_at: s.fetchedAt, last_attempt_at: now, last_error: null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from(TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'order_number' });
      if (error) throw new Error('Add-on refresh could not save results; prior saved data retained.');
    }
    // Only rows that already exist are touched, so a never-fetched order that
    // fails stays absent (and shows as couldn't-load) rather than empty.
    for (const num of failed) {
      await supabase.from(TABLE).update({ last_attempt_at: now, last_error: errors[num].slice(0, 500) }).eq('order_number', num);
    }
  }
  return { fetched, failed, notTried };
}
