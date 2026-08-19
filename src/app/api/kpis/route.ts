import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { DEPARTMENT_MANAGERS, getSalaryMgrCostForWeeks, getGmCostForWeeks } from '@/lib/managers';
import { RATIO_TARGETS, type RatioTier } from '@/lib/ratioTargets';
import { WAGE_TARGETS, type WageLocation, type WageDept } from '@/lib/wageTargets';
import { resolveWeekHours } from '@/lib/scheduleResolution';

const VALID_ROLES = new Set<string>(['specialist', 'senior', 'master']);
// `member.role ?? 'specialist'` alone doesn't protect against a malformed
// role value that isn't null/undefined but also isn't a real tier — e.g. a
// stray `0` slipping in from a bad sync or manual edit. `??` only catches
// null/undefined, so `RATIO_TARGETS[dept][0]` silently misses, `tierRatio`
// comes back undefined, and that person's Expected/Goal production drops to
// zero while their cost (protected by its own `?? ownRateHr` fallback)
// keeps counting — inflating CPO for exactly the people this happens to.
function normalizeRole(role: unknown): RatioTier {
  return typeof role === 'string' && VALID_ROLES.has(role) ? (role as RatioTier) : 'specialist';
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface LaborRow {
  employee:   string;
  location:   string;
  department: string;
  week_of:    string;
  gross_pay:  number;
}

interface ActualRow {
  week_of:       string;
  member_name:   string;
  department:    string;
  location:      string;
  actual_hours:  number;
  actual_orders: number;
}

interface ScheduleSettingRow {
  location: string;
  key:      string;
  value:    unknown;
}

export interface KpiMetrics {
  hours:        number;
  production:   number;
  laborCost:    number;
  // ratio excludes managers entirely — neither their hours nor their
  // production count toward it. A manager's hours mix in non-production
  // (managerial/admin) time that would skew hrs/frame, so ratioHours/
  // ratioProduction track a manager-free subset used only to derive `ratio`;
  // hours/production above stay inclusive for cost, CPO, and totals.
  ratioHours:      number;
  ratioProduction: number;
  ratio:        number | null;   // ratioHours / ratioProduction
  cpo:          number | null;   // laborCost / production
  cpoWithGM:    number | null;   // (laborCost + GM salary) / production — combined only
  hasData:      boolean;
}

export interface PeriodKpis {
  design:            KpiMetrics;
  preservation:      KpiMetrics;
  fulfillment:       KpiMetrics;
  resin:             KpiMetrics;
  ga:                KpiMetrics;   // cost only — no production, no ratio
  combined:          KpiMetrics;   // Design + Preservation + Fulfillment (+ G&A cost spread)
}

export interface WindowResult {
  label:       string;
  periodStart: string;
  periodEnd:   string;
  utah:        PeriodKpis;
  georgia:     PeriodKpis;
  combined:    PeriodKpis;   // Utah + Georgia pooled
}

export interface RatioVariantResult {
  utah:     PeriodKpis;
  georgia:  PeriodKpis;
  combined: PeriodKpis;
}

export interface EstimatedMonthResult {
  label:          string;
  monthStart:     string;
  isSnapshot:     boolean;
  // The 3 trailing calendar months G&A cost was averaged from, e.g. ['Apr 2026','May 2026','Jun 2026']
  gaSourceMonths: string[];
  // "estimate" = each member's own roster ratio (today's behavior).
  // "expected" = each member's role-tier target ratio (Master/Senior/Specialist), ignoring their roster ratio.
  // "goal"     = min(roster ratio, tier target) per member — whichever is stricter.
  estimate:       RatioVariantResult;
  expected:       RatioVariantResult;
  goal:           RatioVariantResult;
}

// ── Salary managers ───────────────────────────────────────────────────────────
// Manager pay/role definitions live in src/lib/managers.ts (single source of
// truth shared with scorecard/route.ts, useActualsWithPayroll.ts, and
// useHistoricalMetrics.ts). Update that file when a manager changes.

const SALARY_MANAGERS = DEPARTMENT_MANAGERS;

// ── Date helpers ──────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function getMondayOf(dateStr: string): string {
  const d   = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return isoDate(d);
}

function getSundayOf(mondayStr: string): string {
  const d = new Date(mondayStr + 'T12:00:00');
  d.setDate(d.getDate() + 6);
  return isoDate(d);
}

function getWeekMondays(start: string, end: string): string[] {
  const mondays: string[] = [];
  const startMonday = getMondayOf(start);
  const cur = new Date(startMonday + 'T12:00:00');
  // A week belongs to the period its Monday falls in — never pull in the week
  // containing `start` if its Monday is before `start` (first-Monday rule).
  if (isoDate(cur) < start) cur.setDate(cur.getDate() + 7);
  while (isoDate(cur) <= end) {
    mondays.push(isoDate(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return mondays;
}

function getQuarterStart(date: Date): Date {
  const q = Math.floor(date.getMonth() / 3);
  return new Date(date.getFullYear(), q * 3, 1);
}

function getQuarterLabel(date: Date): string {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return `Q${q} ${date.getFullYear()}`;
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m) - 1]} ${y}`;
}

function weekLabel(monday: string): string {
  const d = new Date(monday + 'T12:00:00');
  return `W/C ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// ── Dept normalization ────────────────────────────────────────────────────────

function normDept(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes('design'))                                         return 'Design';
  if (l.includes('preservation'))                                   return 'Preservation';
  if (l.includes('fulfillment'))                                    return 'Fulfillment';
  if (l.includes('general') || l.includes('admin') || l === 'g&a') return 'G&A';
  if (l.includes('resin'))                                          return 'Resin';
  return raw;
}

