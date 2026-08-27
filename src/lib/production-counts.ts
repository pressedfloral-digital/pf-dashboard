/**
 * Shared per-staff production counting logic for Preservation / Design /
 * Fulfillment, sourced from the Pressed Floral app (via pf-api) and the
 * order_status_history Supabase table (populated by the status-snapshot cron).
 *
 * Used by both the live /api/production-counts dashboard endpoint and the
 * automated actuals sync (cron + validation script) so both stay in lockstep.
 */
import { pfPost, pfGet } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';

interface SearchResponse {
  items: { uuid?: string }[];
}

interface DetailsUpload {
  uploadType: string;
  uploadedByUserFirstName?: string;
  uploadedByUserLastName?: string;
}

interface DetailsHistory {
  status: string;
  dateCreated: string;
}

interface Details {
  variantTitle?: string;
  eventDate?: string;
  preservationUserFirstName?: string;
  preservationUserLastName?: string;
  assignedToUserFirstName?: string;
  assignedToUserLastName?: string;
  fulfillmentUserFirstName?: string;
  fulfillmentUserLastName?: string;
  orderProductUploads?: DetailsUpload[];
  history?: DetailsHistory[];
}

export interface OrderDetail {
  orderNum:  string;
  variant:   string;
  enteredAt: string;
  eventDate: string;
}

export interface StaffRow {
  staff:  string;
  count:  number;
  orders: OrderDetail[];
}

export interface ProductionCounts {
  Preservation: StaffRow[];
  Design:       StaffRow[];
  Fulfillment:  StaffRow[];
}

// The Pressed Floral production app is a separate system from Rippling/the
// roster — it tags orders with whatever name is on that app's own user
// account, which doesn't get updated just because someone's name changed in
// Rippling. Without this, a name change creates a permanent split: orders
// keep landing under the old name forever, silently missing from that
// person's real actuals/roster-matched history. Add an entry here whenever
// someone's name changes and PF-app orders are still coming in under the
// old one. (staff_locations also needs a row for the current name — see
// the sync cron.)
const STAFF_NAME_ALIASES: Record<string, string> = {
  'Kathryn Hill':      'Kathryn Sonntag',
  'Chloe Leonard':     'Chloe Jensen',
  'Izabella De Prima': 'Bella DePrima',
  'Mia Legas':         'Mia Legas Boots',
};

function canonicalStaffName(staff: string): string {
  return STAFF_NAME_ALIASES[staff] ?? staff;
}

function uploadStaff(details: Details, type: 'bouquet' | 'frame'): string {
  const upload = details.orderProductUploads?.find(u => u.uploadType === type);
  if (!upload) return '';
  return `${upload.uploadedByUserFirstName ?? ''} ${upload.uploadedByUserLastName ?? ''}`.trim();
}

interface DetailsHistoryWithUser extends DetailsHistory {
  userFirstName?: string;
  userLastName?: string;
}

function historyEntry(details: Details, status: string): DetailsHistoryWithUser | null {
  return (details.history as DetailsHistoryWithUser[] | undefined)?.find(h => h.status === status) ?? null;
}

function historyUser(details: Details, status: string): string {
  const entry = historyEntry(details, status);
  if (!entry?.userFirstName) return '';
  return `${entry.userFirstName} ${entry.userLastName ?? ''}`.trim();
}

// For design: also include approved/disapproved as candidates — orders often
// move readyToFrame→frameCompleted→approved same day, so a simple current-
// status query would miss frameCompleted entirely. We cast a wide net, then
// verify the exact frameCompleted date from each order's PF history.
const DESIGN_CANDIDATE_STATUSES = [
  'frameCompleted', 'approved', 'disapproved', 'noResponse',
  'glued', 'readyToSeal', 'readyToPackage',
];

