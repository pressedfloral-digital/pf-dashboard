/** Completed production uses the API's corrected effective date, never assignment dates. */
import { pfGet } from '@/lib/pf-api';
export interface OrderDetail { orderNum: string; variant: string; enteredAt: string; eventDate: string }
export interface StaffRow { staff: string; count: number; orders: OrderDetail[] }
export interface ProductionCounts { Preservation: StaffRow[]; Design: StaffRow[]; Fulfillment: StaffRow[] }
interface Completion { uuid: string; orderProductUuid: string; orderNumber: string; variantTitle?: string; eventDate: string; effectiveAt: string; status: string; staffName?: string }
const STAFF_NAME_ALIASES: Record<string, string> = {
  'Kathryn Hill':      'Kathryn Sonntag',
  'Chloe Leonard':     'Chloe Jensen',
  'Izabella De Prima': 'Bella DePrima',
  'Mia Legas':         'Mia Legas Boots',
  // PF's own history/assignment fields spell this one inconsistently
  // (lowercase k) on some orders -- Rippling and staff_locations use the
  // capital-K spelling, so that's canonical.
  'Mckell Johnson':    'McKell Johnson',
};

export function canonicalStaffName(staff: string): string {
  return STAFF_NAME_ALIASES[staff] ?? staff;
}


export async function computeProductionCounts(start: string, end: string): Promise<ProductionCounts> {
  const events = new Map<string, Completion>();
  const pageSize = 500;
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ startDate: start, endDate: end, page: String(page), pageSize: String(pageSize) });
    const rows = await pfGet<Completion[]>(`/OrderProducts/CompletedProduction?${params}`, { fresh: true });
    for (const row of rows) events.set(row.uuid, row);
    if (rows.length < pageSize) break;
  }
  function department(status: string): StaffRow[] {
    const staff = new Map<string, OrderDetail[]>();
    // A product can revisit a stage. Count each product once within the requested period.
    const products = new Map<string, Completion>();
    for (const event of events.values()) if (event.status === status) {
      const previous = products.get(event.orderProductUuid);
      if (!previous || event.effectiveAt > previous.effectiveAt) products.set(event.orderProductUuid, event);
    }
    for (const event of products.values()) {
      const name = canonicalStaffName(event.staffName?.trim() || 'Unassigned');
      const orders = staff.get(name) ?? [];
      orders.push({ orderNum: event.orderNumber, variant: event.variantTitle ?? '', eventDate: event.eventDate?.split('T')[0] ?? '',
        enteredAt: new Date(event.effectiveAt).toLocaleDateString('en-CA', { timeZone: 'America/Denver' }) });
      staff.set(name, orders);
    }
    return [...staff].map(([name, orders]) => ({ staff: name, count: orders.length, orders: orders.sort((a,b) => a.enteredAt.localeCompare(b.enteredAt)) }))
      .sort((a,b) => b.count - a.count);
  }
  return { Preservation: department('bouquetReceived'), Design: department('frameCompleted'), Fulfillment: department('readyToPackage') };
}