// Which team_member_week_actuals rows belong to a manager, so the actuals
// ratio can exclude their hours (but keep their production). Built from the
// live roster's isManager flag — a current snapshot, same limitation the
// roster already has everywhere else in this codebase (unlike SALARY_MANAGERS
// above, which is time-aware for the specific hardcoded salary managers).
function buildManagerNameSet(rosterRows: ScheduleSettingRow[]): Set<string> {
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

// ── Core computation ──────────────────────────────────────────────────────────

function computePeriodKpis(
  laborRows:    LaborRow[],
  actualRows:   ActualRow[],
  location:     string,
  weekOfs:      string[],
  managerNames: Set<string>   // `${location}|${dept}|${name lowercased}` — see buildManagerNameSet
): PeriodKpis {
  const PROD_DEPTS = ['Design', 'Preservation', 'Fulfillment'] as const;
  const ALL_DEPTS  = [...PROD_DEPTS, 'G&A', 'Resin'] as const;

  // Sum labor cost from weekly_labor_cost
  const laborByDept: Record<string, number> = {};
  for (const row of laborRows.filter(r => r.location === location && weekOfs.includes(r.week_of))) {
    const dept = normDept(row.department);
    laborByDept[dept] = (laborByDept[dept] ?? 0) + row.gross_pay;
  }

  // Inject salary manager costs (never in weekly_labor_cost)
  for (const dept of ALL_DEPTS) {
    const mgrCost = getSalaryMgrCostForWeeks(SALARY_MANAGERS, location, dept, weekOfs);
    if (mgrCost > 0) laborByDept[dept] = (laborByDept[dept] ?? 0) + mgrCost;
  }

  // Sum hours + production from team_member_week_actuals. ratioHoursByDept /
  // ratioProdByDept mirror hoursByDept / prodByDept but skip manager rows
  // entirely — neither a manager's hours nor their production count toward
  // the ratio — unlike hoursByDept/prodByDept themselves, which stay fully
  // inclusive for cost/CPO/total-hours purposes.
  const hoursByDept:      Record<string, number> = {};
  const ratioHoursByDept: Record<string, number> = {};
  const prodByDept:       Record<string, number> = {};
  const ratioProdByDept:  Record<string, number> = {};
  for (const row of actualRows.filter(r => r.location === location && weekOfs.includes(r.week_of))) {
    const dept = normDept(row.department);
    hoursByDept[dept] = (hoursByDept[dept] ?? 0) + row.actual_hours;
    prodByDept[dept]  = (prodByDept[dept]  ?? 0) + row.actual_orders;
    const isMgr = managerNames.has(`${location}|${dept}|${row.member_name.trim().toLowerCase()}`);
    if (!isMgr) {
      ratioHoursByDept[dept] = (ratioHoursByDept[dept] ?? 0) + row.actual_hours;
      ratioProdByDept[dept]  = (ratioProdByDept[dept]  ?? 0) + row.actual_orders;
    }
  }

  function makeMetrics(dept: string, overrideProduction?: number): KpiMetrics {
    const hours          = hoursByDept[dept] ?? 0;
    const production     = overrideProduction ?? (prodByDept[dept] ?? 0);
    const laborCost      = laborByDept[dept] ?? 0;
    const ratioHours      = ratioHoursByDept[dept] ?? 0;
    const ratioProduction = ratioProdByDept[dept] ?? 0;
    return {
      hours,
      production,
      laborCost,
      ratioHours,
      ratioProduction,
      ratio:     (ratioHours > 0 && ratioProduction > 0) ? ratioHours / ratioProduction : null,
      cpo:       (laborCost > 0 && production > 0) ? laborCost / production : null,
      cpoWithGM: null,
      hasData:   hours > 0 || production > 0 || laborCost > 0,
    };
  }

  const design       = makeMetrics('Design');
  const preservation = makeMetrics('Preservation');
  const fulfillment  = makeMetrics('Fulfillment');
  const resin        = makeMetrics('Resin');

  // Combined = Design + Preservation + Fulfillment (Resin excluded from blended CPO)
  const totalProdOrders = design.production + preservation.production + fulfillment.production;

  // G&A CPO = G&A labor cost / total production orders (no production of its own)
  const ga           = makeMetrics('G&A', totalProdOrders);
  const totalHours      = design.hours      + preservation.hours      + fulfillment.hours;
  const gaCost          = ga.laborCost;

  // Blended CPO: sum of per-dept CPOs + G&A spread across total production orders
  let blendedCPO: number | null = null;
  let blendedSum = 0;
  let blendedHasData = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.cpo !== null) { blendedSum += m.cpo; blendedHasData = true; }
  }
  if (gaCost > 0 && totalProdOrders > 0) {
    blendedSum += gaCost / totalProdOrders;
    blendedHasData = true;
  }
  if (blendedHasData) blendedCPO = blendedSum;

  // GM cost is location-wide, not per-department — compute once per location
  // and spread across total production orders (never sum once per dept).
  const gmCostPerLocation = getGmCostForWeeks(location, weekOfs);

  const blendedCPOWithGM =
    blendedCPO !== null && totalProdOrders > 0
      ? blendedCPO + gmCostPerLocation / totalProdOrders
      : blendedCPO !== null
        ? blendedCPO
        : null;

  // Combined ratio: sum of per-dept ratios (additive, mirrors scorecard)
  let combinedRatio: number | null = null;
  let ratioSum = 0; let ratioHasData = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.ratio !== null) { ratioSum += m.ratio; ratioHasData = true; }
  }
  if (ratioHasData) combinedRatio = ratioSum;

  const combinedLaborCost = design.laborCost + preservation.laborCost + fulfillment.laborCost + gaCost;
  const combinedRatioHours      = design.ratioHours      + preservation.ratioHours      + fulfillment.ratioHours;
  const combinedRatioProduction = design.ratioProduction + preservation.ratioProduction + fulfillment.ratioProduction;

  const combined: KpiMetrics = {
    hours:      totalHours,
    production: totalProdOrders,
    laborCost:  combinedLaborCost,
    ratioHours:      combinedRatioHours,
    ratioProduction: combinedRatioProduction,
    ratio:      combinedRatio,
    cpo:        blendedCPO,
    cpoWithGM:  blendedCPOWithGM,
    hasData:    totalHours > 0 || totalProdOrders > 0 || combinedLaborCost > 0,
  };

  return { design, preservation, fulfillment, resin, ga, combined };
}

