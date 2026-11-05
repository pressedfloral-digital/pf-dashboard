import { pfGet } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import { BLOOM_STOCK_PRODUCTS } from '@/lib/bloomStock';

// Preservation turnaround: how long an order product sits in Bouquet Received
// before its first bouquet photo is uploaded. Received times come from the
// PF API's /OrderProducts/Changes feed (copied into pf_bouquet_received);
// upload times from Calendar/OrderProductUploads.

const CURSOR_NAME = 'order_product_changes';
const PAGE_SIZE = 1000;

interface ChangeRow {
  historyUuid:        string;
  orderProductUuid:   string;
  orderNumber:        string | null;
  status:             string;
  location:           string | null;
  enteredAt:          string;
  isStatusTransition: boolean;
}

interface ChangesPage {
  changes:    ChangeRow[];
  nextCursor: string;
  done:       boolean;
}

interface CalendarUpload {
  uploadType:       string;
  dateUploaded:     string;
  orderProductUuid: string;
}

// First run starts at the 1st of last month, so orders received late last
// month and uploaded this month still have a received time.
function defaultCursor(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString();
}

// Reads the Changes feed forward from the saved cursor, keeping Bouquet
// Received entries, until it's caught up or `budgetMs` runs out (each page is
// slow, so a backfill can take a few cron runs). Returns the cursor reached.
export async function syncBouquetReceived(budgetMs: number): Promise<{ cursor: string; pages: number; saved: number; done: boolean }> {
  const startedAt = Date.now();
  const { data: row, error } = await supabase.from('pf_sync_cursors').select('cursor_at').eq('name', CURSOR_NAME).maybeSingle();
  if (error) throw error;
  let cursor = row?.cursor_at ?? defaultCursor();
  let pages = 0, saved = 0, done = false;

  while (!done && Date.now() - startedAt < budgetMs) {
    const page = await pfGet<ChangesPage>(`/OrderProducts/Changes?since=${encodeURIComponent(cursor)}&pageSize=${PAGE_SIZE}`, { fresh: true });
    pages++;
    const received = page.changes
      .filter(c => c.status === 'bouquetReceived' && c.isStatusTransition)
      .map(c => ({
        history_uuid:       c.historyUuid,
        order_product_uuid: c.orderProductUuid,
        order_number:       c.orderNumber,
        location:           c.location,
        entered_at:         c.enteredAt,
      }));
    if (received.length) {
      const { error: upsertError } = await supabase.from('pf_bouquet_received').upsert(received, { onConflict: 'history_uuid' });
      if (upsertError) throw upsertError;
      saved += received.length;
    }
    done = page.done;
    // A full page that ends on the same instant it started would loop forever.
    if (!done && page.nextCursor === cursor) break;
    cursor = page.nextCursor;
    const { error: cursorError } = await supabase.from('pf_sync_cursors')
      .upsert({ name: CURSOR_NAME, cursor_at: cursor, updated_at: new Date().toISOString() }, { onConflict: 'name' });
    if (cursorError) throw cursorError;
  }
  return { cursor, pages, saved, done };
}

const LOCATION_TZ: Record<string, string> = { Utah: 'America/Denver', Georgia: 'America/New_York' };

function localDay(iso: string, location: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: LOCATION_TZ[location] ?? 'America/Denver' });
}

function mondayOf(day: string): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export interface TurnaroundAverage {
  days:  number | null;   // average turnaround in days; null with no uploads
  count: number;          // order products uploaded in the window
}

export interface PreservationTurnaround {
  today:        TurnaroundAverage;
  week:         TurnaroundAverage;   // since Monday
  month:        TurnaroundAverage;   // since the 1st
  syncedThrough: string;             // how far the received feed has been read
  catchingUp:    boolean;            // over an hour behind — still backfilling, recent orders may be missing
  missingPhoto:  MissingPhotoOrder[];  // received over missingPhotoDays ago, no bouquet photo since
  missingPhotoDays: number;
}

// Every bouquet photo upload time per order product (UTC), from this month's
// and last month's calendars, oldest first.
async function bouquetUploads(): Promise<Map<string, string[]>> {
  const today = new Date();
  const months = [0, 1].map(m => new Date(today.getFullYear(), today.getMonth() - m, 1));
  const calendars = await Promise.all(months.map(d =>
    // ~2.8MB a month — over Next's 2MB fetch-cache limit, so fetch fresh.
    pfGet<Record<string, CalendarUpload[]> | null>(`/Calendar/OrderProductUploads/${d.getMonth() + 1}/${d.getFullYear()}/0`, { fresh: true })));
  const all = new Map<string, string[]>();
  calendars.forEach(cal => Object.values(cal ?? {}).forEach(uploads => uploads.forEach(u => {
    if (u.uploadType !== 'bouquet') return;
    const list = all.get(u.orderProductUuid) ?? [];
    list.push(u.dateUploaded);
    all.set(u.orderProductUuid, list);
  })));
  all.forEach(list => list.sort());
  return all;
}

// First bouquet photo per order product — both months are read so a
// re-upload this month isn't mistaken for the first.
function firstBouquetUploads(uploads: Map<string, string[]>): Map<string, string> {
  return new Map([...uploads].map(([op, list]) => [op, list[0]]));
}

// Orders flagged when they've sat in Bouquet Received this many calendar days
// with no bouquet photo since.
const MISSING_PHOTO_DAYS = 3;

export interface MissingPhotoOrder {
  orderProductUuid: string;
  orderNumber:      string | null;
  receivedAt:       string;   // latest time it entered Bouquet Received
  days:             number;   // calendar days since then
}

