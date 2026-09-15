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

function resolveRequestedStaff(
  staff: AssignableStaff[],
  requestedNames?: string[],
): { targets: { requestedName: string; staff: AssignableStaff }[]; unmatched: string[] } {
  if (!requestedNames) {
    return {
      targets: staff.map(person => ({ requestedName: person.name, staff: person })),
      unmatched: [],
    };
  }

  const byName = new Map<string, AssignableStaff>();
  staff.forEach(person => {
    const key = normalizeAssignmentStaffName(person.name);
    if (key && !byName.has(key)) byName.set(key, person);
  });

  const targets: { requestedName: string; staff: AssignableStaff }[] = [];
  const unmatched: string[] = [];
  [...new Set(requestedNames.map(name => name.trim()).filter(Boolean))].forEach(requestedName => {
    const person = byName.get(normalizeAssignmentStaffName(requestedName));
    if (person) targets.push({ requestedName, staff: person });
    else unmatched.push(requestedName);
  });
  return { targets, unmatched };
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
    userUuid: target.staff.uuid,
    counts: await fetchAssignmentCounts(target.staff.uuid, start, end),
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
    uuid: job.target.staff.uuid,
    date: job.date,
    counts: await fetchAssignmentCounts(job.target.staff.uuid, job.date, job.date),
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