function poolLocations(utah: PeriodKpis, georgia: PeriodKpis): PeriodKpis {
  function poolMetrics(a: KpiMetrics, b: KpiMetrics): KpiMetrics {
    const hours          = a.hours          + b.hours;
    const production     = a.production     + b.production;
    const laborCost      = a.laborCost      + b.laborCost;
    const ratioHours      = a.ratioHours      + b.ratioHours;
    const ratioProduction = a.ratioProduction + b.ratioProduction;
    return {
      hours, production, laborCost, ratioHours, ratioProduction,
      ratio:     (ratioHours > 0 && ratioProduction > 0) ? ratioHours / ratioProduction : null,
      cpo:       (laborCost > 0 && production > 0) ? laborCost / production : null,
      cpoWithGM: null,
      hasData:   hours > 0 || production > 0 || laborCost > 0,
    };
  }

  const design       = poolMetrics(utah.design,       georgia.design);
  const preservation = poolMetrics(utah.preservation, georgia.preservation);
  const fulfillment  = poolMetrics(utah.fulfillment,  georgia.fulfillment);
  const resin        = poolMetrics(utah.resin,        georgia.resin);
  const ga           = poolMetrics(utah.ga,           georgia.ga);

  const totalProdOrders = design.production + preservation.production + fulfillment.production;

  // Re-derive blended CPO additively from pooled dept metrics (don't sum two blendedCPOs)
  let blendedCPO: number | null = null;
  let blendedSum = 0; let blendedHasData = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.cpo !== null) { blendedSum += m.cpo; blendedHasData = true; }
  }
  if (ga.laborCost > 0 && totalProdOrders > 0) {
    blendedSum += ga.laborCost / totalProdOrders; blendedHasData = true;
  }
  if (blendedHasData) blendedCPO = blendedSum;

  // Combined GM cost = Utah GM + Georgia GM
  const utahGMCost    = utah.combined.cpoWithGM !== null && utah.combined.cpo !== null && utah.combined.production > 0
    ? (utah.combined.cpoWithGM    - utah.combined.cpo)    * utah.combined.production    : 0;
  const georgiaGMCost = georgia.combined.cpoWithGM !== null && georgia.combined.cpo !== null && georgia.combined.production > 0
    ? (georgia.combined.cpoWithGM - georgia.combined.cpo) * georgia.combined.production : 0;
  const totalGMCost   = utahGMCost + georgiaGMCost;

  const blendedCPOWithGM =
    blendedCPO !== null && totalProdOrders > 0
      ? blendedCPO + totalGMCost / totalProdOrders
      : blendedCPO;

  let combinedRatio: number | null = null;
  let ratioSum = 0; let ratioHasData = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.ratio !== null) { ratioSum += m.ratio; ratioHasData = true; }
  }
  if (ratioHasData) combinedRatio = ratioSum;

  const combinedLaborCost = design.laborCost + preservation.laborCost + fulfillment.laborCost + ga.laborCost;
  const totalHours        = design.hours + preservation.hours + fulfillment.hours;
  const combinedRatioHours      = design.ratioHours      + preservation.ratioHours      + fulfillment.ratioHours;
  const combinedRatioProduction = design.ratioProduction + preservation.ratioProduction + fulfillment.ratioProduction;

  const combined: KpiMetrics = {
    hours: totalHours, production: totalProdOrders, laborCost: combinedLaborCost,
    ratioHours: combinedRatioHours, ratioProduction: combinedRatioProduction,
    ratio: combinedRatio, cpo: blendedCPO, cpoWithGM: blendedCPOWithGM,
    hasData: totalHours > 0 || totalProdOrders > 0,
  };

  return { design, preservation, fulfillment, resin, ga, combined };
}

