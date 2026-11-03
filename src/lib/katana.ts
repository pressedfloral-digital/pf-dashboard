/**
 * Katana MRP API client — recipes (BOMs), materials and stock levels.
 * Server-side only; the API key never reaches the browser.
 *
 * Katana allows 60 requests a minute and caps pages at 250 rows. A full load
 * is ~45 pages, so the catalog (products, materials, recipes, suppliers) is
 * cached for an hour and stock levels for 5 minutes.
 */

const KATANA_URL = 'https://api.katanamrp.com/v1';
const PAGE_SIZE = 250;
const CONCURRENCY = 4;
const CATALOG_REVALIDATE = 3600;
const STOCK_REVALIDATE = 300;

function apiKey(): string {
  const key = process.env.KATANA_API_KEY ?? process.env.Katana_Inventory_API_KEY;
  if (!key) throw new Error('Katana is not configured. Set Katana_Inventory_API_KEY.');
  return key;
}

// Tag on cached stock levels, cleared when a purchase order is created so
// the new "on order" quantities show up immediately.
export const KATANA_STOCK_TAG = 'katana-stock';

async function katanaPage<T>(path: string, page: number, revalidate: number, tags?: string[]): Promise<{ rows: T[]; totalPages: number }> {
  const sep = path.includes('?') ? '&' : '?';
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${KATANA_URL}${path}${sep}limit=${PAGE_SIZE}&page=${page}`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      next: { revalidate, tags },
    });
    if (res.status === 429 && attempt < 3) {
      // x-ratelimit-reset is an epoch-ms timestamp for when the window reopens.
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const wait = reset > Date.now() ? Math.min(reset - Date.now(), 60_000) : 5_000 * (attempt + 1);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Katana GET ${path} → ${res.status}`);
    const json = await res.json() as { data: T[] };
    let totalPages = 1;
    try { totalPages = Number(JSON.parse(res.headers.get('x-pagination') ?? '{}').total_pages) || 1; } catch {}
    return { rows: json.data ?? [], totalPages };
  }
}

async function katanaGetAll<T>(path: string, revalidate: number, tags?: string[]): Promise<T[]> {
  const first = await katanaPage<T>(path, 1, revalidate, tags);
  const rows = [...first.rows];
  for (let p = 2; p <= first.totalPages; p += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, first.totalPages - p + 1) }, (_, k) => katanaPage<T>(path, p + k, revalidate, tags));
    (await Promise.all(batch)).forEach(b => rows.push(...b.rows));
  }
  return rows;
}

// ── Raw shapes (only the fields we use) ──────────────────────────────────────

export interface KatanaVariant {
  id:                number;
  sku:               string | null;
  product_id:        number | null;
  material_id:       number | null;
  type:              'product' | 'material';
  purchase_price:    number | null;
  config_attributes: { config_name: string; config_value: string }[];
}

export interface KatanaItem {
  id:                          number;
  name:                        string;
  uom:                         string;
  category_name:               string | null;
  default_supplier_id:         number | null;
  purchase_uom:                string | null;
  purchase_uom_conversion_rate: string | null;
  archived_at:                 string | null;
  deleted_at:                  string | null;
  variants:                    KatanaVariant[];
}

export interface KatanaBomRow {
  product_variant_id:    number;
  ingredient_variant_id: number;
  quantity:              number;
}

export interface KatanaStock {
  variant_id:        number;
  location_id:       number;
  quantity_in_stock: string;
  quantity_expected: string;
  quantity_committed: string;
}

export interface KatanaData {
  products:  KatanaItem[];
  materials: KatanaItem[];
  bomRows:   KatanaBomRow[];
  suppliers: { id: number; name: string }[];
  stock:     KatanaStock[];
  locationId: number;
}

// Everything needed to turn orders into material requirements for one
// location ("Utah" / "Georgia" — matched to the Katana location by name).
export async function loadKatana(locationName: string): Promise<KatanaData> {
  const locations = await katanaGetAll<{ id: number; name: string }>('/locations', CATALOG_REVALIDATE);
  const location = locations.find(l => l.name.trim().toLowerCase() === locationName.toLowerCase());
  if (!location) throw new Error(`No Katana location named "${locationName}"`);

  // Sequential so the page fan-out stays inside Katana's rate limit.
  const products  = await katanaGetAll<KatanaItem>('/products', CATALOG_REVALIDATE);
  const materials = await katanaGetAll<KatanaItem>('/materials', CATALOG_REVALIDATE);
  const bomRows   = await katanaGetAll<KatanaBomRow>('/bom_rows', CATALOG_REVALIDATE);
  const suppliers = await katanaGetAll<{ id: number; name: string }>('/suppliers', CATALOG_REVALIDATE);
  const stock     = await katanaGetAll<KatanaStock>(`/inventory?location_id=${location.id}`, STOCK_REVALIDATE, [KATANA_STOCK_TAG]);
  return { products, materials, bomRows, suppliers, stock, locationId: location.id };
}

// ── Purchase orders ──────────────────────────────────────────────────────────

export interface NewPurchaseOrderRow {
  variant_id:      number;
  quantity:        number;
  price_per_unit:  number;
  purchase_uom?:   string;
  purchase_uom_conversion_rate?: number;
  arrival_date?:   string;
}

export interface NewPurchaseOrder {
  order_no:              string;
  supplier_id:           number;
  location_id:           number;
  expected_arrival_date: string;
  additional_info:       string;
  purchase_order_rows:   NewPurchaseOrderRow[];
}

// Next number in Katana's "PO-282 …" sequence. Katana returns newest first.
export async function nextPurchaseOrderNumber(): Promise<number> {
  const res = await fetch(`${KATANA_URL}/purchase_orders?limit=100`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Katana GET /purchase_orders → ${res.status}`);
  const { data } = await res.json() as { data: { order_no: string }[] };
  const max = Math.max(0, ...(data ?? []).map(p => Number(p.order_no.match(/^PO-(\d+)/i)?.[1] ?? 0)));
  return max + 1;
}

export async function createPurchaseOrder(po: NewPurchaseOrder): Promise<{ id: number; order_no: string; total: number }> {
  const res = await fetch(`${KATANA_URL}/purchase_orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_type: 'regular', currency: 'USD', status: 'NOT_RECEIVED', ...po }),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Katana couldn't create the purchase order (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
