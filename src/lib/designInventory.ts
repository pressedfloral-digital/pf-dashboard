// Design inventory forecast — which real orders Design is scheduled to work
// on each upcoming week, and what frame stock each of them needs.
//
// Same FIFO idea as Queue & Turnaround (SchedulePage.tsx), but at the order
// level instead of cohort counts: every line item already in Ready to Frame
// is designable now, every line item still in Preservation becomes
// designable PRESERVATION_WEEKS after its bouquet was received, and each
// week's scheduled Design capacity (frames) is filled oldest-intake-first.

// Mirrors PRESERVATION_WEEKS in SchedulePage.tsx — minimum weeks a bouquet
// spends drying before it can be designed.
export const PRESERVATION_WEEKS = 8;

// Already in Design's queue.
export const DESIGN_QUEUE_STATUSES = new Set(['readyToFrame', 'readyToDesign']);
// Still drying; will graduate into Design's queue.
export const PRESERVATION_STATUSES = new Set(['bouquetReceived', 'checkedOn', 'progress', 'almostReadyToFrame']);

// Line items that ride along on an order but aren't anything Design builds —
// counting them would eat design capacity and pad the inventory list.
export const NON_DESIGN_PRODUCTS = new Set(['Floral Preservation Deposit', 'Pre-paid Overnight Shipping Label']);

const SHAPES = new Set(['Rectangle', 'Oval', 'Square', 'Round', 'Circle', 'Heart', 'Arch']);
const SIZE_RE = /^\d+(\.\d+)?x\d+(\.\d+)?$/;

export interface VariantParts {
  shape:   string;
  size:    string;
  finish:  string;
  options: string;
}

// Shopify variant titles are "Shape / Size / Finish" for most frames, but not
// consistently — some drop the size ("Rectangle / Walnut Brown") and
// ornaments/boutonnieres use their own option order ("Toasted Walnut / Green /
// Send your own"). Pick out what's recognizable and keep the rest verbatim.
export function parseVariant(variantTitle: string | null | undefined): VariantParts {
  const parts = variantTitle && variantTitle !== 'Default Title'
    ? variantTitle.split(' / ').map(p => p.trim()).filter(Boolean)
    : [];
  let shape = '', size = '', finish = '';
  const rest: string[] = [];
  for (const p of parts) {
    if (!shape && SHAPES.has(p)) shape = p;
    else if (!size && SIZE_RE.test(p)) size = p;
    else if (!finish) finish = p;
    else rest.push(p);
  }
  return { shape, size, finish, options: rest.join(' / ') };
}

export interface QueueLine extends VariantParts {
  orderNumber:  string;
  customer:     string;
  product:      string;
  variant:      string;
  status:       string;
  intakeDate:   string;                          // YYYY-MM-DD
  intakeSource: 'bouquetReceived' | 'eventDate'; // eventDate = no received date on record
  designableWeek: string;                        // Monday this line can first be designed
  materials?: Materials;                         // filled in once the line is scheduled
}

// ── Backing & glass ──────────────────────────────────────────────────────────
// Backing and glass are separate non-status add-on products on the order
// ("Backing: Rectangle / 16x20 / Linen", "Glass: Rectangle / 16x20 / Art
// Glass"), one per frame, identified only by shape and size — so each frame
// is paired with an unused add-on in the same order with the same shape/size.
// A few custom products carry them in their own variant instead.

export interface OrderAddOn {
  uuid:          string;
  productTitle:  string;
  variantTitle:  string | null;
}

// Products with no backing or glass at all.
const NO_BACKING_GLASS = new Set(['Custom Ornament', 'Custom Mini Frame']);
// Products whose own variant is "Color / Backing / Glass".
const BACKING_GLASS_IN_VARIANT = new Set(['Custom Square Single', 'Custom Footprint Frame']);

export const NOT_ON_ORDER = 'Not on order';

export interface Materials {
  sizeLabel: string;         // "16x20", or the product name when it has no size (Boutonniere, Custom Square Single…)
  backing:   string | null;  // null = product has no backing
  glass:     string | null;  // null = product has no glass
}

export function sizeLabel(line: Pick<QueueLine, 'product' | 'size'>): string {
  if (line.size) return line.size;
  if (line.product.startsWith('Boutonniere')) return 'Boutonniere';
  return line.product === 'Pressed Frame' ? '—' : line.product;
}

function lastPart(v: string | null): string {
  const parts = (v ?? '').split(' / ').map(p => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// Pairs every line with its backing and glass. `used` is shared across all
// of one order's lines so two same-size frames never claim the same add-on.
export function matchMaterials(line: QueueLine, addOns: OrderAddOn[], used: Set<string>): Materials {
  const label = sizeLabel(line);
  if (NO_BACKING_GLASS.has(line.product)) return { sizeLabel: label, backing: null, glass: null };

  const opts = line.variant.split(' / ').map(p => p.trim());
  if (BACKING_GLASS_IN_VARIANT.has(line.product)) {
    return { sizeLabel: label, backing: opts[1] || NOT_ON_ORDER, glass: opts[2] || NOT_ON_ORDER };
  }
  if (line.product === 'Custom Paw Print Frame') {
    return { sizeLabel: label, backing: NOT_ON_ORDER, glass: opts[1] || NOT_ON_ORDER };
  }

  const boutonniere = line.product.startsWith('Boutonniere');
  const pick = (titles: string[]) => {
    const match = addOns.find(a => {
      if (used.has(a.uuid) || !titles.includes(a.productTitle)) return false;
      const { shape, size } = parseVariant(a.variantTitle);
      return (!line.shape || !shape || shape === line.shape) && (!line.size || !size || size === line.size);
    });
    if (!match) return NOT_ON_ORDER;
    used.add(match.uuid);
    return lastPart(match.variantTitle) || NOT_ON_ORDER;
  };
  return {
    sizeLabel: label,
    backing: pick(boutonniere ? ['Boutonniere Backing'] : ['Backing', 'Frame Backing']),
    glass:   pick(boutonniere ? ['Boutonniere Glass']   : ['Glass', 'Frame Glass']),
  };
}

export interface InventoryWeek {
  weekOf:   string;
  capacity: number;
  lines:    QueueLine[];
}

export function mondayOf(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function addWeeks(iso: string, weeks: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// Fill each week's capacity from the oldest designable intake forward.
// Capacity is fractional frames (hours / ratio); a week takes whole line
// items up to its rounded capacity.
export function scheduleLines(lines: QueueLine[], weeks: { weekOf: string; capacity: number }[]): { weeks: InventoryWeek[]; unscheduled: QueueLine[] } {
  const queue = [...lines].sort((a, b) =>
    a.intakeDate.localeCompare(b.intakeDate) || a.orderNumber.localeCompare(b.orderNumber, undefined, { numeric: true }));
  const taken = new Set<QueueLine>();
  const out = weeks.map(({ weekOf, capacity }) => {
    const slots = Math.max(0, Math.round(capacity));
    const picked: QueueLine[] = [];
    for (const line of queue) {
      if (picked.length >= slots) break;
      if (taken.has(line) || line.designableWeek > weekOf) continue;
      picked.push(line);
      taken.add(line);
    }
    return { weekOf, capacity: slots, lines: picked };
  });
  return { weeks: out, unscheduled: queue.filter(l => !taken.has(l)) };
}
