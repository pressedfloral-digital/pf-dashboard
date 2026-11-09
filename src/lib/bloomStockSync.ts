import { supabase } from '@/lib/supabase';
import { shopifyGraphql } from '@/lib/shopifyGraphql';
import { fetchBloomStockDesignRows, normalizeAssignmentStaffName } from '@/lib/assignment-counts';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import {
  AUTO_SYNC_CREATED_BY, DEFAULT_BLOOM_STOCK_ROSTER, planBloomStockSync, productByShopifyId,
  type BloomStockExistingCompletion, type BloomStockShopifyOrder,
} from '@/lib/bloomStock';

// Fills Bloom Stock Historicals from the PF app, counted the way Design's
// actuals are (see fetchBloomStockDesignRows). Runs with the weekly
// sync-production-actuals cron. Rows land in bloom_stock_completions, so
// finished units come off the Bloom Stock queue like a logged order does.

const LOCATION = 'Utah';

const ORDER_BY_NAME = `
query BloomStockSyncOrder($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      legacyResourceId
      name
      lineItems(first: 100) {
        nodes { id currentQuantity product { legacyResourceId } }
      }
    }
  }
}`;

interface OrderNode {
  legacyResourceId: string;
  name: string;
  lineItems: { nodes: { id: string; currentQuantity: number; product: { legacyResourceId: string } | null }[] };
}

async function fetchShopifyOrder(orderName: string): Promise<BloomStockShopifyOrder | null> {
  const data = await shopifyGraphql<{ orders: { nodes: OrderNode[] } }>(ORDER_BY_NAME, { q: `name:${orderName}` });
  const order = data.orders.nodes.find(o => o.name === orderName);
  if (!order) return null;
  return {
    orderId: order.legacyResourceId,
    orderName: order.name,
    lines: order.lineItems.nodes.flatMap(li => {
      const product = li.product ? productByShopifyId.get(li.product.legacyResourceId) : undefined;
      return product ? [{ lineItemId: li.id.split('/').pop()!, productKey: product.key, quantity: li.currentQuantity }] : [];
    }),
  };
}

// The Bloom Stock roster's spelling comes first, so credits line up with the
// hours on that person's Historicals row. Design's roster is included because
// any Utah designer can finish one of these, and that week's Design actuals
// because older weeks include people no longer on either roster.
async function namesForWeek(weekOf: string): Promise<string[]> {
  const [{ data, error }, designActuals] = await Promise.all([
    supabase
      .from('schedule_settings')
      .select('key, value')
      .eq('location', LOCATION)
      .in('key', ['bloomStockRoster', 'designRoster']),
    supabase
      .from('team_member_week_actuals')
      .select('member_name')
      .eq('location', LOCATION).eq('department', 'design').eq('week_of', weekOf).gt('actual_orders', 0),
  ]);
  if (error) throw error;
  if (designActuals.error) throw designActuals.error;
  type Member = { name?: string; _removed?: boolean };
  const membersOf = (key: string) => {
    const value = data?.find(r => r.key === key)?.value as Record<string, Member> | Member[] | null | undefined;
    return value ? Object.values(value) : [];
  };
  const bloom = membersOf('bloomStockRoster');
  const members = [
    ...(bloom.length ? bloom : DEFAULT_BLOOM_STOCK_ROSTER),
    ...membersOf('designRoster'),
    ...(designActuals.data ?? []).map(r => ({ name: r.member_name })),
  ];
  const byNormalized = new Map<string, string>();
  for (const m of members as Member[]) {
    const name = m.name?.trim();
    if (!name || m._removed || isNonProductionStaff(name)) continue;
    const key = normalizeAssignmentStaffName(name);
    if (!byNormalized.has(key)) byNormalized.set(key, name);
  }
  return [...byNormalized.values()];
}

/** Any lookup failure throws before anything is written: missing data is never zero. */
export async function syncBloomStockWeek(weekOf: string, dryRun: boolean) {
  const end = new Date(`${weekOf}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const weekEnd = end.toISOString().slice(0, 10);

  const { rows, resolved, unmatched: unmatchedStaff } = await fetchBloomStockDesignRows(await namesForWeek(weekOf), weekOf, weekEnd);

  const orderNames = [...new Set(rows.map(r => r.orderName))];
  const orders: BloomStockShopifyOrder[] = [];
  for (let i = 0; i < orderNames.length; i += 5) {
    const found = await Promise.all(orderNames.slice(i, i + 5).map(fetchShopifyOrder));
    orders.push(...found.filter(o => o !== null));
  }

  const lineIds = orders.flatMap(o => o.lines.map(l => l.lineItemId));
  const columns = 'id, line_item_id, week_of, member_name, units, created_by';
  const [byLine, autoThisWeek] = await Promise.all([
    lineIds.length
      ? supabase.from('bloom_stock_completions').select(columns).in('line_item_id', lineIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('bloom_stock_completions').select(columns)
      .eq('location', LOCATION).eq('week_of', weekOf).eq('created_by', AUTO_SYNC_CREATED_BY),
  ]);
  if (byLine.error) throw byLine.error;
  if (autoThisWeek.error) throw autoThisWeek.error;
  const existing = [...new Map(
    [...(byLine.data ?? []), ...(autoThisWeek.data ?? [])].map(e => [e.line_item_id, e as BloomStockExistingCompletion]),
  ).values()];

  const plan = planBloomStockSync({ weekOf, rows, orders, existing, resolvedMembers: resolved });

  if (!dryRun) {
    if (plan.deleteIds.length) {
      const { error } = await supabase.from('bloom_stock_completions').delete().in('id', plan.deleteIds);
      if (error) throw error;
    }
    if (plan.writes.length) {
      const { error } = await supabase.from('bloom_stock_completions').upsert(
        plan.writes.map(w => ({ ...w, location: LOCATION, created_by: AUTO_SYNC_CREATED_BY })),
        { onConflict: 'line_item_id' },
      );
      if (error) throw error;
    }
  }

  const byMember: Record<string, number> = {};
  for (const r of rows) byMember[r.member] = (byMember[r.member] ?? 0) + 1;
  return {
    weekOf,
    weekEnd,
    designRows: rows.length,
    byMember,
    written: plan.writes.length,
    removed: plan.deleteIds.length,
    alreadyLogged: plan.alreadyLogged,
    unmatchedRows: plan.unmatched,
    unmatchedStaff,
  };
}
