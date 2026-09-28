/**
 * Direct Pressed Floral assignment counts, matching Support Assistant's
 * Frames > Team view exactly.
 *
 * The .NET endpoint returns the number of order products currently attributed
 * to a user for Preservation, Design, and Fulfillment, filtered by each
 * department's assignment timestamp. Reassignments therefore move attribution
 * in both this dashboard and Support Assistant.
 */
import { pfGet, pfPost } from '@/lib/pf-api';

export type AssignmentDepartment = 'preservation' | 'design' | 'fulfillment';

export interface AssignmentCounts {
  preservation: number;
  design: number;
  fulfillment: number;
}

export interface AssignmentCountRow {
  staff: string;
  userUuid: string;
  counts: AssignmentCounts;
}

interface BaseUserDTO {
  uuid?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface UserPage {
  items?: BaseUserDTO[] | null;
}

interface RawAssignmentCounts {
  assignedToUser?: number | null;
  preservationUser?: number | null;
  fulfillmentUser?: number | null;
}

interface AssignableStaff {
  uuid: string;
  name: string;
}

// The production app keeps the name that was on the user's account when it
// was created. The schedule roster follows current Rippling names. Keep this
// bridge aligned with production-counts.ts until employee identity moves to a
// shared external-id table.
const STAFF_NAME_ALIASES: Record<string, string> = {
  'Kathryn Hill': 'Kathryn Sonntag',
  'Chloe Leonard': 'Chloe Jensen',
  'Izabella De Prima': 'Bella DePrima',
  'Mia Legas': 'Mia Legas Boots',
  'Katelyn Wilson': 'Katelyn Hunger',
  'Laderica': 'Laderica Woods',
  'Kale': 'Kale Haug',
  'Lucy': 'Lucy Elcock',
  'Allie': 'Allie Seegrist',
  'Cydnei Gay': 'Cyd Gay',
  'Emma Swenson': 'Emma Van Dyke',
};

export function canonicalAssignmentStaffName(name: string): string {
  return STAFF_NAME_ALIASES[name] ?? name;
}

export function normalizeAssignmentStaffName(name: string): string {
  return canonicalAssignmentStaffName(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

let staffCache: { expiresAt: number; staff: AssignableStaff[] } | null = null;

/** Fetches the same Admin/Manager/Staff directory used by Support Assistant. */
export async function fetchAssignableStaff(): Promise<AssignableStaff[]> {
  if (staffCache && Date.now() < staffCache.expiresAt) return staffCache.staff;

  const pageSize = 50; // .NET validates this as the maximum page size.
  const users: BaseUserDTO[] = [];
  for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
    const page = await pfPost<UserPage>('/User/WithRole', {
      pageNumber,
      pageSize,
      roles: ['admin', 'manager', 'staff'],
    });
    const items = page.items ?? [];
    users.push(...items);
    if (items.length < pageSize) break;
  }

  const byUuid = new Map<string, AssignableStaff>();
  users.forEach(user => {
    const uuid = user.uuid?.trim();
    const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    if (uuid && name) byUuid.set(uuid, { uuid, name: canonicalAssignmentStaffName(name) });
  });

  const staff = [...byUuid.values()].sort((a, b) => a.name.localeCompare(b.name));
  staffCache = { staff, expiresAt: Date.now() + 10 * 60 * 1000 };
  return staff;
}

function rangeBounds(start: string, end: string): { startDate: string; endDate: string } {
  return {
    // Support Assistant constructs these as server-local calendar boundaries;
    // both deployed Node services run in UTC, so use explicit UTC here.
    startDate: `${start}T00:00:00.000Z`,
    endDate: `${end}T23:59:59.999Z`,
  };
}

export async function fetchAssignmentCounts(
  userUuid: string,
  start: string,
  end: string,
): Promise<AssignmentCounts> {
  const bounds = rangeBounds(start, end);
  const params = new URLSearchParams(bounds);
  const dto = await pfGet<RawAssignmentCounts>(
    `/OrderProducts/ForUser/Counts/${encodeURIComponent(userUuid)}/false/false?${params}`
  );
  return {
    preservation: dto.preservationUser ?? 0,
    design: dto.assignedToUser ?? 0,
    fulfillment: dto.fulfillmentUser ?? 0,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

// Some people have more than one production-app account under the same name
// (e.g. a personal-email login alongside their work one), and orders can land
// on either. Every lookup resolves a name to all of its accounts and sums
// them — picking just one silently undercounts, or zeroes, that person.
interface StaffTarget {
  requestedName: string;
  accounts: AssignableStaff[];
}

function accountsByName(staff: AssignableStaff[]): Map<string, AssignableStaff[]> {
  const byName = new Map<string, AssignableStaff[]>();
  staff.forEach(person => {
    const key = normalizeAssignmentStaffName(person.name);
    if (key) byName.set(key, [...(byName.get(key) ?? []), person]);
  });
  return byName;
}

function resolveRequestedStaff(
  staff: AssignableStaff[],
  requestedNames?: string[],
): { targets: StaffTarget[]; unmatched: string[] } {
  const byName = accountsByName(staff);
  if (!requestedNames) {
    return {
      targets: [...byName.values()].map(accounts => ({ requestedName: accounts[0].name, accounts })),
      unmatched: [],
    };
  }

  const targets: StaffTarget[] = [];
  const unmatched: string[] = [];
  [...new Set(requestedNames.map(name => name.trim()).filter(Boolean))].forEach(requestedName => {
    const accounts = byName.get(normalizeAssignmentStaffName(requestedName));
    if (accounts) targets.push({ requestedName, accounts });
    else unmatched.push(requestedName);
  });
  return { targets, unmatched };
}

async function fetchTargetCounts(target: StaffTarget, start: string, end: string): Promise<AssignmentCounts> {
  const perAccount = await Promise.all(target.accounts.map(a => fetchAssignmentCounts(a.uuid, start, end)));
  return perAccount.reduce(
    (sum, c) => ({
      preservation: sum.preservation + c.preservation,
      design: sum.design + c.design,
      fulfillment: sum.fulfillment + c.fulfillment,
    }),
    { preservation: 0, design: 0, fulfillment: 0 },
  );
}

/** One aggregate count per person for a date range; used by Historicals sync. */
export async function computeAssignmentCounts(
  start: string,
  end: string,
  requestedNames?: string[],
): Promise<{ rows: AssignmentCountRow[]; unmatched: string[] }> {
  const staff = await fetchAssignableStaff();
  const { targets, unmatched } = resolveRequestedStaff(staff, requestedNames);
  const rows = await mapWithConcurrency(targets, 12, async target => ({
    staff: target.requestedName,
    userUuid: target.accounts[0].uuid,
    counts: await fetchTargetCounts(target, start, end),
  }));
  return { rows, unmatched };
}

export interface DailyAssignmentCountRow {
  staff: string;
  userUuid: string;
  days: Record<string, AssignmentCounts>;
}

function listDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Per-day counts for each requested roster name; used by This Week. */
export async function computeDailyAssignmentCounts(
  start: string,
  end: string,
  requestedNames: string[],
): Promise<{ rows: DailyAssignmentCountRow[]; unmatched: string[] }> {
  const dates = listDates(start, end);
  if (dates.length > 7) throw new Error('Daily assignment counts are limited to seven days.');

  const staff = await fetchAssignableStaff();
  const { targets, unmatched } = resolveRequestedStaff(staff, requestedNames);
  const jobs = targets.flatMap(target => dates.map(date => ({ target, date })));
  const results = await mapWithConcurrency(jobs, 12, async job => ({
    requestedName: job.target.requestedName,
    uuid: job.target.accounts[0].uuid,
    date: job.date,
    counts: await fetchTargetCounts(job.target, job.date, job.date),
  }));

  const rowsByName = new Map<string, DailyAssignmentCountRow>();
  results.forEach(result => {
    const row = rowsByName.get(result.requestedName) ?? {
      staff: result.requestedName,
      userUuid: result.uuid,
      days: {},
    };
    row.days[result.date] = result.counts;
    rowsByName.set(result.requestedName, row);
  });
  return { rows: [...rowsByName.values()], unmatched };
}

export interface AssignedOrderProduct {
  uuid: string;
  orderName: string;
  productTitle: string | null;
  variantTitle: string | null;
  status: string | null;
  clientName: string | null;
  eventDate: string | null;
  /** Other stages this person also holds on the product — see fetchAssignedOrderProducts. */
  otherStages: AssignmentDepartment[];
}

interface OrderProductSummaryDTO {
  uuid: string;
  shopifyOrderName?: string | null;
  shopifyOrderNumber?: string | null;
  productTitle?: string | null;
  variantTitle?: string | null;
  status?: string | number | null;
  clientFirstName?: string | null;
  clientLastName?: string | null;
  eventDate?: string | null;
  assignedToUserUuid?: string | null;
  preservationUserUuid?: string | null;
  fulfillmentUserUuid?: string | null;
}

interface OrderProductSummaryPage {
  items?: OrderProductSummaryDTO[] | null;
  totalPages?: number | null;
}

const DEPT_USER_FIELD: Record<AssignmentDepartment, keyof OrderProductSummaryDTO> = {
  preservation: 'preservationUserUuid',
  design: 'assignedToUserUuid',
  fulfillment: 'fulfillmentUserUuid',
};

/**
 * The order products behind one person's assignment count for a date range —
 * the drill-down for Historicals' "synced" cells. Uses the list counterpart of
 * the /ForUser/Counts endpoint, then keeps only rows where the person holds
 * the requested department's role (the list spans all three roles).
 */
export async function fetchAssignedOrderProducts(
  name: string,
  department: AssignmentDepartment,
  start: string,
  end: string,
): Promise<{ matched: boolean; items: AssignedOrderProduct[] }> {
  const { targets } = resolveRequestedStaff(await fetchAssignableStaff(), [name]);
  const accounts = targets[0]?.accounts ?? [];
  if (accounts.length === 0) return { matched: false, items: [] };

  const field = DEPT_USER_FIELD[department];
  const rows: { row: OrderProductSummaryDTO; otherStages: AssignmentDepartment[] }[] = [];
  for (const account of accounts) {
    const pageSize = 50;
    for (let pageNumber = 1; pageNumber <= 40; pageNumber++) {
      const page = await pfPost<OrderProductSummaryPage>('/OrderProducts/ForUser', {
        userUuid: account.uuid,
        activeStatusesOnly: false,
        assignedThisWeek: false,
        ...rangeBounds(start, end),
        pageNumber,
        pageSize,
      });
      const items = page.items ?? [];
      const mine = (row: OrderProductSummaryDTO, f: keyof OrderProductSummaryDTO) =>
        String(row[f] ?? '').toLowerCase() === account.uuid.toLowerCase();
      for (const row of items) {
        if (!mine(row, field)) continue;
        // The API's date filter matches if ANY of the person's stage
        // assignments falls in range, while the counts endpoint checks only
        // this stage's date — and the list doesn't return per-stage dates. So
        // when someone holds more than one stage of a product, it may be here
        // because of the other stage (e.g. preserved last month, fulfilled
        // today). Flag it rather than guess.
        const otherStages = (Object.keys(DEPT_USER_FIELD) as AssignmentDepartment[])
          .filter(d => d !== department && mine(row, DEPT_USER_FIELD[d]));
        rows.push({ row, otherStages });
      }
      if (items.length < pageSize || (page.totalPages != null && pageNumber >= page.totalPages)) break;
    }
  }

  const items = rows
    .map(({ row, otherStages }) => ({
      uuid: row.uuid,
      orderName: row.shopifyOrderName || (row.shopifyOrderNumber ? `#${row.shopifyOrderNumber}` : '—'),
      productTitle: row.productTitle ?? null,
      variantTitle: row.variantTitle ?? null,
      status: row.status == null ? null : String(row.status),
      clientName: [row.clientFirstName, row.clientLastName].filter(Boolean).join(' ') || null,
      eventDate: row.eventDate ? row.eventDate.slice(0, 10) : null,
      otherStages,
    }))
    .sort((a, b) => a.orderName.localeCompare(b.orderName, undefined, { numeric: true }));
  return { matched: true, items };
}
