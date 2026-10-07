// Turns the Design schedule into a weekly purchasing list using Katana.
//
// Every scheduled line (the frame itself, plus its Backing and Glass add-ons)
// is matched to a Katana product variant, its recipe is exploded into
// components (frame mouldings, glass panes, linen, foam core, tape…), and
// each week's component demand is drawn down against Katana stock. Whatever
// a week can't cover from stock + open purchase orders is what still needs
// to be ordered for that week.

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
  inStock:     number;                // never below 0 — see negativeStock
  negativeStock: number | null;       // Katana's raw figure when it's below zero
  onOrder:     number;                // Katana "expected" — open purchase / manufacturing orders
  needed:      Record<string, number>; // weekOf → quantity Design will use
  toOrder:     Record<string, number>; // weekOf → shortfall first hit that week
  totalNeeded: number;
  totalToOrder: number;
  firstShortWeek: string | null;
}

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

export interface OrderPlan {
  location:   string;
  weeks:      string[];   // design weeks with scheduled work
  through:    string;     // last Monday the plan covers (Dec 31's week, or later near year end)
  rows:       PlanRow[];
  unmatched:  Unmatched[];
  substitutions: Substitution[];
  matchedLines: number;
  totalLines:   number;
}

interface PlanWeek { weekOf: string; lines: QueueLine[] }

const round = (n: number) => Math.round(n * 100) / 100;

export function buildOrderPlan(k: KatanaData, location: string, weeks: PlanWeek[], thisWeek: string): OrderPlan {
  const idx = buildIndex(k);
  const suppliers = new Map(k.suppliers.map(s => [s.id, s.name]));
  const stock = new Map(k.stock.filter(s => s.location_id === k.locationId).map(s => [s.variant_id, s]));

  const demand = new Map<number, Record<string, number>>();
  const unmatched = new Map<string, Unmatched>();
  const substitutions = new Map<string, Substitution>();
  let matchedLines = 0, totalLines = 0;

  const addProduct = (weekOf: string, product: string, variant: string): boolean => {
    // Glass backing is the back pane of the Glass add-on's set — nothing
    // extra to build, so it's neither demand nor an unmatched product.
    if (/backing$/i.test(product) && /(^| \/ )glass$/i.test(variant.trim())) return true;
    const m = matchVariant(idx, product, variant);
    const v = m?.variant;
    const reason = !v ? 'no Katana product' : !idx.recipes.has(v.id) ? 'no recipe in Katana' : null;
    if (reason) {
      const key = `${product}|${variant}|${reason}`;
      const u = unmatched.get(key) ?? { product, variant, reason, count: 0 };
      u.count++;
      unmatched.set(key, u);
      return false;
    }
    if (m!.substituted) {
      const l = variantLabel(idx, v!);
      const katana = l.options ? `${l.name} · ${l.options}` : l.name;
      const key = `${product}|${variant}`;
      const sub = substitutions.get(key) ?? { product, variant, katana, count: 0 };
      sub.count++;
      substitutions.set(key, sub);
    }
    const parts = new Map<number, number>();
    explode(idx, v!.id, 1, parts);
    parts.forEach((q, id) => {
      const row = demand.get(id) ?? {};
      row[weekOf] = (row[weekOf] ?? 0) + q;
      demand.set(id, row);
    });
    return true;
  };

  for (const w of weeks) {
    for (const line of w.lines) {
      totalLines++;
      if (addProduct(w.weekOf, line.product, line.variant)) matchedLines++;
      const { backingAddOn, glassAddOn } = line.materials ?? {};
      if (backingAddOn) addProduct(w.weekOf, backingAddOn.productTitle, backingAddOn.variantTitle ?? '');
      if (glassAddOn)   addProduct(w.weekOf, glassAddOn.productTitle, glassAddOn.variantTitle ?? '');
    }
  }

  const rows: PlanRow[] = [];
  demand.forEach((needed, variantId) => {
    const v = idx.variants.get(variantId);
    const item = v ? idx.items.get((v.product_id ?? v.material_id)!) : undefined;
    const s = stock.get(variantId);
    // Negative stock is a Katana bookkeeping gap (used before it was
    // received), not a real deficit — treat the shelf as empty.
    const rawStock = Number(s?.quantity_in_stock ?? 0);
    const inStock = Math.max(0, rawStock);
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
    const orderNowQty = Object.entries(toOrder)
      .filter(([wk]) => addWeeks(wk, -leadWeeks) <= thisWeek)
      .reduce((sum, [, q]) => sum + q, 0);
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
      negativeStock: rawStock < 0 ? rawStock : null,
      onOrder,
      needed,
      toOrder,
      totalNeeded: round(Object.values(needed).reduce((a, b) => a + b, 0)),
      totalToOrder: round(short),
      firstShortWeek,
    });
  });

  rows.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.options.localeCompare(b.options, undefined, { numeric: true }));
  return {
    location,
    weeks: weeks.filter(w => w.lines.length > 0).map(w => w.weekOf),
    through: weeks[weeks.length - 1]?.weekOf ?? '',
    rows,
    unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count),
    substitutions: [...substitutions.values()].sort((a, b) => b.count - a.count),
    matchedLines,
    totalLines,
  };
}
