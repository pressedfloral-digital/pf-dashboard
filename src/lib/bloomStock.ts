import type { ScheduleRule } from '@/lib/scheduleResolution';

// Bloom-stock products — Handprint / Paw Print / Footprint frames and Bloom
// Arrangement Recreation. They're made from Pressed Floral's own pressed
// flower stock, so unlike custom (sent-in) bouquets there's no drying /
// preservation stage: an order is ready to work the day it's placed, worked
// oldest order date first. Utah designers do them as an extra part of their
// role, under the separate Bloom Stock Products department (see
// BloomStockPage.tsx).
//
// Note: Bloom Arrangement Recreation stays excluded from the main production
// counts (see assignment-counts.ts) — this queue is its own separate view.

export type BloomStockProductKey = 'handprint' | 'pawprint' | 'footprint' | 'recreation';

// assumeFulfilledBefore: orders placed before this date (YYYY-MM-DD) are
// treated as already completed even if Shopify still shows the line item
// unfulfilled — older recreations/footprints were finished but never marked
// fulfilled, and would otherwise sit at the front of the queue (ops call,
// 2026-10-16).
export const BLOOM_STOCK_PRODUCTS: { key: BloomStockProductKey; productId: string; label: string; assumeFulfilledBefore?: string }[] = [
  { key: 'handprint',  productId: '8410988609706', label: 'Handprint Frame' },
  { key: 'pawprint',   productId: '8411931345066', label: 'Paw Print Frame' },
  { key: 'footprint',  productId: '8256519962794', label: 'Footprint Frame',              assumeFulfilledBefore: '2026-06-01' },
  { key: 'recreation', productId: '8115685195946', label: 'Bloom Arrangement Recreation', assumeFulfilledBefore: '2026-06-01' },
];

// Products a recreation can be sold as when a regular order is switched to a
// recreation after purchase (lost/moldy blooms, a later change of mind).
// They're Design's normal products, so they never join this queue on their
// own — only when the team adds that order on the Orders board.
export const SWITCHABLE_PRODUCT_IDS = new Set([
  '8036184785066',  // Pressed Frame
  '8256544800938',  // Custom Mini Frame
  '8352467845290',  // Boutonniere Frame
  '8040966193322',  // Custom Ornament
]);

export const BLOOM_STOCK_LABEL: Record<BloomStockProductKey, string> = Object.fromEntries(
  BLOOM_STOCK_PRODUCTS.map(p => [p.key, p.label])
) as Record<BloomStockProductKey, string>;

export const productByShopifyId = new Map(BLOOM_STOCK_PRODUCTS.map(p => [p.productId, p]));

export const emptyByProduct = (): Record<BloomStockProductKey, number> =>
  ({ handprint: 0, pawprint: 0, footprint: 0, recreation: 0 });

// Workflow status, mirroring the sections of the team's old tracking sheet.
// Only new / ready / influencer count toward the work queue — waiting (on
// the customer's own blooms or prints), hold and finished don't.
export type BloomStockStatus = 'new' | 'ready' | 'waiting' | 'hold' | 'influencer' | 'finished';
export const BLOOM_STOCK_STATUSES: { key: BloomStockStatus; label: string }[] = [
  { key: 'new',        label: 'New Orders' },
  { key: 'ready',      label: 'Ready to Design' },
  { key: 'waiting',    label: 'Waiting' },
  { key: 'hold',       label: 'Holding' },
  { key: 'influencer', label: 'Influencer' },
  { key: 'finished',   label: 'Finished' },
];
export const QUEUE_STATUSES = new Set<BloomStockStatus>(['new', 'ready', 'influencer']);

// recreation = made from bloom stock ("Help me customize" / "Recreate from a
// photo"); standard = customer sends their own blooms ("I'll send in my own").
export type BloomStockType = 'recreation' | 'standard' | 'rainbow';
export const BLOOM_STOCK_TYPE_LABEL: Record<BloomStockType, string> = { recreation: 'Recreation', standard: 'Standard', rainbow: 'Rainbow' };

