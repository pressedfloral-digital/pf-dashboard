// Turns the Design schedule into a weekly purchasing list using Katana.
//
// Every scheduled line (the frame itself, plus its Backing and Glass add-ons)
// is matched to a Katana product variant, its recipe is exploded into
// components (frame mouldings, glass panes, linen, foam core, tape…), and
// each week's component demand is drawn down against Katana stock. Whatever
// a week can't cover from stock + open purchase orders is what still needs
// to be ordered for that week.
//
// Lines already designed but not shipped (DESIGNED_STATUSES) are exploded the
// same way and taken out of Katana stock first: their frames, backing and
// glass are built into a piece, but Katana only removes them at fulfillment.

import type { KatanaData, KatanaItem, KatanaVariant } from './katana';
import { addWeeks, type QueueLine } from './designInventory';
import { leadWeeksFor, isExcludedSupplier } from './supplierLeadTimes';

// ── Matching order products to Katana variants ───────────────────────────────

const norm = (s: string | null | undefined) => (s ?? '').replace(/[™®]/g, '').trim().toLowerCase();

// Shopify product titles whose Katana product is named differently.
// `implied` fills in an option the Shopify variant leaves out.
const PRODUCT_ALIASES: Record<string, { names: string[]; implied?: string[] }> = {
  'bloom arrangement recreation': { names: ['bloom arrangment recreation'] },
  'custom pressed frame':         { names: ['pressed frame'] },
  'frame backing':                { names: ['backing'] },
  'boutonniere backing':          { names: ['backing'], implied: ['6x8'] },
};

// Shopify option values that Katana spells differently.
const VALUE_ALIASES: Record<string, string> = {
  'black': 'sleek black',
};

// "Regular Glass" (Shopify) ↔ "Regular" (Katana Boutonniere Glass), etc.
function sameValue(shopify: string, katana: string): boolean {
  const a = VALUE_ALIASES[shopify] ?? shopify;
  return a === katana || a.replace(/ glass$/, '') === katana.replace(/ glass$/, '');
}

export interface KatanaIndex {
  variants:      Map<number, KatanaVariant>;
  items:         Map<number, KatanaItem>;          // by product/material id
  recipes:       Map<number, { variantId: number; quantity: number }[]>;
  productsByName: Map<string, KatanaVariant[]>;
}

export function buildIndex(k: KatanaData): KatanaIndex {
  const variants = new Map<number, KatanaVariant>();
  const items = new Map<number, KatanaItem>();
  const productsByName = new Map<string, KatanaVariant[]>();
  for (const it of [...k.products, ...k.materials]) {
    if (it.deleted_at) continue;
    items.set(it.id, it);
    for (const v of it.variants) variants.set(v.id, v);
  }
  for (const p of k.products) {
    if (p.deleted_at || p.archived_at) continue;
    const key = norm(p.name);
    productsByName.set(key, [...(productsByName.get(key) ?? []), ...p.variants]);
  }
  const recipes = new Map<number, { variantId: number; quantity: number }[]>();
  for (const r of k.bomRows) {
    const list = recipes.get(r.product_variant_id) ?? [];
    list.push({ variantId: r.ingredient_variant_id, quantity: Number(r.quantity) || 0 });
    recipes.set(r.product_variant_id, list);
  }
  return { variants, items, recipes, productsByName };
}

// Boutonnieres are 6x8 pieces in Katana. When Katana has no boutonniere
// version of an add-on (e.g. no Boutonniere Glass *set*), use the regular
// 6x8 product's recipe.
const BOUTONNIERE_SIZE_FALLBACK: Record<string, string> = {
  'boutonniere glass':   'glass',
  'boutonniere backing': 'backing',
  'boutonniere frame':   'pressed frame',
};

// Colors Katana has no variant for, built from the closest color's recipe.
// Antique Gold Floral pieces use Antique Gold sticks/minis elsewhere in
// Katana, and there's no Antique Gold Floral 8x8 Square Single frame.
const COLOR_STANDINS: Record<string, string> = {
  'antique gold floral': 'antique gold',
};