export async function computeProductionCounts(start: string, end: string): Promise<ProductionCounts> {
  // Supabase first_seen_at is when our snapshot ran (UTC), not when the status
  // changed. We buffer by 7 days on each side so we catch orders regardless of
  // when the snapshot ran. The exact date is then verified from the PF history
  // array (Mountain Time).
  const BUFFER_MS = 7 * 24 * 60 * 60 * 1000;
  const startISO = new Date(new Date(`${start}T00:00:00-06:00`).getTime() - BUFFER_MS).toISOString();
  const endISO   = new Date(new Date(`${end}T23:59:59-06:00`).getTime() + BUFFER_MS).toISOString();

  const queryStatus = (status: string) => {
    const q = supabase
      .from('order_status_history')
      .select('order_num')
      .eq('status', status)
      .gte('first_seen_at', startISO)
      .lte('first_seen_at', endISO);
    // Don't filter by location here — some orders have blank location in
    // snapshot. Location filtering happens downstream via staff resolution.
    return q.then(r => [...new Set((r.data ?? []).map(x => x.order_num))]);
  };

  const [presNums, fullNums, ...designBuckets] = await Promise.all([
    queryStatus('bouquetReceived'),
    queryStatus('readyToPackage'),
    ...DESIGN_CANDIDATE_STATUSES.map(queryStatus),
  ]);

  const designNums = [...new Set(designBuckets.flat())];
  const allNums = [...new Set([...presNums, ...designNums, ...fullNums])];
  if (!allNums.length) {
    return { Preservation: [], Design: [], Fulfillment: [] };
  }

  // ── Fetch Details for all orders ─────────────────────────────────────────
  const uniqueOrderNums = [...new Set(allNums)];
  const BATCH = 20;
  const detailsByNum: Record<string, Details> = {};

  for (let i = 0; i < uniqueOrderNums.length; i += BATCH) {
    const batch = uniqueOrderNums.slice(i, i + BATCH);

    const searches = await Promise.all(
      batch.map(num =>
        pfPost<SearchResponse>('/OrderProducts/Search', {
          searchTerm: num, pageNumber: 1, pageSize: 5,
        }).catch(() => null)
      )
    );

    const detailsList = await Promise.all(
      searches.map(s =>
        Promise.all(
          (s?.items ?? []).map(item =>
            item.uuid
              ? pfGet<Details>(`/OrderProducts/Details/${item.uuid}`).catch(() => null)
              : Promise.resolve(null)
          )
        )
      )
    );

    batch.forEach((num, j) => {
      (detailsList[j] ?? []).forEach(d => {
        if (d) detailsByNum[`${num}|${d.variantTitle ?? ''}`] = d;
      });
    });
  }

  // ── Build staff rows, verified against exact history dates ────────────────
  function buildDept(
    orderNums: string[],
    historyStatus: string,
    getStaff: (d: Details) => string,
  ): StaffRow[] {
    const staffMap: Record<string, OrderDetail[]> = {};

    const allKeys = orderNums.flatMap(num =>
      Object.keys(detailsByNum).filter(k => k === `${num}|` || k.startsWith(`${num}|`))
    );
    allKeys.forEach(key => {
      const num = key.split('|')[0];
      const details = detailsByNum[key];
      if (!details) return;

      const rawDate = historyEntry(details, historyStatus)?.dateCreated;
      if (!rawDate) return;
      const exactDate = new Date(rawDate).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
      if (exactDate < start || exactDate > end) return;

      const staff     = canonicalStaffName(getStaff(details) || 'Unassigned');
      const variant   = details.variantTitle ?? '';
      const eventDate = details.eventDate?.split('T')[0] ?? '';

      if (!staffMap[staff]) staffMap[staff] = [];
      staffMap[staff].push({ orderNum: num, variant, enteredAt: exactDate, eventDate });
    });

    return Object.entries(staffMap)
      .map(([staff, orders]) => ({
        staff,
        count:  orders.length,
        orders: orders.sort((a, b) => a.enteredAt.localeCompare(b.enteredAt)),
      }))
      .sort((a, b) => b.count - a.count);
  }

  return {
    Preservation: buildDept(
      presNums,
      'bouquetReceived',
      d =>
        uploadStaff(d, 'bouquet') ||
        `${d.preservationUserFirstName ?? ''} ${d.preservationUserLastName ?? ''}`.trim() ||
        `${d.assignedToUserFirstName ?? ''} ${d.assignedToUserLastName ?? ''}`.trim(),
    ),
    Design: buildDept(
      designNums,
      'frameCompleted',
      d =>
        historyUser(d, 'frameCompleted') ||
        uploadStaff(d, 'frame') ||
        `${d.assignedToUserFirstName ?? ''} ${d.assignedToUserLastName ?? ''}`.trim(),
    ),
    Fulfillment: buildDept(
      fullNums,
      'readyToPackage',
      d =>
        `${d.fulfillmentUserFirstName ?? ''} ${d.fulfillmentUserLastName ?? ''}`.trim() ||
        `${d.assignedToUserFirstName ?? ''} ${d.assignedToUserLastName ?? ''}`.trim(),
    ),
  };
}
