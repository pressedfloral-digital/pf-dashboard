import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfGetAll, pfPost, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';

export const maxDuration = 120;

interface WeeklyReportItem {
  orderNumber?: string | number;
  shopifyOrderNumber?: string | number;
  orderName?: string;
  status?: string;
  location?: string;
  originalOrderDate?: string;
  orderDateUpdated?: string | null;
  variantTitle?: string;
  eventDate?: string;
}

interface SearchItem {
  // Design staff
  assignedToUserFirstName?: string;
  assignedToUserLastName?: string;
  // Preservation staff
  preservationUserFirstName?: string;
  preservationUserLastName?: string;
  // Fulfillment staff
  fulfillmentUserFirstName?: string;
  fulfillmentUserLastName?: string;
  // Dates
  orderDate?: string;
  eventDate?: string;
}

interface SearchResponse {
  items: SearchItem[];
}

const PRESERVATION_STATUSES = new Set([
  'bouquetReceived', 'checkedOn', 'progress', 'almostReadyToFrame',
]);
const DESIGN_STATUSES = new Set([
  'readyToFrame', 'frameCompleted', 'disapproved', 'approved',
]);

function staffForStatus(item: SearchItem, status: string): string {
  let fn = '', ln = '';
  if (PRESERVATION_STATUSES.has(status)) {
    fn = item.preservationUserFirstName ?? '';
    ln = item.preservationUserLastName  ?? '';
  } else if (DESIGN_STATUSES.has(status)) {
    fn = item.assignedToUserFirstName ?? '';
    ln = item.assignedToUserLastName  ?? '';
  } else {
    // Fulfillment
    fn = item.fulfillmentUserFirstName ?? '';
    ln = item.fulfillmentUserLastName  ?? '';
  }
  return `${fn} ${ln}`.trim();
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const status   = req.nextUrl.searchParams.get('status');
  const location = req.nextUrl.searchParams.get('location') ?? 'Utah';

  if (!status) return NextResponse.json({ error: 'status required' }, { status: 400 });

  try {
    // Load staff → location map from Supabase (fast single query)
    const { data: staffRows } = await supabase
      .from('staff_locations')
      .select('name, location');
    const staffLocationMap: Record<string, string> = {};
    staffRows?.forEach(r => { staffLocationMap[r.name] = r.location; });

    // Build monthly date-range paths going back 30 months
    const paths: string[] = [];
    const today = new Date();

    for (let m = 0; m < 48; m++) {
      const y  = today.getFullYear();
      const mo = today.getMonth() - m;
      const firstOfMonth = new Date(y, mo, 1);
      const lastOfMonth  = m === 0 ? today : new Date(y, mo + 1, 0);
      paths.push(
        `/OrderProducts/WeeklyReport?startDate=${fmtDate(firstOfMonth)}&endDate=${fmtDate(lastOfMonth)}`
      );
    }

    // Fetch all months in parallel batches of 8
    const seen   = new Set<string>();
    const orders: { id: string; num: string; name: string; variant: string; orderDate: string; eventDate: string; staff: string; enteredAt: string; days: number; daysLabel: string; location: string }[] = [];

    for (let i = 0; i < paths.length; i += 8) {
      const results = await pfGetAll<WeeklyReportItem[]>(paths.slice(i, i + 8));
      results.forEach(items => {
        if (!items) return;
        items.forEach(item => {
          if (item.status !== status) return;
          // Allow blank-location orders through — we resolve them via staff_locations after Search
          if (location !== 'All' && item.location && item.location !== location) return;
          const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
          if (!num) return;
          const id = `${num}|${item.variantTitle ?? ''}`;
          if (seen.has(id)) return;
          seen.add(id);
          // Use orderDateUpdated (status change) if available, else fall back to order received date
          const statusDateStr = item.orderDateUpdated ?? item.originalOrderDate ?? null;
          const days = statusDateStr
            ? Math.floor((Date.now() - new Date(statusDateStr).getTime()) / 86_400_000)
            : -1;
          const daysLabel = item.orderDateUpdated ? 'in status' : 'order age';

          orders.push({
            id,
            num,
            name:      item.orderName ?? '',
            variant:   item.variantTitle ?? '',
            orderDate: item.originalOrderDate?.split('T')[0] ?? '',
            eventDate: item.eventDate?.split('T')[0] ?? '',
            staff:     '',
            enteredAt: '',
            location:  item.location ?? '',
            days,
            daysLabel,
          });
        });
      });
      if (orders.length >= 10000) break;
    }

    if (!orders.length) {
      return NextResponse.json({ orders: [], total: 0 });
    }

    // Sort by event date ascending (most urgent first)
    orders.sort((a, b) => {
      if (a.eventDate && b.eventDate) return a.eventDate.localeCompare(b.eventDate);
      if (a.eventDate) return -1;
      if (b.eventDate) return 1;
      return Number(b.num) - Number(a.num);
    });

    // Batch-search each order to get department-specific staff
    const BATCH = 50;
    for (let i = 0; i < orders.length; i += BATCH) {
      const batch = orders.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(o =>
          pfPost<SearchResponse>('/OrderProducts/Search', {
            searchTerm: o.num,
            pageNumber: 1,
            pageSize: 1,
            workflowFamily: 'frames',
          }).catch(() => null)
        )
      );
      results.forEach((data, j) => {
        const item = data?.items?.[0];
        if (!item) return;
        batch[j].staff = staffForStatus(item, status);
        // If location is blank, infer it from the assigned staff member
        if (!batch[j].location && batch[j].staff) {
          batch[j].location = staffLocationMap[batch[j].staff] ?? '';
        }
      });
    }

    // Filter out orders whose resolved location doesn't match the requested location
    const filteredOrders = location === 'All'
      ? orders
      : orders.filter(o => o.location === location);

    // Look up entered_at dates from Supabase status history
    const keys = filteredOrders.map(o => o.id);
    const { data: historyRows } = await supabase
      .from('order_status_history')
      .select('order_product_key, entered_at')
      .eq('status', status)
      .in('order_product_key', keys);

    if (historyRows?.length) {
      const enteredMap: Record<string, string> = {};
      historyRows.forEach(r => { enteredMap[r.order_product_key] = r.entered_at?.split('T')[0] ?? ''; });
      filteredOrders.forEach(o => { o.enteredAt = enteredMap[o.id] ?? ''; });
    }

    return NextResponse.json({ orders: filteredOrders, total: filteredOrders.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