function buildWindowResult(
  label:        string,
  start:        string,
  end:          string,
  laborRows:    LaborRow[],
  actualRows:   ActualRow[],
  managerNames: Set<string>
): WindowResult {
  const weekOfs = getWeekMondays(start, end);
  const utah    = computePeriodKpis(laborRows, actualRows, 'Utah',    weekOfs, managerNames);
  const georgia = computePeriodKpis(laborRows, actualRows, 'Georgia', weekOfs, managerNames);
  return { label, periodStart: start, periodEnd: end, utah, georgia, combined: poolLocations(utah, georgia) };
}

// Trailing N-completed-calendar-months average of actual G&A labor cost for a
// location. Used to project G&A into estimated months, which have no actuals
// of their own to draw from. Reuses computePeriodKpis so any G&A salary-manager
// cost injection stays consistent with historical months automatically. No
// actual rows are passed in (G&A cost only), so manager names don't matter here.
function averageGaCostForMonths(
  laborRows: LaborRow[],
  location:  string,
  now:       Date,
  months = 3
): { avg: number; monthKeys: string[] } {
  let total = 0;
  const monthKeys: string[] = [];
  for (let i = months; i >= 1; i--) {
    const first   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const last    = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const weekOfs = getWeekMondays(isoDate(first), isoDate(last));
    total += computePeriodKpis(laborRows, [], location, weekOfs, new Set()).ga.laborCost;
    monthKeys.push(isoDate(first).slice(0, 7));
  }
  return { avg: months > 0 ? total / months : 0, monthKeys };
}

// ── Estimated projections from schedule_settings ──────────────────────────────
// Roster shapes (from useScheduleSettings.ts):
//   designRoster: { [id]: { ratio, payType, hourlyRate, annualSalary, name, isManager? } }
//   presRoster:   { [id]: { ratio, rate, name, payType?, annualSalary?, isManager? } }
//   ffRoster:     { [id]: { ratio, rate, name, payType?, annualSalary? } }
//   designHours / presHours / ffHours: { [memberId]: { [isoMonday]: hours } }

interface DesignRosterEntry  { ratio: number; payType?: string; hourlyRate?: number; annualSalary?: number; name: string; isManager?: boolean; role?: RatioTier; standardTotalWeeklyHours?: number[]; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }
interface PresRosterEntry    { ratio: number; rate?: number;    payType?: string;    annualSalary?: number; name: string; isManager?: boolean; role?: RatioTier; standardTotalWeeklyHours?: number[]; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }
interface HoursMap           { [memberId: string]: Record<string, number> }
interface DailyHoursMap      { [weekOfMemberKey: string]: number[] }  // "${isoMonday}-${memberId}" -> [mon..fri]

// A member's hours for one week, resolved through the same fallback chain
// the Scheduling UI uses (explicit daily overrides -> standard weekly
// template -> legacy pre-template weekly value -> 0), rather than reading
// the legacy weekly map directly. Most of a roster relies entirely on the
// standard-schedule template for weeks nobody has hand-touched — reading
// `hours[memberId]?.[weekOf]` alone (the old behavior) silently treated
// every such week as 0 hours worked, undercounting Estimated/Expected/Goal
// production for anyone without an explicit per-week override.
function resolveMemberWeekHours(
  memberId:  string,
  weekOf:    string,
  hours:     HoursMap,
  dailyHours: DailyHoursMap,
  member:    DesignRosterEntry | PresRosterEntry,
): number {
  return resolveWeekHours({
    dailyMap:            dailyHours,
    weekKey:              `${weekOf}-${memberId}`,
    legacyWeeklyValue:    hours[memberId]?.[weekOf],
    standardWeeklyHours:  member.standardWeeklyHours,
    employment:           { weekIso: weekOf, startDate: member.startDate, endDate: member.endDate },
  });
}

// Paid holidays fall on staff pay (hours/cost unchanged — they're paid whether
// productive or not) but zero production. Estimate each member's lost hours
// for a holiday from that specific week's daily breakdown if one was entered,
// else fall back to an even 1/5 split of that week's total scheduled hours.
function holidayHoursForMember(
  memberId:     string,
  weekOfs:      string[],
  hours:        HoursMap,
  dailyHours:   DailyHoursMap,
  holidaySet:   Set<string>,
  member:       DesignRosterEntry | PresRosterEntry,
): number {
  if (holidaySet.size === 0) return 0;
  let holidayHours = 0;
  for (const weekOf of weekOfs) {
    const weekTotal = resolveMemberWeekHours(memberId, weekOf, hours, dailyHours, member);
    for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
      const d = new Date(weekOf + 'T12:00:00');
      d.setDate(d.getDate() + dayOffset);
      if (!holidaySet.has(isoDate(d))) continue;
      const daily = dailyHours[`${weekOf}-${memberId}`]?.[dayOffset];
      holidayHours += daily ?? (weekTotal / 5);
    }
  }
  return holidayHours;
}

const FULL_TIME_HOURS_PER_YEAR = 2080; // 52wk × 40hr, for salary→hourly-equivalent comparisons

