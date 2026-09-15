import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';

// GET /api/state-sales?months=12
// Sums shopify_order_state_facts (raw per-order state/date/revenue rows)
// over the trailing N months and returns it per state, plus how many
// distinct calendar months actually have data (so a caller doesn't silently
// treat a partially-backfilled window as a full N-month figure).
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const months = Math.min(48, Math.max(1, parseInt(req.nextUrl.searchParams.get('months') ?? '12', 10) || 12));
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let rows: { state_code: string; revenue: number; order_date: string }[];
  try {
    rows = await fetchAllRows<{ state_code: string; revenue: number; order_date: string }>(
      (from, to) => supabase
        .from('shopify_order_state_facts')
        .select('state_code, revenue, order_date')
        .gte('order_date', cutoffStr)
        .range(from, to)
    );
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  const byState: Record<string, { order_count: number; revenue: number }> = {};
  const monthsSeen = new Set<string>();
  rows.forEach(row => {
    monthsSeen.add(row.order_date.slice(0, 7));
    const bucket = byState[row.state_code] ?? { order_count: 0, revenue: 0 };
    bucket.order_count += 1;
    bucket.revenue += Number(row.revenue);
    byState[row.state_code] = bucket;
  });

  return NextResponse.json({ states: byState, monthsRequested: months, monthsWithData: monthsSeen.size });
}
