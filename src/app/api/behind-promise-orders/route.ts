import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { isoMonday } from '@/lib/weekDates';
import { DESIGN_QUEUE_STATUSES, mondayOf } from '@/lib/designInventory';
import { loadLocationQueueLines } from '@/lib/designPipeline';

export const maxDuration = 120;

export interface BehindPromiseOrder {
  orderNumber:  string;
  customer:     string;
  product:      string;
  variant:      string;
  stage:        'design_queue' | 'drying';
  intakeDate:   string;
  intakeSource: 'bouquetReceived' | 'eventDate';
}

// ── GET /api/behind-promise-orders?location=Utah&weekOf=2026-07-20 ───────────
// Every order line received in one intake week that hasn't been designed yet
// (still in the design queue or still drying) — the orders behind a Queue &
// Turnaround row's "behind promise" flag. Grouped into intake weeks exactly
// like /api/design-inventory (see loadLocationQueueLines).
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') === 'Georgia' ? 'Georgia' : 'Utah';
  const weekOf   = req.nextUrl.searchParams.get('weekOf') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
    return NextResponse.json({ error: 'weekOf must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const { lines, failedMonths, totalMonths } = await loadLocationQueueLines(location, isoMonday(0));
    const orders: BehindPromiseOrder[] = lines
      .filter(l => mondayOf(l.intakeDate) === mondayOf(weekOf))
      .map(l => ({
        orderNumber:  l.orderNumber,
        customer:     l.customer,
        product:      l.product,
        variant:      l.variant,
        stage:        DESIGN_QUEUE_STATUSES.has(l.status) ? 'design_queue' as const : 'drying' as const,
        intakeDate:   l.intakeDate,
        intakeSource: l.intakeSource,
      }))
      .sort((a, b) => a.intakeDate.localeCompare(b.intakeDate) || a.orderNumber.localeCompare(b.orderNumber, undefined, { numeric: true }));
    // A missing month can only drop orders, never add them — still return
    // what loaded, but say the list may be incomplete.
    return NextResponse.json({ orders, incomplete: failedMonths > 0, failedMonths, totalMonths });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