function projectDept(
  roster:        Record<string, DesignRosterEntry | PresRosterEntry>,
  hours:         HoursMap,
  dailyHours:    DailyHoursMap,
  weekOfs:       string[],         // Mondays in the month (isoMonday strings)
  location:      string,
  dept:          WageDept,
  holidaySet:    Set<string>,
  mode:          'estimate' | 'expected' | 'goal',
  mgrTotalHours: HoursMap
): { hours: number; production: number; laborCost: number; ratioHours: number; ratioProduction: number } {
  let totalHours = 0, totalProduction = 0, totalCost = 0;
  // Estimated ratio excludes managers entirely — neither their hours nor
  // their (roster-ratio-derived) production count toward it.
  let ratioHours = 0, ratioProduction = 0;
  // Names whose pay was already added below via their own roster entry — the
  // SALARY_MANAGERS fallback further down exists to cover managers whose pay
  // never appears anywhere else, so it must skip anyone already counted here
  // or their salary gets added twice.
  const costedNames = new Set<string>();

  for (const [memberId, member] of Object.entries(roster)) {
    if ((member as { _removed?: boolean })._removed) continue;

    const memberHours = weekOfs.reduce((sum, w) => sum + resolveMemberWeekHours(memberId, w, hours, dailyHours, member), 0);

    totalHours += memberHours;
    if (!member.isManager) ratioHours += memberHours;
    if (member.ratio > 0) {
      const tierRatio = RATIO_TARGETS[dept][normalizeRole(member.role)];
      const effectiveRatio =
        mode === 'estimate' ? member.ratio :
        mode === 'expected' ? tierRatio :
        /* goal */             Math.min(member.ratio, tierRatio);

      const holidayHours   = holidayHoursForMember(memberId, weekOfs, hours, dailyHours, holidaySet, member);
      const productiveHours = Math.max(0, memberHours - holidayHours);
      if (effectiveRatio > 0) {
        const memberProduction = productiveHours / effectiveRatio;
        totalProduction += memberProduction;
        if (!member.isManager) ratioProduction += memberProduction;
      }
    }

    const payType     = member.payType ?? 'hourly';
    const hourlyRate  = (member as DesignRosterEntry).hourlyRate ?? (member as PresRosterEntry).rate ?? 0;
    const annualSal   = member.annualSalary ?? 0;

    // Managers have no wage-tier target (WAGE_TARGETS only covers
    // specialist/senior/master production rates) — their real pay (hourly or
    // salary prorated for the month) is always included in total cost as-is.
    if (mode === 'estimate' || member.isManager) {
      if (payType === 'salary' && annualSal > 0) {
        totalCost += (annualSal / 52) * weekOfs.length;
        costedNames.add(member.name.trim().toLowerCase());
      } else if (hourlyRate > 0) {
        // Hourly managers are paid for their full work week (management +
        // production combined), not just the production hours counted into
        // memberHours above. Fallback chain, highest to lowest priority:
        // explicit weekly mgrTotalHours entry -> the roster's standing
        // "Total schedule" template (standardTotalWeeklyHours, summed) ->
        // that week's production hours if neither is set.
        const totalTemplateWeekly = (member as DesignRosterEntry).standardTotalWeeklyHours
          ?.reduce((s, h) => s + (h ?? 0), 0);
        const payHours = member.isManager
          ? weekOfs.reduce((sum, w) => sum + (mgrTotalHours[memberId]?.[w] ?? totalTemplateWeekly ?? resolveMemberWeekHours(memberId, w, hours, dailyHours, member)), 0)
          : memberHours;
        totalCost += payHours * hourlyRate;
        costedNames.add(member.name.trim().toLowerCase());
      }
    } else {
      const ownRateHr = payType === 'salary' && annualSal > 0 ? annualSal / FULL_TIME_HOURS_PER_YEAR : hourlyRate;
      // Goal costs a member at their real pay, full stop — only the ratio
      // (already handled above) gets the min(own, tier) treatment. A raise
      // or a promotion to a higher-paying tier shows up here the same way
      // it always does: through the roster's own rate, kept current via the
      // Rippling upload/rate sync, not by substituting in a role's wage
      // target. Expected is the one mode that still uses the wage target —
      // it's deliberately rate-blind, modeling "what if paid role-
      // appropriately" regardless of this person's actual pay.
      const effectiveRateHr =
        mode === 'expected' ? (WAGE_TARGETS[location as WageLocation]?.[dept]?.[normalizeRole(member.role)] ?? ownRateHr) :
        /* goal */             ownRateHr;
      if (effectiveRateHr > 0) {
        totalCost += memberHours * effectiveRateHr;
        costedNames.add(member.name.trim().toLowerCase());
      }
    }
  }

  // Add salary manager cost for this dept — a specific named individual's
  // fixed pay, not subject to a role-average hypothetical, so it's the same
  // across all three modes, same as G&A. Skip anyone whose pay is already
  // counted above via their own roster entry (isManager + a real rate on
  // file) — this list exists only to cover managers whose pay never appears
  // on the roster at all.
  const uncostedManagers = SALARY_MANAGERS.filter(mgr => !costedNames.has(mgr.name.trim().toLowerCase()));
  totalCost += getSalaryMgrCostForWeeks(uncostedManagers, location, dept, weekOfs);

  return { hours: totalHours, production: totalProduction, laborCost: totalCost, ratioHours, ratioProduction };
}

