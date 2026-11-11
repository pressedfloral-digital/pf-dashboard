import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfGetAll, pfGet, pfPost, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';

export const maxDuration = 300;

interface WeeklyReportItem {
  orderNumber?:        string | number;
  shopifyOrderNumber?: string | number;
  variantTitle?:       string;
  status?:             string;
  location?:           string;
  uuid?:               string;
  orderName?:          string;
  originalOrderDate?:  string;
}

interface SearchResponse {
  items?: { uuid?: string }[];
}

interface DetailsUpload {
  uploadType:               string;
  uploadedByUserFirstName?: string | null;
  uploadedByUserLastName?:  string | null;
}

interface OrderProduct {
  uuid:          string;
  variantTitle?: string;
  status?:       string;
}

interface Details {
  orderProductUploads?: DetailsUpload[];
  originalOrderDate?:   string | null;
  orderStatus?:         string | null;
  orderTags?:           string[] | null;
  tags?:                string | null;
  pressedFloralOrderLineItems?: OrderProduct[];
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return runResolve(true);
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return runResolve(false);
}

async function runResolve(previewOnly: boolean) {
  try {
    // ── Step 1: Load staff → location map ─────────────────────────────────────
    const { data: staffRows } = await supabase.from('staff_locations').select('name, location');
    const staffLocationMap: Record<string, string> = {};
    staffRows?.forEach(r => { staffLocationMap[r.name] = r.location; });

    // ── Step 2: Load already-resolved order numbers ───────────────────────────
    // We track by order_num now so we don't re-scan orders already fully resolved
    const { data: cached } = await supabase.from('order_location_cache').select('order_num');
    const alreadyResolvedOrders = new Set((cached ?? []).map(r => r.order_num));

    // ── Step 3: Scan WeeklyReport for unassigned orders ───────────────────────
    const today = new Date();
    const paths: string[] = [];
    for (let m = 0; m < 18; m++) {
      const first = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const last  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
      paths.push(`/OrderProducts/WeeklyReport?startDate=${fmtDate(first)}&endDate=${fmtDate(last)}&pageSize=1000`);
    }

    // Collect unique unassigned order numbers to resolve
    const toResolve = new Map<string, { orderNum: string; variantTitle: string; uuid: string | null; status: string; orderDate: string }>();

    for (let i = 0; i < paths.length; i += 6) {
      const results = await pfGetAll<WeeklyReportItem[]>(paths.slice(i, i + 6));
      results.forEach(items => {
        if (!items) return;
        items.forEach(item => {
          if (item.status === 'orderReceived') return;
          if (item.location) return;
          const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
          if (!num) return;
          if (alreadyResolvedOrders.has(num)) return;
          if (!toResolve.has(num)) {
            toResolve.set(num, {
              orderNum:     num,
              variantTitle: item.variantTitle ?? '',
              uuid:         item.uuid ?? null,
              status:       item.status ?? '',
              orderDate:    item.originalOrderDate?.split('T')[0] ?? '',
            });
          }
        });
      });
    }

    if (!toResolve.size) {
      return NextResponse.json({ resolved: 0, message: 'No new unassigned orders to resolve' });
    }

    // ── Step 4: Resolve missing UUIDs via Search ──────────────────────────────
    const needsSearch = [...toResolve.entries()].filter(([, v]) => !v.uuid);
    const SEARCH_BATCH = 20;

    for (let i = 0; i < needsSearch.length; i += SEARCH_BATCH) {
      const batch = needsSearch.slice(i, i + SEARCH_BATCH);
      const results = await Promise.all(
        batch.map(([, v]) =>
          pfPost<SearchResponse>('/OrderProducts/Search', {
            searchTerm: v.orderNum, pageNumber: 1, pageSize: 1, workflowFamily: 'frames',
          }).catch(() => null)
        )
      );
      results.forEach((res, j) => {
        const uuid = res?.items?.[0]?.uuid;
        if (uuid) {
          const [key, v] = batch[j];
          toResolve.set(key, { ...v, uuid });
        }
      });
    }

    // ── Step 5: Fetch Details to get location + ALL order products ────────────
    const allEntries = [...toResolve.entries()].filter(([, v]) => !!v.uuid) as [string, { orderNum: string; variantTitle: string; uuid: string; status: string; orderDate: string }][];
    const BATCH = 30;
    const rows: { order_product_key: string; order_num: string; location: string; variant_title: string; status: string; order_date: string }[] = [];
    const unmatchedNames = new Map<string, number>();
    const unresolvedOrders: { orderNum: string; variantTitle: string; status: string; orderDate: string }[] = [];
    const pendingStaffSearch = new Map<string, { orderNum: string; variantTitle: string; status: string; orderDate: string }>();
    let noPhotoResolved = 0;

    for (let i = 0; i < allEntries.length; i += BATCH) {
      const batch = allEntries.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(([, v]) =>
          pfGet<Details>(`/OrderProducts/Details/${v.uuid}`).catch(() => null)
        )
      );
      results.forEach((d, j) => {
        if (!d) return;
        const [, { orderNum, variantTitle, status, orderDate: itemOrderDate }] = batch[j];

        // Check for GA tag → auto-assign Georgia
        const tagStr = Array.isArray(d.orderTags) ? d.orderTags.join(',') : (d.tags ?? '');
        if (tagStr.toUpperCase().includes('GA')) {
          // Store all products for this order as Georgia
          const products = d.pressedFloralOrderLineItems ?? [];
          if (products.length > 0) {
            products.forEach(p => {
              if (!p.uuid || !p.status) return;
              rows.push({
                order_product_key: `${orderNum}|${p.uuid}`,
                order_num:         orderNum,
                location:          'Georgia',
                variant_title:     p.variantTitle ?? '',
                status:            p.status,
                order_date:        itemOrderDate,
              });
            });
          } else {
            rows.push({
              order_product_key: `${orderNum}|${variantTitle}`,
              order_num:         orderNum,
              location:          'Georgia',
              variant_title:     variantTitle,
              status,
              order_date:        itemOrderDate,
            });
          }
          return;
        }

        // Try bouquet uploader first
        const UPLOAD_PRIORITY = ['bouquet', 'frame'];
        const uploads = d.orderProductUploads ?? [];
        const prioritized = [
          ...UPLOAD_PRIORITY.map(t => uploads.find(u => u.uploadType === t)),
          ...uploads.filter(u => !UPLOAD_PRIORITY.includes(u.uploadType)),
        ].filter(Boolean) as DetailsUpload[];

        let uploaderName = '';
        let usedFallback = false;
        for (const upload of prioritized) {
          const name = [upload.uploadedByUserFirstName, upload.uploadedByUserLastName].filter(Boolean).join(' ').trim();
          if (name && staffLocationMap[name]) {
            uploaderName = name;
            usedFallback = upload.uploadType !== 'bouquet';
            break;
          }
        }

        const location = staffLocationMap[uploaderName] ?? '';
        if (!location) {
          pendingStaffSearch.set(orderNum, { orderNum, variantTitle, status, orderDate: itemOrderDate });
          return;
        }

        if (usedFallback) noPhotoResolved++;

        // Store ALL products for this order with their UUIDs
        const products = d.pressedFloralOrderLineItems ?? [];
        if (products.length > 0) {
          products.forEach(p => {
            if (!p.uuid || !p.status) return;
            rows.push({
              order_product_key: `${orderNum}|${p.uuid}`,
              order_num:         orderNum,
              location,
              variant_title:     p.variantTitle ?? '',
              status:            p.status,
              order_date:        itemOrderDate,
            });
          });
        } else {
          rows.push({
            order_product_key: `${orderNum}|${variantTitle}`,
            order_num:         orderNum,
            location,
            variant_title:     variantTitle,
            status,
            order_date:        itemOrderDate,
          });
        }
      });
    }

    // ── Step 5b: Fallback via preservation staff ──────────────────────────────
    interface SearchStaffItem {
      preservationUserFirstName?: string;
      preservationUserLastName?:  string;
    }
    interface SearchStaffResponse { items?: SearchStaffItem[] }

    const pendingList = [...pendingStaffSearch.entries()];
    const SEARCH_STAFF_BATCH = 20;
    for (let i = 0; i < pendingList.length; i += SEARCH_STAFF_BATCH) {
      const batch = pendingList.slice(i, i + SEARCH_STAFF_BATCH);
      const results = await Promise.all(
        batch.map(([, v]) =>
          pfPost<SearchStaffResponse>('/OrderProducts/Search', {
            searchTerm: v.orderNum, pageNumber: 1, pageSize: 1, workflowFamily: 'frames',
          }).catch(() => null)
        )
      );
      results.forEach((res, j) => {
        const [, { orderNum, variantTitle, status, orderDate }] = batch[j];
        const item = res?.items?.[0];
        const staffName = item
          ? [item.preservationUserFirstName, item.preservationUserLastName].filter(Boolean).join(' ').trim()
          : '';
        const location = staffLocationMap[staffName] ?? '';
        if (location) {
          rows.push({
            order_product_key: `${orderNum}|${variantTitle}`,
            order_num:         orderNum,
            location,
            variant_title:     variantTitle,
            status,
            order_date:        orderDate,
          });
        } else {
          const label = staffName ? `[preservation] ${staffName}` : '(no photo)';
          unmatchedNames.set(label, (unmatchedNames.get(label) ?? 0) + 1);
          unresolvedOrders.push({ orderNum, variantTitle, status, orderDate });
        }
      });
    }

    const unmatched = [...unmatchedNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    if (previewOnly) {
      return NextResponse.json({ previewOnly: true, wouldResolve: rows.length, unmatched, unresolvedOrders, total: toResolve.size });
    }

    if (!rows.length) {
      return NextResponse.json({ resolved: 0, total: toResolve.size, unmatched, unresolvedOrders, message: `Scanned ${toResolve.size} unassigned orders but none could be matched to a location` });
    }

    // ── Step 6: Upsert to cache ───────────────────────────────────────────────
    const { error } = await supabase
      .from('order_location_cache')
      .upsert(rows, { onConflict: 'order_product_key', ignoreDuplicates: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // ── Step 7: Also update order_status_history with resolved locations ──────
    // This ensures the Sorted by Location view immediately reflects the new locations
    await supabase.rpc('apply_cache_locations');

    return NextResponse.json({ resolved: rows.length, noPhotoResolved, total: toResolve.size, unmatched, unresolvedOrders });

  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