function katanaNames(title: string, parts: string[]): { names: string[]; implied: string[] } {
  if (title === 'glass' || title === 'frame glass') {
    return { names: [parts.some(p => p.startsWith('art glass')) ? 'art glass' : 'regular glass'], implied: [] };
  }
  const alias = PRODUCT_ALIASES[title];
  return alias ? { names: [title, ...alias.names], implied: alias.implied ?? [] } : { names: [title], implied: [] };
}

// Every wanted option must appear on the Katana variant; Katana may carry
// extra options (Boutonniere Frame has a fixed 6x8 size), but only when
// exactly one variant fits — otherwise nothing is guessed. Variants with a
// recipe win over ones without.
function findVariant(idx: KatanaIndex, names: string[], wanted: string[], loose: boolean): KatanaVariant | null {
  // Loose: "Walnut Brown Wide Moulding" (Shopify) ↔ "Walnut Brown Moulding" (Katana boutonniere).
  const fold = (s: string) => loose ? s.replace(/ wide /, ' ') : s;
  let best: { v: KatanaVariant; score: number }[] = [];
  for (const name of names) {
    for (const v of idx.productsByName.get(name) ?? []) {
      const values = v.config_attributes.map(a => norm(a.config_value));
      if (!wanted.every(w => values.some(val => sameValue(fold(w), fold(val))))) continue;
      const score = (idx.recipes.has(v.id) ? 100 : 0) - (values.length - wanted.length);
      if (!best.length || score > best[0].score) best = [{ v, score }];
      else if (score === best[0].score) best.push({ v, score });
    }
    if (best.length) break;
  }
  return best.length === 1 ? best[0].v : null;
}

export interface VariantMatch {
  variant:     KatanaVariant;
  substituted: boolean;  // matched through a fallback, not an exact Katana variant
}

// Finds the Katana variant for a Shopify product + variant title: an exact
// match first, then the fallbacks above, in order.
export function matchVariant(idx: KatanaIndex, productTitle: string, variantTitle: string | null | undefined): VariantMatch | null {
  const title = norm(productTitle);
  const parts = (variantTitle && variantTitle !== 'Default Title' ? variantTitle.split(' / ') : []).map(norm).filter(Boolean);
  const { names, implied } = katanaNames(title, parts);
  const wanted = [...parts, ...implied];
  const withRecipe = (v: KatanaVariant | null) => v && idx.recipes.has(v.id) ? v : null;

  const exact = findVariant(idx, names, wanted, false);
  if (withRecipe(exact)) return { variant: exact!, substituted: false };

  const attempts: (() => KatanaVariant | null)[] = [
    () => findVariant(idx, names, wanted, true),
    () => {
      const fb = BOUTONNIERE_SIZE_FALLBACK[title];
      if (!fb) return null;
      const n = katanaNames(fb, parts);
      return findVariant(idx, n.names, [...parts.filter(p => p !== 'boutonniere'), '6x8'], true);
    },
    () => {
      if (!wanted.some(w => COLOR_STANDINS[w])) return null;
      return findVariant(idx, names, wanted.map(w => COLOR_STANDINS[w] ?? w), true);
    },
  ];
  for (const attempt of attempts) {
    const v = withRecipe(attempt());
    if (v) return { variant: v, substituted: true };
  }
  return exact ? { variant: exact, substituted: false } : null;
}

// Recipe → leaf components. Sub-assemblies (an ingredient with its own
// recipe) are exploded too; anything without a recipe is a stocked item.
export function explode(idx: KatanaIndex, variantId: number, qty: number, out: Map<number, number>, depth = 0): void {
  const recipe = idx.recipes.get(variantId);
  if (!recipe || depth > 5) {
    out.set(variantId, (out.get(variantId) ?? 0) + qty);
    return;
  }
  for (const r of recipe) explode(idx, r.variantId, qty * r.quantity, out, depth + 1);
}