function buildRatioVariant(
  settings:      ScheduleSettingRow[],
  monthKey:      string,
  utahGaCost:    number,
  georgiaGaCost: number,
  paidHolidays:  string[],
  mode:          'estimate' | 'expected' | 'goal'
): RatioVariantResult {
  const utah    = projectMonthForLocation(settings, 'Utah',    monthKey, utahGaCost,    paidHolidays, mode);
  const georgia = projectMonthForLocation(settings, 'Georgia', monthKey, georgiaGaCost, paidHolidays, mode);
  return { utah, georgia, combined: poolLocations(utah, georgia) };
}

function projectMonthForLocation(
  settings:   ScheduleSettingRow[],
  location:   string,
  monthStart: string,
  gaCost:     number,
  paidHolidays: string[],
  mode:       'estimate' | 'expected' | 'goal'
): PeriodKpis {
  const monthEnd = new Date(monthStart + 'T12:00:00');
  monthEnd.setMonth(monthEnd.getMonth() + 1);
  monthEnd.setDate(0);
  const weekOfs      = getWeekMondays(monthStart, isoDate(monthEnd));
  const holidaySet   = new Set(paidHolidays);

  const get = (key: string) => settings.find(r => r.location === location && r.key === key)?.value ?? {};

  const designRoster     = get('designRoster')     as Record<string, DesignRosterEntry>;
  const presRoster       = get('presRoster')       as Record<string, PresRosterEntry>;
  const ffRoster         = get('ffRoster')         as Record<string, PresRosterEntry>;
  const designHours      = get('designHours')      as HoursMap;
  const presHours        = get('presHours')        as HoursMap;
  const ffHours          = get('ffHours')          as HoursMap;
  const designDailyHours = get('designDailyHours') as DailyHoursMap;
  const presDailyHours   = get('presDailyHours')   as DailyHoursMap;
  const ffDailyHours     = get('ffDailyHours')     as DailyHoursMap;
  // Hourly managers' true total work hours (management + production combined),
  // entered separately from their production hours in Scheduling — e.g. a
  // design manager scheduled for 26 production hours but paid for a full
  // 40hr/week. Keyed by memberId, one shared map across all departments.
  // Falls back to production hours per week if a manager has no entry here.
  const mgrTotalHours    = get('mgrTotalHours')    as HoursMap;

  const designMetrics = projectDept(designRoster, designHours, designDailyHours, weekOfs, location, 'Design',       holidaySet, mode, mgrTotalHours);
  const presMetrics   = projectDept(presRoster,   presHours,   presDailyHours,   weekOfs, location, 'Preservation', holidaySet, mode, mgrTotalHours);
  const ffMetrics     = projectDept(ffRoster,     ffHours,     ffDailyHours,     weekOfs, location, 'Fulfillment',  holidaySet, mode, mgrTotalHours);

  function toMetrics(m: { hours: number; production: number; laborCost: number; ratioHours: number; ratioProduction: number }): KpiMetrics {
    return {
      hours:      m.hours,
      production: m.production,
      laborCost:  m.laborCost,
      ratioHours:      m.ratioHours,
      ratioProduction: m.ratioProduction,
      ratio:      m.ratioHours > 0 && m.ratioProduction > 0 ? m.ratioHours / m.ratioProduction : null,
      cpo:        m.laborCost > 0 && m.production > 0 ? m.laborCost / m.production : null,
      cpoWithGM:  null,
      hasData:    m.hours > 0 || m.production > 0 || m.laborCost > 0,
    };
  }

  const design       = toMetrics(designMetrics);
  const preservation = toMetrics(presMetrics);
  const fulfillment  = toMetrics(ffMetrics);
  const resin: KpiMetrics = { hours: 0, production: 0, laborCost: 0, ratioHours: 0, ratioProduction: 0, ratio: null, cpo: null, cpoWithGM: null, hasData: false };

  const totalProdOrders = design.production + preservation.production + fulfillment.production;

  // G&A has no production of its own — mirror computePeriodKpis, which spreads
  // it across total org production so its CPO ($/unit) is computable.
  const ga: KpiMetrics = {
    hours: 0, production: totalProdOrders, laborCost: gaCost,
    ratioHours: 0, ratioProduction: 0,
    ratio: null,
    cpo: gaCost > 0 && totalProdOrders > 0 ? gaCost / totalProdOrders : null,
    cpoWithGM: null,
    hasData: gaCost > 0,
  };

  const totalHours        = design.hours       + preservation.hours       + fulfillment.hours;
  const combinedLaborCost = design.laborCost   + preservation.laborCost   + fulfillment.laborCost + ga.laborCost;

  let blendedCPO: number | null = null;
  let blendedSum = 0; let blendedHasData = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.cpo !== null) { blendedSum += m.cpo; blendedHasData = true; }
  }
  if (gaCost > 0 && totalProdOrders > 0) {
    blendedSum += gaCost / totalProdOrders;
    blendedHasData = true;
  }
  if (blendedHasData) blendedCPO = blendedSum;

  // GM cost for projected month
  const gmCostTotal = getGmCostForWeeks(location, weekOfs);

  const blendedCPOWithGM =
    blendedCPO !== null && totalProdOrders > 0
      ? blendedCPO + gmCostTotal / totalProdOrders
      : blendedCPO;

  let combinedRatio: number | null = null;
  let ratioSum = 0; let ratioHasData = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.ratio !== null) { ratioSum += m.ratio; ratioHasData = true; }
  }
  if (ratioHasData) combinedRatio = ratioSum;

  const combinedRatioHours      = design.ratioHours      + preservation.ratioHours      + fulfillment.ratioHours;
  const combinedRatioProduction = design.ratioProduction + preservation.ratioProduction + fulfillment.ratioProduction;

  const combined: KpiMetrics = {
    hours: totalHours, production: totalProdOrders, laborCost: combinedLaborCost,
    ratioHours: combinedRatioHours, ratioProduction: combinedRatioProduction,
    ratio: combinedRatio, cpo: blendedCPO, cpoWithGM: blendedCPOWithGM,
    hasData: totalHours > 0 || totalProdOrders > 0 || combinedLaborCost > 0,
  };

  return { design, preservation, fulfillment, resin, ga, combined };
}