// "Blooms Process" add-on variants (Shopify title search, 2026-10-18).
export const SEND_OWN_VARIANT_IDS = new Set([
  '46803740393642',  // Blooms Process — Send your own
  '47489459060906',  // Blooms Process Footprint — I'll send in my own
  '48176285450410',  // Blooms Process Paw Print — I'll send in my own
  '48191500189866',  // Blooms Process Handprint — I'll send in my own
]);
export const RECREATE_VARIANT_IDS = new Set([
  '46803740426410',  // Blooms Process — Recreate based off a photo
  '47489459093674',  // Blooms Process Footprint — Help me customize after purchase
  '48176285483178',  // Blooms Process Paw Print — Help me customize after purchase
  '48191500222634',  // Blooms Process Handprint — Help me customize after purchase
]);

export interface BloomStockQueueItem {
  lineItemId:   string;
  orderId:      string;   // Shopify legacy order id, for the admin link
  orderNumber:  string;   // e.g. "#41234"
  orderDate:    string;   // YYYY-MM-DD, Utah calendar day
  productKey:   BloomStockProductKey;
  variantTitle: string | null;
  quantity:     number;   // still-open units (unfulfilled minus logged complete)
  location:     'Utah' | 'Georgia' | null;  // order's location tag, if any
  eventDate:    string | null;
  customer:     string | null;
  // From Shopify's Blooms Process add-on, unless the team overrode it.
  type:         BloomStockType | null;
  status:       BloomStockStatus;
  assignee:     string | null;
  notes:        string | null;
  // False until someone on the team has touched this order on the board —
  // new Shopify orders arrive unsorted and are flagged for review.
  sorted:       boolean;
  // Placed before the product's assumeFulfilledBefore date and never given a
  // status by the team — treated as done, hidden from the queue math.
  assumedDone:  boolean;
}

export interface BloomStockQueueResponse {
  items:       BloomStockQueueItem[];
  // Units ordered per ISO-Monday order week over the recent lookback, every
  // order regardless of fulfillment — the baseline intake pace for the
  // 52-week projection.
  intakeByWeek: { weekOf: string; byProduct: Record<BloomStockProductKey, number> }[];
  // Recreations sold as another product and switched later (tracked on the
  // board), by original order week — forecast separately at their recent pace.
  switchedByWeek: { weekOf: string; units: number }[];
  fetchedAt:   string;
  storeDomain: string;
}

// Utah settings (schedule_settings) ──────────────────────────────────────────

// A Bloom Stock Products roster member. standardWeeklyHours is their
// standing Mon–Sun template (one-off weeks override it via
// bloomStockDailyHours). Pay isn't stored here — CPO reads it from the
// Rippling upload by name.
export interface BloomStockMember {
  id:           string;
  name:         string;
  role?:        'specialist' | 'senior' | 'master';
  // Hours per item. Set by hand, or refreshed from the last 8 weeks of
  // Bloom Stock Historicals (↻, and automatically once a week —
  // ratioUpdatedWeek is the ISO Monday of the last automatic refresh).
  ratio?:       number;
  ratioUpdatedWeek?: string;
  standardWeeklyHours?: number[];
  startDate?:   string;
  endDate?:     string;
  // Date-bounded, toggleable replacements for standardWeeklyHours — see scheduleResolution.ts.
  scheduleRules?: ScheduleRule[];
  // ISO dates marked off on the Time Off calendar — see EmploymentWindow.daysOff.
  daysOff?: string[];
  // ISO date → hours off that day (partial day off) — see EmploymentWindow.hoursOff.
  hoursOff?: Record<string, number>;
}

export const DEFAULT_BLOOM_STOCK_ROSTER: BloomStockMember[] = [
  { id: 'bs-1', name: 'Jennika Merrill', standardWeeklyHours: [3, 3, 3, 3, 3, 0, 0] },
  { id: 'bs-2', name: 'Mia Legas Boots', standardWeeklyHours: [6, 6, 6, 6, 6, 0, 0] },
];

// A what-if launch: extra orders per week for a product that doesn't exist
// yet (or a promo spike on an existing one), worked by the same team at the
// same single ratio.
export interface BloomStockScenario {
  id:           string;
  name:         string;
  startWeek:    string;  // ISO Monday, first order week
  endWeek:      string;  // ISO Monday, last order week (inclusive)
  unitsPerWeek: number;
  enabled:      boolean;
}

// "Everything ordered before orderCutoff is finished by dueBy?"
export interface BloomStockDeadline {
  orderCutoff: string;  // YYYY-MM-DD, orders placed before this date
  dueBy:       string;  // YYYY-MM-DD, must be finished by this date
}

