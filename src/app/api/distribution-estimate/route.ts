import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { unstable_cache } from 'next/cache';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { isoMonday, isoMondayFromDate, getISOWeekNumber } from '@/lib/weekDates';

// GET /api/distribution-estimate?weeks=52
//
// For each of the next N weeks, suggests a Utah % distribution based on
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
// slowness, so that scan+rollup is cached (see getSeasonalAggregates below)
// and only recomputed hourly or when a sync lands (sync-state-sales calls
// revalidateTag). states/planned moves stay uncached (small tables, and a
// plan needs to take effect immediately, not after an hour).

const MIN_ORDERS_FOR_WEEK_SIGNAL = 40;
export const STATE_SALES_CACHE_TAG = 'state-sales-facts';

interface Fact { state_code: string; order_date: string }
interface StateRow { state_code: string; location: 'Utah' | 'Georgia' }
interface PlannedMove { state_code: string; new_location: 'Utah' | 'Georgia'; effective_date: string }

interface SeasonalAggregates {
  byWeekOfYear: Record<number, Record<string, number>>;
  totalByWeekOfYear: Record<number, number>;
  byMonthOfYear: Record<number, Record<string, number>>;
  totalByMonthOfYear: Record<number, number>;
  yearsOfHistory: number;
}

const getSeasonalAggregates = unstable_cache(
  async (): Promise<SeasonalAggregates> => {
    const facts = await fetchAllRows<Fact>((from, to) =>
      supabase.from('shopify_order_state_facts').select('state_code, order_date').range(from, to)
    );

    const byWeekOfYear: Record<number, Record<string, number>> = {};
    const totalByWeekOfYear: Record<number, number> = {};
    const byMonthOfYear: Record<number, Record<string, number>> = {};
    const totalByMonthOfYear: Record<number, number> = {};
    const yearsSeen = new Set<number>();

    facts.forEach(f => {
      const d = new Date(f.order_date + 'T12:00:00');
      yearsSeen.add(d.getFullYear());
      const weekNum  = getISOWeekNumber(isoMondayFromDate(d));
      const monthNum = d.getMonth() + 1;

      byWeekOfYear[weekNum] = byWeekOfYear[weekNum] ?? {};
      byWeekOfYear[weekNum][f.state_code] = (byWeekOfYear[weekNum][f.state_code] ?? 0) + 1;
      totalByWeekOfYear[weekNum] = (totalByWeekOfYear[weekNum] ?? 0) + 1;

      byMonthOfYear[monthNum] = byMonthOfYear[monthNum] ?? {};
      byMonthOfYear[monthNum][f.state_code] = (byMonthOfYear[monthNum][f.state_code] ?? 0) + 1;
      totalByMonthOfYear[monthNum] = (totalByMonthOfYear[monthNum] ?? 0) + 1;
    });

    return { byWeekOfYear, totalByWeekOfYear, byMonthOfYear, totalByMonthOfYear, yearsOfHistory: yearsSeen.size };
  },
  ['distribution-estimate-seasonal-aggregates'],
  { revalidate: 3600, tags: [STATE_SALES_CACHE_TAG] },
);

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const weeksCount = Math.min(104, Math.max(1, parseInt(req.nextUrl.searchParams.get('weeks') ?? '52', 10) || 52));

  let seasonal: SeasonalAggregates;
  try {
    seasonal = await getSeasonalAggregates();
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
  const { byWeekOfYear, totalByWeekOfYear, byMonthOfYear } = seasonal;

  const [statesResult, movesResult] = await Promise.all([
    supabase.from('state_location_routing').select('state_code, location').returns<StateRow[]>(),
    supabase.from('planned_state_moves').select('state_code, new_location, effective_date').returns<PlannedMove[]>(),
  ]);
  if (statesResult.error) return NextResponse.json({ error: statesResult.error.message }, { status: 500 });
  if (movesResult.error) return NextResponse.json({ error: movesResult.error.message }, { status: 500 });
  const states = statesResult.data ?? [];
  const moves  = movesResult.data ?? [];

  // A state's effective location for a given week: the most recent planned
  // move whose effective_date has arrived by then, else its current routing.
  function effectiveLocation(stateCode: string, weekOf: string): 'Utah' | 'Georgia' {
    const applicable = moves
      .filter(m => m.state_code === stateCode && m.effective_date <= weekOf)
      .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
    if (applicable) return applicable.new_location;
    return states.find(s => s.state_code === stateCode)?.location ?? 'Utah';
  }

  const estimates: Record<string, { utPct: number | null; hasSeasonalData: boolean }> = {};
  for (let w = 0; w < weeksCount; w++) {
    const weekOf = isoMonday(w);
    const weekNum  = getISOWeekNumber(weekOf);
    const monthNum = new Date(weekOf + 'T12:00:00').getMonth() + 1;

    const useWeekSignal = (totalByWeekOfYear[weekNum] ?? 0) >= MIN_ORDERS_FOR_WEEK_SIGNAL;
    const shareSource = useWeekSignal ? byWeekOfYear[weekNum] : byMonthOfYear[monthNum];

    let utShare = 0, gaShare = 0;
    states.forEach(s => {
      const share = shareSource?.[s.state_code] ?? 0;
      if (effectiveLocation(s.state_code, weekOf) === 'Utah') utShare += share; else gaShare += share;
    });

    const hasSeasonalData = (utShare + gaShare) > 0;
    estimates[weekOf] = {
      utPct: hasSeasonalData ? (utShare / (utShare + gaShare)) * 100 : null,
      hasSeasonalData,
    };
  }

  return NextResponse.json({ estimates, yearsOfHistory: seasonal.yearsOfHistory, weeksReturned: weeksCount });
}
