import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// A plain "Georgia" or "Utah" tag means the physical flowers have arrived at
// that location and are ready for resin work — this is what actually gates
// entry into the resin queue now. The PF pipeline-status tags below
// (bouquetReceived etc.) are kept only as an informational display label
// (pf_status) when present; they used to be what determined queue membership,
// but that read as unreliable in practice, so they no longer gate anything.
const LOCATION_TAGS = ['Georgia', 'Utah'] as const;

const PIPELINE_STATUSES = [
  'bouquetReceived','checkedOn','progress','almostReadyToFrame',
  'readyToFrame','frameCompleted','glued','readyToSeal',
  'readyToPackage','readyToFulfill','preparingToBeShipped','approved','disapproved',
];

const STATUS_RANK: Record<string, number> = {
  bouquetReceived:1, checkedOn:2, progress:3, almostReadyToFrame:4,
  readyToFrame:5, frameCompleted:6, glued:7, readyToSeal:8,
  readyToPackage:9, readyToFulfill:10, preparingToBeShipped:11, approved:12, disapproved:13,
};

const RESIN_PRODUCT_IDS = new Set([
  '8199232553130',
  '7880850047146',
  '8069413830826',
]);

// "Blooms Process" add-on products, scoped to just the three real resin
// products (necklace/locket/ring) — NOT Footprint, Mini Frame, Paw Print,
// or Handprint, which share the naming convention but aren't resin work and
// shouldn't influence this queue at all, even indirectly. Each has two
// variants that mean very different things for queue timing:
//   RECREATE (`Help me customize after purchase`) — the customer supplies a
//     photo. No physical delivery to wait on, so this is the true signal
//     that an order can skip the Georgia/Utah tag wait entirely.
//   SEND_OWN (`I'll send in my own`) — the customer is mailing something in
//     physically. Still needs to actually arrive, same as a normal order,
//     so this does NOT bypass the wait — it's tracked only so the ops
//     dashboard can show "waiting on their own delivery" instead of
//     silently treating it like a normal wedding-flowers order.
// Variant IDs from a GraphQL title search for "Blooms Process*" on
// 2026-08-18.
const RECREATE_VARIANT_IDS = new Set([
  '47597193232554',  // Blooms Process PF Necklace — Help me customize after purchase
  '47597372833962',  // Blooms Process Custom Locket — Help me customize after purchase
  '47597411598506',  // Blooms Process Custom Ring — Help me customize after purchase
]);
const SEND_OWN_VARIANT_IDS = new Set([
  '47597193199786',  // Blooms Process PF Necklace — I'll send in my own
  '47597372801194',  // Blooms Process Custom Locket — I'll send in my own
  '47597411565738',  // Blooms Process Custom Ring — I'll send in my own
]);

// Classifies an order's Blooms Process selection from its line items —
// shared by both the tag-based and photo-inspiration passes below so every
// resin line item gets the same classification regardless of which pass
// found it.
function classifyBloomsProcess(lineItems: ShopifyLineItem[]): 'recreate' | 'send_own' | null {
  if (lineItems.some(li => RECREATE_VARIANT_IDS.has(String(li.variant_id)))) return 'recreate';
  if (lineItems.some(li => SEND_OWN_VARIANT_IDS.has(String(li.variant_id)))) return 'send_own';
  return null;
}

// Not every order carries the event date as a plain order tag — orders built
// through the frame bundle app instead store it as a line-item property
// named "Event date" on that bundle's "main" item (alongside "_Type of
// event" etc.), with no matching order tag at all. Falls back to scanning
// every line item's properties for the first "Event date" value that looks
// like a real date, tried only when the order-tag scan comes up empty.
function findEventDateInLineItemProperties(lineItems: ShopifyLineItem[]): string | null {
  for (const li of lineItems) {
    for (const prop of (li.properties ?? [])) {
      if (prop.name.trim().toLowerCase() === 'event date' && /^\d{4}-\d{2}-\d{2}$/.test(prop.value.trim())) {
        return prop.value.trim();
      }
    }
  }
  return null;
}

const SHOPIFY_API_VERSION = '2024-01';

