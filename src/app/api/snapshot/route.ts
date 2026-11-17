import { NextResponse } from 'next/server';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { pfPost, pfGetAll, fmtDate } from '@/lib/pf-api';
import { supabase } from '@/lib/supabase';
import type { WeeklyReportItem } from '@/types/dashboard';

export const maxDuration = 300;

interface SearchItem {
  assignedToUserUuid?: string;
  assignedToUserFirstName?: string;
  assignedToUserLastName?: string;
  frameValetKey?: unknown;
}

interface SearchResponse {
  items: SearchItem[];
  totalItems?: number;
}

/**
 * Discover all active designer UUIDs by sampling recent cohort weeks.
 * Returns map of uuid → name.
 */
async function discoverDesignerUuids(): Promise<Record<string, string>> {
  const today  = new Date();
  const paths: string[] = [];
  // Sample last 8 cohort weeks
  for (let w = -8; w <= 0; w++) {
    const mon = new Date(today.getTime() + w * 7 * 86400000);
    const sun = new Date(mon.getTime() + 6 * 86400000);
    paths.push(`/OrderProducts/WeeklyReport?startDate=${fmtDate(mon)}&endDate=${fmtDate(sun)}`);
  }

  const allItems: WeeklyReportItem[] = [];
  for (let i = 0; i < paths.length; i += 8) {
    const results = await pfGetAll<WeeklyReportItem[]>(paths.slice(i, i + 8));
    results.forEach(items => { if (items) allItems.push(...items); });
  }

  // Get order numbers for Utah items
  const orderNums = [...new Set(
    allItems
      .filter(item => item.location?.toLowerCase().includes('utah'))
      .map(item => String(item.orderNumber ?? item.shopifyOrderNumber ?? ''))
      .filter(Boolean)
  )].slice(0, 200); // sample up to 200 orders

  // Batch search to find designer UUIDs
  const uuidMap: Record<string, string> = {}; // uuid → name
  const BATCH = 50;
  for (let i = 0; i < orderNums.length; i += BATCH) {
    const batch = orderNums.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(num =>
        pfPost<SearchResponse>('/OrderProducts/Search', { searchTerm: num, pageNumber: 1, pageSize: 1 })
          .catch(() => null)
      )
    );
    results.forEach(data => {
      const item = data?.items?.[0];
      const uuid = item?.assignedToUserUuid;
      const fn   = item?.assignedToUserFirstName;
      const ln   = item?.assignedToUserLastName;
      if (uuid && fn) uuidMap[uuid] = `${fn} ${ln ?? ''}`.trim();
    });
  }

  return uuidMap;
}

/**
 * Get ALL framed orders for a designer by paginating
 * searchTerm=' ' + assignedToUserUuid.
 */
async function getDesignerFrameCount(uuid: string): Promise<number> {
  let count = 0;
  let page  = 1;
  const PAGE_SIZE = 100;

  while (true) {
    const data = await pfPost<SearchResponse>('/OrderProducts/Search', {
      searchTerm: ' ',
      assignedToUserUuid: uuid,
      pageNumber: page,
      pageSize: PAGE_SIZE,
    }).catch(() => null);

    if (!data?.items?.length) break;

    count += data.items.filter(item => item.frameValetKey).length;

    const total = data.totalItems ?? 0;
    if (page * PAGE_SIZE >= total) break;
    page++;
    if (page > 20) break; // safety cap: 2000 orders max per designer
  }

  return count;
}

export async function POST() {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  // Manual admin tool — no dashboard button calls this.
  if (access.role !== 'admin') return forbidden('Admin only');

  try {
    // Step 1: Get known designers from Supabase, or discover from API
    const { data: storedDesigners } = await supabase
      .from('designers')
      .select('uuid, first_name, last_name')
      .eq('is_active', true);

    let uuidMap: Record<string, string> = {};

    if (storedDesigners?.length) {
      storedDesigners.forEach(d => {
        uuidMap[d.uuid] = `${d.first_name} ${d.last_name ?? ''}`.trim();
      });
    } else {
      // First run: discover designers from API
      uuidMap = await discoverDesignerUuids();

      // Store them for future use
      if (Object.keys(uuidMap).length) {
        const rows = Object.entries(uuidMap).map(([uuid, name]) => {
          const parts = name.split(' ');
          return {
            uuid,
            first_name: parts[0],
            last_name:  parts.slice(1).join(' ') || null,
            is_active:  true,
          };
        });
        await supabase.from('designers').upsert(rows, { onConflict: 'uuid' });
      }
    }

    if (!Object.keys(uuidMap).length) {
      return NextResponse.json({ error: 'No designers found' }, { status: 400 });
    }

    // Step 2: For each designer, count ALL-TIME framed orders via direct UUID search
    // This is complete — no cohort window limitation
    const designerEntries = Object.entries(uuidMap);
    const counts = await Promise.all(
      designerEntries.map(async ([uuid, name]) => {
        const count = await getDesignerFrameCount(uuid);
        return { uuid, name, count };
      })
    );

    const designerCounts: Record<string, number> = {};
    counts.forEach(({ name, count }) => {
      if (count > 0) designerCounts[name] = count;
    });

    // Step 3: Save snapshot
    const today = fmtDate(new Date());
    const { error } = await supabase
      .from('frame_snapshots')
      .upsert({ snapshot_date: today, counts: designerCounts }, { onConflict: 'snapshot_date' });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      date: today,
      designersFound: designerEntries.length,
      designers: counts
        .filter(d => d.count > 0)
        .sort((a, b) => b.count - a.count)
        .map(({ name, count }) => ({ name, count })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
