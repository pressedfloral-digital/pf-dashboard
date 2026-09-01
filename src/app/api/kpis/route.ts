import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { DEPARTMENT_MANAGERS, getSalaryMgrCostForWeeks, getGmCostForWeeks } from '@/lib/managers';
import { RATIO_TARGETS, type RatioTier } from '@/lib/ratioTargets';
import type { WageDept } from '@/lib/wageTargets';
import { resolveWeekHours, resolveWeekPayHours } from '@/lib/scheduleResolution';
import { fetchAllRows } from '@/lib/fetchAllRows';

// MTD/QTD/YTD figures need to reflect whatever's in weekly_labor_cost right
// now — a payroll upload landing mid-month should show up on next load, not
// wait for a deploy or a cache TTL. Force dynamic + no-store so nothing
// (Next's route cache, Vercel's edge, or the browser) ever serves a stale
// KPI snapshot.
export const dynamic = 'force-dynamic';

// Same pattern rosterRoleSync.ts uses to infer manager status from a
// Rippling title — duplicated locally rather than imported since that
// module is client-upload-focused and this is a read-only projection.
const MANAGER_TITLE_RE = /manager|head of|director/i;

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

// Monthly performance bonuses -- only fetched/injected for the Monthly
// series (see the `monthlySeries` block in GET below). location/department
// are null for rows whose employee didn't match rippling_employees at
// upload time; those are excluded from department attribution here.
interface BonusRow {
  location:    string | null;
  department:  string | null;
  bonus_month: string;   // ISO date, first-of-month
  gross_pay:   number;
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
  // Monthly performance bonus $ attributed to this dept (0 outside the
  // Monthly-series window — see buildWindowResult/computePeriodKpis).
  // Unlike GM cost, bonus IS attributable per department (per-employee
  // data joined to the directory at upload time), so it folds directly
  // into each dept's own laborCost rather than being spread org-wide.
  bonusCost:    number;
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
  cpoWithBonus:   number | null; // (laborCost + bonusCost) / production
  cpoWithGMBonus: number | null; // (laborCost + bonusCost + GM share) / production — combined only
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
  managerNames: Set<string>,  // `${location}|${dept}|${name lowercased}` — see buildManagerNameSet
  bonusByDept?: Record<string, number>   // dept -> $ — Monthly-series callers only, see buildWindowResult
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
    const bonusCost       = bonusByDept?.[dept] ?? 0;
    const ratioHours      = ratioHoursByDept[dept] ?? 0;
    const ratioProduction = ratioProdByDept[dept] ?? 0;
    return {
      hours,
      production,
      laborCost,
      bonusCost,
      ratioHours,
      ratioProduction,
      ratio:          (ratioHours > 0 && ratioProduction > 0) ? ratioHours / ratioProduction : null,
      cpo:            (laborCost > 0 && production > 0) ? laborCost / production : null,
      cpoWithGM:      null,
      cpoWithBonus:   ((laborCost + bonusCost) > 0 && production > 0) ? (laborCost + bonusCost) / production : null,
      cpoWithGMBonus: null,
      hasData:        hours > 0 || production > 0 || laborCost > 0 || bonusCost > 0,
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

  // Bonus-inclusive blended CPO, mirroring the GM-inclusive block above but
  // additive per-dept (bonus IS attributable per department, unlike GM).
  let blendedCPOWithBonus: number | null = null;
  let blendedSumWithBonus = 0;
  let blendedHasDataWithBonus = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.cpoWithBonus !== null) { blendedSumWithBonus += m.cpoWithBonus; blendedHasDataWithBonus = true; }
  }
  const gaCostWithBonus = gaCost + ga.bonusCost;
  if (gaCostWithBonus > 0 && totalProdOrders > 0) {
    blendedSumWithBonus += gaCostWithBonus / totalProdOrders;
    blendedHasDataWithBonus = true;
  }
  if (blendedHasDataWithBonus) blendedCPOWithBonus = blendedSumWithBonus;

  const blendedCPOWithGMBonus =
    blendedCPOWithBonus !== null && totalProdOrders > 0
      ? blendedCPOWithBonus + gmCostPerLocation / totalProdOrders
      : blendedCPOWithBonus;

  const combinedBonusCost = design.bonusCost + preservation.bonusCost + fulfillment.bonusCost + ga.bonusCost;

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
    bonusCost:  combinedBonusCost,
    ratioHours:      combinedRatioHours,
    ratioProduction: combinedRatioProduction,
    ratio:      combinedRatio,
    cpo:        blendedCPO,
    cpoWithGM:  blendedCPOWithGM,
    cpoWithBonus:   blendedCPOWithBonus,
    cpoWithGMBonus: blendedCPOWithGMBonus,
    hasData:    totalHours > 0 || totalProdOrders > 0 || combinedLaborCost > 0,
  };

  return { design, preservation, fulfillment, resin, ga, combined };
}

