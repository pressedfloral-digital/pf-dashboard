import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfPost, pfGetAll, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import { hasBearerSecret } from '@/lib/bearerSecret';

export const maxDuration = 300;

const PIPELINE_STATUSES = new Set([
  'bouquetReceived', 'checkedOn', 'progress', 'almostReadyToFrame',
  'readyToFrame', 'frameCompleted', 'disapproved', 'approved', 'noResponse',
  'readyToSeal', 'glued', 'readyToPackage', 'readyToFulfill', 'preparingToBeShipped',
]);

interface SearchItem {
  uuid:                        string;
  shopifyOrderNumber:          string;
  status:                      string;
  orderDate?:                  string;
  assignedToUserFirstName?:    string | null;
  assignedToUserLastName?:     string | null;
  preservationUserFirstName?:  string | null;
  preservationUserLastName?:   string | null;
  fulfillmentUserFirstName?:   string | null;
  fulfillmentUserLastName?:    string | null;
}

interface SearchResponse {
  totalItems:  number;
  totalPages:  number;
  items:       SearchItem[];
}

interface WeeklyReportItem {
  orderNumber?:        string | number;
  shopifyOrderNumber?: string | number;
  location?:           string | null;
  status?:             string | null;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronOk = hasBearerSecret(authHeader, process.env.CRON_SECRET);
  if (!cronOk) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runSync();
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronOk = hasBearerSecret(authHeader, process.env.CRON_SECRET);
  if (!cronOk) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return runSync();
}

