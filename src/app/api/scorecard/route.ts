import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { DEPARTMENT_MANAGERS, getSalaryMgrCostForWeeks } from '@/lib/managers';
import { fetchAllRows } from '@/lib/fetchAllRows';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LaborRow {
  employee: string;
  location: string;
  department: string;
  week_of: string;
  gross_pay: number;
}

interface ActualRow {
  week_of: string;
  member_name: string;
  department: string;
  location: string;
  actual_hours: number;
  actual_orders: number;
}

interface RosterSettingRow {
  location: string;
  key:      string;
  value:    unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Months that belong to a given week_of (Monday attribution — matches dashboard)
function weekMonth(weekOf: string): string {
  // e.g. "2026-03-30" → "2026-03"
  return weekOf.slice(0, 7);
}

// Monday of the week containing the given date, as "YYYY-MM-DD"
function getMondayOf(d: Date): string {
  const dow  = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
}

// All week_of dates whose Monday falls in a given month key ("2026-03")
function weeksInMonth(weekOfs: string[], monthKey: string): string[] {
  return weekOfs.filter(w => weekMonth(w) === monthKey);
}

// Manager pay/role definitions live in src/lib/managers.ts (single source of
// truth shared with kpis/route.ts, useActualsWithPayroll.ts, and
// useHistoricalMetrics.ts). Update that file when a manager changes.

// Returns salary manager weekly cost contribution for a given location+dept+weekOf
function getSalaryMgrCost(location: string, dept: string, weekOf: string): number {
  return getSalaryMgrCostForWeeks(DEPARTMENT_MANAGERS, location, dept, [weekOf]);
}

// Which team_member_week_actuals rows belong to a manager, so Combined ratio
// can exclude their hours AND their production — mirrors buildManagerNameSet
// in src/app/api/kpis/route.ts. Built from the live roster's isManager flag.
function buildManagerNameSet(rosterRows: RosterSettingRow[]): Set<string> {
  const deptByKey: Record<string, string> = {
    designRoster: 'Design', presRoster: 'Preservation', ffRoster: 'Fulfillment',
  };
  const set = new Set<string>();
  for (const row of rosterRows) {
    const dept = deptByKey[row.key];
    if (!dept) continue;
    const roster = row.value as Record<string, { name?: string; isManager?: boolean }> | null;
    if (!roster) continue;
    for (const member of Object.values(roster)) {
      if (member?.isManager && member.name) {
        set.add(`${row.location}|${dept}|${member.name.trim().toLowerCase()}`);
      }
    }
  }
  return set;
}

// Departments included in blended CPO (all except Resin)
const BLENDED_DEPTS = ['Design', 'Preservation', 'Fulfillment', 'G&A'];
// All departments that have their own CPO
const ALL_CPO_DEPTS = ['Design', 'Preservation', 'Fulfillment', 'G&A', 'Resin'];

// Production metric for each dept (matches dashboard conventions)
// Design → frames (actual_orders in design historicals)
// Preservation → bouquets (actual_orders in preservation historicals)
// Fulfillment → orders (actual_orders in fulfillment historicals)
// G&A → no production metric (cost only, spread across total blended orders)
// Resin → actual_orders in resin historicals

// ── GET /api/scorecard ────────────────────────────────────────────────────────
// Query params:
//   location  = Utah | Georgia | both (default: both)
//   month     = YYYY-MM (default: last complete month)
//   months    = number of months to return (default: 13 for YTD + prev)

export async function GET(req: NextRequest) {
  const isSyncCaller = req.headers.get('authorization') === `Bearer ${process.env.SCORECARDS_SYNC_SECRET}`;
  if (!isSyncCaller) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const locationParam = req.nextUrl.searchParams.get('location') ?? 'both';
  const monthParam    = req.nextUrl.searchParams.get('month');   // "2026-03"
  const monthsBack    = parseInt(req.nextUrl.searchParams.get('months') ?? '13');

  // Build month range
  const now = new Date();
  // Business-month convention: "current" is whichever calendar month
  // contains the Monday of the current week (matches weekMonth's Monday
  // attribution for bucketing weeks, and kpis/route.ts's est-current/MTD).
  const currentMonth = weekMonth(getMondayOf(now));
  const targetMonth  = monthParam ?? (() => {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  // Date range: from 13 months back to end of current month
  const fromDate = (() => {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  })();

  const locations: string[] = locationParam === 'both'
    ? ['Utah', 'Georgia']
    : [locationParam];

  try {
    // ── Fetch labor cost data ─────────────────────────────────────────────────
    // fetchAllRows, not a plain .select() — weekly_labor_cost/
    // team_member_week_actuals are past (or closing in on) Postgrest's
    // silent 1000-row cap, and this route's default 13-month, both-locations
    // window is exactly the kind of broad query that cap truncates without
    // any error. See src/lib/fetchAllRows.ts.
    const laborRows = await fetchAllRows<LaborRow>((from, to) => {
      let q = supabase
        .from('weekly_labor_cost')
        .select('employee,location,department,week_of,gross_pay')
        .gte('week_of', fromDate);
      if (locationParam !== 'both') q = q.eq('location', locationParam);
      return q.range(from, to);
    });

    // ── Fetch team actuals (hours + production) ───────────────────────────────
    const actualRows = await fetchAllRows<ActualRow>((from, to) => {
      let q = supabase
        .from('team_member_week_actuals')
        .select('week_of,member_name,department,location,actual_hours,actual_orders')
        .gte('week_of', fromDate);
      if (locationParam !== 'both') q = q.eq('location', locationParam);
      return q.range(from, to);
    });

    // ── Fetch goals ───────────────────────────────────────────────────────────
    const { data: goalsData, error: goalsError } = await supabase
      .from('scorecard_goals')
      .select('*')
      .gte('month_key', fromDate.slice(0, 7));
    if (goalsError) throw goalsError;

    // ── Fetch roster (for manager-hours/production exclusion on Combined ratio) ─
    const { data: rosterData, error: rosterError } = await supabase
      .from('schedule_settings')
      .select('location,key,value')
      .in('key', ['designRoster', 'presRoster', 'ffRoster']);
    if (rosterError) throw rosterError;
    const managerNames = buildManagerNameSet(rosterData ?? []);

    // ── Compute monthly actuals per location ──────────────────────────────────
    const allWeekOfs = [...new Set([
      ...laborRows.map(r => r.week_of),
      ...actualRows.map(r => r.week_of),
    ])].sort();

    // Build month list
    const monthSet = new Set(allWeekOfs.map(weekMonth));
    monthSet.add(targetMonth);
    monthSet.add(currentMonth);
    const monthList = [...monthSet].sort();

    const result: Record<string, unknown> = {
      months:      monthList,
      targetMonth,
      currentMonth,
      byLocation:  {} as Record<string, unknown>,
      blended:     {} as Record<string, unknown>,
      goals:       goalsData ?? [],
    };

    // Per-location monthly metrics
    for (const loc of locations) {
      const locResult: Record<string, unknown> = {};

      for (const month of monthList) {
        const weekOfs = weeksInMonth(allWeekOfs, month);

        // ── Labor cost by dept this month ─────────────────────────────────────
        const laborByDept: Record<string, number> = {};
        // Hourly staff from weekly_labor_cost upload
        for (const row of laborRows.filter(r => r.location === loc && weekOfs.includes(r.week_of))) {
          const dept = normalizeDeptForScorecard(row.department);
          laborByDept[dept] = (laborByDept[dept] ?? 0) + row.gross_pay;
        }
        // Salary managers — computed from annual salary, never in weekly_labor_cost
        // Mirrors useActualsWithPayroll.ts getSalaryMgrCost logic exactly
        const allDepts = ['Design', 'Preservation', 'Fulfillment', 'G&A', 'Resin'];
        for (const dept of allDepts) {
          for (const weekOf of weekOfs) {
            const mgrCost = getSalaryMgrCost(loc, dept, weekOf);
            if (mgrCost > 0) laborByDept[dept] = (laborByDept[dept] ?? 0) + mgrCost;
          }
        }

        // ── Production by dept this month (from team_member_week_actuals) ──────
        const productionByDept: Record<string, number> = {};
        const hoursByDept:      Record<string, number> = {};
        // ratioHoursByDept / ratioProductionByDept mirror the above but skip
        // manager rows entirely — Combined ratio counts neither a manager's
        // hours nor their production, while productionByDept/hoursByDept stay
        // fully inclusive for CPO/cost purposes.
        const ratioHoursByDept:      Record<string, number> = {};
        const ratioProductionByDept: Record<string, number> = {};
        for (const row of actualRows.filter(r => r.location === loc && weekOfs.includes(r.week_of))) {
          const dept = normalizeDeptForScorecard(row.department);
          productionByDept[dept] = (productionByDept[dept] ?? 0) + row.actual_orders;
          hoursByDept[dept]      = (hoursByDept[dept]      ?? 0) + row.actual_hours;
          const isMgr = managerNames.has(`${loc}|${dept}|${row.member_name.trim().toLowerCase()}`);
          if (!isMgr) {
            ratioHoursByDept[dept]      = (ratioHoursByDept[dept]      ?? 0) + row.actual_hours;
            ratioProductionByDept[dept] = (ratioProductionByDept[dept] ?? 0) + row.actual_orders;
          }
        }

        // ── Per-dept CPO ──────────────────────────────────────────────────────
        const deptCPO: Record<string, number | null> = {};
        for (const dept of ALL_CPO_DEPTS) {
          const cost   = laborByDept[dept]      ?? 0;
          const orders = productionByDept[dept] ?? 0;
          deptCPO[dept] = (cost > 0 && orders > 0) ? cost / orders : null;
        }

        // ── Blended CPO (excludes Resin) ─────────────────────────────────────
        // = (Preservation cost / Preservation orders)
        // + (Design cost / Design orders)
        // + (Fulfillment cost / Fulfillment orders)
        // + (G&A cost / all production orders combined)
        //
        // Each dept contributes its own CPO to the sum. G&A has no production
        // of its own so it divides by the total of the three production depts.
        const PROD_DEPTS_FOR_BLEND = ['Design', 'Preservation', 'Fulfillment'] as const;
        const totalProductionOrders = PROD_DEPTS_FOR_BLEND.reduce(
          (s, d) => s + (productionByDept[d] ?? 0), 0
        );

        let blendedCPO: number | null = null;
        let blendedCPOSum = 0;
        let blendedHasData = false;

        for (const dept of PROD_DEPTS_FOR_BLEND) {
          const cost   = laborByDept[dept]      ?? 0;
          const orders = productionByDept[dept] ?? 0;
          if (cost > 0 && orders > 0) {
            blendedCPOSum += cost / orders;
            blendedHasData = true;
          }
        }

        // G&A: divide by total production orders across all three depts
        const gaCost = laborByDept['G&A'] ?? 0;
        if (gaCost > 0 && totalProductionOrders > 0) {
          blendedCPOSum += gaCost / totalProductionOrders;
          blendedHasData = true;
        }

        if (blendedHasData) blendedCPO = blendedCPOSum;

        // ── Combined location ratio ───────────────────────────────────────────
        // = (Preservation hours / Preservation orders)
        // + (Design hours / Design orders)
        // + (Fulfillment hours / Fulfillment orders)
        // + (G&A hours / all production orders combined)
        // Uses ratioHoursByDept/ratioProductionByDept throughout — manager
        // hours and manager production are excluded entirely, not just hours.
        let combinedRatio: number | null = null;
        let combinedRatioSum = 0;
        let combinedHasData  = false;

        const ratioTotalProductionOrders = PROD_DEPTS_FOR_BLEND.reduce(
          (s, d) => s + (ratioProductionByDept[d] ?? 0), 0
        );

        for (const dept of PROD_DEPTS_FOR_BLEND) {
          const hrs    = ratioHoursByDept[dept]      ?? 0;
          const orders = ratioProductionByDept[dept] ?? 0;
          if (hrs > 0 && orders > 0) {
            combinedRatioSum += hrs / orders;
            combinedHasData   = true;
          }
        }

        // G&A has no manager-exclusion roster of its own (buildManagerNameSet
        // only covers Design/Preservation/Fulfillment) — its hours stay as-is.
        const gaHours = ratioHoursByDept['G&A'] ?? 0;
        if (gaHours > 0 && ratioTotalProductionOrders > 0) {
          combinedRatioSum += gaHours / ratioTotalProductionOrders;
          combinedHasData   = true;
        }

        if (combinedHasData) combinedRatio = combinedRatioSum;

        // Keep these for company-wide rollup (summing per-loc blendedCPO components)
        const blendedCost   = BLENDED_DEPTS.reduce((s, d) => s + (laborByDept[d] ?? 0), 0);
        const blendedOrders = totalProductionOrders;

        // ── Per-member ratios ─────────────────────────────────────────────────
        const memberRatios: Array<{
          name: string; department: string;
          hours: number; orders: number; ratio: number | null;
        }> = [];

        // Group by member+dept
        const memberDeptMap: Record<string, { hours: number; orders: number }> = {};
        for (const row of actualRows.filter(r => r.location === loc && weekOfs.includes(r.week_of))) {
          const key = `${row.member_name}||${normalizeDeptForScorecard(row.department)}`;
          if (!memberDeptMap[key]) memberDeptMap[key] = { hours: 0, orders: 0 };
          memberDeptMap[key].hours  += row.actual_hours;
          memberDeptMap[key].orders += row.actual_orders;
        }
        for (const [key, vals] of Object.entries(memberDeptMap)) {
          const [name, dept] = key.split('||');
          memberRatios.push({
            name, department: dept,
            hours:  vals.hours,
            orders: vals.orders,
            ratio:  (vals.hours > 0 && vals.orders > 0) ? vals.hours / vals.orders : null,
          });
        }

        locResult[month] = {
          laborByDept,
          productionByDept,
          hoursByDept,
          ratioHoursByDept,
          ratioProductionByDept,
          deptCPO,
          blendedCPO,
          combinedRatio,
          blendedCost,
          blendedOrders,
          memberRatios,
          hasData: Object.keys(laborByDept).length > 0 || Object.keys(productionByDept).length > 0,
        };
      }

      (result.byLocation as Record<string, unknown>)[loc] = locResult;
    }

    // ── Company-wide blended (Utah + Georgia combined) ────────────────────────
    // Company blended CPO = sum of per-dept CPOs across both locations combined.
    // We recompute from the raw totals so we don't double-count by adding two
    // already-summed blendedCPOs together.
    // Formula: same additive pattern, but pooling Utah + Georgia labor & production.
    for (const month of monthList) {
      type LocMonthData = {
        laborByDept: Record<string, number>;
        productionByDept: Record<string, number>;
        hoursByDept: Record<string, number>;
        ratioHoursByDept: Record<string, number>;
        ratioProductionByDept: Record<string, number>;
      };
      const locData = (result.byLocation as Record<string, Record<string, LocMonthData>>);

      // Pool labor and production across locations
      const pooledLabor: Record<string, number> = {};
      const pooledProd:  Record<string, number> = {};
      const pooledHours: Record<string, number> = {};
      // Manager-free pools, for Combined ratio only — see per-location comment above.
      const pooledRatioHours: Record<string, number> = {};
      const pooledRatioProd:  Record<string, number> = {};

      for (const loc of locations) {
        const m = locData[loc]?.[month];
        if (!m) continue;
        for (const [dept, val] of Object.entries(m.laborByDept ?? {})) {
          pooledLabor[dept] = (pooledLabor[dept] ?? 0) + val;
        }
        for (const [dept, val] of Object.entries(m.productionByDept ?? {})) {
          pooledProd[dept]  = (pooledProd[dept]  ?? 0) + val;
        }
        for (const [dept, val] of Object.entries(m.hoursByDept ?? {})) {
          pooledHours[dept] = (pooledHours[dept] ?? 0) + val;
        }
        for (const [dept, val] of Object.entries(m.ratioHoursByDept ?? {})) {
          pooledRatioHours[dept] = (pooledRatioHours[dept] ?? 0) + val;
        }
        for (const [dept, val] of Object.entries(m.ratioProductionByDept ?? {})) {
          pooledRatioProd[dept] = (pooledRatioProd[dept] ?? 0) + val;
        }
      }

      const PROD_DEPTS_BLEND = ['Design', 'Preservation', 'Fulfillment'] as const;
      const pooledTotalOrders = PROD_DEPTS_BLEND.reduce((s, d) => s + (pooledProd[d] ?? 0), 0);
      const pooledRatioTotalOrders = PROD_DEPTS_BLEND.reduce((s, d) => s + (pooledRatioProd[d] ?? 0), 0);

      let companyBlendedCPO: number | null = null;
      let companyBlendedSum = 0;
      let companyHasData    = false;

      for (const dept of PROD_DEPTS_BLEND) {
        const cost   = pooledLabor[dept] ?? 0;
        const orders = pooledProd[dept]  ?? 0;
        if (cost > 0 && orders > 0) { companyBlendedSum += cost / orders; companyHasData = true; }
      }
      const gaPooled = pooledLabor['G&A'] ?? 0;
      if (gaPooled > 0 && pooledTotalOrders > 0) {
        companyBlendedSum += gaPooled / pooledTotalOrders;
        companyHasData = true;
      }
      if (companyHasData) companyBlendedCPO = companyBlendedSum;

      // Company combined ratio: same additive structure, manager-free pools
      let companyCombinedRatio: number | null = null;
      let companyCombinedSum = 0;
      let companyCombinedHasData = false;

      for (const dept of PROD_DEPTS_BLEND) {
        const hrs    = pooledRatioHours[dept] ?? 0;
        const orders = pooledRatioProd[dept]  ?? 0;
        if (hrs > 0 && orders > 0) { companyCombinedSum += hrs / orders; companyCombinedHasData = true; }
      }
      const gaHoursPooled = pooledRatioHours['G&A'] ?? 0;
      if (gaHoursPooled > 0 && pooledRatioTotalOrders > 0) {
        companyCombinedSum += gaHoursPooled / pooledRatioTotalOrders;
        companyCombinedHasData = true;
      }
      if (companyCombinedHasData) companyCombinedRatio = companyCombinedSum;

      (result.blended as Record<string, unknown>)[month] = {
        blendedCPO:    companyBlendedCPO,
        combinedRatio: companyCombinedRatio,
        totalOrders:   pooledTotalOrders,
        pooledLabor,
        pooledProd,
      };
    }

    return NextResponse.json(result);
  } catch (e) {
    console.error('Scorecard error:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// ── POST /api/scorecard ───────────────────────────────────────────────────────
// Upsert a scorecard goal
// Body: { monthKey, location, department, goalCPO, minCPO, notes }
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await req.json() as {
      monthKey:   string;
      location:   string;  // 'Utah' | 'Georgia' | 'Company'
      department: string;  // 'Design' | 'Preservation' | 'Fulfillment' | 'G&A' | 'Resin' | 'Blended'
      goalCPO:    number | null;
      minCPO:     number | null;
      notes?:     string;
    };

    const { error } = await supabase
      .from('scorecard_goals')
      .upsert({
        month_key:  body.monthKey,
        location:   body.location,
        department: body.department,
        goal_cpo:   body.goalCPO,
        min_cpo:    body.minCPO,
        notes:      body.notes ?? null,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'month_key,location,department' });

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// Normalize department names to scorecard keys
function normalizeDeptForScorecard(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes('design'))                         return 'Design';
  if (l.includes('preservation'))                   return 'Preservation';
  if (l.includes('fulfillment'))                    return 'Fulfillment';
  if (l.includes('general') || l.includes('admin') || l === 'g&a') return 'G&A';
  if (l.includes('resin'))                          return 'Resin';
  return raw;
}