export function variantLabel(idx: KatanaIndex, v: KatanaVariant): { name: string; options: string } {
  const item = idx.items.get((v.product_id ?? v.material_id)!);
  return { name: item?.name ?? `Variant ${v.id}`, options: v.config_attributes.map(a => a.config_value).join(' / ') };
}

// ── Weekly plan ──────────────────────────────────────────────────────────────

export interface PlanRow {
  variantId:   number;
  sku:         string | null;
  name:        string;
  options:     string;
  category:    string;
  uom:         string;
  purchaseUom: string | null;
  purchaseConversion: number | null;  // uom per purchase uom (e.g. 5500 yards per roll)
  supplier:    string | null;
  supplierId:  number | null;
  leadWeeks:   number;                // weeks before the needed Monday the order must be placed
  orderBy:     string | null;         // Monday the first shortfall must be ordered by
  orderNowQty: number;                // shortfall whose order-by date is this week or already past
  purchasePrice: number;              // Katana purchase price per stock unit
  inStock:     number;                // available: Katana stock minus alreadyUsed, never below 0
  katanaStock?: number;               // Katana's on-hand figure (never below 0 — see negativeStock)
  alreadyUsed?: number;               // built into designed, not-yet-shipped pieces
  negativeStock: number | null;       // Katana's raw figure when it's below zero
  onOrder:     number;                // Katana "expected" — open purchase / manufacturing orders
  needed:      Record<string, number>; // weekOf → quantity Design will use
  toOrder:     Record<string, number>; // weekOf → shortfall first hit that week
  totalNeeded: number;
  totalToOrder: number;
  firstShortWeek: string | null;
  computedToOrder?: number;          // set when the quantity was edited by hand — what the recipes said
  removed?:    boolean;              // taken off the order list by hand
  edit?:       OrderEdit;            // who edited it and when
}

// Hand edits to the order list, saved per location in schedule_settings
// (key ORDER_EDITS_KEY) as { [variantId]: OrderEdit }.
export const ORDER_EDITS_KEY = 'inventoryOrderEdits';

export interface OrderEdit {
  qty?:     number;    // total to order, in the component's Katana stock unit
  removed?: boolean;
  by:       string;
  at:       string;    // ISO timestamp
}

export type OrderEdits = Record<string, OrderEdit>;

export interface Unmatched {
  product:  string;
  variant:  string;
  reason:   'no Katana product' | 'no recipe in Katana';
  count:    number;
}

export interface Substitution {
  product:  string;
  variant:  string;
  katana:   string;   // the Katana product + options whose recipe was used
  count:    number;
}

// One Katana component used by designed, not-yet-shipped pieces.
export interface UsedRow {
  variantId:   number;
  sku:         string | null;
  name:        string;
  options:     string;
  category:    string;
  uom:         string;
  katanaStock: number;          // never below 0
  negativeStock: number | null;
  used:        number;
  available:   number;          // katanaStock - used, never below 0
  overUsed:    number;          // how far used exceeds Katana stock (0 normally)
  lines:       number;          // designed lines that use it
}

export interface UsedSummary {
  rows:         UsedRow[];
  unmatched:    Unmatched[];
  substitutions: Substitution[];
  matchedLines: number;
  totalLines:   number;
  unknownAddOnLines: number;
}

export interface OrderPlan {
  location:   string;
  weeks:      string[];   // design weeks with scheduled work
  through:    string;     // last Monday the plan covers (the last week with scheduled orders, at least Dec 31's week)
  rows:       PlanRow[];
  unmatched:  Unmatched[];
  substitutions: Substitution[];
  matchedLines: number;
  totalLines:   number;
  // Lines whose order add-ons couldn't be loaded: their backing and glass are
  // missing from the quantities above, not known to be absent.
  unknownAddOnLines: number;
  // Absent on copies saved before designed pieces were subtracted.
  used?: UsedSummary;
}