// ── GET /api/kpis ─────────────────────────────────────────────────────────────
//
// Query params:
//   windows = comma-separated list of:
//     mtd, qtd, ytd
//     weekly-N     (last N completed weeks,    default 12)
//     monthly-N    (last N completed months,   default 12)
//     quarterly-N  (last N completed quarters, default 4)
//     est-current  (estimated current month)
//     est-next     (estimated next month)
//
// Returns: { windows: WindowResult[], estimated: { current?, next? } }

export async function GET(req: NextRequest) {
  const isSyncCaller = req.headers.get('authorization') === `Bearer ${process.env.SCORECARDS_SYNC_SECRET}`;
  if (!isSyncCaller) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const windowsParam = req.nextUrl.searchParams.get('windows')
    ?? 'mtd,qtd,ytd,weekly-12,monthly-12,quarterly-4,est-current,est-next';
  const requested = windowsParam.split(',').map(s => s.trim());

  const now   = new Date();
  const today = isoDate(now);

  // Determine how far back we need data
  const monthsBack   = Math.max(...requested.filter(w => w.startsWith('monthly-')).map(w => parseInt(w.split('-')[1]) || 12),   12);
  const quartersBack = Math.max(...requested.filter(w => w.startsWith('quarterly-')).map(w => parseInt(w.split('-')[1]) || 4), 4);
  const weeksBack    = Math.max(...requested.filter(w => w.startsWith('weekly-')).map(w => parseInt(w.split('-')[1]) || 12),    12);

  const earliestDate = [
    `${now.getFullYear()}-01-01`,
    isoDate(getQuarterStart(now)),
    isoDate(new Date(now.getFullYear(), now.getMonth() - monthsBack,       1)),
    isoDate(new Date(now.getFullYear(), now.getMonth() - quartersBack * 3, 1)),
    isoDate(new Date(now.getTime() - weeksBack * 7 * 24 * 60 * 60 * 1000)),
  ].sort()[0];

  try {
    // Single set of queries — all computation happens in memory. Roster is
    // fetched here (not just inside the est-current/est-next block below) so
    // the actuals windows can also identify which team_member_week_actuals
    // rows belong to a manager, for the ratio's manager-hours exclusion.
    const [laborRes, actualsRes, rosterRes] = await Promise.all([
      supabase
        .from('weekly_labor_cost')
        .select('employee,location,department,week_of,gross_pay')
        .gte('week_of', earliestDate),
      supabase
        .from('team_member_week_actuals')
        .select('week_of,member_name,department,location,actual_hours,actual_orders')
        .gte('week_of', earliestDate),
      supabase
        .from('schedule_settings')
        .select('location,key,value')
        .in('key', ['designRoster', 'presRoster', 'ffRoster']),
    ]);

    if (laborRes.error)   throw laborRes.error;
    if (actualsRes.error) throw actualsRes.error;
    if (rosterRes.error)  throw rosterRes.error;

    const laborRows:  LaborRow[]  = laborRes.data  ?? [];
    const actualRows: ActualRow[] = actualsRes.data ?? [];
    const managerNames = buildManagerNameSet(rosterRes.data ?? []);

    const results: WindowResult[] = [];

    // ── MTD ───────────────────────────────────────────────────────────────────
    if (requested.includes('mtd')) {
      const mtdStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      results.push(buildWindowResult(`${monthLabel(mtdStart.slice(0, 7))} MTD`, mtdStart, today, laborRows, actualRows, managerNames));
    }

    // ── QTD ───────────────────────────────────────────────────────────────────
    if (requested.includes('qtd')) {
      const qtdStart = isoDate(getQuarterStart(now));
      results.push(buildWindowResult(`${getQuarterLabel(now)} QTD`, qtdStart, today, laborRows, actualRows, managerNames));
    }

    // ── YTD ───────────────────────────────────────────────────────────────────
    if (requested.includes('ytd')) {
      results.push(buildWindowResult(`${now.getFullYear()} YTD`, `${now.getFullYear()}-01-01`, today, laborRows, actualRows, managerNames));
    }

    // ── Weekly series ─────────────────────────────────────────────────────────
    const weeklySeries = requested.find(w => w.startsWith('weekly-'));
    if (weeklySeries) {
      const n = parseInt(weeklySeries.split('-')[1]) || 12;
      const thisMonday = getMondayOf(today);
      for (let i = n; i >= 1; i--) {
        const d = new Date(thisMonday + 'T12:00:00');
        d.setDate(d.getDate() - i * 7);
        const monday = isoDate(d);
        const sunday = getSundayOf(monday);
        results.push(buildWindowResult(weekLabel(monday), monday, sunday, laborRows, actualRows, managerNames));
      }
    }

    // ── Monthly series ────────────────────────────────────────────────────────
    const monthlySeries = requested.find(w => w.startsWith('monthly-'));
    if (monthlySeries) {
      const n = parseInt(monthlySeries.split('-')[1]) || 12;
      for (let i = n; i >= 1; i--) {
        const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const last  = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const key   = isoDate(first).slice(0, 7);
        results.push(buildWindowResult(monthLabel(key), isoDate(first), isoDate(last), laborRows, actualRows, managerNames));
      }
    }

    // ── Quarterly series ──────────────────────────────────────────────────────
    const quarterlySeries = requested.find(w => w.startsWith('quarterly-'));
    if (quarterlySeries) {
      const n = parseInt(quarterlySeries.split('-')[1]) || 4;
      for (let i = n; i >= 1; i--) {
        const qDate  = new Date(now.getFullYear(), now.getMonth() - i * 3, 1);
        const qStart = getQuarterStart(qDate);
        const qEnd   = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 0);
        results.push(buildWindowResult(getQuarterLabel(qStart), isoDate(qStart), isoDate(qEnd), laborRows, actualRows, managerNames));
      }
    }

    // ── Estimated projections ─────────────────────────────────────────────────
    let estimated: { current?: EstimatedMonthResult; next?: EstimatedMonthResult } | null = null;

    if (requested.includes('est-current') || requested.includes('est-next')) {
      const { data: settingsData, error: settingsError } = await supabase
        .from('schedule_settings')
        .select('location,key,value');
      if (settingsError) throw settingsError;
      const liveSettings: ScheduleSettingRow[] = settingsData ?? [];

      // G&A has no schedule/roster to project from — use a trailing 3-month
      // actual average instead. Same window applies to both current and next
      // month estimates (there's no actual G&A data for either to draw on).
      const utahGa    = averageGaCostForMonths(laborRows, 'Utah',    now);
      const georgiaGa = averageGaCostForMonths(laborRows, 'Georgia', now);
      const gaSourceMonths = utahGa.monthKeys.map(monthLabel);

      const paidHolidays = (liveSettings.find(r => r.location === 'Global' && r.key === 'paidHolidays')?.value as string[]) ?? [];

      estimated = {};

      if (requested.includes('est-current')) {
        const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

        // Try month-end snapshot first (locked, immutable)
        const { data: snapData } = await supabase
          .from('monthly_schedule_snapshots')
          .select('location,settings_json')
          .eq('snapshot_month', currentMonthKey);

        const snapSettings: ScheduleSettingRow[] = (snapData ?? []).flatMap(snap =>
          Object.entries(snap.settings_json as Record<string, unknown>).map(([key, value]) => ({
            location: snap.location as string,
            key,
            value,
          }))
        );

        const useSettings     = snapSettings.length > 0 ? snapSettings : liveSettings;
        const isSnapshot      = snapSettings.length > 0;

        estimated.current = {
          label:      `Est. ${monthLabel(currentMonthKey.slice(0, 7))}`,
          monthStart: currentMonthKey,
          isSnapshot,
          gaSourceMonths,
          estimate: buildRatioVariant(useSettings, currentMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'estimate'),
          expected: buildRatioVariant(useSettings, currentMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'expected'),
          goal:     buildRatioVariant(useSettings, currentMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'goal'),
        };
      }

      if (requested.includes('est-next')) {
        const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const nextMonthKey  = isoDate(nextMonthDate);

        estimated.next = {
          label:      `Est. ${monthLabel(nextMonthKey.slice(0, 7))}`,
          monthStart: nextMonthKey,
          isSnapshot: false,
          gaSourceMonths,
          estimate: buildRatioVariant(liveSettings, nextMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'estimate'),
          expected: buildRatioVariant(liveSettings, nextMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'expected'),
          goal:     buildRatioVariant(liveSettings, nextMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'goal'),
        };
      }
    }

    return NextResponse.json({
      ok:        true,
      windows:   results,
      estimated,
      meta: { generatedAt: new Date().toISOString(), windowCount: results.length },
    });

  } catch (e) {
    console.error('KPI route error:', e);
    // Supabase/Postgrest errors are plain {message,details,hint,code}
    // objects, not real Error instances — String(e) on one of those gives
    // the useless "[object Object]" (no custom toString), which the client
    // then wraps again into "Error: [object Object]". Pull the real message
    // off whichever shape actually threw.
    const message =
      e instanceof Error ? e.message :
      typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message :
      String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