// Order products whose latest Bouquet Received entry is over
// MISSING_PHOTO_DAYS old with no bouquet photo uploaded after it, oldest
// first. Looks back to the 1st of last month — as far as the upload
// calendars go — so anything received before that isn't checked.
async function computeMissingPhotos(location: string, uploads: Map<string, string[]>): Promise<MissingPhotoOrder[]> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
  const cutoff = now.getTime() - MISSING_PHOTO_DAYS * 86_400_000;

  const latest = new Map<string, { at: string; orderNumber: string | null; location: string | null }>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase.from('pf_bouquet_received')
      .select('order_product_uuid, order_number, location, entered_at')
      .gte('entered_at', since)
      .order('entered_at')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    (data ?? []).forEach(r => {
      const at = new Date(r.entered_at).toISOString();
      const prev = latest.get(r.order_product_uuid);
      if (!prev || at > prev.at) latest.set(r.order_product_uuid, { at, orderNumber: r.order_number, location: r.location });
    });
    if (!data || data.length < PAGE_SIZE) break;
  }

  const missing: MissingPhotoOrder[] = [];
  latest.forEach((r, op) => {
    if ((r.location ?? 'Utah') !== location) return;
    const receivedMs = new Date(r.at).getTime();
    if (receivedMs > cutoff) return;
    // Upload times vary in fractional digits, so compare as times, not text.
    if ((uploads.get(op) ?? []).some(at => new Date(at).getTime() >= receivedMs)) return;
    missing.push({ orderProductUuid: op, orderNumber: r.orderNumber, receivedAt: r.at, days: Math.floor((now.getTime() - receivedMs) / 86_400_000) });
  });

  // Bloom stock products (Handprint / Paw Print / Footprint frames, Bloom
  // Arrangement Recreation) are made from Pressed Floral's own pressed stock,
  // so no bouquet photo is ever uploaded for them — never flag them.
  const titles = await productTitles(missing.map(m => m.orderProductUuid));
  return missing
    .filter(m => !isBloomStockTitle(titles.get(m.orderProductUuid)))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

const BLOOM_STOCK_TITLES = BLOOM_STOCK_PRODUCTS.map(p => p.label.toLowerCase());

// Matched on the PF product title (the API doesn't return the Shopify
// product id). Regular orders switched to a recreation on the Bloom Stock
// board keep their frame title and stay flagged: their order can also hold
// sent-in bouquets that do need photos.
function isBloomStockTitle(title: string | null | undefined): boolean {
  const t = title?.trim().toLowerCase() ?? '';
  return BLOOM_STOCK_TITLES.some(b => t.includes(b));
}

// An order product's title never changes, so it's looked up once per server
// instance. A failed lookup isn't cached and leaves the flag showing.
const titleCache = new Map<string, string | null>();
async function productTitles(uuids: string[]): Promise<Map<string, string | null | undefined>> {
  const todo = [...new Set(uuids)].filter(u => !titleCache.has(u));
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async uuid => {
      try {
        const d = await pfGet<{ productTitle?: string | null }>(`/OrderProducts/Details/${uuid}`);
        titleCache.set(uuid, d?.productTitle ?? null);
      } catch { /* keep flagged */ }
    }));
  }
  return new Map(uuids.map(u => [u, titleCache.get(u)]));
}

// Today / this week / this month averages for one location, by the local day
// each first bouquet photo was uploaded. Each upload pairs with the latest
// time its order product entered Bouquet Received before that upload.
export async function computeTurnaround(location: string, syncedThrough: string): Promise<PreservationTurnaround> {
  const uploads = await bouquetUploads();
  const firstUpload = firstBouquetUploads(uploads);
  const todayLocal = localDay(new Date().toISOString(), location);
  const weekStart  = mondayOf(todayLocal);
  const monthStart = todayLocal.slice(0, 8) + '01';
  const since      = weekStart < monthStart ? weekStart : monthStart;

  const inWindow = [...firstUpload].filter(([, at]) => localDay(at, location) >= since);
  const opUuids = inWindow.map(([op]) => op);
  const receivedAt = new Map<string, { at: string; location: string | null }[]>();
  for (let i = 0; i < opUuids.length; i += 200) {
    const { data, error } = await supabase.from('pf_bouquet_received')
      .select('order_product_uuid, location, entered_at')
      .in('order_product_uuid', opUuids.slice(i, i + 200));
    if (error) throw error;
    (data ?? []).forEach(r => {
      const list = receivedAt.get(r.order_product_uuid) ?? [];
      list.push({ at: new Date(r.entered_at).toISOString(), location: r.location });
      receivedAt.set(r.order_product_uuid, list);
    });
  }

  const sums = { today: [0, 0], week: [0, 0], month: [0, 0] };
  for (const [op, uploadedAt] of inWindow) {
    const before = (receivedAt.get(op) ?? []).filter(r => r.at <= uploadedAt);
    if (!before.length) continue;
    const last = before.reduce((a, b) => (b.at > a.at ? b : a));
    if ((last.location ?? 'Utah') !== location) continue;
    const days = (new Date(uploadedAt).getTime() - new Date(last.at).getTime()) / 86_400_000;
    const day = localDay(uploadedAt, location);
    if (day === todayLocal)  { sums.today[0] += days; sums.today[1]++; }
    if (day >= weekStart)    { sums.week[0]  += days; sums.week[1]++; }
    if (day >= monthStart)   { sums.month[0] += days; sums.month[1]++; }
  }
  const avg = ([total, count]: number[]): TurnaroundAverage => ({ days: count ? total / count : null, count });
  const catchingUp = Date.now() - new Date(syncedThrough).getTime() > 60 * 60 * 1000;
  const missingPhoto = await computeMissingPhotos(location, uploads);
  return { today: avg(sums.today), week: avg(sums.week), month: avg(sums.month), syncedThrough, catchingUp, missingPhoto, missingPhotoDays: MISSING_PHOTO_DAYS };
}