interface PlanWeek { weekOf: string; lines: QueueLine[] }

const round = (n: number) => Math.round(n * 100) / 100;

export function buildOrderPlan(k: KatanaData, location: string, weeks: PlanWeek[], thisWeek: string, designedLines: QueueLine[] = []): OrderPlan {
  const idx = buildIndex(k);
  const suppliers = new Map(k.suppliers.map(s => [s.id, s.name]));
  const stock = new Map(k.stock.filter(s => s.location_id === k.locationId).map(s => [s.variant_id, s]));

  // Explodes one order product into `sink` (variantId → quantity), noting
  // products with no Katana match/recipe and stand-in recipes.
  const tracker = () => ({ unmatched: new Map<string, Unmatched>(), substitutions: new Map<string, Substitution>() });
  const addProduct = (t: ReturnType<typeof tracker>, sink: (id: number, q: number) => void, product: string, variant: string): boolean => {
    // Glass backing is the back pane of the Glass add-on's set — nothing
    // extra to build, so it's neither demand nor an unmatched product.
    if (/backing$/i.test(product) && /(^| \/ )glass$/i.test(variant.trim())) return true;
    const m = matchVariant(idx, product, variant);
    const v = m?.variant;
    const reason = !v ? 'no Katana product' : !idx.recipes.has(v.id) ? 'no recipe in Katana' : null;
    if (reason) {
      const key = `${product}|${variant}|${reason}`;
      const u = t.unmatched.get(key) ?? { product, variant, reason, count: 0 };
      u.count++;
      t.unmatched.set(key, u);
      return false;
    }
    if (m!.substituted) {
      const l = variantLabel(idx, v!);
      const katana = l.options ? `${l.name} · ${l.options}` : l.name;
      const key = `${product}|${variant}`;
      const sub = t.substitutions.get(key) ?? { product, variant, katana, count: 0 };
      sub.count++;
      t.substitutions.set(key, sub);
    }
    const parts = new Map<number, number>();
    explode(idx, v!.id, 1, parts);
    parts.forEach((q, id) => sink(id, q));
    return true;
  };
  // A line plus its matched backing and glass add-ons.
  const addLine = (t: ReturnType<typeof tracker>, sink: (id: number, q: number) => void, line: QueueLine): boolean => {
    const ok = addProduct(t, sink, line.product, line.variant);
    const { backingAddOn, glassAddOn } = line.materials ?? {};
    if (backingAddOn) addProduct(t, sink, backingAddOn.productTitle, backingAddOn.variantTitle ?? '');
    if (glassAddOn)   addProduct(t, sink, glassAddOn.productTitle, glassAddOn.variantTitle ?? '');
    return ok;
  };

  // ── Already designed, not shipped: comes out of Katana stock first ──
  const usedTrack = tracker();
  const usedQty = new Map<number, number>();
  const usedLineCount = new Map<number, number>();
  let usedMatched = 0, usedUnknownAddOns = 0;
  for (const line of designedLines) {
    const touched = new Set<number>();
    if (addLine(usedTrack, (id, q) => { usedQty.set(id, (usedQty.get(id) ?? 0) + q); touched.add(id); }, line)) usedMatched++;
    touched.forEach(id => usedLineCount.set(id, (usedLineCount.get(id) ?? 0) + 1));
    if (line.materials?.addOnsUnknown) usedUnknownAddOns++;
  }

  // ── Scheduled demand ──
  const demandTrack = tracker();
  const demand = new Map<number, Record<string, number>>();
  let matchedLines = 0, totalLines = 0, unknownAddOnLines = 0;
  for (const w of weeks) {
    const sink = (id: number, q: number) => {
      const row = demand.get(id) ?? {};
      row[w.weekOf] = (row[w.weekOf] ?? 0) + q;
      demand.set(id, row);
    };
    for (const line of w.lines) {
      totalLines++;
      if (addLine(demandTrack, sink, line)) matchedLines++;
      if (line.materials?.addOnsUnknown) unknownAddOnLines++;
    }
  }
  const { unmatched, substitutions } = demandTrack;

  // Katana on hand (negative is a bookkeeping gap — counted as empty), less
  // what designed pieces already hold.
  const stockFor = (variantId: number) => {
    const s = stock.get(variantId);
    const raw = Number(s?.quantity_in_stock ?? 0);
    const katanaStock = Math.max(0, raw);
    const used = round(usedQty.get(variantId) ?? 0);
    return { katanaStock, raw, used, available: Math.max(0, round(katanaStock - used)), overUsed: Math.max(0, round(used - katanaStock)) };
  };

  const rows: PlanRow[] = [];
  demand.forEach((needed, variantId) => {
    const v = idx.variants.get(variantId);
    const item = v ? idx.items.get((v.product_id ?? v.material_id)!) : undefined;
    const s = stock.get(variantId);
    const { katanaStock, raw: rawStock, used: alreadyUsed, available: inStock } = stockFor(variantId);
    const onOrder = Number(s?.quantity_expected ?? 0);

    // Draw each week's use down from stock + incoming; any week that pushes
    // the balance further below zero needs that much more ordered.
    let balance = inStock + onOrder;
    let short = 0;
    let firstShortWeek: string | null = null;
    const toOrder: Record<string, number> = {};
    for (const w of weeks) {
      const use = needed[w.weekOf] ?? 0;
      if (!use) continue;
      balance -= use;
      const nowShort = Math.max(0, -balance);
      if (nowShort > short) {
        toOrder[w.weekOf] = round(nowShort - short);
        firstShortWeek ??= w.weekOf;
        short = nowShort;
      }
    }
    Object.keys(needed).forEach(wk => { needed[wk] = round(needed[wk]); });

    const label = v ? variantLabel(idx, v) : { name: `Variant ${variantId}`, options: '' };
    const conversion = Number(item?.purchase_uom_conversion_rate);
    const supplier = item?.default_supplier_id ? suppliers.get(item.default_supplier_id) ?? null : null;
    if (isExcludedSupplier(supplier)) return;
    const leadWeeks = leadWeeksFor(supplier);
    const orderNowQty = dueNow(toOrder, leadWeeks, thisWeek);
    rows.push({
      variantId,
      sku: v?.sku ?? null,
      ...label,
      category: item?.category_name ?? 'Uncategorized',
      uom: item?.uom ?? '',
      purchaseUom: item?.purchase_uom ?? null,
      purchaseConversion: item?.purchase_uom && conversion > 0 ? conversion : null,
      supplier,
      supplierId: item?.default_supplier_id ?? null,
      leadWeeks,
      orderBy: firstShortWeek ? addWeeks(firstShortWeek, -leadWeeks) : null,
      orderNowQty: round(orderNowQty),
      purchasePrice: Number(v?.purchase_price ?? 0),
      inStock,
      katanaStock,
      alreadyUsed,
      negativeStock: rawStock < 0 ? rawStock : null,
      onOrder,
      needed,
      toOrder,
      totalNeeded: round(Object.values(needed).reduce((a, b) => a + b, 0)),
      totalToOrder: round(short),
      firstShortWeek,
    });
  });

  const byCategory = (a: { category: string; name: string; options: string }, b: { category: string; name: string; options: string }) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.options.localeCompare(b.options, undefined, { numeric: true });
  rows.sort(byCategory);

  const usedRows: UsedRow[] = [];
  usedQty.forEach((_, variantId) => {
    const v = idx.variants.get(variantId);
    const item = v ? idx.items.get((v.product_id ?? v.material_id)!) : undefined;
    if (isExcludedSupplier(item?.default_supplier_id ? suppliers.get(item.default_supplier_id) ?? null : null)) return;
    const st = stockFor(variantId);
    usedRows.push({
      variantId,
      sku: v?.sku ?? null,
      ...(v ? variantLabel(idx, v) : { name: `Variant ${variantId}`, options: '' }),
      category: item?.category_name ?? 'Uncategorized',
      uom: item?.uom ?? '',
      katanaStock: st.katanaStock,
      negativeStock: st.raw < 0 ? st.raw : null,
      used: st.used,
      available: st.available,
      overUsed: st.overUsed,
      lines: usedLineCount.get(variantId) ?? 0,
    });
  });
  usedRows.sort(byCategory);

  return {
    location,
    weeks: weeks.filter(w => w.lines.length > 0).map(w => w.weekOf),
    through: weeks[weeks.length - 1]?.weekOf ?? '',
    rows,
    unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count),
    substitutions: [...substitutions.values()].sort((a, b) => b.count - a.count),
    matchedLines,
    totalLines,
    unknownAddOnLines,
    used: {
      rows: usedRows,
      unmatched: [...usedTrack.unmatched.values()].sort((a, b) => b.count - a.count),
      substitutions: [...usedTrack.substitutions.values()].sort((a, b) => b.count - a.count),
      matchedLines: usedMatched,
      totalLines: designedLines.length,
      unknownAddOnLines: usedUnknownAddOns,
    },
  };
}

