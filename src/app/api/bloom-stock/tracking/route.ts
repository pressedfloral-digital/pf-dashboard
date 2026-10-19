import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { isoMondayFromDate } from '@/lib/weekDates';
import { BLOOM_STOCK_STATUSES, productByShopifyId, SWITCHABLE_PRODUCT_IDS } from '@/lib/bloomStock';
import { shopifyGraphql } from '@/lib/shopifyGraphql';

// Orders board edits for Bloom Stock Products (replaces the team's tracking
// sheet). One row per Shopify line item in bloom_stock_order_tracking.
//
// POST { lineItemId, orderId, orderName, productKey, units, status?, type?, assignee?, notes? }
// POST { addOrderNumber } — put an order on the board by hand, e.g. a Pressed
//      Frame order switched to a recreation. Uses its bloom-stock line items,
//      else its open frame/ornament line items tracked as a recreation.
//
// Setting status 'finished' also logs the line item in
// bloom_stock_completions for this week under the assignee, so it counts in
// Historicals / CPO the same as an order number typed there.

const STATUSES = new Set(BLOOM_STOCK_STATUSES.map(s => s.key));
const TYPES = new Set(['recreation', 'standard', 'rainbow']);

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const raw = await req.json() as Record<string, unknown>;
  if (typeof raw.addOrderNumber === 'string') return addOrder(raw.addOrderNumber, userId);

  const b = raw as {
    lineItemId: string; orderId: string; orderName: string; productKey: string; units: number;
    status?: string; type?: string | null; assignee?: string | null; notes?: string | null;
  };
  if (!b.lineItemId || !b.orderId || !b.orderName || !b.productKey) {
    return NextResponse.json({ error: 'lineItemId, orderId, orderName and productKey required' }, { status: 400 });
  }
  if (b.status !== undefined && !STATUSES.has(b.status as never)) return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
  if (b.type != null && !TYPES.has(b.type)) return NextResponse.json({ error: 'Unknown type' }, { status: 400 });

  try {
    const { data: existing, error: exErr } = await supabase
      .from('bloom_stock_order_tracking').select('*').eq('line_item_id', b.lineItemId).maybeSingle();
    if (exErr) throw exErr;

    const row = {
      line_item_id: b.lineItemId,
      order_id:     b.orderId,
      order_name:   b.orderName,
      product_key:  b.productKey,
      status:       b.status ?? existing?.status ?? 'new',
      type:         b.type !== undefined ? b.type : existing?.type ?? null,
      assignee:     b.assignee !== undefined ? (b.assignee || null) : existing?.assignee ?? null,
      notes:        b.notes !== undefined ? (b.notes || null) : existing?.notes ?? null,
      updated_by:   userId,
      updated_at:   new Date().toISOString(),
    };
    const { error } = await supabase.from('bloom_stock_order_tracking').upsert(row, { onConflict: 'line_item_id' });
    if (error) throw error;

    if (row.status === 'finished' && existing?.status !== 'finished') {
      const weekOf = isoMondayFromDate(new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date()) + 'T12:00:00'));
      const { error: compErr } = await supabase.from('bloom_stock_completions').upsert({
        location: 'Utah', week_of: weekOf, member_name: row.assignee ?? 'Unassigned',
        order_name: b.orderName, order_id: b.orderId, line_item_id: b.lineItemId,
        product_key: b.productKey, units: Math.max(1, Number(b.units) || 1), created_by: userId,
      }, { onConflict: 'line_item_id', ignoreDuplicates: true });
      if (compErr) throw compErr;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[bloom-stock/tracking] Error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

const ORDER_BY_NAME = `
query BloomStockAddOrder($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      legacyResourceId name
      lineItems(first: 100) { nodes { id unfulfilledQuantity product { legacyResourceId } } }
    }
  }
}`;

async function addOrder(input: string, userId: string) {
  const num = input.trim().replace(/^#/, '');
  if (!/^\d+$/.test(num)) return NextResponse.json({ error: 'Enter an order number like 41234' }, { status: 400 });
  const orderName = `#${num}`;
  try {
    const data = await shopifyGraphql<{ orders: { nodes: {
      legacyResourceId: string; name: string;
      lineItems: { nodes: { id: string; unfulfilledQuantity: number; product: { legacyResourceId: string } | null }[] };
    }[] } }>(ORDER_BY_NAME, { q: `name:${orderName}` });
    const order = data.orders.nodes.find(o => o.name === orderName);
    if (!order) return NextResponse.json({ error: `Order ${orderName} not found in Shopify` }, { status: 404 });

    const open = order.lineItems.nodes.filter(li => li.unfulfilledQuantity > 0 && li.product);
    const bloom = open.filter(li => productByShopifyId.has(li.product!.legacyResourceId));
    const picked = bloom.length > 0
      ? bloom.map(li => ({ li, key: productByShopifyId.get(li.product!.legacyResourceId)!.key, switched: false }))
      : open.filter(li => SWITCHABLE_PRODUCT_IDS.has(li.product!.legacyResourceId)).map(li => ({ li, key: 'recreation', switched: true }));
    if (picked.length === 0) {
      return NextResponse.json({ error: `${orderName} has no open frame, ornament or bloom-stock item to track` }, { status: 400 });
    }
    const { error } = await supabase.from('bloom_stock_order_tracking').upsert(picked.map(({ li, key, switched }) => ({
      line_item_id: li.id.split('/').pop()!, order_id: order.legacyResourceId, order_name: order.name,
      product_key: key, status: 'new', type: switched ? 'recreation' : null,
      notes: switched ? 'Switched to recreation' : null,
      updated_by: userId, updated_at: new Date().toISOString(),
    })), { onConflict: 'line_item_id', ignoreDuplicates: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, added: picked.length });
  } catch (e) {
    console.error('[bloom-stock/tracking] add order error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
