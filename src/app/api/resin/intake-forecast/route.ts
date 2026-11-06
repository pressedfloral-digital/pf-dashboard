import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { isoMonday } from '@/lib/weekDates';
import { fetchAllRows } from '@/lib/fetchAllRows';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import { getDistributionEstimates, type WeekDistributionEstimate } from '@/lib/distributionEstimate';
import {
  computeActualIntakeByWeek, computeCombinedIntakeByWeek, computeRollingMultiplier, estimateLocationBouquets,
  type IntakeProjectionInputs, type TeamActualRow,
} from '@/lib/intakeHistory';
import { resinIntakeWeek, resinShareOfBouquets } from '@/lib/resinCohortProjection';

const SHARE_WEEKS = 13;
const HORIZON_WEEKS = 52;
const LOCATIONS = ['Utah', 'Georgia'] as const;

// Expected resin units per future week: the company-wide bouquet forecast
// (Utah + Georgia, since resin is made in Utah from both locations' orders)
// × resin's recent share of bouquets received. The forecast already carries
// seasonality, so resin's estimate rises and falls with it.
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const [settingsRes, resinRows, presIntakeRows, presTeamRows, distribution] = await Promise.all([
      supabase.from('schedule_settings').select('location,key,value'),
      // Cleared rows count too: they're finished units that still arrived in
      // their intake week, and leaving them out would understate the share.
      fetchAllRows<{ quantity: number | null; event_date: string | null; order_date: string | null }>((from, to) => supabase.from('resin_queue')
        .select('quantity,event_date,order_date').order('line_item_id').range(from, to)),
      fetchAllRows<{ location: string; week_of: string; received: number }>((from, to) => supabase.from('preservation_week_actuals')
        .select('location,week_of,received').range(from, to)),
      fetchAllRows<TeamActualRow & { location: string }>((from, to) => supabase.from('team_member_week_actuals')
        .select('location,department,week_of,member_name,actual_hours,actual_orders').eq('department', 'preservation').range(from, to)),
      // Same fallback as useDistributionEstimate: no estimate -> 50/50.
      getDistributionEstimates(HORIZON_WEEKS, 0).catch(() => ({ estimates: {} as Record<string, WeekDistributionEstimate>, yearsOfHistory: 0 })),
    ]);
    if (settingsRes.error) throw settingsRes.error;
    const settings = settingsRes.data ?? [];
    const setting = <T,>(location: string, key: string, dflt: T): T =>
      (settings.find(r => r.location === location && r.key === key)?.value as T) ?? dflt;

    const intakeByLocation = LOCATIONS.map(location => {
      const pres: Record<string, number> = {};
      for (const r of presIntakeRows) if (r.location === location) pres[r.week_of] = r.received;
      const team = presTeamRows.filter(r => r.location === location && !isNonProductionStaff(r.member_name));
      return computeActualIntakeByWeek(location, team, pres);
    });
    const companyActualIntakeByWeek = computeCombinedIntakeByWeek(intakeByLocation[0], intakeByLocation[1]);

    const resinByWeek: Record<string, number> = {};
    for (const r of resinRows) {
      const week = resinIntakeWeek(r);
      if (week) resinByWeek[week] = (resinByWeek[week] ?? 0) + (r.quantity ?? 1);
    }
    const shareWeeks = Array.from({ length: SHARE_WEEKS }, (_, i) => isoMonday(-1 - i));
    const share = resinShareOfBouquets(resinByWeek, companyActualIntakeByWeek, shareWeeks);
    if (share === null) return NextResponse.json({ share: null, shareWeeks: SHARE_WEEKS, estimateByWeek: {} });

    const inputs: IntakeProjectionInputs = {
      companyActualIntakeByWeek,
      companyMultipliers:       setting<Record<string, number>>('Global', 'companyMultipliers', {}),
      rollingCompanyMultiplier: computeRollingMultiplier(companyActualIntakeByWeek, isoMonday),
      distributionPct:          setting<Record<string, { ut: number; ga: number }>>('Global', 'distributionPct', {}),
      suggestedUtPct:           w => distribution.estimates[w]?.utPct ?? 50,
    };
    const estimateByWeek: Record<string, number> = {};
    for (let w = 1; w < HORIZON_WEEKS; w++) {
      const weekOf = isoMonday(w);
      const bouquets = LOCATIONS.reduce((sum, location) => {
        // Older rows stored a flat number (Utah's); see useScheduleSettings.
        const raw = setting<Record<string, number | { ut: number; ga: number }>>(location, 'weeklyEstimates', {});
        const weeklyEstimates = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'number' ? { ut: v, ga: 0 } : v]));
        return sum + estimateLocationBouquets(location, weekOf, weeklyEstimates, setting<number>(location, 'avgIntake', 45), inputs);
      }, 0);
      estimateByWeek[weekOf] = Math.round(bouquets * share);
    }

    return NextResponse.json({ share, shareWeeks: SHARE_WEEKS, estimateByWeek });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not build the resin forecast';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