// Shortfall whose order-by date (need-by week minus lead time) is this week or past.
// Shortfall whose order-by date (need week minus lead time) is on or before
// `cutoff` — what a PO placed now has to cover to reach that far ahead.
export function qtyDueBy(toOrder: Record<string, number>, leadWeeks: number, cutoff: string): number {
  return Object.entries(toOrder)
    .filter(([wk]) => addWeeks(wk, -leadWeeks) <= cutoff)
    .reduce((sum, [, q]) => sum + q, 0);
}

function dueNow(toOrder: Record<string, number>, leadWeeks: number, thisWeek: string): number {
  return qtyDueBy(toOrder, leadWeeks, thisWeek);
}

// Applies hand edits on top of the computed list. Runs in the browser too,
// so an edit shows immediately without rebuilding the schedule.
//  - removed: the item drops off the order list.
//  - qty: replaces the total to order. Lowering it trims the latest weeks
//    first; raising it adds the extra to the earliest week it's needed (or
//    this week), so order-by dates stay meaningful.
export function applyEdits(plan: OrderPlan, edits: OrderEdits, thisWeek: string): OrderPlan {
  if (!Object.keys(edits).length) return plan;
  const rows = plan.rows.map(r => {
    const edit = edits[String(r.variantId)];
    if (!edit) return r;
    if (edit.removed) {
      return { ...r, edit, removed: true, toOrder: {}, totalToOrder: 0, orderNowQty: 0, orderBy: null, firstShortWeek: null };
    }
    if (edit.qty === undefined) return r;

    const target = round(Math.max(0, edit.qty));
    const toOrder: Record<string, number> = {};
    const weeksAsc = Object.keys(r.toOrder).sort();
    let left = target;
    for (const wk of weeksAsc) {
      const q = Math.min(r.toOrder[wk], left);
      if (q > 0) toOrder[wk] = round(q);
      left = round(left - q);
    }
    if (left > 0) {
      const wk = weeksAsc[0] ?? r.firstShortWeek ?? thisWeek;
      toOrder[wk] = round((toOrder[wk] ?? 0) + left);
    }
    const firstShortWeek = Object.keys(toOrder).sort()[0] ?? null;
    return {
      ...r,
      edit,
      computedToOrder: r.totalToOrder,
      toOrder,
      totalToOrder: target,
      firstShortWeek,
      orderBy: firstShortWeek ? addWeeks(firstShortWeek, -r.leadWeeks) : null,
      orderNowQty: round(dueNow(toOrder, r.leadWeeks, thisWeek)),
    };
  });
  const weeks = [...new Set([...plan.weeks, ...rows.flatMap(r => Object.keys(r.toOrder))])].sort();
  return { ...plan, rows, weeks };
}