// "Pressed Floral shop" (Orem, UT) — used only to detect when a Georgia-
// origin item's fulfillment has been manually moved to Utah in Shopify (see
// the transfer-detection section below). The dashboard never writes this
// itself anymore — purely observes whatever your team sets directly in
// Shopify and reflects it.
const UTAH_LOCATION_ID = 67995631786;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// This now runs unattended (automatic split/move on every cron sync), so a
// transient 429 shouldn't fail the whole run — one retry after Shopify's
// requested backoff (or a conservative default) covers the common case.
//
// Returns { data, link } — Shopify's cursor-pagination info comes back as an
// HTTP response header ("Link: <...>; rel=\"next\""), not as a field in the
// JSON body, so callers that need to page through results must read `link`,
// not `data.link` (that's always undefined and silently looks like "no more
// pages" — this previously meant every paginated fetch in this file stopped
// after its first 250 results no matter how many actually matched).
async function shopifyFetch(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${path}`,
      {
        method,
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN!,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      }
    );
    if (res.status === 429 && attempt === 0) {
      const retryAfter = parseFloat(res.headers.get('Retry-After') ?? '1');
      await sleep(Math.max(500, retryAfter * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Shopify ${path} → ${res.status}: ${await res.text()}`);
    return { data: await res.json(), link: res.headers.get('link') ?? '' };
  }
  throw new Error(`Shopify ${path} → still rate-limited after retry`);
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('[resin-queue-sync] Starting sync...');
    const resinLineItems: ResinLineItem[] = [];
    const seen = new Set<string>();

    for (const locationTag of LOCATION_TAGS) {
      let pageInfo: string | null = null;
      let isFirst = true;

      while (true) {
        let url: string;
        if (isFirst) {
          url = `/orders.json?tag=${locationTag}&status=open&limit=250&fields=id,order_number,created_at,tags,line_items`;
        } else {
          url = `/orders.json?page_info=${pageInfo}&limit=250&fields=id,order_number,created_at,tags,line_items`;
        }
        isFirst = false;

        const { data, link } = await shopifyFetch(url);
        const orders: ShopifyOrder[] = data.orders ?? [];

        for (const order of orders) {
          const orderTags = (order.tags ?? '').split(',').map((t: string) => t.trim());
          // Informational only now — see LOCATION_TAGS comment above.
          const pipelineStatus = PIPELINE_STATUSES.find(s => orderTags.includes(s)) ?? null;
          // Event-date tag convention shared with /api/event-date-orders and
          // /api/event-date-forecast: a plain YYYY-MM-DD tag = the customer's
          // event (e.g. wedding) date.
          const eventDateTag = orderTags.find((t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t))
            ?? findEventDateInLineItemProperties(order.line_items);
          const bloomsProcessType = classifyBloomsProcess(order.line_items);

          for (const li of order.line_items) {
            if (!RESIN_PRODUCT_IDS.has(String(li.product_id))) continue;
            if (li.fulfillment_status === 'fulfilled') continue;
            if (seen.has(String(li.id))) continue;
            seen.add(String(li.id));

            resinLineItems.push({
              shopifyOrderId:     String(order.id),
              shopifyOrderNumber: String(order.order_number),
              lineItemId:         String(li.id),
              lineItemTitle:      li.title ?? '',
              variantTitle:       li.variant_title ?? null,
              quantity:           li.quantity ?? 1,
              fulfillmentStatus:  li.fulfillment_status ?? null,
              productId:          String(li.product_id),
              orderCreatedAt:     order.created_at,
              eventDate:          eventDateTag,
              pipelineStatus,
              originLocation:     locationTag,
              bloomsProcessType,
            });
          }
        }

        if (link.includes('rel="next"')) {
          const match = link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
          pageInfo = match?.[1] ?? null;
          if (!pageInfo) break;
        } else {
          break;
        }
      }
    }

    // ── Also fetch photo-inspiration orders (no pipeline tag needed) ──────────
    {
      let photoPageInfo: string | null = null;
      let photoIsFirst = true;
      while (true) {
        const { data, link } = await shopifyFetch(
          photoIsFirst
            ? `/orders.json?tag=Custom+Resin&status=open&limit=250&fields=id,order_number,created_at,tags,line_items`
            : `/orders.json?page_info=${photoPageInfo}&limit=250&fields=id,order_number,created_at,tags,line_items`
        );
        photoIsFirst = false;
        const orders: ShopifyOrder[] = data.orders ?? [];

        for (const order of orders) {
          // Skip orders already caught by the Georgia/Utah tag search above
          const orderTags = (order.tags ?? '').split(',').map((t: string) => t.trim());
          const locationTag = LOCATION_TAGS.find(t => orderTags.includes(t)) ?? null;
          if (locationTag) continue;

          // Only "recreate from photo" bypasses the wait here — "send your
          // own" still needs a physical delivery, so it stays gated by the
          // normal Georgia/Utah tag path (see classifyBloomsProcess comment).
          const bloomsProcessType = classifyBloomsProcess(order.line_items);
          if (bloomsProcessType !== 'recreate') continue;

          const eventDateTag = orderTags.find((t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t))
            ?? findEventDateInLineItemProperties(order.line_items);

          for (const li of order.line_items) {
            if (!RESIN_PRODUCT_IDS.has(String(li.product_id))) continue;
            if (li.fulfillment_status === 'fulfilled') continue;
            if (seen.has(String(li.id))) continue;
            seen.add(String(li.id));

            resinLineItems.push({
              shopifyOrderId:     String(order.id),
              shopifyOrderNumber: String(order.order_number),
              lineItemId:         String(li.id),
              lineItemTitle:      li.title ?? '',
              variantTitle:       li.variant_title ?? null,
              quantity:           li.quantity ?? 1,
              fulfillmentStatus:  li.fulfillment_status ?? null,
              productId:          String(li.product_id),
              orderCreatedAt:     order.created_at,
              eventDate:          eventDateTag,
              pipelineStatus:     'recreation',
              bloomsProcessType,
            });
          }
        }

        if (link.includes('rel="next"')) {
          const match = link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
          photoPageInfo = match?.[1] ?? null;
          if (!photoPageInfo) break;
        } else {
          break;
        }
      }
    }

    console.log(`[resin-queue-sync] Found ${resinLineItems.length} unfulfilled resin line items`);

    if (resinLineItems.length === 0) {
      return NextResponse.json({ synced: 0, message: 'No unfulfilled resin line items found' });
    }

    const orderNumbers = [...new Set(resinLineItems.map(li => li.shopifyOrderNumber))];

    const { data: cacheRows, error: cacheError } = await supabase
      .from('uuid_location_cache')
      .select('order_num, status, location, order_date')
      .in('order_num', orderNumbers);

    if (cacheError) throw cacheError;

    const orderMap = new Map<string, { location: string | null; order_date: string | null; status: string }>();
    for (const row of (cacheRows ?? [])) {
      const existing = orderMap.get(row.order_num);
      const thisRank = STATUS_RANK[row.status] ?? 999;
      const existingRank = existing ? (STATUS_RANK[existing.status] ?? 999) : 9999;
      if (!existing || thisRank < existingRank) {
        orderMap.set(row.order_num, { location: row.location, order_date: row.order_date, status: row.status });
      }
    }

    console.log(`[resin-queue-sync] Matched ${orderMap.size}/${orderNumbers.length} orders in cache`);

    const rows = resinLineItems.map(li => {
      const cache = orderMap.get(li.shopifyOrderNumber);
      const status = cache?.status ?? li.pipelineStatus ?? 'unknown';
      return {
        shopify_order_id:           li.shopifyOrderId,
        shopify_order_number:       li.shopifyOrderNumber,
        line_item_id:               li.lineItemId,
        line_item_title:            li.lineItemTitle,
        variant_title:              li.variantTitle,
        quantity:                   li.quantity,
        shopify_fulfillment_status: li.fulfillmentStatus,
        pf_status:                  status,
        pf_status_rank:             STATUS_RANK[status] ?? 99,
        // The Georgia/Utah tag is now the authoritative origin signal — it's
        // what qualified the order for the queue in the first place. Only
        // photo-inspiration orders (no location tag, see below) fall back to
        // uuid_location_cache's staff-derived guess.
        origin_location:            li.originLocation ?? cache?.location ?? null,
        order_date:                 cache?.order_date ?? li.orderCreatedAt?.split('T')[0] ?? null,
        event_date:                 li.eventDate,
        blooms_process_type:        li.bloomsProcessType,
        synced_at:                  new Date().toISOString(),
        // Un-clear anything found again this run (e.g. a cancelled order that
        // got reinstated) — see the reconciliation step below for the other
        // direction.
        cleared_at:                 null,
      };
    });

    const { error: upsertError, data: upsertData } = await supabase
      .from('resin_queue')
      .upsert(rows, { onConflict: 'line_item_id' })
      .select('line_item_id');

    if (upsertError) throw new Error('Upsert failed: ' + JSON.stringify(upsertError));
    const insertedCount = upsertData?.length ?? 0;

    // ── Reconcile: clear out rows this sync no longer finds ───────────────────
    // Upsert alone only ever adds/refreshes rows — a line item that gets
    // fulfilled, cancelled, un-tagged, or edited into a new Shopify line item
    // id would otherwise sit in resin_queue forever, since nothing else ever
    // revisits it. This run's `rows` is the complete, authoritative set of
    // currently-open, Georgia/Utah-tagged (+ photo-inspiration) resin line
    // items — anything previously active but absent from it is stale.
    // Soft-delete (cleared_at) rather than a hard DELETE, so completed orders
    // stay available for future reporting; active-queue endpoints filter to
    // cleared_at IS NULL.
    const foundIds = new Set(rows.map(r => r.line_item_id));
    const activeIds: string[] = [];
    {
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data: page, error: pageError } = await supabase
          .from('resin_queue')
          .select('line_item_id')
          .is('cleared_at', null)
          .range(from, from + PAGE - 1);
        if (pageError) throw pageError;
        activeIds.push(...(page ?? []).map(r => r.line_item_id));
        if (!page || page.length < PAGE) break;
        from += PAGE;
      }
    }
    const staleIds = activeIds.filter(id => !foundIds.has(id));

    let clearedCount = 0;
    const CLEAR_BATCH = 200;
    for (let i = 0; i < staleIds.length; i += CLEAR_BATCH) {
      const batch = staleIds.slice(i, i + CLEAR_BATCH);
      const { error: clearError } = await supabase
        .from('resin_queue')
        .update({ cleared_at: new Date().toISOString() })
        .in('line_item_id', batch);
      if (clearError) {
        console.error('[resin-queue-sync] Failed to clear stale rows:', clearError);
      } else {
        clearedCount += batch.length;
      }
    }

    // ── Detect Georgia → Utah fulfillment transfers (read-only) ────────────────
    // The dashboard never moves or splits fulfillments in Shopify itself —
    // your team does that by hand once they've physically shipped a
    // Georgia-origin item to Utah. This just watches for that change: for
    // each Georgia-origin resin item not yet marked transferred, checks its
    // current fulfillment order's assigned location, and if Shopify now
    // shows it at Utah, stamps transferred_to_utah_at so the ops dashboard
    // can show "transferred to UT on <date>". Once set, never re-checked or
    // reverted — this only observes, never writes, to Shopify.
    const georgiaItems = resinLineItems.filter(li => li.originLocation === 'Georgia');
    const lineItemIds = georgiaItems.map(li => li.lineItemId);

    const { data: existingTrackingRows, error: trackingError } = lineItemIds.length
      ? await supabase
          .from('resin_queue')
          .select('line_item_id, transferred_to_utah_at')
          .in('line_item_id', lineItemIds)
      : { data: [] as { line_item_id: string; transferred_to_utah_at: string | null }[], error: null };
    if (trackingError) throw trackingError;

    const trackingByLineItem = new Map((existingTrackingRows ?? []).map(r => [r.line_item_id, r]));

    // Vercel serverless functions have a real time limit and each order here
    // costs a Shopify round trip — cap the work per run. What's left over is
    // picked up on the next scheduled/manual sync since "needs check" is
    // state-driven (transferred_to_utah_at), not one-shot.
    const FULFILLMENT_CHECK_LIMIT = 150;
    const needsCheck = georgiaItems.filter(li => !trackingByLineItem.get(li.lineItemId)?.transferred_to_utah_at);

    const byOrder = new Map<string, ResinLineItem[]>();
    for (const li of needsCheck.slice(0, FULFILLMENT_CHECK_LIMIT)) {
      const list = byOrder.get(li.shopifyOrderId) ?? [];
      list.push(li);
      byOrder.set(li.shopifyOrderId, list);
    }

    let transferCount = 0, fulfillmentErrors = 0;
    const patches: { lineItemId: string; transferred_to_utah_at: string }[] = [];
    const now = new Date().toISOString();

    for (const [orderId, items] of byOrder) {
      try {
        const { data: foData } = await shopifyFetch(`/orders/${orderId}/fulfillment_orders.json`);
        const fos = foData.fulfillment_orders as ShopifyFulfillmentOrder[] | undefined;

        for (const fo of (fos ?? [])) {
          if (fo.assigned_location_id !== UTAH_LOCATION_ID) continue;
          const matchingFOLineItems = (fo.line_items ?? []).filter(foLi =>
            items.some(li => li.lineItemId === String(foLi.line_item_id))
          );
          for (const foLi of matchingFOLineItems) {
            const id = String(foLi.line_item_id);
            if (!trackingByLineItem.get(id)?.transferred_to_utah_at) {
              patches.push({ lineItemId: id, transferred_to_utah_at: now });
              transferCount++;
            }
          }
        }
      } catch (err) {
        fulfillmentErrors++;
        console.error(`[resin-queue-sync] Transfer check failed for order ${orderId}:`, err);
      }
      await sleep(300); // stay well under Shopify's REST rate limit
    }

    for (const patch of patches) {
      const { error } = await supabase
        .from('resin_queue')
        .update({ transferred_to_utah_at: patch.transferred_to_utah_at })
        .eq('line_item_id', patch.lineItemId);
      if (error) console.error(`[resin-queue-sync] Failed to save transfer tracking for ${patch.lineItemId}:`, error);
    }

    return NextResponse.json({
      synced:        rows.length,
      inserted:      insertedCount,
      cleared:       clearedCount,
      ordersMatched: orderMap.size,
      ordersTotal:   orderNumbers.length,
      unmatched:     orderNumbers.length - orderMap.size,
      transfers: {
        ordersChecked:  byOrder.size,
        remainingQueue: Math.max(0, needsCheck.length - FULFILLMENT_CHECK_LIMIT),
        transferred:    transferCount,
        errors:         fulfillmentErrors,
      },
      supabaseUrl:   process.env.NEXT_PUBLIC_SUPABASE_URL,
    });

  } catch (err) {
    console.error('[resin-queue-sync] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

interface ResinLineItem {
  shopifyOrderId:     string;
  shopifyOrderNumber: string;
  lineItemId:         string;
  lineItemTitle:      string;
  variantTitle:       string | null;
  quantity:           number;
  fulfillmentStatus:  string | null;
  productId:          string;
  orderCreatedAt:     string;
  eventDate:          string | null;
  pipelineStatus:     string | null;
  // The Georgia/Utah tag that qualified this order for the queue. Unset for
  // photo-inspiration orders, which skip the location-tag gate entirely.
  originLocation?:    typeof LOCATION_TAGS[number];
  // See classifyBloomsProcess — 'recreate' bypasses the delivery wait,
  // 'send_own' still needs one, null means no Blooms Process item at all.
  bloomsProcessType:  'recreate' | 'send_own' | null;
}

interface ShopifyOrder {
  id:           number;
  order_number: number;
  created_at:   string;
  tags:         string;
  line_items:   ShopifyLineItem[];
}

interface ShopifyLineItem {
  id:                 number;
  title:              string;
  variant_title:      string | null;
  variant_id:         number;
  product_id:         number;
  quantity:           number;
  fulfillment_status: string | null;
  properties?:        { name: string; value: string }[];
}

interface ShopifyFulfillmentOrder {
  id:                  number;
  assigned_location_id: number;
  line_items:          { id: number; line_item_id: number; quantity: number }[];
}
