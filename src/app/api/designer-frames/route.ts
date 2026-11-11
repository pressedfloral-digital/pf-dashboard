import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { pfGetAll, pfPost, fmtDate } from '@/lib/pf-api';
import type { WeeklyReportItem, SearchResponse } from '@/types/dashboard';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const cohortStart = searchParams.get('cohortStart');
  const cohortEnd   = searchParams.get('cohortEnd');

  if (!cohortStart || !cohortEnd) {
    return NextResponse.json({ error: 'cohortStart and cohortEnd required' }, { status: 400 });
  }

  try {
    const startDate = new Date(cohortStart + 'T12:00:00');
    const endDate   = new Date(cohortEnd   + 'T12:00:00');

    // Build Monday-aligned week list covering the requested range
    const weekPaths: string[] = [];
    const weekKeys: string[]  = [];

    const cur = new Date(startDate);
    const dow = cur.getDay();
    cur.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1));
    cur.setHours(0, 0, 0, 0);

    while (cur <= endDate) {
      const mon = new Date(cur);
      const sun = new Date(cur.getTime() + 6 * 86400000);
      weekPaths.push(`/OrderProducts/WeeklyReport?startDate=${fmtDate(mon)}&endDate=${fmtDate(sun)}`);
      weekKeys.push(fmtDate(mon));
      cur.setDate(cur.getDate() + 7);
    }

    if (!weekPaths.length) {
      return NextResponse.json({ designers: [], weekKeys: [] });
    }

    // Fetch all weeks in parallel (batches of 8)
    const orderWeekMap: Record<string, string> = {}; // orderNum → weekKey (Monday)
    for (let i = 0; i < weekPaths.length; i += 8) {
      const results = await pfGetAll<WeeklyReportItem[]>(weekPaths.slice(i, i + 8));
      results.forEach((items, j) => {
        if (!items) return;
        items.forEach(item => {
          if (item.location !== 'Utah') return;
          const num = String(item.orderNumber ?? item.shopifyOrderNumber ?? '');
          if (num && !orderWeekMap[num]) orderWeekMap[num] = weekKeys[i + j];
        });
      });
    }

    const orderNums = Object.keys(orderWeekMap);
    if (!orderNums.length) {
      return NextResponse.json({ designers: [], weekKeys: [] });
    }

    // Search each order individually to find frameValetKey + assigned designer
    const BATCH = 50;
    const orderDesignerMap: Record<string, string> = {}; // orderNum → designer name
    const orderUuidMap: Record<string, string> = {};     // orderNum → orderUuid
    for (let i = 0; i < orderNums.length; i += BATCH) {
      const batch = orderNums.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(num =>
          pfPost<SearchResponse>('/OrderProducts/Search', {
            searchTerm: num,
            pageNumber: 1,
            pageSize: 1,
            workflowFamily: 'frames',
          }).catch(() => null)
        )
      );
      results.forEach((data, j) => {
        const item = data?.items?.[0];
        if (!item?.frameValetKey) return;
        const fn = item.assignedToUserFirstName;
        const ln = item.assignedToUserLastName;
        if (!fn && !ln) return;
        orderDesignerMap[batch[j]] = `${fn ?? ''} ${ln ?? ''}`.trim();
        if (item.orderUuid) orderUuidMap[batch[j]] = item.orderUuid;
      });
    }

    if (!Object.keys(orderDesignerMap).length) {
      return NextResponse.json({ designers: [], weekKeys: [] });
    }

    // Group by designer and cohort week
    const byDesigner: Record<string, {
      weeks: Record<string, number>;
      orders: Record<string, string[]>;
    }> = {};

    for (const [num, weekKey] of Object.entries(orderWeekMap)) {
      const designer = orderDesignerMap[num];
      if (!designer) continue;
      if (!byDesigner[designer]) byDesigner[designer] = { weeks: {}, orders: {} };
      byDesigner[designer].weeks[weekKey] = (byDesigner[designer].weeks[weekKey] ?? 0) + 1;
      byDesigner[designer].orders[weekKey] = [...(byDesigner[designer].orders[weekKey] ?? []), num];
    }

    const allWeekKeys = [...new Set(
      Object.values(byDesigner).flatMap(d => Object.keys(d.weeks))
    )].sort();

    const shownWeekKeys = allWeekKeys.slice(-8);
    const shownSet      = new Set(shownWeekKeys);

    const designers = Object.entries(byDesigner)
      .map(([name, d]) => {
        const grandTotal = Object.values(d.weeks).reduce((s, n) => s + n, 0);
        const shownTotal = shownWeekKeys.reduce((s, k) => s + (d.weeks[k] ?? 0), 0);
        return {
          name,
          weeks:        shownWeekKeys.map(k => d.weeks[k] ?? 0),
          otherCount:   grandTotal - shownTotal,
          total:        grandTotal,
          ordersByWeek: shownWeekKeys.map(k => d.orders[k] ?? []),
          otherOrders:  Object.entries(d.orders)
            .filter(([wk]) => !shownSet.has(wk))
            .flatMap(([, o]) => o),
        };
      })
      .filter(d => d.total > 0)
      .sort((a, b) => b.total - a.total);

    return NextResponse.json({ designers, weekKeys: shownWeekKeys, orderUuidMap });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