// ─── Projection ───────────────────────────────────────────────────────────────

// FIFO, week 0 = this week, all in items (hours ÷ the single ratio).
// backlog is items already ordered; intake[w] items ordered during week w;
// capacity[w] items the scheduled hours can finish in week w. For orders placed in week w, returns the week index in
// which their last unit is finished (null = not within the horizon). Orders
// placed in a week can be worked that same week — no drying stage.
export function bloomStockDoneWeeks(backlog: number, intake: number[], capacity: number[]): (number | null)[] {
  const cumCap: number[] = [];
  capacity.reduce((s, c, i) => (cumCap[i] = s + c), 0);
  let demand = backlog;
  return intake.map((h, w) => {
    demand += h;
    if (demand <= 1e-9) return w;
    for (let t = w; t < cumCap.length; t++) if (cumCap[t] >= demand - 1e-9) return t;
    return null;
  });
}

// ─── Seasonal order forecast ──────────────────────────────────────────────────
//
// Same idea as Design's bouquet-arrival estimate (last year × growth), done
// per product because they launched at different times:
//   forecast(week) = last year's same week (5-week centred average, so one
//                    odd week doesn't swing it) × that product's growth
//   growth         = its last 12 weeks ÷ the same 12 weeks a year earlier
//                    (clamped 0.5–3)
// A product without a real year of history (fewer than
// SEASONAL_MIN_LY_ORDERS in last year's matching 12 weeks — e.g. Footprint,
// launched Oct 2025, or Handprint/Paw Print, Apr 2026) uses its own trailing
// 8-week average instead, so a launch trickle doesn't become a 3× growth rate.
const SEASONAL_MIN_LY_ORDERS = 10;

export interface BloomStockForecastBasis {
  method:     'seasonal' | 'recent';
  growth?:    number;   // seasonal only
  lastYear?:  number;   // seasonal only: smoothed same-week-last-year units
}
export interface BloomStockWeekForecast {
  byProduct: Record<BloomStockProductKey, number>;
  switched:  number;   // switched recreations (8-week average), included in total
  total:     number;
  basis:     Record<BloomStockProductKey, BloomStockForecastBasis>;
}

function addWeeksIso(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n * 7);
  return d.toISOString().split('T')[0];
}

export function forecastBloomStockWeek(
  history: Map<string, Record<BloomStockProductKey, number>>,  // ISO Monday → units ordered
  weekIso: string,
  thisMonday: string,
  switchedHistory: Map<string, number> = new Map(),
): BloomStockWeekForecast {
  const at = (w: string, k: BloomStockProductKey) => history.get(w)?.[k] ?? 0;
  const sumWeeks = (from: string, offsets: number[], k: BloomStockProductKey) =>
    offsets.reduce((t, o) => t + at(addWeeksIso(from, o), k), 0);
  const last12 = Array.from({ length: 12 }, (_, i) => -(i + 1));
  const last8 = Array.from({ length: 8 }, (_, i) => -(i + 1));

  const byProduct = emptyByProduct();
  const basis = {} as Record<BloomStockProductKey, BloomStockForecastBasis>;
  for (const p of BLOOM_STOCK_PRODUCTS) {
    const recent = sumWeeks(thisMonday, last12, p.key);
    const recentLY = sumWeeks(addWeeksIso(thisMonday, -52), last12, p.key);
    if (recentLY >= SEASONAL_MIN_LY_ORDERS) {
      const growth = Math.min(3, Math.max(0.5, recent / recentLY));
      const lastYear = sumWeeks(addWeeksIso(weekIso, -52), [-2, -1, 0, 1, 2], p.key) / 5;
      byProduct[p.key] = lastYear * growth;
      basis[p.key] = { method: 'seasonal', growth: Math.round(growth * 100) / 100, lastYear: Math.round(lastYear * 10) / 10 };
    } else {
      byProduct[p.key] = sumWeeks(thisMonday, last8, p.key) / 8;
      basis[p.key] = { method: 'recent' };
    }
  }
  const switched = last8.reduce((t, o) => t + (switchedHistory.get(addWeeksIso(thisMonday, o)) ?? 0), 0) / 8;
  return { byProduct, switched, total: BLOOM_STOCK_PRODUCTS.reduce((t, p) => t + byProduct[p.key], 0) + switched, basis };
}
