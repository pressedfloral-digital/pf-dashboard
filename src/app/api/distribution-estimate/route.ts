import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDistributionEstimates } from '@/lib/distributionEstimate';

// GET /api/distribution-estimate?weeks=52&past=0
//
// For each of the next N weeks (plus `past` weeks before this one), suggests a Utah % distribution based on
// real historical seasonality (which states' orders concentrate in which
// week/month of year — e.g. FL/TX skewing heavier in winter) applied to
// each state's EFFECTIVE location for that week: its current
// state_location_routing assignment, overridden by any planned_state_moves
// entry whose effective_date has arrived by then. This is a *default*, not
// an override — the Growth & Distribution tab only falls back to it for a
// week that has no manually-set distributionPct, same as every other
// smart-default in this app (see intakeHistory.ts's rolling multiplier).
//
// Seasonality signal: prefers the real ISO week-of-year (e.g. "week 38
// across all synced years") when there's enough order volume in that week
// to be a signal rather than noise; falls back to the calendar month
// otherwise. Both are rolled up from shopify_order_state_facts (raw
// per-order rows, currently 20k+ and growing monthly), not pre-aggregated —
// scanning all of them on every request was the "takes a second to load"
// slowness, so that scan+rollup is cached (see getSeasonalAggregates in the lib)
// and only recomputed hourly or when a sync lands (sync-state-sales calls
// revalidateTag). states/planned moves stay uncached (small tables, and a
// plan needs to take effect immediately, not after an hour).
//
// Past weeks are a *reconstruction* — the model re-run with today's order
// history, with implemented moves unwound for weeks before they took effect.
// The Growth & Distribution tab prefers growth_forecast_snapshots (what was
// actually forecast at the time) and only falls back to this for weeks that
// predate snapshotting.
//
// The model itself lives in src/lib/distributionEstimate.ts so
// /api/labor-forecast can project bouquets received with the same default.

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const weeksCount = Math.min(104, Math.max(1, parseInt(req.nextUrl.searchParams.get('weeks') ?? '52', 10) || 52));
  const pastCount  = Math.min(520, Math.max(0, parseInt(req.nextUrl.searchParams.get('past') ?? '0', 10) || 0));

  try {
    const { estimates, yearsOfHistory } = await getDistributionEstimates(weeksCount, pastCount);
    return NextResponse.json({ estimates, yearsOfHistory, weeksReturned: weeksCount });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
