import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { GENERAL_MANAGERS, getGmCostForWeeks } from '@/lib/managers';
import { getWeekMondays } from '@/lib/weekDates';
import {
  projectDept, buildManagerHomeDept,
  type DesignRosterEntry, type PresRosterEntry, type HoursMap, type DailyHoursMap, type MemberCostLine,
} from '@/lib/scheduleProjection';

// Admin-only: estimated labor cost per location / department / month, from
// the saved Scheduling rosters + schedules (schedule_settings) and each
// person's pay on the roster. Same projectDept math as All KPIs' "Est."
// months, just run for a longer horizon and with a per-person breakdown.
//
// G&A is intentionally not projected here — it has no schedule to project
// from (All KPIs uses a trailing payroll average for it instead).

export const dynamic = 'force-dynamic';

const DEPTS = ['Design', 'Preservation', 'Fulfillment', 'Resin'] as const;
type Dept = typeof DEPTS[number];

interface SettingRow { location: string; key: string; value: unknown }

export interface DeptForecast {
  cost:    number;
  hours:   number;
  members: MemberCostLine[];
}

export interface LocationMonthForecast {
  depts: Record<Dept, DeptForecast>;
  gm:    { cost: number; names: string[] };
}

export interface MonthForecast {
  monthStart: string;   // 'YYYY-MM-01'
  label:      string;   // 'Oct 2026'
  weeks:      number;   // Mondays attributed to this month (first-Monday rule)
  isSnapshot: boolean;  // current month read from its locked month-end snapshot
  locations:  Record<'Utah' | 'Georgia', LocationMonthForecast>;
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function monthLabel(monthStart: string): string {
  return new Date(monthStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function projectLocationMonth(
  settings: SettingRow[],
  location: string,
  weekOfs: string[],
  holidaySet: Set<string>,
  managerHomeDept: Map<string, Set<string>>,
): LocationMonthForecast {
  const get = (key: string) => settings.find(r => r.location === location && r.key === key)?.value ?? {};

  // Resin's roster is a plain array (see ResinPage.tsx) — key it by id like
  // the other three departments, same as /api/kpis does.
  const resinRaw = get('resinRoster');
  const resinArr = Array.isArray(resinRaw) ? resinRaw as (DesignRosterEntry & { id: string })[] : [];
  const resinRoster: Record<string, DesignRosterEntry> = Object.fromEntries(resinArr.map(m => [m.id, m]));

  const inputs: Record<Dept, [Record<string, DesignRosterEntry | PresRosterEntry>, HoursMap, DailyHoursMap]> = {
    Design:       [get('designRoster') as Record<string, DesignRosterEntry>, get('designHours') as HoursMap, get('designDailyHours') as DailyHoursMap],
    Preservation: [get('presRoster')   as Record<string, PresRosterEntry>,   get('presHours')   as HoursMap, get('presDailyHours')   as DailyHoursMap],
    Fulfillment:  [get('ffRoster')     as Record<string, PresRosterEntry>,   get('ffHours')     as HoursMap, get('ffDailyHours')     as DailyHoursMap],
    Resin:        [resinRoster,                                              get('resinHours')  as HoursMap, get('resinDailyHours')  as DailyHoursMap],
  };
  const mgrTotalHours = get('mgrTotalHours') as HoursMap;

  const depts = {} as Record<Dept, DeptForecast>;
  for (const dept of DEPTS) {
    const [roster, hours, daily] = inputs[dept];
    const members: MemberCostLine[] = [];
    // Cost is real pay in every mode; 'estimate' only affects production,
    // which this view doesn't use.
    const r = projectDept(roster, hours, daily, weekOfs, location, dept, holidaySet, 'estimate', mgrTotalHours, managerHomeDept, undefined, members);
    members.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
    depts[dept] = { cost: r.laborCost, hours: r.hours, members };
  }

  const gmNames = GENERAL_MANAGERS
    .filter(gm => gm.location === location && weekOfs.some(w => (!gm.from || w >= gm.from) && (!gm.to || w <= gm.to)))
    .map(gm => gm.name);

  return { depts, gm: { cost: getGmCostForWeeks(location, weekOfs), names: [...new Set(gmNames)] } };
}

// GET /api/labor-forecast?months=12
// Starts at the current business month (the month containing this week's
// Monday — same convention as /api/kpis) and runs `months` months forward.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('clerk_user_id', userId)
    .single();
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403 });

  const months = Math.min(24, Math.max(1, parseInt(req.nextUrl.searchParams.get('months') ?? '12') || 12));

  try {
    const now = new Date();
    const dow = now.getDay();
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
    const businessMonthStart = `${isoDate(thisMonday).slice(0, 7)}-01`;

    const [settingsRes, empRes, snapRes] = await Promise.all([
      supabase.from('schedule_settings').select('location,key,value'),
      supabase.from('rippling_employees').select('full_name,location,department,title').eq('active', true),
      // Current month only: prefer its locked month-end snapshot, same as
      // All KPIs' Est. current month, so the two always agree.
      supabase.from('monthly_schedule_snapshots').select('location,settings_json').eq('snapshot_month', businessMonthStart),
    ]);
    if (settingsRes.error) throw settingsRes.error;

    const liveSettings: SettingRow[] = settingsRes.data ?? [];
    const snapSettings: SettingRow[] = (snapRes.data ?? []).flatMap(snap =>
      Object.entries(snap.settings_json as Record<string, unknown>).map(([key, value]) => ({ location: snap.location as string, key, value }))
    );
    const paidHolidays = (liveSettings.find(r => r.location === 'Global' && r.key === 'paidHolidays')?.value as string[]) ?? [];
    const holidaySet = new Set(paidHolidays);
    const managerHomeDept = buildManagerHomeDept(empRes.data ?? []);

    const result: MonthForecast[] = [];
    const [y, m] = businessMonthStart.split('-').map(Number);
    for (let i = 0; i < months; i++) {
      const first = new Date(y, m - 1 + i, 1, 12);
      const last  = new Date(y, m + i, 0, 12);
      const monthStart = isoDate(first);
      const weekOfs = getWeekMondays(monthStart, isoDate(last));
      const isSnapshot = i === 0 && snapSettings.length > 0;
      const settings = isSnapshot ? snapSettings : liveSettings;

      result.push({
        monthStart,
        label: monthLabel(monthStart),
        weeks: weekOfs.length,
        isSnapshot,
        locations: {
          Utah:    projectLocationMonth(settings, 'Utah',    weekOfs, holidaySet, managerHomeDept),
          Georgia: projectLocationMonth(settings, 'Georgia', weekOfs, holidaySet, managerHomeDept),
        },
      });
    }

    return NextResponse.json(
      { months: result, generatedAt: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message
      : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message
      : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