async function runSync() {
  try {
    // ── Step 1: Load staff → location map ────────────────────────────────────
    const { data: staffRows } = await supabase
      .from('staff_locations')
      .select('name, location');

    const staffLocationMap: Record<string, string> = {};
    staffRows?.forEach(r => { staffLocationMap[r.name.trim()] = r.location; });

    // ── Step 2: WeeklyReport scan — location source for ALL orders ────────────
    // Covers both PF-assigned and unassigned orders in the last 12 months.
    const today = new Date();
    const weeklyPaths: string[] = [];
    for (let m = 0; m < 12; m++) {
      const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
      weeklyPaths.push(
        `/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}&pageSize=1000`
      );
    }

    const wrOrderLocation = new Map<string, string>(); // orderNum → location
    const wrAllOrderNums  = new Set<string>();

    for (let i = 0; i < weeklyPaths.length; i += 6) {
      const results = await pfGetAll<WeeklyReportItem[]>(weeklyPaths.slice(i, i + 6));
      results.forEach(items => {
        if (!items) return;
        items.forEach(item => {
          const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '').trim();
          if (!num) return;
          if (item.status && !PIPELINE_STATUSES.has(item.status)) return;
          wrAllOrderNums.add(num);
          // Store location for ALL orders — first non-blank value wins
          if (item.location && !wrOrderLocation.has(num)) {
            wrOrderLocation.set(num, item.location);
          }
        });
      });
    }

    console.log(`WeeklyReport: ${wrAllOrderNums.size} order nums, ${wrOrderLocation.size} with location`);

    // ── Step 3: order_location_cache — bouquet upload fallback ───────────────
    // resolve-locations writes here after fetching Details + checking bouquet uploader.
    // Used for orders where WeeklyReport has no location and staff lookup fails.
    const { data: olcRows } = await supabase
      .from('order_location_cache')
      .select('order_num, location');

    const olcOrderLocation = new Map<string, string>();
    olcRows?.forEach(r => {
      if (r.location && !olcOrderLocation.has(r.order_num)) {
        olcOrderLocation.set(r.order_num, r.location);
      }
    });

    console.log(`order_location_cache: ${olcOrderLocation.size} orders with location`);

    // ── Step 4: Bulk Search scan — collect all pipeline UUIDs ────────────────
    const PAGE_SIZE = 50;
    let pageNumber = 1;
    let totalPages = 1;

    const pipelineItems    = new Map<string, SearchItem>();
    const orderNumToUuids  = new Map<string, Set<string>>();

    console.log('Starting bulk Search scan...');
    while (pageNumber <= totalPages) {
      const res = await pfPost<SearchResponse>('/OrderProducts/Search', {
        searchTerm: ' ',
        pageSize:   PAGE_SIZE,
        pageNumber,
        workflowFamily: 'frames',
      });

      if (!res.items || res.items.length === 0) break;
      totalPages = res.totalPages;

      res.items.forEach(item => {
        if (!PIPELINE_STATUSES.has(item.status)) return;
        if (!item.uuid || !item.shopifyOrderNumber) return;

        pipelineItems.set(item.uuid, item);

        const orderNum = String(item.shopifyOrderNumber);
        if (!orderNumToUuids.has(orderNum)) orderNumToUuids.set(orderNum, new Set());
        orderNumToUuids.get(orderNum)!.add(item.uuid);
      });

      pageNumber++;
    }

    console.log(`Bulk Search: ${pipelineItems.size} UUIDs, ${orderNumToUuids.size} unique orders`);

    // ── Step 5: Individually fetch orders WeeklyReport knows but Search missed ─
    const missingOrderNums = [...wrAllOrderNums].filter(num => !orderNumToUuids.has(num));
    console.log(`Missing from bulk Search: ${missingOrderNums.length}`);

    const INDIVIDUAL_BATCH = 10;
    let individuallyFetched = 0;

    for (let i = 0; i < missingOrderNums.length; i += INDIVIDUAL_BATCH) {
      const batch = missingOrderNums.slice(i, i + INDIVIDUAL_BATCH);
      const results = await Promise.all(
        batch.map(orderNum =>
          pfPost<SearchResponse>('/OrderProducts/Search', {
            searchTerm: orderNum,
            pageNumber: 1,
            pageSize:   10,
            workflowFamily: 'frames',
          }).catch(() => null)
        )
      );

      results.forEach((res, j) => {
        if (!res?.items) return;
        const orderNum = batch[j];
        res.items.forEach(item => {
          if (!PIPELINE_STATUSES.has(item.status)) return;
          if (!item.uuid) return;
          if (String(item.shopifyOrderNumber) !== orderNum) return;
          pipelineItems.set(item.uuid, item);
          if (!orderNumToUuids.has(orderNum)) orderNumToUuids.set(orderNum, new Set());
          orderNumToUuids.get(orderNum)!.add(item.uuid);
          individuallyFetched++;
        });
      });
    }

    console.log(`Individually fetched ${individuallyFetched} UUIDs`);
    console.log(`Total pipeline UUIDs: ${pipelineItems.size}`);

    // ── Step 6: Stub rows for orders still not in Search ─────────────────────
    let stubsCreated = 0;
    for (const orderNum of missingOrderNums) {
      if (orderNumToUuids.has(orderNum)) continue;
      const syntheticUuid = `stub-${orderNum}`;
      pipelineItems.set(syntheticUuid, {
        uuid:               syntheticUuid,
        shopifyOrderNumber: orderNum,
        status:             'unknown',
        orderDate:          undefined,
      });
      orderNumToUuids.set(orderNum, new Set([syntheticUuid]));
      stubsCreated++;
    }

    if (pipelineItems.size === 0) {
      return NextResponse.json({ synced: 0, message: 'No pipeline items found' });
    }

    // ── Step 7: Resolve location for each UUID ────────────────────────────────
    // Priority 1: WeeklyReport (covers PF-assigned Utah/Georgia + recent orders)
    // Priority 2: Staff lookup from Search API fields
    // Priority 3: order_location_cache (bouquet upload method)
    const rows: {
      uuid:       string;
      order_num:  string;
      status:     string;
      location:   string | null;
      staff_name: string | null;
      order_date: string | null;
      synced_at:  string;
    }[] = [];

    const now = new Date().toISOString();

    for (const [uuid, item] of pipelineItems) {
      const orderNum = String(item.shopifyOrderNumber);
      let location:  string | null = null;
      let staffName: string | null = null;

      // Priority 1: WeeklyReport
      const wrLocation = wrOrderLocation.get(orderNum);
      if (wrLocation) {
        location = wrLocation;
      } else {
        // Priority 2: staff lookup
        const staffCandidates = [
          [item.preservationUserFirstName, item.preservationUserLastName],
          [item.assignedToUserFirstName,   item.assignedToUserLastName],
          [item.fulfillmentUserFirstName,  item.fulfillmentUserLastName],
        ];
        for (const [first, last] of staffCandidates) {
          const name = [first, last].filter(Boolean).join(' ').trim();
          if (name && staffLocationMap[name]) {
            location  = staffLocationMap[name];
            staffName = name;
            break;
          }
        }

        // Priority 3: bouquet upload cache
        if (!location) {
          const olcLocation = olcOrderLocation.get(orderNum);
          if (olcLocation) location = olcLocation;
        }
      }

      rows.push({
        uuid,
        order_num:  orderNum,
        status:     item.status,
        location,
        staff_name: staffName,
        order_date: item.orderDate?.split('T')[0] ?? null,
        synced_at:  now,
      });
    }

    // ── Step 8: Upsert all rows ───────────────────────────────────────────────
    const BATCH = 500;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase
        .from('uuid_location_cache')
        .upsert(rows.slice(i, i + BATCH), { onConflict: 'uuid', ignoreDuplicates: false });
      if (error) {
        console.error('Upsert error:', error.message);
      } else {
        upserted += Math.min(BATCH, rows.length - i);
      }
    }

    // ── Step 9: Delete stale UUIDs ────────────────────────────────────────────
    const { data: existingRows } = await supabase
      .from('uuid_location_cache')
      .select('uuid');

    const existingUuids = new Set((existingRows ?? []).map(r => r.uuid));
    const liveSet       = new Set([...pipelineItems.keys()]);
    const toDelete      = [...existingUuids].filter(u => !liveSet.has(u));

    if (toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += BATCH) {
        await supabase
          .from('uuid_location_cache')
          .delete()
          .in('uuid', toDelete.slice(i, i + BATCH));
      }
      console.log(`Deleted ${toDelete.length} stale UUIDs`);
    }

    const resolved   = rows.filter(r => r.location !== null).length;
    const unresolved = rows.filter(r => r.location === null).length;

    return NextResponse.json({
      synced:            upserted,
      resolved,
      unresolved,
      deleted:           toDelete.length,
      totalScanned:      pipelineItems.size,
      wrOrderNums:       wrAllOrderNums.size,
      olcOrders:         olcOrderLocation.size,
      missingFromSearch: missingOrderNums.length,
      foundIndividually: individuallyFetched,
      stubs:             stubsCreated,
      message: `Synced ${upserted} UUIDs (${resolved} with location, ${unresolved} unresolved).`,
    });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
