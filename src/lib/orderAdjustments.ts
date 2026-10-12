// Manager adjustments to auto-synced Historicals order counts — an order
// number added that the sync missed, or one removed that it shouldn't have
// counted. Stored in order_count_adjustments, keyed exactly like the
// team_member_week_actuals row they adjust.
//
// actual_orders (what every rollup reads) = synced_orders + net adjustments.
// The sync (cron/sync-production-actuals) refreshes synced_orders and re-applies
// the adjustments; /api/order-adjustments re-applies them on every change.
//
// No server imports here — HistoricalsSection uses these helpers client-side.

export interface OrderAdjustment {
  id:              string;
  location:        string;
  department:      string;
  week_of:         string;
  member_name:     string;
  order_name:      string;
  action:          'add' | 'remove';
  products:        number;
  note:            string | null;
  created_by_name: string | null;
  created_at:      string;
}

export const adjustmentRowKey = (location: string, department: string, weekOf: string, memberName: string) =>
  `${location}|${department}|${weekOf}|${memberName}`;

export function netAdjustment(adjustments: Pick<OrderAdjustment, 'action' | 'products'>[]): number {
  return adjustments.reduce((s, a) => s + (a.action === 'add' ? Number(a.products) : -Number(a.products)), 0);
}

/** Normalizes "#43515", " 43515 " and "43515" to "#43515". */
export function normalizeOrderName(raw: string): string {
  const trimmed = raw.trim().replace(/^#+/, '');
  return trimmed ? `#${trimmed}` : '';
}