function poolLocations(utah: PeriodKpis, georgia: PeriodKpis): PeriodKpis {
  function poolMetrics(a: KpiMetrics, b: KpiMetrics): KpiMetrics {
    const hours          = a.hours          + b.hours;
    const production     = a.production     + b.production;
    const laborCost      = a.laborCost      + b.laborCost;
    const bonusCost       = a.bonusCost      + b.bonusCost;
    const ratioHours      = a.ratioHours      + b.ratioHours;
    const ratioProduction = a.ratioProduction + b.ratioProduction;
    return {
      hours, production, laborCost, bonusCost, ratioHours, ratioProduction,
      ratio:          (ratioHours > 0 && ratioProduction > 0) ? ratioHours / ratioProduction : null,
      cpo:            (laborCost > 0 && production > 0) ? laborCost / production : null,
      cpoWithGM:      null,
      cpoWithBonus:   ((laborCost + bonusCost) > 0 && production > 0) ? (laborCost + bonusCost) / production : null,
      cpoWithGMBonus: null,
      hasData:        hours > 0 || production > 0 || laborCost > 0 || bonusCost > 0,
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

  // Bonus is already additive per pooled dept (no reverse-derivation needed
  // the way GM cost requires, since bonusCost isn't spread org-wide).
  let blendedCPOWithBonus: number | null = null;
  let blendedSumWithBonus = 0; let blendedHasDataWithBonus = false;
  for (const m of [design, preservation, fulfillment]) {
    if (m.cpoWithBonus !== null) { blendedSumWithBonus += m.cpoWithBonus; blendedHasDataWithBonus = true; }
  }
  const gaCostWithBonus = ga.laborCost + ga.bonusCost;
  if (gaCostWithBonus > 0 && totalProdOrders > 0) {
    blendedSumWithBonus += gaCostWithBonus / totalProdOrders; blendedHasDataWithBonus = true;
  }
  if (blendedHasDataWithBonus) blendedCPOWithBonus = blendedSumWithBonus;

  const blendedCPOWithGMBonus =
    blendedCPOWithBonus !== null && totalProdOrders > 0
      ? blendedCPOWithBonus + totalGMCost / totalProdOrders
      : blendedCPOWithBonus;

  const combinedBonusCost = design.bonusCost + preservation.bonusCost + fulfillment.bonusCost + ga.bonusCost;

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
    bonusCost: combinedBonusCost,
    ratioHours: combinedRatioHours, ratioProduction: combinedRatioProduction,
    ratio: combinedRatio, cpo: blendedCPO, cpoWithGM: blendedCPOWithGM,
    cpoWithBonus: blendedCPOWithBonus, cpoWithGMBonus: blendedCPOWithGMBonus,
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
  managerNames: Set<string>,
  bonusByLocDept?: Record<string, Record<string, number>>  // location -> dept -> $ — Monthly-series only
): WindowResult {
  const weekOfs = getWeekMondays(start, end);
  const utah    = computePeriodKpis(laborRows, actualRows, 'Utah',    weekOfs, managerNames, bonusByLocDept?.['Utah']);
  const georgia = computePeriodKpis(laborRows, actualRows, 'Georgia', weekOfs, managerNames, bonusByLocDept?.['Georgia']);
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

// A member's PRODUCTION hours for one week, resolved through the same
// fallback chain the Scheduling UI uses (explicit daily overrides ->
// standard weekly template -> legacy pre-template weekly value -> 0),
// rather than reading the legacy weekly map directly. Most of a roster
// relies entirely on the standard-schedule template for weeks nobody has
// hand-touched — reading `hours[memberId]?.[weekOf]` alone (the old
// behavior) silently treated every such week as 0 hours worked,
// undercounting Estimated/Expected/Goal production for anyone without an
// explicit per-week override.
//
// On a paid holiday with no explicit override, this already comes back 0
// for that day (staff produce nothing) — see resolveWeekHours/resolveDayHours
// in scheduleResolution.ts for the exact per-weekday holiday logic.
function resolveMemberWeekHours(
  memberId:  string,
  weekOf:    string,
  hours:     HoursMap,
  dailyHours: DailyHoursMap,
  member:    DesignRosterEntry | PresRosterEntry,
  holidays?: string[],
): number {
  return resolveWeekHours({
    dailyMap:            dailyHours,
    weekKey:              `${weekOf}-${memberId}`,
    legacyWeeklyValue:    hours[memberId]?.[weekOf],
    standardWeeklyHours:  member.standardWeeklyHours,
    employment:           { weekIso: weekOf, startDate: member.startDate, endDate: member.endDate },
    holidays,
  });
}

// Guaranteed-PAY basis for one week — equals resolveMemberWeekHours except on
// a paid holiday, where staff are still paid (their standard hours for that
// weekday) whether or not they produced anything, plus whatever's already
// recorded for that day (worked hours, or a placeholder entered before the
// day was declared a holiday — either way, guaranteed pay still applies on
// top of it). See resolveDayHours' payHours for the exact semantics.
function resolveMemberWeekPayHours(
  memberId:  string,
  weekOf:    string,
  hours:     HoursMap,
  dailyHours: DailyHoursMap,
  member:    DesignRosterEntry | PresRosterEntry,
  holidays?: string[],
): number {
  return resolveWeekPayHours({
    dailyMap:            dailyHours,
    weekKey:              `${weekOf}-${memberId}`,
    legacyWeeklyValue:    hours[memberId]?.[weekOf],
    standardWeeklyHours:  member.standardWeeklyHours,
    employment:           { weekIso: weekOf, startDate: member.startDate, endDate: member.endDate },
    holidays,
  });
}

function projectDept(
  roster:        Record<string, DesignRosterEntry | PresRosterEntry>,
  hours:         HoursMap,
  dailyHours:    DailyHoursMap,
  weekOfs:       string[],         // Mondays in the month (isoMonday strings)
  location:      string,
  dept:          WageDept | 'Resin',
  holidaySet:    Set<string>,
  mode:          'estimate' | 'expected' | 'goal',
  mgrTotalHours: HoursMap,
  managerHomeDept: Map<string, Set<string>>
): { hours: number; production: number; laborCost: number; ratioHours: number; ratioProduction: number } {
  const holidays = Array.from(holidaySet);
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

    // PRODUCTION hours — already holiday-zeroed for any day with no explicit
    // override (staff still get paid; see memberPayHours below for that).
    const memberHours = weekOfs.reduce((sum, w) => sum + resolveMemberWeekHours(memberId, w, hours, dailyHours, member, holidays), 0);
    // Guaranteed-PAY basis — equals memberHours on non-holiday weeks, but on
    // a holiday reflects the member's standard hours for that weekday (paid
    // regardless) plus any worked hours a manager entered on top.
    const memberPayHours = weekOfs.reduce((sum, w) => sum + resolveMemberWeekPayHours(memberId, w, hours, dailyHours, member, holidays), 0);

    totalHours += memberHours;
    if (!member.isManager) ratioHours += memberHours;
    if (member.ratio > 0) {
      const tierRatio = RATIO_TARGETS[dept][normalizeRole(member.role)];
      // A manager's own scheduled *production* hours (memberHours below —
      // never their full mgrTotalHours work week, which only feeds cost)
      // are expected to run at their role's tier pace same as anyone
      // else's — Expected/Goal answer "at the official target ratio, how
      // much would these hours produce," and that framing applies whether
      // or not the person is a manager. Only the ratio *metric* itself
      // (ratioHours/ratioProduction below) excludes managers, since judging
      // their efficiency isn't the point — their hours/production still
      // count fully toward CPO's totals in every mode.
      const effectiveRatio =
        mode === 'estimate' ? member.ratio :
        mode === 'expected' ? tierRatio :
        /* goal */             Math.min(member.ratio, tierRatio);

      if (effectiveRatio > 0) {
        const memberProduction = memberHours / effectiveRatio;
        totalProduction += memberProduction;
        if (!member.isManager) ratioProduction += memberProduction;
      }
    }

    const payType     = member.payType ?? 'hourly';
    const hourlyRate  = (member as DesignRosterEntry).hourlyRate ?? (member as PresRosterEntry).rate ?? 0;
    const annualSal   = member.annualSalary ?? 0;

    // A manager can be scheduled on more than one department's roster to
    // flex-help (their hours/production above still count fully there) —
    // but their pay belongs only to the department Rippling actually has
    // them under. `homeDepts` is undefined when Rippling has no manager-
    // titled record for this person at all (nothing to compare against, so
    // don't risk under-counting someone not yet uploaded); it's a non-empty
    // set that excludes `dept` when we positively know they manage
    // elsewhere — that's the only case cost gets skipped here.
    const homeDepts = managerHomeDept.get(`${location}|${member.name.trim().toLowerCase()}`);
    const managesElsewhere = !!member.isManager && homeDepts !== undefined && !homeDepts.has(dept);

    // Cost is always real pay, in every mode — only production (above) varies
    // by mode via the ratio. A raise or a promotion to a better-paying role
    // shows up here through the roster's own rate (kept current via the
    // Rippling upload/rate sync), never through a substituted role target.
    if (managesElsewhere) {
      // Skip — their full pay already lands in their real department's
      // projectDept call instead.
    } else if (payType === 'salary' && annualSal > 0) {
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
        ? weekOfs.reduce((sum, w) => sum + (mgrTotalHours[memberId]?.[w] ?? totalTemplateWeekly ?? resolveMemberWeekPayHours(memberId, w, hours, dailyHours, member, holidays)), 0)
        : memberPayHours;
      totalCost += payHours * hourlyRate;
      costedNames.add(member.name.trim().toLowerCase());
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
  mode:          'estimate' | 'expected' | 'goal',
  managerHomeDept: Map<string, Set<string>>
): RatioVariantResult {
  const utah    = projectMonthForLocation(settings, 'Utah',    monthKey, utahGaCost,    paidHolidays, mode, managerHomeDept);
  const georgia = projectMonthForLocation(settings, 'Georgia', monthKey, georgiaGaCost, paidHolidays, mode, managerHomeDept);
  return { utah, georgia, combined: poolLocations(utah, georgia) };
}

function projectMonthForLocation(
  settings:   ScheduleSettingRow[],
  location:   string,
  monthStart: string,
  gaCost:     number,
  paidHolidays: string[],
  mode:       'estimate' | 'expected' | 'goal',
  managerHomeDept: Map<string, Set<string>>
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

  // Resin's roster is stored as a plain array (see ResinPage.tsx), not the
  // memberId-keyed Record the other three departments use — key it the same
  // way before handing it to projectDept, which otherwise reuses the exact
  // same roster-entry shape (ratio/payType/hourlyRate/annualSalary/isManager/
  // standardWeeklyHours/employment dates) with no other changes needed.
  // Resin is a single shared (Utah-only) roster in practice, so this reads
  // as empty/zero for Georgia rather than needing a special case.
  const resinRosterRaw = get('resinRoster');
  const resinRosterArr = Array.isArray(resinRosterRaw) ? resinRosterRaw as (DesignRosterEntry & { id: string })[] : [];
  const resinRoster: Record<string, DesignRosterEntry> = Object.fromEntries(resinRosterArr.map(m => [m.id, m]));
  const resinHours       = get('resinHours')       as HoursMap;
  const resinDailyHours  = get('resinDailyHours')  as DailyHoursMap;

  const designMetrics = projectDept(designRoster, designHours, designDailyHours, weekOfs, location, 'Design',       holidaySet, mode, mgrTotalHours, managerHomeDept);
  const presMetrics   = projectDept(presRoster,   presHours,   presDailyHours,   weekOfs, location, 'Preservation', holidaySet, mode, mgrTotalHours, managerHomeDept);
  const ffMetrics     = projectDept(ffRoster,     ffHours,     ffDailyHours,     weekOfs, location, 'Fulfillment',  holidaySet, mode, mgrTotalHours, managerHomeDept);
  const resinMetrics  = projectDept(resinRoster,  resinHours,  resinDailyHours,  weekOfs, location, 'Resin',        holidaySet, mode, mgrTotalHours, managerHomeDept);

  function toMetrics(m: { hours: number; production: number; laborCost: number; ratioHours: number; ratioProduction: number }): KpiMetrics {
    return {
      hours:      m.hours,
      production: m.production,
      laborCost:  m.laborCost,
      bonusCost:  0,   // est-current/est-next never have bonus data by design
      ratioHours:      m.ratioHours,
      ratioProduction: m.ratioProduction,
      ratio:      m.ratioHours > 0 && m.ratioProduction > 0 ? m.ratioHours / m.ratioProduction : null,
      cpo:        m.laborCost > 0 && m.production > 0 ? m.laborCost / m.production : null,
      cpoWithGM:  null,
      cpoWithBonus:   null,
      cpoWithGMBonus: null,
      hasData:    m.hours > 0 || m.production > 0 || m.laborCost > 0,
    };
  }

  const design       = toMetrics(designMetrics);
  const preservation = toMetrics(presMetrics);
  const fulfillment  = toMetrics(ffMetrics);
  const resin        = toMetrics(resinMetrics);

  // Resin is intentionally excluded from totalProdOrders/combined/ga below —
  // matches its existing treatment everywhere else in this route (e.g.
  // computePeriodKpis' ALL_DEPTS-based org totals), not a side effect of
  // adding it here. It's still returned as its own field for the Resin tab.
  const totalProdOrders = design.production + preservation.production + fulfillment.production;

  // G&A has no production of its own — mirror computePeriodKpis, which spreads
  // it across total org production so its CPO ($/unit) is computable.
  const ga: KpiMetrics = {
    hours: 0, production: totalProdOrders, laborCost: gaCost,
    bonusCost: 0,
    ratioHours: 0, ratioProduction: 0,
    ratio: null,
    cpo: gaCost > 0 && totalProdOrders > 0 ? gaCost / totalProdOrders : null,
    cpoWithGM: null,
    cpoWithBonus: null,
    cpoWithGMBonus: null,
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
    bonusCost: 0,
    ratioHours: combinedRatioHours, ratioProduction: combinedRatioProduction,
    ratio: combinedRatio, cpo: blendedCPO, cpoWithGM: blendedCPOWithGM,
    cpoWithBonus: null, cpoWithGMBonus: null,
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

  // Business-month convention: the "current" month is whichever calendar
  // month contains the Monday of the current week — the same first-Monday
  // attribution getWeekMondays already uses to bucket weeks into months.
  // Without this, MTD/estimates flip over to the next calendar month a day
  // or two before the business week that owns those trailing days is done.
  const businessMonthKey    = getMondayOf(today).slice(0, 7); // "YYYY-MM"
  const [businessYear, businessMonthNum] = businessMonthKey.split('-').map(Number); // businessMonthNum is 1-indexed
  const businessMonthDate   = new Date(businessYear, businessMonthNum - 1, 1);

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
    //
    // fetchAllRows, not a plain .select() — weekly_labor_cost and
    // team_member_week_actuals are well past (or, for actuals, closing in
    // on) Postgrest's silent 1000-row cap, and earliestDate here can span
    // up to a year. A plain unranged .select() was silently dropping
    // whichever rows landed past row 1000 (arbitrary order, no error), which
    // is what made Georgia Design's MTD CPO read a third of its real value.
    const [laborRows, actualRows, rosterRes, bonusRows] = await Promise.all([
      fetchAllRows<LaborRow>((from, to) =>
        supabase
          .from('weekly_labor_cost')
          .select('employee,location,department,week_of,gross_pay')
          .gte('week_of', earliestDate)
          .range(from, to)
      ),
      fetchAllRows<ActualRow>((from, to) =>
        supabase
          .from('team_member_week_actuals')
          .select('week_of,member_name,department,location,actual_hours,actual_orders')
          .gte('week_of', earliestDate)
          .range(from, to)
      ),
      supabase
        .from('schedule_settings')
        .select('location,key,value')
        .in('key', ['designRoster', 'presRoster', 'ffRoster']),
      // Only ever consumed by the Monthly series below — fetched here
      // alongside everything else so it's available for that block.
      fetchAllRows<BonusRow>((from, to) =>
        supabase
          .from('monthly_bonus')
          .select('location,department,bonus_month,gross_pay')
          .gte('bonus_month', earliestDate)
          .range(from, to)
      ),
    ]);

    if (rosterRes.error)  throw rosterRes.error;

    const managerNames = buildManagerNameSet(rosterRes.data ?? []);

    const results: WindowResult[] = [];

    // ── MTD ───────────────────────────────────────────────────────────────────
    if (requested.includes('mtd')) {
      const mtdStart = `${businessMonthKey}-01`;
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
      // location -> monthKey ("YYYY-MM") -> dept -> $. Unmatched employees
      // (null location/department at upload time) are excluded here — see
      // monthly-bonus-upload's `unmatched` response field for reconciliation.
      const bonusByLocDeptMonth: Record<string, Record<string, Record<string, number>>> = {};
      for (const row of bonusRows) {
        if (!row.location || !row.department) continue;
        const monthKey = row.bonus_month.slice(0, 7);
        const dept     = normDept(row.department);
        bonusByLocDeptMonth[row.location] ??= {};
        bonusByLocDeptMonth[row.location][monthKey] ??= {};
        bonusByLocDeptMonth[row.location][monthKey][dept] =
          (bonusByLocDeptMonth[row.location][monthKey][dept] ?? 0) + row.gross_pay;
      }

      const n = parseInt(monthlySeries.split('-')[1]) || 12;
      for (let i = n; i >= 1; i--) {
        const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const last  = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
        const key   = isoDate(first).slice(0, 7);
        const bonusForMonth = {
          Utah:    bonusByLocDeptMonth['Utah']?.[key],
          Georgia: bonusByLocDeptMonth['Georgia']?.[key],
        };
        results.push(buildWindowResult(monthLabel(key), isoDate(first), isoDate(last), laborRows, actualRows, managerNames, bonusForMonth));
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
      const utahGa    = averageGaCostForMonths(laborRows, 'Utah',    businessMonthDate);
      const georgiaGa = averageGaCostForMonths(laborRows, 'Georgia', businessMonthDate);
      const gaSourceMonths = utahGa.monthKeys.map(monthLabel);

      const paidHolidays = (liveSettings.find(r => r.location === 'Global' && r.key === 'paidHolidays')?.value as string[]) ?? [];

      // A manager can legitimately be scheduled to flex-help another
      // department without that making it the department they manage —
      // their pay should only ever land in the one department Rippling
      // actually has them under. Without this, a manager placed on a
      // second roster (helping out, or a stale sync fallback carrying
      // their real title onto a roster row for a department they have no
      // real record in) gets their full pay counted there too, double-
      // counting a single salary/rate across two departments' CPO.
      const { data: managerEmpRows } = await supabase
        .from('rippling_employees')
        .select('full_name,location,department,title')
        .eq('active', true);
      // name|location -> the department(s) Rippling actually has them under
      // with a manager title. Absence of a person from this map means "no
      // Rippling info either way" — cost still counts wherever the roster
      // says (avoids under-counting a manager not yet uploaded); presence
      // means we know their real department(s), so cost is skipped anywhere
      // else they're flagged isManager on a roster.
      const managerHomeDept = new Map<string, Set<string>>();
      for (const e of (managerEmpRows ?? []) as { full_name: string; location: string; department: string; title: string }[]) {
        if (!MANAGER_TITLE_RE.test(e.title ?? '')) continue;
        const key = `${e.location}|${e.full_name.trim().toLowerCase()}`;
        if (!managerHomeDept.has(key)) managerHomeDept.set(key, new Set());
        managerHomeDept.get(key)!.add(e.department);
      }

      estimated = {};

      if (requested.includes('est-current')) {
        const currentMonthKey = `${businessMonthKey}-01`;

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
          estimate: buildRatioVariant(useSettings, currentMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'estimate', managerHomeDept),
          expected: buildRatioVariant(useSettings, currentMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'expected', managerHomeDept),
          goal:     buildRatioVariant(useSettings, currentMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'goal', managerHomeDept),
        };
      }

      if (requested.includes('est-next')) {
        // businessMonthNum is the 1-indexed current month, which is also
        // next month's 0-indexed Date value — no +1 needed here.
        const nextMonthDate = new Date(businessYear, businessMonthNum, 1);
        const nextMonthKey  = isoDate(nextMonthDate);

        estimated.next = {
          label:      `Est. ${monthLabel(nextMonthKey.slice(0, 7))}`,
          monthStart: nextMonthKey,
          isSnapshot: false,
          gaSourceMonths,
          estimate: buildRatioVariant(liveSettings, nextMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'estimate', managerHomeDept),
          expected: buildRatioVariant(liveSettings, nextMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'expected', managerHomeDept),
          goal:     buildRatioVariant(liveSettings, nextMonthKey, utahGa.avg, georgiaGa.avg, paidHolidays, 'goal', managerHomeDept),
        };
      }
    }

    return NextResponse.json({
      ok:        true,
      windows:   results,
      estimated,
      meta: { generatedAt: new Date().toISOString(), windowCount: results.length },
    }, { headers: { 'Cache-Control': 'no-store, must-revalidate' } });

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
