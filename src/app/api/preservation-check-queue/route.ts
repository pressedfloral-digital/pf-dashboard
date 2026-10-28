import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfGet, pfGetAll, fmtDate } from '@/lib/pf-api';

export const maxDuration = 120;

// Live counts for Preservation's This Week rows, per location:
//   received — orders that moved into Bouquet Received, by the day they did.
//              Orders sit there 14 days before the app auto-advances them,
//              so current status is exact for this week.
//   pressed  — each order product's first bouquet photo upload, by day
//              (Calendar/OrderProductUploads). Check 1 is due 3 days later.
//   c2 / c3  — orders in In Progress / Almost Ready to Frame, by the day they
//              entered it; the page turns that into a due day.
// Read straight from the production app's WeeklyReport (same feed as the
// status-snapshot cron) — order_status_history and uuid_location_cache both
// carry stale rows, so their counts don't match the app. orderDateUpdated is
// when the order entered its current status.

const STATUS_TO_CHECK = {
  bouquetReceived:    'received',
  progress:           'c2',
  almostReadyToFrame: 'c3',
} as const;

type CheckKey = typeof STATUS_TO_CHECK[keyof typeof STATUS_TO_CHECK] | 'pressed';
type Queue = Record<CheckKey, Record<string, number>>;

interface CalendarUpload {
  uploadType:         string;
  orderProductUuid:   string;
  shopifyOrderNumber: string;
}

const LOCATION_TZ: Record<string, string> = { Utah: 'America/Denver', Georgia: 'America/New_York' };

// Minutes the location's clock is off UTC right now (e.g. -360 for MDT) —
// what Calendar/OrderProductUploads expects so its day buckets are local.
function utcOffsetMinutes(location: string): number {
  const tz = LOCATION_TZ[location] ?? 'America/Denver';
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const utc   = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

function localDay(iso: string, location: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: LOCATION_TZ[location] ?? 'America/Denver' });
}

interface WeeklyReportItem {
  orderNumber?:        string | number;
  shopifyOrderNumber?: string | number;
  variantTitle?:       string;
  status?:             string;
  location?:           string;
  orderDateUpdated?:   string | null;
  originalOrderDate?:  string;
  uuid?:               string;
  tags?:               string;
}

// Orders with no location in the app (mostly Order Received — Utah orders
// aren't tagged at checkout) belong to Georgia when they carry a GA tag,
// otherwise Utah.
function resolveLocation(item: WeeklyReportItem): string {
  if (item.location) return item.location;
  const tags = (item.tags ?? '').split(',').map(t => t.trim().toUpperCase());
  return tags.includes('GA') ? 'Georgia' : 'Utah';
}

// 12 monthly WeeklyReport calls per load — cache per location for a few
// minutes so flipping tabs doesn't refetch.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; byEntered: Queue }>();
// Requests that arrive while a load is running wait on it instead of
// starting their own (the page can fire two at once).
const pending = new Map<string, Promise<Queue>>();

async function loadQueue(location: string): Promise<Queue> {
  const paths: string[] = [];
  const today = new Date();
  for (let m = 0; m < 12; m++) {
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const lastOfMonth  = m === 0 ? today : new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
    paths.push(`/OrderProducts/WeeklyReport?startDate=${fmtDate(firstOfMonth)}&endDate=${fmtDate(lastOfMonth)}&pageSize=1000`);
  }

  const byEntered: Queue = { received: {}, pressed: {}, c2: {}, c3: {} };
  const seen = new Set<string>();
  const orderLocation = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 6) {
    const results = await pfGetAll<WeeklyReportItem[]>(paths.slice(i, i + 6));
    results.forEach(items => {
      items?.forEach(item => {
        const orderNum = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
        if (orderNum && !orderLocation.has(orderNum)) orderLocation.set(orderNum, resolveLocation(item));
        const key = STATUS_TO_CHECK[item.status as keyof typeof STATUS_TO_CHECK];
        if (!key || resolveLocation(item) !== location) return;
        const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
        const id = item.uuid ?? `${num}|${item.variantTitle ?? ''}`;
        if (!num || seen.has(id)) return;
        seen.add(id);
        const stamp = item.orderDateUpdated ?? item.originalOrderDate;
        if (!stamp) return;
        const day = localDay(stamp, location);
        byEntered[key][day] = (byEntered[key][day] ?? 0) + 1;
      });
    });
  }

  // Pressed: first bouquet photo per order product. Three months back so a
  // re-upload this month isn't mistaken for the first one.
  const offset = utcOffsetMinutes(location);
  const months = [0, 1, 2].map(m => new Date(today.getFullYear(), today.getMonth() - m, 1));
  const calendars = await Promise.all(months.map(d =>
    // ~2.8MB a month (signed photo URLs) — over Next's 2MB fetch-cache limit,
    // so skip it; this route caches the counts itself.
    pfGet<Record<string, CalendarUpload[]> | null>(`/Calendar/OrderProductUploads/${d.getMonth() + 1}/${d.getFullYear()}/${offset}`, { fresh: true }).catch(() => null)));
  const firstPhoto = new Map<string, { day: string; orderNum: string }>();
  calendars.forEach(cal => Object.entries(cal ?? {}).forEach(([dayKey, uploads]) => {
    const day = dayKey.slice(0, 10);
    uploads.forEach(u => {
      if (u.uploadType !== 'bouquet') return;
      const prev = firstPhoto.get(u.orderProductUuid);
      if (!prev || day < prev.day) firstPhoto.set(u.orderProductUuid, { day, orderNum: String(u.shopifyOrderNumber) });
    });
  }));
  firstPhoto.forEach(({ day, orderNum }) => {
    if ((orderLocation.get(orderNum) ?? 'Utah') !== location) return;
    byEntered.pressed[day] = (byEntered.pressed[day] ?? 0) + 1;
  });

  return byEntered;
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') ?? 'Utah';
  try {
    const hit = cache.get(location);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return NextResponse.json({ byEntered: hit.byEntered, refreshedAt: new Date(hit.at).toISOString() });
    }
    let load = pending.get(location);
    if (!load) {
      load = loadQueue(location).finally(() => pending.delete(location));
      pending.set(location, load);
    }
    const byEntered = await load;
    const at = Date.now();
    cache.set(location, { at, byEntered });
    return NextResponse.json({ byEntered, refreshedAt: new Date(at).toISOString() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
