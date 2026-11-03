/**
 * Direct Pressed Floral assignment counts using the same attribution and
 * UTC calendar as Support Assistant, excluding non-production products.
 *
 * The .NET endpoint returns the number of order products currently attributed
 * to a user for Preservation, Design, and Fulfillment, filtered by each
 * department's assignment timestamp. Reassignments therefore move attribution
 * in both this dashboard and Support Assistant.
 */
import { pfPost } from '@/lib/pf-api';
import { assignmentDates, createSingleFlight, sumCounts, validateBatch, type BatchResponse } from '@/lib/assignment-batch';

export type AssignmentDepartment = 'preservation' | 'design' | 'fulfillment';

const ASSIGNMENT_DEPARTMENTS: AssignmentDepartment[] = ['preservation', 'design', 'fulfillment'];

// Products that never count toward production order counts — and so never
// toward Historicals, ratios or CPO — even though staff are assigned to them.
// Matched on the product title, case-insensitively.
const EXCLUDED_PRODUCT_TITLES = ['bloom arrangement recreation'];

export function isExcludedFromCounts(productTitle: string | null | undefined): boolean {
  const title = productTitle?.trim().toLowerCase() ?? '';
  return EXCLUDED_PRODUCT_TITLES.some(t => title.includes(t));
}

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
const directoryFlight = createSingleFlight<AssignableStaff[]>(0, 1);
export function fetchAssignableStaff(): Promise<AssignableStaff[]> {
  return directoryFlight('directory', loadAssignableStaff);
}
async function loadAssignableStaff(): Promise<AssignableStaff[]> {
  if (staffCache && Date.now() < staffCache.expiresAt) return staffCache.staff;

  const pageSize = 50; // .NET validates this as the maximum page size.
  const users: BaseUserDTO[] = [];
  for (let pageNumber = 1; pageNumber <= 200; pageNumber++) {
    const page = await pfPost<UserPage>('/User/WithRole', {
      pageNumber,
      pageSize,
      roles: ['admin', 'manager', 'staff'],
    }, { timeoutMs: 25000, retry: false });
    if (!Array.isArray(page.items)) throw new Error('Incomplete staff directory.');
    const items = page.items;
    users.push(...items);
    if (items.length < pageSize) break;
    if (pageNumber === 200) throw new Error('Staff directory exceeds supported size.');
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

export interface DailyAssignmentCountRow {
  staff: string;
  userUuid: string;
  days: Record<string, AssignmentCounts>;
}

const batchFlight = createSingleFlight<BatchResponse>(5 * 60 * 1000);

/** One request for every account, date and department. No legacy fan-out fallback. */
export async function computeDailyAssignmentCounts(
  start: string, end: string, requestedNames?: string[],
): Promise<{ rows: DailyAssignmentCountRow[]; unmatched: string[]; refreshedAt: string }> {
  const dates = assignmentDates(start, end);
  const { targets, unmatched } = resolveRequestedStaff(await fetchAssignableStaff(), requestedNames);
  const users = [...new Set(targets.flatMap(t => t.accounts.map(a => a.uuid.toLowerCase())))].sort();
  if (users.length > 200) throw new Error('Assignment reports are limited to 200 accounts.');
  if (!users.length) return { rows: [], unmatched, refreshedAt: new Date().toISOString() };
  const result = await batchFlight(JSON.stringify([start, end, users]), async () => {
    const response = await pfPost<BatchResponse>('/OrderProducts/ForUser/Counts/Batch', {
      start, end, userUuids: users,
    }, { timeoutMs: 25000, retry: false });
    validateBatch(response, users, dates);
    return response;
  });
  const counts = validateBatch(result, users, dates);
  const rows = targets.map(target => ({
    staff: target.requestedName,
    userUuid: target.accounts[0].uuid,
    days: Object.fromEntries(dates.map(date => [date, sumCounts(target.accounts.map(account =>
      counts.get(`${account.uuid.toLowerCase()}/${date}`)!,
    ))])),
  }));
  return { rows, unmatched, refreshedAt: result.refreshedAt };
}

/** Historical weekly totals use exactly the same daily snapshot as the dashboard. */
export async function computeAssignmentCounts(start: string, end: string, requestedNames?: string[]) {
  const result = await computeDailyAssignmentCounts(start, end, requestedNames);
  return {
    rows: result.rows.map(row => ({ staff: row.staff, userUuid: row.userUuid, counts: sumCounts(Object.values(row.days)) })),
    unmatched: result.unmatched,
  };
}

export interface AssignedOrderProduct {
  uuid: string;
  orderName: string;
  productTitle: string | null;
  variantTitle: string | null;
  status: string | null;
  clientName: string | null;
  eventDate: string | null;
  /** Other stages this person also holds on the product — see deptOrderProducts. */
  otherStages: AssignmentDepartment[];
  /** A product that never counts — see isExcludedFromCounts. */
  excluded: boolean;
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

interface ListedOrderProduct {
  account: AssignableStaff;
  row: OrderProductSummaryDTO;
}

interface DeptOrderProduct {
  row: OrderProductSummaryDTO;
  otherStages: AssignmentDepartment[];
}

async function listTargetOrderProducts(
  accounts: AssignableStaff[],
  start: string,
  end: string,
): Promise<ListedOrderProduct[]> {
  const listed: ListedOrderProduct[] = [];
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
      items.forEach(row => listed.push({ account, row }));
      if (items.length < pageSize || (page.totalPages != null && pageNumber >= page.totalPages)) break;
    }
  }
  return listed;
}

// Keeps only rows where the person holds the requested department's role
// (the list spans all three roles).
function deptOrderProducts(listed: ListedOrderProduct[], department: AssignmentDepartment): DeptOrderProduct[] {
  const rows: DeptOrderProduct[] = [];
  for (const { account, row } of listed) {
    const mine = (d: AssignmentDepartment) =>
      String(row[DEPT_USER_FIELD[d]] ?? '').toLowerCase() === account.uuid.toLowerCase();
    if (!mine(department)) continue;
    // The API's date filter matches if ANY of the person's stage assignments
    // falls in range, while the counts endpoint checks only this stage's date
    // — and the list doesn't return per-stage dates. So when someone holds
    // more than one stage of a product, it may be here because of the other
    // stage (e.g. preserved last month, fulfilled today). Flag it rather than
    // guess.
    const otherStages = ASSIGNMENT_DEPARTMENTS.filter(d => d !== department && mine(d));
    rows.push({ row, otherStages });
  }
  return rows;
}

/**
 * The order products behind one person's assignment count for a date range —
 * the drill-down for Historicals' "synced" cells. Uses the list counterpart of
 * the /ForUser/Counts endpoint. Excluded products (isExcludedFromCounts) are
 * returned flagged so the drill-down can show them as not counted.
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

  const rows = deptOrderProducts(await listTargetOrderProducts(accounts, start, end), department);
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
      excluded: isExcludedFromCounts(row.productTitle),
    }))
    .sort((a, b) => a.orderName.localeCompare(b.orderName, undefined, { numeric: true }));
  return { matched: true, items };
}
