import { auth } from "@clerk/nextjs/server";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { DESIGNER_IDS } from "@/lib/teamMembers";
import { isoMonday } from "@/lib/weekDates";
import { resolveWeekHours, type ScheduleRule } from "@/lib/scheduleResolution";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  // Allow passing explicit params for impersonation
  const memberNameParam = req.nextUrl.searchParams.get("memberName");
  const locationParam   = req.nextUrl.searchParams.get("location");
  const departmentParam = req.nextUrl.searchParams.get("department");

  let memberName: string;
  let location: string;
  let department: string;

  if (memberNameParam && locationParam && departmentParam) {
    // Verify caller is allowed — must be admin/GM/manager
    const { data: caller } = await supabase
      .from("user_profiles")
      .select("role, team_member_name, location, department")
      .eq("clerk_user_id", userId)
      .single();

    const isPrivileged = ["admin", "general_manager", "manager"].includes(caller?.role ?? "");
    const isOwnData =
      caller?.team_member_name === memberNameParam &&
      caller?.location === locationParam &&
      caller?.department === departmentParam;
    if (!isPrivileged && !isOwnData) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    memberName = memberNameParam;
    location   = locationParam;
    department = departmentParam;
  } else {
    // Normal user flow — look up their own profile
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("clerk_user_id", userId)
      .single();

    if (!profile) return NextResponse.json({ error: "No profile" }, { status: 403 });

    memberName = profile.team_member_name;
    location   = profile.location;
    department = profile.department;
  }

  // Home department/location come from the live Rippling roster when available
  if (memberName) {
    const { data: emp } = await supabase
      .from("rippling_employees")
      .select("department, location")
      .ilike("full_name", memberName.trim())
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (emp?.department) department = emp.department.toLowerCase();
    if (emp?.location)   location   = emp.location;
  }

  if (!memberName || !location || !department) {
    return NextResponse.json({ thisWeek: null, historicals: [], upcomingWeeks: [] });
  }

  const since = new Date();
  since.setDate(since.getDate() - 26 * 7);
  const sinceIso = since.toISOString().split("T")[0];

  const { data: actuals } = await supabase
    .from("team_member_week_actuals")
    .select("week_of, actual_hours, actual_orders, department")
    .eq("location", location)
    .eq("member_name", memberName)
    .gte("week_of", sinceIso)
    .order("week_of", { ascending: false });

  const rows = actuals ?? [];
  const thisWeekOf  = isoMonday(0);

  // Averages/ratio/this week all based on home department
  const homeDeptRowsEarly = rows.filter(r => r.department?.toLowerCase() === department?.toLowerCase());
  const thisWeekRow = homeDeptRowsEarly.find(r => r.week_of === thisWeekOf);

  const ratioData   = homeDeptRowsEarly.filter(r => r.actual_hours > 0 && r.actual_orders > 0);
  const totalHours  = ratioData.reduce((s, r) => s + (r.actual_hours ?? 0), 0);
  const totalOrders = ratioData.reduce((s, r) => s + (r.actual_orders ?? 0), 0);


  // All rows sorted newest first, include department
  const historicals = rows.slice(0, 24).map(r => ({
    weekOf:     r.week_of,
    hours:      r.actual_hours,
    orders:     r.actual_orders,
    department: r.department,
    ratio:      r.actual_hours > 0 && r.actual_orders > 0
      ? Math.round((r.actual_hours / r.actual_orders) * 100) / 100
      : null,
  }));

  // Fetch scheduled hours for ALL departments (including resin) for this person
  const ALL_DEPT_KEYS = [
    { dept: 'design',       weekly: 'designHours',    daily: 'designDailyHours' },
    { dept: 'preservation', weekly: 'presHours',       daily: 'presDailyHours'   },
    { dept: 'fulfillment',  weekly: 'ffHours',         daily: 'ffDailyHours'     },
    { dept: 'resin',        weekly: 'resinHours',      daily: 'resinDailyHours'  },
  ];

  const designerId = DESIGNER_IDS[memberName] ?? null;

  // Fetch all schedule keys in one query
  const allKeys = ALL_DEPT_KEYS.flatMap(d => [d.weekly, d.daily]);
  const { data: scheduleRows } = await supabase
    .from("schedule_settings")
    .select("key, value")
    .eq("location", location)
    .in("key", allKeys);

  const scheduleMap: Record<string, Record<string, number[] | Record<string, number>>> = {};
  for (const row of scheduleRows ?? []) {
    try {
      const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      scheduleMap[row.key] = parsed;
    } catch { /* ignore */ }
  }

  // Home dept config
  const homeDeptNorm = department?.toLowerCase() ?? '';
  const homeDeptConfig = ALL_DEPT_KEYS.find(d => d.dept === homeDeptNorm) ?? ALL_DEPT_KEYS[0];

  // homeWeeklyHours / dailyHours computed below after roster lookup

  // Cross-dept hours — look up by name across each dept's roster, not by home designerId
  // Each dept roster is stored under e.g. presRoster, ffRoster, designRoster, resinRoster
  const ROSTER_KEYS: Record<string, string> = {
    design:       'designRoster',
    preservation: 'presRoster',
    fulfillment:  'ffRoster',
    resin:        'resinRoster',
  };

  // Fetch all roster keys too
  const rosterKeyList = Object.values(ROSTER_KEYS);
  const { data: rosterRows } = await supabase
    .from("schedule_settings")
    .select("key, value")
    .eq("location", location)
    .in("key", rosterKeyList);

  type RosterEntry = {
    id?: string; name?: string; ratio?: number; _removed?: boolean;
    standardWeeklyHours?: number[]; startDate?: string; endDate?: string;
    scheduleRules?: ScheduleRule[]; daysOff?: string[]; hoursOff?: Record<string, number>;
  };
  const rosterMap: Record<string, Record<string, RosterEntry>> = {};
  for (const row of rosterRows ?? []) {
    try {
      const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      rosterMap[row.key] = parsed;
    } catch { /* ignore */ }
  }

  // Helper: find a person in a given dept roster by name match.
  // Rosters may be objects keyed by ID or arrays (resin) — prefer member.id over the key.
  function findMemberInRoster(rosterKey: string, name: string): { id: string; ratio: number | null; entry: RosterEntry } | null {
    const roster = rosterMap[rosterKey] ?? {};
    const nameLower = name.trim().toLowerCase();
    for (const [key, member] of Object.entries(roster)) {
      if (member?._removed) continue;
      if (member?.name?.trim().toLowerCase() === nameLower) {
        return { id: member?.id ?? key, ratio: member?.ratio ?? null, entry: member };
      }
    }
    return null;
  }
  function rosterEntryById(rosterKey: string, id: string): RosterEntry | undefined {
    const roster = rosterMap[rosterKey] ?? {};
    return roster[id] ?? Object.values(roster).find(m => m?.id === id);
  }

  // Paid holidays are global — needed so a holiday week resolves the same as on the Scheduling tab
  const { data: holidayRow } = await supabase
    .from("schedule_settings")
    .select("value")
    .eq("location", "Global")
    .eq("key", "paidHolidays")
    .maybeSingle();
  const paidHolidays: string[] = (() => {
    try {
      const v = typeof holidayRow?.value === "string" ? JSON.parse(holidayRow.value) : holidayRow?.value;
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  })();
  function findIdInRoster(rosterKey: string, name: string): string | null {
    return findMemberInRoster(rosterKey, name)?.id ?? null;
  }

  // Shape-aware schedule readers. Resin stores weekly hours as {isoMonday: {memberId: hours}}
  // (date-then-member); other depts store {memberId: {isoMonday: hours}} (member-then-date).
  // Both are date-keyed — we translate week offset -> isoMonday at the read boundary so the
  // rest of this route can keep working with plain offset-indexed arrays.
  function getLegacyWeekly(dept: string, weeklyKey: string, id: string, weekIso: string): number | undefined {
    const raw = scheduleMap[weeklyKey] ?? {};
    const val = dept === 'resin'
      ? (raw[weekIso] && !Array.isArray(raw[weekIso]) ? (raw[weekIso] as Record<string, number>)[id] : undefined)
      : (raw[id] && !Array.isArray(raw[id]) ? (raw[id] as Record<string, number>)[weekIso] : undefined);
    return typeof val === 'number' ? val : undefined;
  }
  // Production hours per week, resolved through the same fallback chain the
  // Scheduling tab's Weekly Schedule uses (daily overrides -> legacy weekly ->
  // standard template + rules, minus days off / holidays / employment window).
  function getWeeklyHours(dept: string, weeklyKey: string, dailyKey: string, id: string, entry?: RosterEntry): number[] {
    const dailyMap = (scheduleMap[dailyKey] ?? {}) as Record<string, (number | null)[]>;
    return Array.from({ length: 52 }, (_, i) => {
      const weekIso = isoMonday(i);
      const h = resolveWeekHours({
        dailyMap,
        weekKey: `${weekIso}-${id}`,
        legacyWeeklyValue: getLegacyWeekly(dept, weeklyKey, id, weekIso),
        standardWeeklyHours: entry?.standardWeeklyHours,
        employment: { weekIso, startDate: entry?.startDate, endDate: entry?.endDate, rules: entry?.scheduleRules, daysOff: entry?.daysOff, hoursOff: entry?.hoursOff },
        holidays: paidHolidays,
      });
      return Math.round(h * 100) / 100;
    });
  }
  function getDailyHours(dept: string, dailyKey: string, id: string): number[] {
    const raw = scheduleMap[dailyKey] ?? {};
    // Daily hours are keyed `${isoMonday}-${memberId}`; "this week" = offset 0.
    const arr = raw[`${isoMonday(0)}-${id}`];
    return Array.isArray(arr) ? (arr as number[]).slice(0, 5) : [];
  }
  // Target ratio comes from the roster, not actuals
  const homeRosterKey = ROSTER_KEYS[homeDeptNorm] ?? null;
  const homeMember = homeRosterKey ? findMemberInRoster(homeRosterKey, memberName) : null;
  const homeRosterId = homeMember?.id ?? null;
  const targetRatio: number | null = homeMember?.ratio ?? null;

  // Prefer the home-roster ID; fall back to DESIGNER_IDS for legacy design/pres IDs
  const homeScheduleId = homeRosterId ?? designerId;
  const homeEntry = homeMember?.entry ?? (homeScheduleId && homeRosterKey ? rosterEntryById(homeRosterKey, homeScheduleId) : undefined);
  const homeWeeklyHours: number[] = homeScheduleId
    ? getWeeklyHours(homeDeptNorm, homeDeptConfig.weekly, homeDeptConfig.daily, homeScheduleId, homeEntry) : [];
  const dailyHours: number[] = homeScheduleId
    ? getDailyHours(homeDeptNorm, homeDeptConfig.daily, homeScheduleId) : [];
  const crossDeptWeekly: { dept: string; hours: number[]; ratio: number | null }[] = [];
  for (const dk of ALL_DEPT_KEYS) {
    if (dk.dept === homeDeptNorm) continue;
    // Find this person's ID in the cross-dept roster by name
    const cross = findMemberInRoster(ROSTER_KEYS[dk.dept] ?? '', memberName);
    if (!cross) continue;

    const deptWeekly: number[] = getWeeklyHours(dk.dept, dk.weekly, dk.daily, cross.id, cross.entry);
    if (deptWeekly.some(h => h > 0)) {
      crossDeptWeekly.push({ dept: dk.dept, hours: deptWeekly, ratio: cross.ratio });
    }
  }

  // One row per department this person is scheduled in — the team member's
  // slice of each department's Weekly Schedule
  const deptSchedules = [
    ...(homeWeeklyHours.some(h => h > 0) ? [{ dept: homeDeptNorm, isHome: true, ratio: targetRatio, hours: homeWeeklyHours }] : []),
    ...crossDeptWeekly.map(d => ({ dept: d.dept, isHome: false, ratio: d.ratio, hours: d.hours })),
  ].map(d => ({ ...d, weeks: d.hours.map((h, i) => ({ weekOf: isoMonday(i), hours: h })) }))
   .map(({ hours: _hours, ...d }) => d);

  // Merged weekly totals (home + all cross-dept)
  const NUM_WEEKS = 8;
  const mergedWeeklyHours = Array.from({ length: NUM_WEEKS }, (_, i) => {
    const home  = homeWeeklyHours[i] ?? 0;
    const cross = crossDeptWeekly.reduce((s, d) => s + (d.hours[i] ?? 0), 0);
    const total = home + cross;
    return total > 0 ? Math.round(total * 10) / 10 : null;
  });

  // Also store daily breakdown for each cross-dept (for the weekly grid)
  const crossDeptDaily: { dept: string; daily: number[] }[] = [];
  for (const dk of ALL_DEPT_KEYS) {
    if (dk.dept === homeDeptNorm) continue;
    const crossId = findIdInRoster(ROSTER_KEYS[dk.dept] ?? '', memberName);
    if (!crossId) continue;
    const deptDaily: number[] = getDailyHours(dk.dept, dk.daily, crossId);
    if (deptDaily.some(h => h > 0)) {
      crossDeptDaily.push({ dept: dk.dept, daily: deptDaily });
    }
  }

  const thisWeekCrossDeptHours = crossDeptWeekly
    .filter(d => (d.hours[0] ?? 0) > 0)
    .map(d => ({ dept: d.dept, hours: d.hours[0] }));

  const upcomingWeeks = Array.from({ length: NUM_WEEKS }, (_, i) => ({
    weekOf: isoMonday(i),
    scheduledHours: mergedWeeklyHours[i] ?? null,
    crossDept: crossDeptWeekly
      .filter(d => (d.hours[i] ?? 0) > 0)
      .map(d => ({ dept: d.dept, hours: d.hours[i] })),
  }));

  const thisWeekScheduledHours = mergedWeeklyHours[0] ?? null;

  return NextResponse.json({
    routeVersion: 'v3-resin-shapes',
    memberName,
    location,
    department,
    dailyHours,
    thisWeek: {
      weekOf:         thisWeekOf,
      scheduledHours: thisWeekScheduledHours,
      ordersAssigned: thisWeekRow?.actual_orders ?? null,
      actualHours:    thisWeekRow?.actual_hours  ?? null,
      targetRatio,
      crossDeptHours: thisWeekCrossDeptHours,
      crossDeptDaily,
    },
    historicals,
    upcomingWeeks,
    deptSchedules,
    avgHours:  ratioData.length > 0 ? Math.round((totalHours  / ratioData.length) * 10) / 10 : null,
    avgOrders: ratioData.length > 0 ? Math.round((totalOrders / ratioData.length) * 10) / 10 : null,
    homeDepartment: department,
  });
}
