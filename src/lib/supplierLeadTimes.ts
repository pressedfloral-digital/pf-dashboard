// How many weeks before the Monday stock is needed an order has to be placed
// with each supplier. Matched against the Katana default supplier name.
const LEAD_WEEKS: { match: RegExp; weeks: number }[] = [
  { match: /^border\s*(and|&)\s*square/i, weeks: 6 },
  { match: /^in\s*line\s*oval/i,          weeks: 8 },
];

// Suppliers whose items are left off the order list and stock counts entirely.
const EXCLUDED_SUPPLIERS: RegExp[] = [/^ernest/i];

export function isExcludedSupplier(supplier: string | null | undefined): boolean {
  const name = (supplier ?? '').trim();
  return EXCLUDED_SUPPLIERS.some(re => re.test(name));
}

export const DEFAULT_LEAD_WEEKS = 6;

// The longest lead time — the schedule always looks at least this far ahead,
// so late in the year next year's needs show up while there's time to order.
export const MAX_LEAD_WEEKS = Math.max(DEFAULT_LEAD_WEEKS, ...LEAD_WEEKS.map(l => l.weeks));

export function leadWeeksFor(supplier: string | null | undefined): number {
  const name = (supplier ?? '').trim();
  return LEAD_WEEKS.find(l => l.match.test(name))?.weeks ?? DEFAULT_LEAD_WEEKS;
}
