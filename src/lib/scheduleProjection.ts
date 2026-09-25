// Schedule -> hours/production/labor-cost projection over a set of weeks,
// shared by /api/kpis (Est. months + Historicals "planned" comparison) and
// /api/labor-forecast (admin monthly labor cost view) so the two can never
// disagree on how a roster + schedule turns into dollars.

import { DEPARTMENT_MANAGERS, getSalaryMgrCostForWeeks } from '@/lib/managers';
import { RATIO_TARGETS, type RatioTier } from '@/lib/ratioTargets';
import type { WageDept } from '@/lib/wageTargets';
import { resolveWeekHours, resolveWeekPayHours } from '@/lib/scheduleResolution';


const VALID_ROLES = new Set<string>(['specialist', 'senior', 'master']);
// `member.role ?? 'specialist'` alone doesn't protect against a malformed
// role value that isn't null/undefined but also isn't a real tier — e.g. a
// stray `0` slipping in from a bad sync or manual edit. `??` only catches
// null/undefined, so `RATIO_TARGETS[dept][0]` silently misses, `tierRatio`
// comes back undefined, and that person's Expected/Goal production drops to
// zero while their cost (protected by its own `?? ownRateHr` fallback)
// keeps counting — inflating CPO for exactly the people this happens to.
export function normalizeRole(role: unknown): RatioTier {
  return typeof role === 'string' && VALID_ROLES.has(role) ? (role as RatioTier) : 'specialist';
}

// ── Estimated projections from schedule_settings ──────────────────────────────
// Roster shapes (from useScheduleSettings.ts):
//   designRoster: { [id]: { ratio, payType, hourlyRate, annualSalary, name, isManager? } }
//   presRoster:   { [id]: { ratio, rate, name, payType?, annualSalary?, isManager? } }
//   ffRoster:     { [id]: { ratio, rate, name, payType?, annualSalary? } }
//   designHours / presHours / ffHours: { [memberId]: { [isoMonday]: hours } }

export interface DesignRosterEntry  { ratio: number; payType?: string; hourlyRate?: number; annualSalary?: number; name: string; isManager?: boolean; role?: RatioTier; standardTotalWeeklyHours?: number[]; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }
export interface PresRosterEntry    { ratio: number; rate?: number;    payType?: string;    annualSalary?: number; name: string; isManager?: boolean; role?: RatioTier; standardTotalWeeklyHours?: number[]; standardWeeklyHours?: number[]; startDate?: string; endDate?: string }
export interface HoursMap           { [memberId: string]: Record<string, number> }
export interface DailyHoursMap      { [weekOfMemberKey: string]: number[] }  // "${isoMonday}-${memberId}" -> [mon..fri]

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

// One person's slice of a projectDept call — only collected when the caller
// passes a `breakdown` array (the admin Labor Cost view). `basis` says which
// pay path produced `cost`: 'none' means scheduled hours with no rate on file
// (so $0 is a data gap, not a real zero), 'elsewhere' means a manager whose
// pay is counted in their real home department instead of this one.
// Same pattern rosterRoleSync.ts uses to infer manager status from a
// Rippling title — duplicated locally rather than imported since that
// module is client-upload-focused and this is a read-only projection.
const MANAGER_TITLE_RE = /manager|head of|director/i;

// name|location -> the department(s) Rippling actually has them under with a
// manager title, from active rippling_employees rows. Absence of a person
// from this map means "no Rippling info either way" — cost still counts
// wherever the roster says (avoids under-counting a manager not yet
// uploaded); presence means we know their real department(s), so projectDept
// skips cost anywhere else they're flagged isManager on a roster.
export function buildManagerHomeDept(
  rows: { full_name: string; location: string; department: string; title: string | null }[]
): Map<string, Set<string>> {
  const managerHomeDept = new Map<string, Set<string>>();
  for (const e of rows) {
    if (!MANAGER_TITLE_RE.test(e.title ?? '')) continue;
    const key = `${e.location}|${e.full_name.trim().toLowerCase()}`;
    if (!managerHomeDept.has(key)) managerHomeDept.set(key, new Set());
    managerHomeDept.get(key)!.add(e.department);
  }
  return managerHomeDept;
}

