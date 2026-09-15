import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { revalidateTag } from 'next/cache';
import { supabase } from '@/lib/supabase';
import { STATE_SALES_CACHE_TAG } from '@/app/api/distribution-estimate/route';

export const maxDuration = 300;

// Monthly: pulls the previous completed calendar month's orders from
// Shopify and upserts one row per non-cancelled US order into
// shopify_order_state_facts (state, date, revenue) — raw facts, not a
// pre-aggregated bucket, so the Growth & Distribution tab's seasonal
// reassignment planner (src/app/api/distribution-estimate/route.ts) can
// roll them up by week-of-year, month-of-year, or trailing window as
// needed, all from the same source of truth.
//
// ?month=YYYY-MM syncs one specific month. ?months=N backfills the last N
// completed months (used interactively to seed history — the cron itself
// only ever needs months=1).
//
// Known gap: an order cancelled after its month has already synced isn't
// retroactively removed (no periodic reconciliation pass) — acceptable for
// a seasonal-pattern estimate, not for financial reporting.

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN!;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN!;
const SHOPIFY_API    = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01`;

interface ShopifyOrder {
  id: number;
  created_at: string;
  cancelled_at: string | null;
  total_price: string;
  current_total_price: string | null;
  shipping_address: { province_code?: string; country_code?: string } | null;
}

async function fetchOrders(createdAtMin: string, createdAtMax: string): Promise<ShopifyOrder[]> {
  const orders: ShopifyOrder[] = [];
  let pageUrl: string | null =
    `/orders.json?status=any&fields=id,created_at,cancelled_at,total_price,current_total_price,shipping_address` +
    `&limit=250&created_at_min=${createdAtMin}&created_at_max=${createdAtMax}`;

  while (pageUrl) {
    const res: Response = await fetch(`${SHOPIFY_API}${pageUrl}`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`Shopify orders fetch failed: ${res.status}`);
    const data = await res.json();
    orders.push(...(data.orders ?? []));

    const linkHeader = res.headers.get('link') ?? '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      const nextUrl = new URL(nextMatch[1]);
      pageUrl = nextUrl.pathname.replace('/admin/api/2024-01', '') + nextUrl.search;
    } else {
      pageUrl = null;
    }
  }
  return orders;
}

// monthStr = 'YYYY-MM' -> [inclusive start ISO, exclusive-ish end ISO (start of next month)]
function monthBounds(monthStr: string): { start: string; end: string } {
  const [y, m] = monthStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function monthsAgo(n: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function syncMonth(monthStr: string): Promise<{ rows: number; orders: number }> {
  const { start, end } = monthBounds(monthStr);
  const orders = await fetchOrders(start, end);

  const rows = orders
    .filter(o => !o.cancelled_at && o.shipping_address?.province_code && o.shipping_address?.country_code === 'US')
    .map(o => ({
      order_id:   o.id,
      state_code: o.shipping_address!.province_code!,
      order_date: o.created_at.slice(0, 10),
      revenue:    Math.round((parseFloat(o.current_total_price ?? o.total_price ?? '0') || 0) * 100) / 100,
      synced_at:  new Date().toISOString(),
    }));

  // Chunked — a full month can be a couple thousand rows, comfortably under
  // Postgres' parameter limits per statement either way, but chunking keeps
  // each upsert call small and predictable.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('shopify_order_state_facts').upsert(rows.slice(i, i + 500), { onConflict: 'order_id' });
    if (error) throw error;
  }

  return { rows: rows.length, orders: orders.length };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const singleMonth = req.nextUrl.searchParams.get('month');
  const monthsParam = req.nextUrl.searchParams.get('months');

  const targets: string[] = singleMonth
    ? [singleMonth]
    : Array.from({ length: Math.min(48, Math.max(1, parseInt(monthsParam ?? '1', 10) || 1)) }, (_, i) => monthsAgo(i + 1));

  try {
    const synced: Record<string, { rows: number; orders: number }> = {};
    for (const monthStr of targets) {
      synced[monthStr] = await syncMonth(monthStr);
    }
    revalidateTag(STATE_SALES_CACHE_TAG, { expire: 0 }); // so the seasonal estimate reflects this sync immediately, not after an hour
    return NextResponse.json({ ok: true, synced });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
