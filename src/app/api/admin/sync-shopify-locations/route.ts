import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { hasBearerSecret } from '@/lib/bearerSecret';

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const SHOPIFY_API = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01`;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function shopifyFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${SHOPIFY_API}${path}`, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!hasBearerSecret(auth, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Hardcoded Shopify location IDs (verified from admin UI)
  // "Pressed Floral shop" (Orem, UT) = 67995631786
  // "Pressed Floral Georgia" (Atlanta, GA) = 68727701674
  const utahLocation = { id: 67995631786, name: "Pressed Floral shop" };
  const georgiaLocation = { id: 68727701674, name: "Pressed Floral Georgia" };

  const locationIdMap: Record<string, number> = {
    Utah: utahLocation.id,
    Georgia: georgiaLocation.id,
  };

  // 2. Pull all resolved orders from uuid_location_cache
  const PIPELINE_STATUSES = [
    "bouquetReceived", "checkedOn", "inProgress", "almostReadyToFrame",
    "readyToFrame", "frameCompleted", "glued", "readyToSeal",
    "readyToPackage", "readyToFulfill", "preparingToShip",
    "approved", "disapproved"
  ];

  const { data: cacheRows, error: dbError } = await supabase
    .from("uuid_location_cache")
    .select("order_num, location")
    .in("location", ["Utah", "Georgia"])
    .in("status", PIPELINE_STATUSES);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // Dedupe to one row per order_num
  const orderMap = new Map<string, string>();
  for (const row of cacheRows ?? []) {
    if (row.order_num && row.location) {
      orderMap.set(row.order_num, row.location);
    }
  }

  const allOrders = Array.from(orderMap.entries());
  const totalOrders = allOrders.length;
  const searchParams = new URL(req.url).searchParams;
  const limit = 50;
  const offset = parseInt(searchParams.get("offset") ?? "0");
  const dryRun = searchParams.get("dryRun") === "true";
  const batch = allOrders.slice(offset, offset + limit);
  const nextOffset = offset + limit < totalOrders ? offset + limit : null;

  const results = { updated: 0, skipped: 0, errors: [] as string[], updatedOrders: [] as string[] };

  for (const [orderNum, location] of batch) {
    const targetLocationId = locationIdMap[location];

    try {
      const orderName = encodeURIComponent(`#${orderNum}`);
      const { orders } = await shopifyFetch(
        `/orders.json?name=${orderName}&status=any&fields=id,name`
      );

      if (!orders || orders.length === 0) {
        results.skipped++;
        continue;
      }

      const shopifyOrderId = orders[0].id;

      const { fulfillment_orders } = await shopifyFetch(
        `/orders/${shopifyOrderId}/fulfillment_orders.json`
      );

      if (!fulfillment_orders || fulfillment_orders.length === 0) {
        results.skipped++;
        continue;
      }

      for (const fo of fulfillment_orders) {
        if (fo.assigned_location_id === targetLocationId) {
          results.skipped++;
          continue;
        }

        if (!dryRun) {
          await shopifyFetch(`/fulfillment_orders/${fo.id}/move.json`, {
            method: "POST",
            body: JSON.stringify({
              fulfillment_order: {
                new_location_id: targetLocationId,
              },
            }),
          });
        }
        results.updated++;
        results.updatedOrders.push(orderNum);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.errors.push(`Order ${orderNum}: ${message}`);
    }
  }

  return NextResponse.json({
    dryRun,
    totalOrders,
    offset,
    limit,
    batchSize: batch.length,
    nextOffset,
    ...results,
  });
}
