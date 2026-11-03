import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { shopifyGraphql, utahDate } from '@/lib/shopifyGraphql';
import { isoMondayFromDate } from '@/lib/weekDates';
import {
  BLOOM_STOCK_PRODUCTS, productByShopifyId, emptyByProduct, SEND_OWN_VARIANT_IDS, RECREATE_VARIANT_IDS,
  type BloomStockProductKey, type BloomStockQueueItem, type BloomStockQueueResponse,
  type BloomStockStatus, type BloomStockType,
} from '@/lib/bloomStock';

// Live read of the bloom-stock queue from Shopify. Shopify's order search can
// filter by product_id, so the whole open set is only a few hundred line
// items (~3 GraphQL pages) — read on demand instead of synced into a table.
// The raw Shopify read is cached briefly so tab switches don't each cost a
// multi-second round trip (?refresh=true bypasses); logged completions are
// applied fresh on every request so a logged order drops out immediately.

const CACHE_MS = 10 * 60 * 1000;
// Two years of weekly order history feeds the seasonal forecast
// (same week last year needs ~64 weeks; the rest smooths the growth rate).
const INTAKE_LOOKBACK_WEEKS = 110;

type RawItem = Omit<BloomStockQueueItem, 'status' | 'assignee' | 'notes' | 'assumedDone' | 'sorted'> & { beforeCutoff: boolean; influencer: boolean };
interface RawLine { item: RawItem; unfulfilled: number }
interface RawData {
  lines:       RawLine[];
  intakeByWeek: BloomStockQueueResponse['intakeByWeek'];
  switchedByWeek: BloomStockQueueResponse['switchedByWeek'];
  fetchedAt:   string;
}
let cache: { at: number; data: RawData } | null = null;

const ORDER_FIELDS = `
      legacyResourceId
      name
      createdAt
      cancelledAt
      tags
      customer { displayName }
      lineItems(first: 100) {
        nodes {
          id
          variantTitle
          variant { legacyResourceId }
          currentQuantity
          unfulfilledQuantity
          product { legacyResourceId }
          customAttributes { key value }
        }
      }
`;

const ORDERS_QUERY = `
query BloomStockOrders($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {${ORDER_FIELDS}    }
  }
}`;

// Orders the team added to the board by hand (e.g. a Pressed Frame order
// switched to a recreation) don't match the product search — fetched by id.
const ORDERS_BY_ID = `
query BloomStockOrdersById($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order {${ORDER_FIELDS}  } }
}`;

interface OrderNode {
  legacyResourceId: string;
  name:        string;
  createdAt:   string;
  cancelledAt: string | null;
  tags:        string[];
  customer:    { displayName: string } | null;
  lineItems: { nodes: {
    id:                  string;
    variantTitle:        string | null;
    variant:             { legacyResourceId: string } | null;
    currentQuantity:     number;
    unfulfilledQuantity: number;
    product:             { legacyResourceId: string } | null;
    customAttributes:    { key: string; value: string | null }[];
  }[] };
}

