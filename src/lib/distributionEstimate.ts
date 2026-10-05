import { unstable_cache } from 'next/cache';
import { supabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { isoMonday, isoMondayFromDate, getISOWeekNumber } from '@/lib/weekDates';

// Server-side core of /api/distribution-estimate (see that route for what the
// model does and why), extracted so /api/labor-forecast can project each
// location's bouquets received with the exact same Utah % default the
// Growth & Distribution and Queue & Turnaround tabs use.

const MIN_ORDERS_FOR_WEEK_SIGNAL = 40;
export const STATE_SALES_CACHE_TAG = 'state-sales-facts';

interface Fact { state_code: string; order_date: string }
interface StateRow { state_code: string; location: 'Utah' | 'Georgia' }
interface PlannedMove { state_code: string; new_location: 'Utah' | 'Georgia'; effective_date: string; implemented_at: string | null }

export interface WeekDistributionEstimate { utPct: number | null; hasSeasonalData: boolean }

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

// Suggested Utah % per week, for `pastCount` weeks before this one through
// `weeksCount - 1` weeks ahead, keyed by that week's Monday. Throws on any
// query error.
export async function getDistributionEstimates(weeksCount: number, pastCount: number): Promise<{
  estimates: Record<string, WeekDistributionEstimate>;
  yearsOfHistory: number;
}> {
  const seasonal = await getSeasonalAggregates();
  const { byWeekOfYear, totalByWeekOfYear, byMonthOfYear } = seasonal;

  const [statesResult, movesResult] = await Promise.all([
    supabase.from('state_location_routing').select('state_code, location').returns<StateRow[]>(),
    supabase.from('planned_state_moves').select('state_code, new_location, effective_date, implemented_at').returns<PlannedMove[]>(),
  ]);
  if (statesResult.error) throw new Error(statesResult.error.message);
  if (movesResult.error) throw new Error(movesResult.error.message);
  const states = statesResult.data ?? [];
  const moves  = movesResult.data ?? [];

  // A state's effective location for a given week: the most recent planned
  // move whose effective_date has arrived by then, else — for a week before
  // an implemented move took effect — the location it moved away from (the
  // routing row was already flipped when it was marked implemented), else
  // its current routing.
  function effectiveLocation(stateCode: string, weekOf: string): 'Utah' | 'Georgia' {
    const stateMoves = moves.filter(m => m.state_code === stateCode);
    const applicable = stateMoves
      .filter(m => m.effective_date <= weekOf)
      .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
    if (applicable) return applicable.new_location;
    const nextImplemented = stateMoves
      .filter(m => m.implemented_at && m.effective_date > weekOf)
      .sort((a, b) => a.effective_date.localeCompare(b.effective_date))[0];
    if (nextImplemented) return nextImplemented.new_location === 'Utah' ? 'Georgia' : 'Utah';
    return states.find(s => s.state_code === stateCode)?.location ?? 'Utah';
  }

  const estimates: Record<string, WeekDistributionEstimate> = {};
  for (let w = -pastCount; w < weeksCount; w++) {
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

  return { estimates, yearsOfHistory: seasonal.yearsOfHistory };
}
