import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isoMonday } from '@/lib/weekDates';
import { DESIGN_QUEUE_STATUSES, mondayOf, scheduleLines } from '@/lib/designInventory';
import { loadLocationQueueLines, loadDesignCapacityWeeks } from '@/lib/designPipeline';

export const maxDuration = 120;

export interface WeekOrder {
  orderNumber:  string;
  customer:     string;
  product:      string;
  variant:      string;
  stage:        'design_queue' | 'drying';
  intakeDate:   string;
  intakeSource: 'bouquetReceived' | 'eventDate';
}

// ── GET /api/design-week-orders?location=Utah&weekOf=2026-10-26 ──────────────
// The order lines Design should work on in one week, in the order to design
// them (oldest intake first) — the same fill /api/design-inventory does,
// without the Katana and add-on steps, so it stays quick enough to open from
// a Weekly Schedule "Week total".
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') === 'Georgia' ? 'Georgia' : 'Utah';
  const weekParam = req.nextUrl.searchParams.get('weekOf') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
    return NextResponse.json({ error: 'weekOf must be YYYY-MM-DD' }, { status: 400 });
  }
  const thisWeek = isoMonday(0);
  const weekOf = mondayOf(weekParam);
  if (weekOf < thisWeek) {
    return NextResponse.json({ error: 'Only this week and later weeks can be listed.' }, { status: 400 });
  }

  try {
    const [pipeline, { capacityWeeks, designedThisWeek }] = await Promise.all([
      loadLocationQueueLines(location, thisWeek),
      loadDesignCapacityWeeks(location, thisWeek, weekOf),
    ]);
    // A missing month would drop its orders and pull later orders forward
    // into this week, so the list would be wrong, not just short.
    if (pipeline.failedMonths > 0) {
      return NextResponse.json({
        error: `the production app didn't return ${pipeline.failedMonths} of ${pipeline.totalMonths} months of orders. Try again in a minute.`,
      }, { status: 503 });
    }
    const { weeks } = scheduleLines(pipeline.lines, capacityWeeks);
    const week = weeks.find(w => w.weekOf === weekOf);
    const cap  = capacityWeeks.find(w => w.weekOf === weekOf);
    const orders: WeekOrder[] = (week?.lines ?? []).map(l => ({
      orderNumber:  l.orderNumber,
      customer:     l.customer,
      product:      l.product,
      variant:      l.variant,
      stage:        DESIGN_QUEUE_STATUSES.has(l.status) ? 'design_queue' : 'drying',
      intakeDate:   l.intakeDate,
      intakeSource: l.intakeSource,
    }));
    return NextResponse.json({
      weekOf,
      orders,
      scheduled:        Math.round(cap?.scheduled ?? 0),
      capacity:         week?.capacity ?? 0,
      designedThisWeek: weekOf === thisWeek ? designedThisWeek : 0,
      generatedAt:      new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