async function fetchOrders(q: string): Promise<OrderNode[]> {
  const out: OrderNode[] = [];
  let after: string | null = null;
  do {
    const data: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: OrderNode[] } } =
      await shopifyGraphql(ORDERS_QUERY, { q, after });
    out.push(...data.orders.nodes);
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// Same event-date conventions as resin-queue-sync: a plain YYYY-MM-DD order
// tag, else an "Event date" line-item property from the frame bundle app.
function findEventDate(order: OrderNode): string | null {
  const tag = order.tags.find(t => /^\d{4}-\d{2}-\d{2}$/.test(t.trim()));
  if (tag) return tag.trim();
  for (const li of order.lineItems.nodes) {
    for (const a of li.customAttributes) {
      const v = (a.value ?? '').trim();
      if (a.key.trim().toLowerCase() === 'event date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    }
  }
  return null;
}

async function loadRaw(): Promise<RawData> {
  const productFilter = `(${BLOOM_STOCK_PRODUCTS.map(p => `product_id:${p.productId}`).join(' OR ')})`;
  const since = new Date();
  since.setDate(since.getDate() - INTAKE_LOOKBACK_WEEKS * 7 - 7);
  const sinceIso = isoMondayFromDate(since);

  const [openOrders, recentOrders] = await Promise.all([
    // Order-level filter narrows the search; the line-item check below is
    // what decides membership (a partially-fulfilled order can have this
    // product already shipped while something else on it is still open).
    fetchOrders(`${productFilter} AND status:open AND (fulfillment_status:unshipped OR fulfillment_status:partial)`),
    fetchOrders(`${productFilter} AND created_at:>=${sinceIso}`),
  ]);

  const lines: RawLine[] = [];
  // productFor decides which of the order's line items belong on the board
  // and as which product (null = skip).
  const addOrder = (order: OrderNode, productFor: (li: OrderNode['lineItems']['nodes'][number]) => (typeof BLOOM_STOCK_PRODUCTS)[number] | undefined) => {
    const location = order.tags.includes('Utah') ? 'Utah' : order.tags.includes('Georgia') ? 'Georgia' : null;
    const eventDate = findEventDate(order);
    const orderDate = utahDate(order.createdAt);
    // Order-level Blooms Process choice: send own → standard, customize /
    // recreate from photo → recreation.
    const variantIds = order.lineItems.nodes.map(li => li.variant?.legacyResourceId ?? '');
    const type: BloomStockType | null = variantIds.some(v => SEND_OWN_VARIANT_IDS.has(v)) ? 'standard'
      : variantIds.some(v => RECREATE_VARIANT_IDS.has(v)) ? 'recreation' : null;
    for (const li of order.lineItems.nodes) {
      const product = productFor(li);
      if (!product || li.unfulfilledQuantity <= 0) continue;
      lines.push({
        unfulfilled: li.unfulfilledQuantity,
        item: {
          lineItemId:   li.id.split('/').pop()!,
          orderId:      order.legacyResourceId,
          orderNumber:  order.name,
          orderDate,
          productKey:   product.key,
          variantTitle: li.variantTitle,
          quantity:     li.unfulfilledQuantity,
          location,
          eventDate,
          customer: order.customer?.displayName?.trim() || null,
          type,
          beforeCutoff: !!product.assumeFulfilledBefore && orderDate < product.assumeFulfilledBefore,
          influencer: /influencer/i.test(`${order.customer?.displayName ?? ''} ${order.tags.join(' ')}`),
        },
      });
    }
  };
  for (const order of openOrders) {
    addOrder(order, li => (li.product ? productByShopifyId.get(li.product.legacyResourceId) : undefined));
  }

  // Hand-added line items still being tracked (not finished) that the
  // product search didn't find.
  const found = new Set(lines.map(l => l.item.lineItemId));
  const { data: tracked, error: trackedErr } = await supabase
    .from('bloom_stock_order_tracking')
    .select('line_item_id, order_id, product_key')
    .neq('status', 'finished');
  if (trackedErr) throw trackedErr;
  const extra = (tracked ?? []).filter(t => !found.has(t.line_item_id));
  const extraByLine = new Map(extra.map(t => [t.line_item_id, BLOOM_STOCK_PRODUCTS.find(p => p.key === t.product_key)]));
  const orderIds = [...new Set(extra.map(t => t.order_id))];
  for (let i = 0; i < orderIds.length; i += 50) {
    const data = await shopifyGraphql<{ nodes: (OrderNode | null)[] }>(ORDERS_BY_ID,
      { ids: orderIds.slice(i, i + 50).map(id => `gid://shopify/Order/${id}`) });
    for (const order of data.nodes) {
      if (!order || order.cancelledAt) continue;
      // Hand-added items skip the before-June assumption: someone chose to track them.
      addOrder(order, li => extraByLine.get(li.id.split('/').pop()!));
    }
  }
  for (const l of lines) if (extraByLine.has(l.item.lineItemId)) l.item.beforeCutoff = false;

  const intake = new Map<string, Record<BloomStockProductKey, number>>();
  for (const order of recentOrders) {
    if (order.cancelledAt) continue;
    const wk = isoMondayFromDate(new Date(utahDate(order.createdAt) + 'T12:00:00'));
    for (const li of order.lineItems.nodes) {
      const product = li.product ? productByShopifyId.get(li.product.legacyResourceId) : undefined;
      if (!product || li.currentQuantity <= 0) continue;
      const row = intake.get(wk) ?? emptyByProduct();
      row[product.key] += li.currentQuantity;
      intake.set(wk, row);
    }
  }
  // Recreations sold as a Pressed Frame etc. and switched later (tracked on
  // the board, any status) never match the product search — count them in
  // the history too, by their original order week.
  const { data: allTracked, error: allTrackedErr } = await supabase
    .from('bloom_stock_order_tracking')
    .select('line_item_id, order_id, product_key');
  if (allTrackedErr) throw allTrackedErr;
  const searched = new Set<string>();
  for (const o of recentOrders) for (const li of o.lineItems.nodes) {
    if (li.product && productByShopifyId.has(li.product.legacyResourceId)) searched.add(li.id.split('/').pop()!);
  }
  const switched = (allTracked ?? []).filter(t => !searched.has(t.line_item_id));
  const switchedKey = new Map(switched.map(t => [t.line_item_id, t.product_key as BloomStockProductKey]));
  const switchedOrders = [...new Set(switched.map(t => t.order_id))];
  // Kept apart from `intake`: only switched orders the team has put on the
  // board are known (mostly this year's), so mixing them in would inflate
  // the year-over-year growth rate.
  const switchedIntake = new Map<string, number>();
  for (let i = 0; i < switchedOrders.length; i += 50) {
    const data = await shopifyGraphql<{ nodes: (OrderNode | null)[] }>(ORDERS_BY_ID,
      { ids: switchedOrders.slice(i, i + 50).map(id => `gid://shopify/Order/${id}`) });
    for (const order of data.nodes) {
      if (!order || order.cancelledAt) continue;
      const day = utahDate(order.createdAt);
      if (day < sinceIso) continue;
      const wk = isoMondayFromDate(new Date(day + 'T12:00:00'));
      for (const li of order.lineItems.nodes) {
        const key = switchedKey.get(li.id.split('/').pop()!);
        if (!key || li.currentQuantity <= 0) continue;
        switchedIntake.set(wk, (switchedIntake.get(wk) ?? 0) + li.currentQuantity);
      }
    }
  }

  const intakeByWeek = [...intake.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekOf, byProduct]) => ({ weekOf, byProduct }));

  const switchedByWeek = [...switchedIntake.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekOf, units]) => ({ weekOf, units }));
  return { lines, intakeByWeek, switchedByWeek, fetchedAt: new Date().toISOString() };
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const refresh = req.nextUrl.searchParams.get('refresh') === 'true';
    if (refresh || !cache || Date.now() - cache.at >= CACHE_MS) {
      cache = { at: Date.now(), data: await loadRaw() };
    }
    const raw = cache.data;

    // Units team members have logged complete in Historicals come off the
    // queue now, even though Shopify won't show them fulfilled until
    // fulfillment ships them.
    const ids = raw.lines.map(l => l.item.lineItemId);
    const done = new Map<string, number>();
    const tracking = new Map<string, { status: BloomStockStatus; type: BloomStockType | null; assignee: string | null; notes: string | null }>();
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const [comp, track] = await Promise.all([
        supabase.from('bloom_stock_completions').select('line_item_id, units').in('line_item_id', batch),
        supabase.from('bloom_stock_order_tracking').select('line_item_id, status, type, assignee, notes').in('line_item_id', batch),
      ]);
      if (comp.error) throw comp.error;
      if (track.error) throw track.error;
      for (const r of comp.data ?? []) done.set(r.line_item_id, (done.get(r.line_item_id) ?? 0) + Number(r.units));
      for (const r of track.data ?? []) tracking.set(r.line_item_id, r);
    }

    const items: BloomStockQueueItem[] = raw.lines
      .map(({ item: { beforeCutoff, influencer, ...item }, unfulfilled }) => {
        const t = tracking.get(item.lineItemId);
        const type = t?.type ?? item.type;
        return {
          ...item,
          type,
          quantity: Math.max(0, unfulfilled - (done.get(item.lineItemId) ?? 0)),
          // Until the team sets one: influencer orders (by name/tag) start in
          // Influencer, customer-supplied blooms in Waiting, the rest in New.
          status:   t?.status ?? (influencer ? 'influencer' : type === 'standard' ? 'waiting' : 'new'),
          assignee: t?.assignee ?? null,
          notes:    t?.notes ?? null,
          assumedDone: beforeCutoff && !t,
          sorted:      !!t,
        };
      })
      .filter(i => i.quantity > 0 && i.status !== 'finished')
      .sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.orderNumber.localeCompare(b.orderNumber));

    const body: BloomStockQueueResponse = {
      items,
      intakeByWeek: raw.intakeByWeek,
      switchedByWeek: raw.switchedByWeek,
      fetchedAt:    raw.fetchedAt,
      storeDomain:  process.env.SHOPIFY_STORE_DOMAIN ?? '',
    };
    return NextResponse.json(body);
  } catch (err) {
    console.error('[bloom-stock/queue] Error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