export interface MemberCostLine {
  name:      string;
  hours:     number;   // scheduled production hours
  payHours:  number;   // hours paid for (hourly only; 0 for salary)
  rate:      number;   // hourly rate, or weekly salary for 'salary'/'fixed-salary'
  cost:      number;
  basis:     'hourly' | 'salary' | 'fixed-salary' | 'elsewhere' | 'none';
  isManager: boolean;
}

export function projectDept(
  roster:        Record<string, DesignRosterEntry | PresRosterEntry>,
  hours:         HoursMap,
  dailyHours:    DailyHoursMap,
  weekOfs:       string[],         // Mondays in the month (isoMonday strings)
  location:      string,
  dept:          WageDept | 'Resin',
  holidaySet:    Set<string>,
  mode:          'estimate' | 'expected' | 'goal',
  mgrTotalHours: HoursMap,
  managerHomeDept: Map<string, Set<string>>,
  // Per-member "own ratio" to use instead of their current roster ratio —
  // keyed `${dept}|${name lowercased}`, see buildTrailingRatioOverrides.
  // Only ever passed for a past window's planned comparison; future months
  // (est-current/est-next) have no trailing actuals to build one from, so
  // this is undefined there and every member falls back to their roster
  // ratio, same as before this param existed.
  ratioOverride?: Map<string, number>,
  breakdown?: MemberCostLine[]
): { hours: number; production: number; laborCost: number; ratioHours: number; ratioProduction: number } {
  const holidays = Array.from(holidaySet);
  let totalHours = 0, totalProduction = 0, totalCost = 0;
  // Estimated ratio excludes managers entirely — neither their hours nor
  // their (roster-ratio-derived) production count toward it.
  let ratioHours = 0, ratioProduction = 0;
  // Names whose pay was already added below via their own roster entry — the
  // DEPARTMENT_MANAGERS fallback further down exists to cover managers whose pay
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
    // A member's own ratio can improve (or slip) fast enough that today's
    // roster ratio is a poor stand-in for what it was as of a past window —
    // prefer their trailing-actual ratio there when one's available (see
    // buildTrailingRatioOverrides); otherwise (future months, or no actuals
    // in the lookback) fall back to the roster's own ratio field.
    const ownRatio = ratioOverride?.get(`${dept}|${member.name.trim().toLowerCase()}`) ?? member.ratio;
    if (ownRatio > 0) {
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
        mode === 'estimate' ? ownRatio :
        mode === 'expected' ? tierRatio :
        /* goal */             Math.min(ownRatio, tierRatio);

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
    const line: MemberCostLine = { name: member.name, hours: memberHours, payHours: 0, rate: 0, cost: 0, basis: 'none', isManager: !!member.isManager };
    if (managesElsewhere) {
      // Skip — their full pay already lands in their real department's
      // projectDept call instead.
      line.basis = 'elsewhere';
    } else if (payType === 'salary' && annualSal > 0) {
      totalCost += (annualSal / 52) * weekOfs.length;
      costedNames.add(member.name.trim().toLowerCase());
      Object.assign(line, { basis: 'salary', rate: annualSal / 52, cost: (annualSal / 52) * weekOfs.length });
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
      Object.assign(line, { basis: 'hourly', payHours, rate: hourlyRate, cost: payHours * hourlyRate });
    }
    if (breakdown && (line.hours > 0 || line.cost > 0)) breakdown.push(line);
  }

  // Add salary manager cost for this dept — a specific named individual's
  // fixed pay, not subject to a role-average hypothetical, so it's the same
  // across all three modes, same as G&A. Skip anyone whose pay is already
  // counted above via their own roster entry (isManager + a real rate on
  // file) — this list exists only to cover managers whose pay never appears
  // on the roster at all.
  const uncostedManagers = DEPARTMENT_MANAGERS.filter(mgr => !costedNames.has(mgr.name.trim().toLowerCase()));
  totalCost += getSalaryMgrCostForWeeks(uncostedManagers, location, dept, weekOfs);
  if (breakdown) {
    for (const mgr of uncostedManagers) {
      const cost = getSalaryMgrCostForWeeks([mgr], location, dept, weekOfs);
      if (cost > 0) breakdown.push({ name: mgr.name, hours: 0, payHours: 0, rate: (mgr.annualSalary / 52) / mgr.departments.length, cost, basis: 'fixed-salary', isManager: true });
    }
  }

  return { hours: totalHours, production: totalProduction, laborCost: totalCost, ratioHours, ratioProduction };
}
