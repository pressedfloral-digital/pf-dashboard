'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useScheduleSettings, usePaidHolidays } from './useScheduleSettings';
import { getMondayDate, isoMonday, getWeekLabel } from '@/lib/weekDates';
import { InputModeToggle, round2, type InputMode } from './InputModeToggle';
import { resolveDayHours, resolveWeekHours, isDayOff, applyTimeOff, hoursOffOn, resolveWeekPayHours, baseDailyArray, isWithinEmployment, WEEKDAY_LABELS, type DailyHoursMap, type ScheduleRule } from '@/lib/scheduleResolution';
import { HistoricalsSection } from './HistoricalsSection';
import { EmployeeAutocomplete, type RipplingEmployee } from './EmployeeAutocomplete';
import { EmploymentDatesEditor } from './EmploymentDatesEditor';
import { type TimeOffPatch } from './TimeOffCalendar';
import { AddTimeOffButton } from './AddTimeOff';
import { AddUnavailabilityButton, AvailabilityChips, ScheduledTimeBox, entriesOn, withStandardPreferred, withDefaultUnavailable, useShowAvailability, standardHoursOn, type UnavailabilityEntry } from './Unavailability';
import { GridViewMenu, useGridView, HIDE_WEEKEND } from './GridView';
import { MemberTierBadges } from './MemberTierBadge';
import { isNonProductionStaff } from '@/lib/nonProductionStaff';
import { WeekCell, WeekHead } from './WeekCell';
import { PersonCell, DayHead, InlineNumber, ShiftBlock, OffBlock, ArchiveButton, ArchivedMembers, useDraggableOrder, useRowDrag } from './ScheduleBlocks';
import { HelpTip } from './HelpTip';
import { useProductionAssignmentCounts } from '@/hooks/useProductionAssignmentCounts';
import { ProductionActual, ProductionActualsStatus, sumActuals } from './ProductionActual';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ResinMember {
  id:          string;
  name:        string;
  ratio:       number;   // hours per unit
  payType:     'hourly' | 'salary';
  hourlyRate:  number;
  annualSalary: number;
  isManager?:  boolean;
  role?:       'specialist' | 'senior' | 'master';
  // Standard Mon-Sun hours (index 0=Monday..6=Sunday) — see src/lib/scheduleResolution.ts.
  standardWeeklyHours?: number[];
  // Manager-only: standing full work-week template (management + production
  // combined) — the fallback a manager's per-week mgrTotalHours entry drops
  // to when unset, mirroring Design/Preservation/Fulfillment's own field of
  // the same name (see SchedulePage.tsx and route.ts's projectDept).
  standardTotalWeeklyHours?: number[];
  // Employment window, both ISO 'YYYY-MM-DD' and inclusive — see scheduleResolution.ts.
  startDate?: string;
  endDate?:   string;
  // Date-bounded, toggleable replacements for standardWeeklyHours — see scheduleResolution.ts.
  scheduleRules?: ScheduleRule[];
  // ISO dates marked off on the Time Off calendar — see EmploymentWindow.daysOff.
  daysOff?: string[];
  // ISO date → hours off that day (partial day off) — see EmploymentWindow.hoursOff.
  hoursOff?: Record<string, number>;
  _removed?: boolean;   // archived: off the schedule, history kept
}

interface CohortRow {
  weekOf:       string;   // ISO date — Monday of intake week
  weekLabel:    string;
  units:        number;   // resin units that entered queue this week
  weeksElapsed: number;   // weeks since this intake week, i.e. its current age
  weeksToComplete: number | null;
  // Same walk, with the hypothetical hires from the hiring plan strip added.
  weeksToCompletePlanned: number | null;
  estimated:    boolean;  // no real order yet — projected at the recent average intake pace
}

interface QueueSummary {
  totalUnits:    number;
  utahOrigin:    number;
  georgiaOrigin: number;
  unknownOrigin: number;
  cohorts:       { weekOf: string; units: number }[];
  // Oldest event date still sitting in the queue — a live "what we're
  // currently working through" reading, no manual calibration needed since
  // resin_queue only ever holds genuinely-outstanding line items.
  oldestEventDate: string | null;
  offsetDays: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const WEEKS = 52;
const WINDOW = 8;  // weeks visible in the schedule grid at once
// Ratio (hours per unit) assumed for a hypothetical new hire on the Queue &
// Turnaround planner — a specialist pace, not the team's blended average,
// same reasoning as SchedulePage's NEW_HIRE_RATIO for Design.
const RESIN_NEW_HIRE_RATIO = 2.0;

// The production app has no Resin stage — resin pieces are assigned to the
// resin team member as the designer, so live Resin actuals read the Design
// assignment count for the resin roster.
const RESIN_MT_DEPARTMENT = 'design' as const;

// Mon–Sun ISO dates for a "This week" offset, built the same way as
// SchedulePage's getWeekdays so both pages ask MT for identical days.
function weekIsoDates(weekOffset: number): string[] {
  const monday = getMondayDate(weekOffset);
  return [0, 1, 2, 3, 4, 5, 6].map(di => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + di);
    return d.toISOString().split('T')[0];
  });
}

export const DEFAULT_RESIN_ROSTER: ResinMember[] = [
  { id: 'resin-1', name: 'Preslee Peterson', ratio: 1.5, payType: 'hourly', hourlyRate: 0, annualSalary: 0, isManager: true, role: 'master' },
];

function mondayOf(dateStr: string): Date {
  const d   = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Persistence helpers ───────────────────────────────────────────────────────

function useResinSettings() {
  const { settings, loading, saveState, update } = useScheduleSettings('Utah');
  const { holidays: paidHolidays } = usePaidHolidays();

  const resinDailyHours: DailyHoursMap = settings.resinDailyHours ?? {};

  function setResinDailyHours(h: DailyHoursMap) { update('resinDailyHours', h); }

  // Saved order is the array order. `allRoster` keeps archived members (for
  // writes and the Archived list); `roster` is everyone still on the team.
  const allRoster: ResinMember[] = Array.isArray(settings.resinRoster)
    ? (settings.resinRoster as unknown as ResinMember[])
    : DEFAULT_RESIN_ROSTER;
  const roster = allRoster.filter(m => !m._removed);

  const unavailability: UnavailabilityEntry[] = settings.unavailability ?? [];
  function setUnavailability(next: UnavailabilityEntry[]) { update('unavailability', next); }

  // Date-keyed: isoMonday -> { memberId -> hours }
  const hours: Record<string, Record<string, number>> = settings.resinHours ?? {};

  // Manager production-vs-total hours — shared keys with design/preservation/
  // fulfillment (member ids don't collide across departments), same pattern
  // used there: production hours drive units/ratio, total hours drive cost.
  const mgrTotalHours: Record<string, Record<string, number>> = settings.mgrTotalHours ?? {};
  const mgrTotalDailyHours: DailyHoursMap = settings.mgrTotalDailyHours ?? {};

  const queueFrontWeek: string | null = settings.resinQueueFrontWeek ?? null;
  const newHireHours: Record<string, number> = settings.resinNewHireHours ?? {};

  function setRoster(r: ResinMember[]) { update('resinRoster', r as unknown); }
  function setMgrTotalDailyHours(h: DailyHoursMap) { update('mgrTotalDailyHours', h); }
  // No longer written going forward (daily entries/template supersede it),
  // but a "reset to template" action still needs to be able to clear any
  // legacy value left over from before the daily-hours linkage existed —
  // otherwise it would keep outranking the template in resolveWeekHours.
  function setHours(h: Record<string, Record<string, number>>) { update('resinHours', h); }
  function setQueueFrontWeek(w: string | null) { update('resinQueueFrontWeek', w); }
  function setNewHireHours(weekIso: string, h: number) {
    const next = { ...newHireHours };
    if (h !== 0) next[weekIso] = h; else delete next[weekIso];
    update('resinNewHireHours', next);
  }

  return {
    allRoster, roster, setRoster, hours, setHours, resinDailyHours, setResinDailyHours,
    mgrTotalHours, mgrTotalDailyHours, setMgrTotalDailyHours,
    queueFrontWeek, setQueueFrontWeek,
    newHireHours, setNewHireHours,
    unavailability, setUnavailability,
    paidHolidays,
    loading, saveState,
  };
}

// ─── Main component ────────────────────────────────────────────────────────────

interface ResinPageProps {
  resinQueue?: number;  // live count from dashboard (if wired up)
  canViewCPO?: boolean;
  canSeeManagerCPO?: (name: string) => boolean;
  userRole?: string;
  // Utah's availability list, when the page around Resin already holds it —
  // one copy, so edits here and in the other Utah grids don't overwrite each
  // other. Falls back to Resin's own Utah settings when not passed.
  unavailability?: UnavailabilityEntry[];
  onUnavailabilityChange?: (next: UnavailabilityEntry[]) => void;
}

export default function ResinPage({ resinQueue, canViewCPO = true, canSeeManagerCPO = () => false, userRole = 'admin', unavailability: unavailabilityProp, onUnavailabilityChange }: ResinPageProps) {
  const [activeTab, setActiveTab] = useState<'thisweek' | 'schedule' | 'queue' | 'historicals'>('thisweek');
  const [thisWeekOffset, setThisWeekOffset] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const [showCPO, setShowCPO] = useState(false);
  const [resinInputMode, setResinInputMode] = useState<InputMode>('hours');
  const [queueSummary, setQueueSummary] = useState<QueueSummary | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const {
    allRoster, roster, setRoster, hours, resinDailyHours, setResinDailyHours,
    mgrTotalHours, mgrTotalDailyHours, setMgrTotalDailyHours,
    queueFrontWeek, setQueueFrontWeek,
    newHireHours, setNewHireHours,
    unavailability: ownUnavailability, setUnavailability: setOwnUnavailability,
    paidHolidays,
    loading, saveState,
  } = useResinSettings();
  const unavailability = unavailabilityProp ?? ownUnavailability;
  const setUnavailability = onUnavailabilityChange ?? setOwnUnavailability;
  const [showAvail] = useShowAvailability();
  const view = useGridView();

  // App/technology staff are kept off every roster view (see nonProductionStaff.ts).
  const productionRoster = roster.filter(m => !isNonProductionStaff(m.name));
  const rosterDrag = useDraggableOrder(productionRoster, reorderRoster);
  const rowDrag = useRowDrag(productionRoster, reorderRoster);

  const thisWeekDates = weekIsoDates(thisWeekOffset);
  const resinActuals = useProductionAssignmentCounts({
    names: productionRoster.map(m => m.name),
    dates: thisWeekDates,
    enabled: activeTab === 'thisweek',
  });
  const actualFor = (name: string, iso: string) => resinActuals.getCount(name, iso, RESIN_MT_DEPARTMENT);

  // Fetch queue summary — re-fetches whenever queueFrontWeek changes so the
  // top summary cards (total/Utah/Georgia) stay consistent with the
  // turnaround table below, which already excludes cohorts before that week
  // as completed. Without frontWeek the API just returns the full uncleared
  // total, same as before this existed.
  useEffect(() => {
    const params = queueFrontWeek ? `&frontWeek=${queueFrontWeek}` : '';
    fetch(`/api/resin/queue?summary=true${params}`)
      .then(r => r.json())
      .then(d => setQueueSummary(d))
      .catch(() => {})
      .finally(() => setQueueLoading(false));
  }, [queueFrontWeek]);

  // ── Derived: weekly capacity ───────────────────────────────────────────────
  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => weekOffset + i);

  // Shared params for resolveWeekHours/resolveWeekPayHours — holidays flows
  // through both so a paid-holiday week's production and guaranteed-pay
  // totals stay consistent with each other and with the daily helpers below.
  function weekHoursParams(weekIdx: number, m: ResinMember) {
    const weekIso = isoMonday(weekIdx);
    return {
      dailyMap: resinDailyHours, weekKey: `${weekIso}-${m.id}`,
      legacyWeeklyValue: hours[weekIso]?.[m.id],
      standardWeeklyHours: m.standardWeeklyHours,
      employment: { weekIso, startDate: m.startDate, endDate: m.endDate, rules: m.scheduleRules, daysOff: m.daysOff, hoursOff: m.hoursOff },
      holidays: paidHolidays,
    };
  }

  function memberWeekHours(weekIdx: number, m: ResinMember): number {
    return resolveWeekHours(weekHoursParams(weekIdx, m));
  }

  // Guaranteed-pay basis for the week — equals memberWeekHours except on a
  // paid holiday, where it's the member's standard hours for that weekday
  // (guaranteed) plus any worked override, instead of the holiday-zeroed
  // production number.
  function memberWeekPayHours(weekIdx: number, m: ResinMember): number {
    return resolveWeekPayHours(weekHoursParams(weekIdx, m));
  }

  function weeklyCapacity(weekIdx: number): number {
    return roster.reduce((sum, m) => sum + (m.ratio > 0 ? memberWeekHours(weekIdx, m) / m.ratio : 0), 0);
  }

  // Same idea as Design's resolveMgrTotalWeekHours: a day's fallback is that
  // day's already-resolved PAY hours (guaranteed-holiday-pay-aware) — this is
  // a manager's own hours entry, which drives cost rather than units, so it
  // should never silently drop to $0 on an unworked holiday.
  function resolveMgrTotalWeekHours(weekIdx: number, m: ResinMember, payHrs: number): number {
    const weekIso = isoMonday(weekIdx);
    const weekKey = `${weekIso}-${m.id}`;
    const hasDailyOverrides = mgrTotalDailyHours[weekKey] !== undefined;
    const weeklyOverride = mgrTotalHours[m.id]?.[weekIso];
    // A flat weekly total (no day-by-day breakdown for this week) wins
    // outright when set — same priority getMgrTotalDH gives an explicit
    // per-day override, just at the week level instead.
    if (!hasDailyOverrides && weeklyOverride != null) return weeklyOverride;
    if (!hasDailyOverrides && !m.standardTotalWeeklyHours) return payHrs;
    // Sum day-by-day via getMgrTotalDH so this always matches what the "This
    // week" total cells display (override > template day > production pay).
    let sum = 0;
    for (let day = 0; day < 7; day++) sum += getMgrTotalDH(m, weekIdx, day);
    return sum;
  }

  // Production hours drive units/ratio; managers' total hours (production +
  // managerial) drive cost instead. A manager's own CPO is only shown to
  // viewers the pay-privacy chain (see canSeeManagerCPO) allows.
  function weekMemberStats(weekIdx: number, m: ResinMember) {
    const hrs      = memberWeekHours(weekIdx, m);
    const units    = m.ratio > 0 ? hrs / m.ratio : 0;
    const payHrs   = memberWeekPayHours(weekIdx, m);
    const totalHrs = m.isManager ? resolveMgrTotalWeekHours(weekIdx, m, payHrs) : payHrs;
    const cost     = m.payType === 'salary' ? m.annualSalary / 52 : totalHrs * m.hourlyRate;
    const cpo      = (!m.isManager || canSeeManagerCPO(m.name)) && units > 0 && cost > 0 ? cost / units : null;
    return { hrs, units, cost, cpo };
  }

  function weekTotals(weekIdx: number) {
    let totalUnits = 0, totalCost = 0;
    roster.forEach(m => {
      const { units, cost } = weekMemberStats(weekIdx, m);
      totalUnits += units;
      totalCost  += cost;
    });
    return { totalUnits, totalCost, totalCPO: totalUnits > 0 && totalCost > 0 ? totalCost / totalUnits : null };
  }

  const avgWeeklyCapacity = (() => {
    let total = 0;
    for (let w = 0; w < 8; w++) total += weeklyCapacity(w);
    return total / 8;
  })();

  // Full tracked-horizon schedule capacity, per week — used to project cohort
  // completion against real near-term staffing changes instead of a flat
  // 8-week average that can't see them.
  const capacityByWeek = Array.from({ length: WEEKS }, (_, w) => weeklyCapacity(w));

  // ── Hiring / what-if plan ─────────────────────────────────────────────────
  // Same as Design's: a hire's hours carry forward from their start week on,
  // and only ever feed the Planned side — Scheduled stays exactly what's in
  // the Schedule tab.
  const hireHoursByWeek: number[] = [];
  {
    let cumulative = 0;
    for (let w = 0; w < WEEKS; w++) {
      cumulative += newHireHours[isoMonday(w)] ?? 0;
      hireHoursByWeek.push(cumulative);
    }
  }
  const planCapacityByWeek = capacityByWeek.map((c, w) => Math.max(0, c + hireHoursByWeek[w] / RESIN_NEW_HIRE_RATIO));

  // ── Derived: turnaround simulation ────────────────────────────────────────
  // Cohorts older than queueFrontWeek are stuck-open stragglers (a bad tag, an
  // abandoned line item) rather than real backlog — folding them into the FIFO
  // walk would anchor "weeks to complete" to whichever ancient order happens
  // to still be open, instead of where the team actually is right now. They're
  // still surfaced (see stragglerCohorts below) so someone can go close them
  // out, just excluded from the timing math.
  const { activeCohorts, stragglerCohorts } = (() => {
    const empty = { activeCohorts: [] as { weekOf: string; units: number }[], stragglerCohorts: [] as { weekOf: string; units: number }[] };
    if (!queueSummary) return empty;
    if (!queueFrontWeek) return { activeCohorts: queueSummary.cohorts, stragglerCohorts: [] };
    const active: { weekOf: string; units: number }[] = [];
    const stragglers: { weekOf: string; units: number }[] = [];
    for (const c of queueSummary.cohorts) {
      (c.weekOf < queueFrontWeek ? stragglers : active).push(c);
    }
    return { activeCohorts: active, stragglerCohorts: stragglers };
  })();

  const cohortRows: CohortRow[] = (() => {
    if (activeCohorts.length === 0) return [];

    // Real, already-booked cohorts only run as far out as customers have
    // actually placed orders with event dates, which tends to trail off a
    // few months ahead. Past that point, project the remaining weeks up to
    // the full 52-week horizon at the recent average intake pace — same
    // idea as avgWeeklyCapacity's trailing average — so this table reads
    // out as far as the other departments' Queue & Turnaround tabs instead
    // of just stopping once real bookings run out. These projected weeks
    // are flagged `estimated` and don't count toward the "active units in
    // queue" total shown above, since they aren't real orders yet.
    const todayIso = isoMonday(0);
    const lastRealWeek = activeCohorts.reduce((max, c) => (c.weekOf > max ? c.weekOf : max), todayIso);
    const recentReal = activeCohorts.filter(c => c.weekOf >= isoMonday(-8)).map(c => c.units);
    const avgRecentIntake = recentReal.length > 0 ? recentReal.reduce((s, u) => s + u, 0) / recentReal.length : 0;

    const projectedCohorts: { weekOf: string; units: number; estimated: boolean }[] =
      activeCohorts.map(c => ({ ...c, estimated: false }));
    if (avgRecentIntake > 0) {
      for (let w = 0; w < WEEKS; w++) {
        const weekIso = isoMonday(w);
        if (weekIso <= lastRealWeek) continue;
        projectedCohorts.push({ weekOf: weekIso, units: Math.round(avgRecentIntake), estimated: true });
      }
    }
    projectedCohorts.sort((a, b) => a.weekOf.localeCompare(b.weekOf));

    // Week-by-week FIFO: each week's scheduled capacity works the oldest
    // cohorts that have actually arrived by then, and whatever capacity is
    // left over once the arrived queue is empty is lost (idle hours can't be
    // spent on flowers that haven't shown up yet). A cumulative-capacity vs
    // cumulative-units match would instead bank those idle hours against
    // future cohorts, so extra staff early on (or a light week before a
    // busy season) would make every later cohort read weeks too fast.
    // Horizon extends past the tracked schedule (assuming the last tracked
    // week's capacity holds) so a large backlog doesn't read as "never
    // clears" just because the capacity array ran out.
    const today = getMondayDate(0);
    const weeksElapsedOf = (weekOf: string) =>
      Math.round((today.getTime() - mondayOf(weekOf).getTime()) / (7 * 24 * 60 * 60 * 1000));
    // Past/current cohorts are already in hand at week 0; future ones arrive
    // in their own intake week.
    const arrivalWeek = projectedCohorts.map(c => Math.max(0, -weeksElapsedOf(c.weekOf)));
    // Run once per capacity array (Scheduled, then Planned with hypothetical
    // hires) on fresh copies so the two walks can't contaminate each other.
    function runWalk(capByWeek: number[]): (number | null)[] {
      const horizon = capByWeek.length * 2;
      const capAt = (w: number) => w < capByWeek.length ? capByWeek[w] : (capByWeek[capByWeek.length - 1] ?? 0);
      const remaining = projectedCohorts.map(c => c.units);
      const doneWeek: (number | null)[] = projectedCohorts.map(() => null);
      let front = 0;  // first cohort with work left — FIFO, so everything before it is done
      for (let w = 0; w < horizon && front < projectedCohorts.length; w++) {
        let cap = capAt(w);
        for (let i = front; i < projectedCohorts.length && cap > 0; i++) {
          if (arrivalWeek[i] > w) break;  // sorted by week, so nothing later has arrived either
          if (remaining[i] <= 0) continue;
          const take = Math.min(cap, remaining[i]);
          remaining[i] -= take;
          cap -= take;
          if (remaining[i] <= 1e-9) doneWeek[i] = w;
        }
        while (front < projectedCohorts.length && remaining[front] <= 1e-9) {
          if (doneWeek[front] === null) doneWeek[front] = Math.max(w, arrivalWeek[front]);
          front++;
        }
      }
      return doneWeek;
    }
    const doneWeek        = runWalk(capacityByWeek);
    const doneWeekPlanned = runWalk(planCapacityByWeek);

    return projectedCohorts.map(({ weekOf, units, estimated }, i) => ({
      weekOf,
      weekLabel: mondayOf(weekOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      units,
      weeksElapsed: weeksElapsedOf(weekOf),
      weeksToComplete: doneWeek[i],
      weeksToCompletePlanned: doneWeekPlanned[i],
      estimated,
    }));
  })();

  // ── Handlers ──────────────────────────────────────────────────────────────

  function getDH(memberId: string, weekIdx: number, di: number): number {
    const m = roster.find(m => m.id === memberId);
    const weekIso = isoMonday(weekIdx);
    return resolveDayHours(resinDailyHours, `${weekIso}-${memberId}`, di, m?.standardWeeklyHours,
      { weekIso, startDate: m?.startDate, endDate: m?.endDate, rules: m?.scheduleRules, daysOff: m?.daysOff, hoursOff: m?.hoursOff }, paidHolidays).hours;
  }

  // Guaranteed-pay basis for the day — see resolveDayHours' payHours.
  function getDHPay(memberId: string, weekIdx: number, di: number): number {
    const m = roster.find(m => m.id === memberId);
    const weekIso = isoMonday(weekIdx);
    return resolveDayHours(resinDailyHours, `${weekIso}-${memberId}`, di, m?.standardWeeklyHours,
      { weekIso, startDate: m?.startDate, endDate: m?.endDate, rules: m?.scheduleRules, daysOff: m?.daysOff, hoursOff: m?.hoursOff }, paidHolidays).payHours;
  }

  function isDHOverride(memberId: string, weekIdx: number, di: number): boolean {
    const m = roster.find(m => m.id === memberId);
    const weekIso = isoMonday(weekIdx);
    return resolveDayHours(resinDailyHours, `${weekIso}-${memberId}`, di, m?.standardWeeklyHours,
      { weekIso, startDate: m?.startDate, endDate: m?.endDate, rules: m?.scheduleRules, daysOff: m?.daysOff, hoursOff: m?.hoursOff }, paidHolidays).isOverride;
  }

  function isDHDayOff(memberId: string, weekIdx: number, di: number): boolean {
    const m = roster.find(m => m.id === memberId);
    return isDayOff(di, { weekIso: isoMonday(weekIdx), daysOff: m?.daysOff, hoursOff: m?.hoursOff });
  }
  function isDHHoliday(memberId: string, weekIdx: number, di: number): boolean {
    const m = roster.find(m => m.id === memberId);
    const weekIso = isoMonday(weekIdx);
    return resolveDayHours(resinDailyHours, `${weekIso}-${memberId}`, di, m?.standardWeeklyHours,
      { weekIso, startDate: m?.startDate, endDate: m?.endDate, rules: m?.scheduleRules, daysOff: m?.daysOff, hoursOff: m?.hoursOff }, paidHolidays).isHoliday;
  }

  // Member-agnostic holiday check for a whole day column (header, Day total
  // row) — paid holidays are a global calendar, not per-member.
  function isHolidayColumn(weekIdx: number, di: number): boolean {
    const date = getMondayDate(weekIdx);
    date.setDate(date.getDate() + di);
    return paidHolidays.includes(date.toISOString().split('T')[0]);
  }

  function setDH(memberId: string, weekIdx: number, di: number, val: number) {
    const weekIso = isoMonday(weekIdx);
    const key = `${weekIso}-${memberId}`;
    const padded = [...baseDailyArray(resinDailyHours, key, hours[weekIso]?.[memberId], isoMonday(0))];
    padded[di] = val;
    setResinDailyHours({ ...resinDailyHours, [key]: padded });
  }

  // Priority: an explicit override for this exact day, then this day's slot
  // in the standing Total-schedule template, then production pay hours —
  // matches resolveMgrTotalWeekHours' own chain (see below) day-by-day.
  function getMgrTotalDH(m: ResinMember, weekIdx: number, di: number): number {
    const override = mgrTotalDailyHours[`${isoMonday(weekIdx)}-${m.id}`]?.[di];
    if (override != null) return override;
    if (m.standardTotalWeeklyHours) {
      return applyTimeOff(m.standardTotalWeeklyHours[di] ?? 0, di, { weekIso: isoMonday(weekIdx), daysOff: m.daysOff, hoursOff: m.hoursOff });
    }
    return getDHPay(m.id, weekIdx, di);
  }

  function setMgrTotalDH(memberId: string, weekIdx: number, di: number, val: number) {
    const key = `${isoMonday(weekIdx)}-${memberId}`;
    const prev = mgrTotalDailyHours[key] ?? [null, null, null, null, null, null, null];
    const padded = Array.from({ length: 7 }, (_, j) => prev[j] ?? null);
    padded[di] = val;
    setMgrTotalDailyHours({ ...mgrTotalDailyHours, [key]: padded });
  }

  function dailyCost(m: ResinMember, weekIdx: number, di: number): number {
    const h = m.isManager ? getMgrTotalDH(m, weekIdx, di) : getDHPay(m.id, weekIdx, di);
    return m.payType === 'salary' ? m.annualSalary / 260 : h * m.hourlyRate;
  }

  function updateRosterField(id: string, field: keyof ResinMember, val: string | number | boolean) {
    setRoster(allRoster.map(m => m.id === id ? { ...m, [field]: val } : m));
  }

  function addMember() {
    const id = `resin-${Date.now()}`;
    setRoster([...allRoster, { id, name: 'Team Member', ratio: 1.5, payType: 'hourly', hourlyRate: 0, annualSalary: 0 }]);
  }

  // Archive, not delete — past hours and Historicals keep the member.
  function archiveMember(id: string) {
    setRoster(allRoster.map(m => m.id === id ? { ...m, _removed: true } : m));
  }
  function restoreMember(id: string) {
    setRoster(allRoster.map(m => m.id === id ? { ...m, _removed: false } : m));
  }
  // New order for the active members; archived ones stay at the end.
  function reorderRoster(newOrder: string[]) {
    const byId = new Map(allRoster.map(m => [m.id, m]));
    const ordered = newOrder.map(id => byId.get(id)).filter((m): m is ResinMember => !!m);
    setRoster([...ordered, ...allRoster.filter(m => !newOrder.includes(m.id))]);
  }
  function saveTimeOff(patches: Record<string, TimeOffPatch>) {
    setRoster(allRoster.map(m => patches[m.id] ? { ...m, ...patches[m.id] } : m));
  }

  async function refreshRatio(m: ResinMember) {
    setRefreshingId(m.id);
    try {
      const res = await fetch(`/api/actuals?location=Utah&type=team&weeks=100`);
      const data = await res.json() as { teamActuals?: { department: string; week_of: string; member_name: string; actual_hours: number; actual_orders: number }[] };
      const rows = (data.teamActuals ?? [])
        .filter(r => r.department === 'Resin' && r.member_name === m.name)
        .sort((a, b) => b.week_of.localeCompare(a.week_of))
        .slice(0, 8);
      const totalHours  = rows.reduce((s, r) => s + r.actual_hours,  0);
      const totalOrders = rows.reduce((s, r) => s + r.actual_orders, 0);
      if (totalOrders > 0 && totalHours > 0) {
        updateRosterField(m.id, 'ratio', Math.round(totalHours / totalOrders * 100) / 100);
      }
    } catch {}
    setRefreshingId(null);
  }

  async function syncQueue() {
    setSyncLoading(true);
    setSyncResult(null);
    try {
      const res = await fetch('/api/cron/resin-queue-sync');
      const d = await res.json();
      setSyncResult(
        `Synced ${d.synced ?? 0} resin items, cleared ${d.cleared ?? 0} no-longer-open` +
        (d.transfers ? ` · ${d.transfers.transferred ?? 0} GA→UT transfers detected, ${d.transfers.errors ?? 0} errors` : '')
      );
      // Refresh summary
      const params = queueFrontWeek ? `&frontWeek=${queueFrontWeek}` : '';
      const s = await fetch(`/api/resin/queue?summary=true${params}`).then(r => r.json());
      setQueueSummary(s);
    } catch (e) {
      setSyncResult('Sync failed — check console');
    } finally {
      setSyncLoading(false);
    }
  }

  const hasRates = canViewCPO && roster.some(m => m.hourlyRate > 0 || m.annualSalary > 0);

  // ISO dates of the This Week days, for the day-header pills
  const thisWeekIsos = WEEKDAY_LABELS.map((_, di) => {
    const d = getMondayDate(thisWeekOffset);
    d.setDate(d.getDate() + di);
    return d.toISOString().split('T')[0];
  });
  const todayIso = (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.toISOString().split('T')[0]; })();

  const TABS = [
    { id: 'thisweek'    as const, label: 'This Week' },
    { id: 'schedule'    as const, label: 'Weekly Schedule' },
    { id: 'queue'       as const, label: 'Queue & Turnaround' },
    { id: 'historicals' as const, label: 'Historicals' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-5 h-5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" />
        <span className="ml-3 text-sm text-slate-500">Loading resin schedule…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-purple-500" />
          <h2 className="text-sm font-semibold text-slate-700"><HelpTip id="resin.title">Resin Scheduling</HelpTip></h2>
          {saveState === 'saving' && <span className="text-xs text-slate-400">Saving…</span>}
          {saveState === 'saved'  && <span className="text-xs text-emerald-500">Saved</span>}
          {saveState === 'error'  && <span className="text-xs text-red-500">Save failed</span>}
        </div>

        {/* Queue summary pills */}
        <div className="flex items-center gap-2 flex-wrap">
          {queueLoading ? (
            <span className="text-xs text-slate-400">Loading queue…</span>
          ) : queueSummary ? (
            <>
              <span className="text-xs bg-purple-50 border border-purple-100 text-purple-700 rounded-full px-3 py-1 font-medium">
                {queueSummary.totalUnits.toLocaleString()} in queue
              </span>
              {queueSummary.georgiaOrigin > 0 && (
                <span className="text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-full px-3 py-1">
                  {queueSummary.georgiaOrigin} Georgia-origin
                </span>
              )}
              {queueSummary.utahOrigin > 0 && (
                <span className="text-xs bg-slate-50 border border-slate-200 text-slate-600 rounded-full px-3 py-1">
                  {queueSummary.utahOrigin} Utah-origin
                </span>
              )}
            </>
          ) : null}
          <button
            onClick={syncQueue}
            disabled={syncLoading}
            className="text-xs border border-slate-200 rounded px-2.5 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {syncLoading ? 'Syncing…' : 'Sync Queue'}
          </button>
        </div>
      </div>

      {syncResult && (
        <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded px-3 py-2">{syncResult}</p>
      )}

      {/* ── Georgia transfer note ────────────────────────────────────────────────
          The dashboard never writes to Shopify's fulfillment location itself
          — your team moves it by hand once they've physically shipped a
          Georgia item to Utah. Sync Queue just watches for that change and
          reflects it (see the queue table below) once it sees the location
          is now Utah. */}
      {(queueSummary?.georgiaOrigin ?? 0) > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm font-medium text-amber-800">
            {queueSummary!.georgiaOrigin} resin orders originated in Georgia
          </p>
          <p className="text-xs text-amber-600 mt-0.5">
            All resin work happens in Utah. Once your team ships the flowers and updates the fulfillment location
            in Shopify yourselves, the next sync will detect it and show it as transferred below.
          </p>
        </div>
      )}

      {/* ── Roster ────────────────────────────────────────────────────────────── */}
      <div>
        <button onClick={() => setShowRoster(r => !r)}
          className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
          {showRoster ? '▲ Hide' : '▼ Edit'} resin roster, ratios &amp; pay rates
        </button>
        {showRoster && (
          <div className="mt-3 bg-white border border-slate-100 rounded-xl p-5">
            <div className="grid grid-cols-[16px_1fr_80px_90px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
              <span /><span>Name</span><span className="text-center">Role</span><span className="text-center">Ratio</span><span />
            </div>
            <div className="space-y-3">
              {productionRoster.map(m => (
                <div key={m.id}
                  className={`rounded transition-colors ${rosterDrag.dragOverId === m.id ? 'bg-indigo-50' : ''}`}
                  onDragOver={e => rosterDrag.handleDragOver(e, m.id)}
                  onDrop={() => rosterDrag.handleDrop(m.id)}>
                  <div className="grid grid-cols-[16px_1fr_80px_90px_20px] gap-2 items-center">
                    <span
                      draggable
                      onDragStart={e => { e.stopPropagation(); rosterDrag.handleDragStart(m.id); }}
                      onDragEnd={rosterDrag.handleDragEnd}
                      className="text-slate-300 cursor-grab active:cursor-grabbing text-center select-none px-1">⠿</span>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className="flex-1 min-w-0">
                        <EmployeeAutocomplete
                          value={m.name}
                          location="Utah"
                          department="Resin"
                          onChange={val => updateRosterField(m.id, 'name', val)}
                          onSelect={(emp: RipplingEmployee) => {
                            updateRosterField(m.id, 'name', emp.full_name);
                            updateRosterField(m.id, 'role', emp.role);
                            updateRosterField(m.id, 'payType', emp.pay_type);
                            updateRosterField(m.id, 'hourlyRate', emp.hourly_rate ?? 0);
                            updateRosterField(m.id, 'annualSalary', emp.annual_salary ?? 0);
                            updateRosterField(m.id, 'isManager', /manager|head of|director/i.test(emp.title ?? ''));
                          }}
                        />
                      </div>
                      <MemberTierBadges name={m.name} location="Utah" dept="Resin" fallbackRole={m.role} fallbackIsManager={m.isManager} className="inline-flex shrink-0" />
                    </div>
                    <select value={m.role ?? 'specialist'} onChange={e => updateRosterField(m.id, 'role', e.target.value)}
                      className="border border-slate-200 rounded px-1.5 py-1.5 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
                      <option value="specialist">Specialist</option>
                      <option value="senior">Senior</option>
                      <option value="master">Master</option>
                    </select>
                    <div className="flex items-center gap-1">
                      <input type="number" value={m.ratio} step="0.01" min="0.01"
                        onChange={e => updateRosterField(m.id, 'ratio', parseFloat(e.target.value) || 0)}
                        className="w-full border border-slate-200 rounded px-2 py-1.5 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                      <button onClick={() => refreshRatio(m)} title="Update ratio from last 8 weeks of historicals"
                        className="text-slate-300 hover:text-indigo-500 transition-colors text-sm shrink-0"
                        disabled={refreshingId === m.id}>
                        {refreshingId === m.id ? '…' : '↻'}
                      </button>
                    </div>
                    {roster.length > 1 ? <ArchiveButton onClick={() => archiveMember(m.id)} /> : <span />}
                  </div>
                  <div className="flex items-center gap-1.5 pl-6 mt-1.5">
                    <span className="text-[10px] text-slate-400 w-32 shrink-0">Employment dates</span>
                    <EmploymentDatesEditor
                      startDate={m.startDate}
                      endDate={m.endDate}
                      onStartDateChange={val => updateRosterField(m.id, 'startDate', val)}
                      onEndDateChange={val => updateRosterField(m.id, 'endDate', val)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">Pay rates &amp; titles come from Rippling upload.</p>
            <button onClick={addMember}
              className="mt-4 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">
              + Add team member
            </button>
            <ArchivedMembers members={allRoster.filter(m => m._removed)} onRestore={restoreMember} />
            <p className="mt-3 text-xs text-slate-400"><strong>Ratio:</strong> hours per unit. e.g. 1.5 = 1 unit takes 1.5 hrs.</p>
          </div>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────────── */}
      <div className="flex border-b border-slate-200">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <HelpTip id={id === 'schedule' ? 'resin.tab.schedule' : `sched.tab.${id}`}>{label}</HelpTip>
          </button>
        ))}
      </div>

      {/* ── THIS WEEK TAB ────────────────────────────────────────────────────── */}
      {activeTab === 'thisweek' && (
        <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <div>
              <ProductionActualsStatus loading={resinActuals.loading} error={resinActuals.error} refreshedAt={resinActuals.refreshedAt} />
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <GridViewMenu options={['times', 'hours', 'output', 'mgrTotal', 'actuals', 'weekend']} />
              <AddUnavailabilityButton people={productionRoster.map(m => ({ id: m.id, name: m.name }))} list={unavailability}
                onChange={setUnavailability} defaultDate={thisWeekIsos.find(iso => iso >= todayIso) ?? thisWeekIsos[0]} />
              <AddTimeOffButton disabled={userRole === 'viewer'} defaultDate={thisWeekIsos.find(iso => iso >= todayIso) ?? thisWeekIsos[0]}
                people={productionRoster.map(m => ({ id: m.id, name: m.name, daysOff: m.daysOff, hoursOff: m.hoursOff }))}
                onSave={saveTimeOff} />
              <button onClick={() => setThisWeekOffset(Math.max(0, thisWeekOffset - 1))} disabled={thisWeekOffset === 0}
                className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
              <button onClick={() => setThisWeekOffset(Math.min(WEEKS - 1, thisWeekOffset + 1))} disabled={thisWeekOffset >= WEEKS - 1}
                className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className={`min-w-full text-xs ${view.weekend ? '' : HIDE_WEEKEND}`}>
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="sticky left-0 z-10 bg-white px-4 py-3 text-left text-[13px] font-medium text-slate-500 min-w-[190px]">Team member</th>
                  {WEEKDAY_LABELS.map((d, di) => (
                    <th key={d} className="px-1.5 py-3 min-w-[104px]">
                      <DayHead label={d} iso={thisWeekIsos[di]} today={thisWeekIsos[di] === todayIso} holiday={isHolidayColumn(thisWeekOffset, di)} />
                    </th>
                  ))}
                  <th className="px-3 py-3 text-center text-[13px] font-medium text-slate-500 whitespace-nowrap">Week total</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const weekIso = isoMonday(thisWeekOffset);
                  // Rows: everyone employed some day this week, scheduled or not
                  const isScheduledThisWeek = (m: ResinMember) =>
                    [0,1,2,3,4,5,6].some(di => getDH(m.id, thisWeekOffset, di) > 0 || (!!m.isManager && getMgrTotalDH(m, thisWeekOffset, di) > 0));
                  // Scheduled people first, then the rest (stable sort keeps drag order within each group)
                  const visibleTeam = productionRoster.filter(m => {
                    if (isScheduledThisWeek(m)) return true;
                    const employment = { weekIso, startDate: m.startDate, endDate: m.endDate };
                    return thisWeekIsos.some((_, di) => isWithinEmployment(di, employment));
                  }).sort((a, b) => Number(isScheduledThisWeek(b)) - Number(isScheduledThisWeek(a)));
                  if (visibleTeam.length === 0) return (
                    <tr><td colSpan={9} className="px-4 py-6 text-center text-xs text-slate-400">
                      No one is on the roster this week.
                    </td></tr>
                  );
                  return visibleTeam.map((m) => {
                  const weekTotal = [0,1,2,3,4,5,6].reduce((s, di) => s + getDH(m.id, thisWeekOffset, di), 0);
                  const weekTotalHrs = [0,1,2,3,4,5,6].reduce((s, di) => s + (m.isManager ? getMgrTotalDH(m, thisWeekOffset, di) : getDH(m.id, thisWeekOffset, di)), 0);
                  const units = m.ratio > 0 ? weekTotal / m.ratio : 0;
                  return (
                    <tr key={m.id} {...rowDrag.rowProps(m.id)} className={`border-b border-slate-100 ${rowDrag.isOver(m.id) ? 'bg-sky-50' : ''}`}>
                      <td {...rowDrag.handleProps(m.id)} className={`sticky left-0 z-10 cursor-grab ${rowDrag.isOver(m.id) ? 'bg-sky-50' : 'bg-white'} px-4 py-2 whitespace-nowrap`}>
                        <PersonCell name={m.name} grip>
                          <MemberTierBadges name={m.name} location="Utah" dept="Resin" fallbackRole={m.role} fallbackIsManager={m.isManager} />
                          {resinActuals.unmatched.has(m.name.trim()) && <div className="text-[9px] font-medium text-red-500">MT staff not linked</div>}
                        </PersonCell>
                      </td>
                      {[0,1,2,3,4,5,6].map(di => {
                        const dayVal = getDH(m.id, thisWeekOffset, di);
                        const isOverride = isDHOverride(m.id, thisWeekOffset, di);
                        const isHoliday = isDHHoliday(m.id, thisWeekOffset, di);
                        const dayUnits = m.ratio > 0 ? dayVal / m.ratio : 0;
                        const totalDayVal = m.isManager ? getMgrTotalDH(m, thisWeekOffset, di) : dayVal;
                        if (isDHDayOff(m.id, thisWeekOffset, di)) {
                          return <td key={di} className="p-1 align-top"><OffBlock sub={isHoliday ? 'Holiday' : 'Time off'} /></td>;
                        }
                        const hoursOff = hoursOffOn(di, { weekIso, hoursOff: m.hoursOff });
                        const dayEntries = withDefaultUnavailable(withStandardPreferred(entriesOn(unavailability, m.id, thisWeekIsos[di]), m.id, m.name, thisWeekIsos[di], standardHoursOn(m, weekIso, di)), m.id, m.name, thisWeekIsos[di]);
                        const avail = showAvail ? dayEntries : [];
                        const unav = avail.some(e => e.kind === 'unavailable');
                        const working = dayVal > 0 || (!!m.isManager && totalDayVal > 0);
                        // With hours and output hidden, a working day's block would only say
                        // "Scheduled" — skip it unless something else in it is turned on.
                        const hideBlock = working && !view.hours && !view.output && !((!!m.isManager && view.mgrTotal) || view.actuals || avail.length > 0 || isHoliday || hoursOff > 0);
                        return (
                          <td key={di} className="group relative p-1 align-top">
                            {view.times && <ScheduledTimeBox entries={dayEntries} hours={m.isManager ? totalDayVal : dayVal} tone="resin" />}
                            {!hideBlock && (
                            <ShiftBlock tone={working ? 'resin' : isHoliday ? 'holiday' : unav ? 'unavailable' : avail.length ? 'preferred' : null} edited={isOverride && dayVal > 0}>
                              <InlineNumber
                                value={dayVal || ''}
                                step="0.5"
                                title={isHoliday
                                  ? (isOverride ? 'Paid holiday — worked hours, paid on top of guaranteed holiday pay' : 'Paid holiday — no production expected, staff still paid. Click to enter hours if someone worked.')
                                  : isOverride ? 'Changed for this day only — click to edit' : 'Following the standard weekly schedule — click to override just this day'}
                                onChange={raw => setDH(m.id, thisWeekOffset, di, raw)}
                                className="block w-full">
                                {dayVal > 0 ? (
                                  <>
                                    {view.hours && <span className="block text-xs font-semibold">{round2(dayVal)}h</span>}
                                    {view.output && <span className={`block ${view.hours ? 'opacity-70' : 'text-xs font-semibold'}`}>{round2(dayUnits)} units</span>}
                                  </>
                                ) : (
                                  <span className="block py-1">{isHoliday ? 'Holiday' : m.isManager && totalDayVal > 0 ? (view.hours ? 'No production' : '') : unav ? 'Unavailable' : 'Available'}</span>
                                )}
                              </InlineNumber>
                              {m.isManager && view.mgrTotal && (
                                <InlineNumber value={totalDayVal || ''} onChange={v => setMgrTotalDH(m.id, thisWeekOffset, di, v)} placeholder="total h"
                                  title="Total hours (production + managerial) — click to edit"
                                  className="mt-0.5 block text-[10px] font-medium text-violet-700">
                                  {totalDayVal > 0 ? `${round2(totalDayVal)}h total` : '+ total'}
                                </InlineNumber>
                              )}
                              {view.actuals && <ProductionActual value={actualFor(m.name, thisWeekDates[di])} loading={resinActuals.loading} unit="u"
                                drill={{ name: m.name, start: thisWeekDates[di], end: thisWeekDates[di], department: RESIN_MT_DEPARTMENT }} />}
                              <AvailabilityChips entries={avail} iso={thisWeekIsos[di]} scheduled={working} list={unavailability} onChange={setUnavailability} />
                              {isHoliday && <div className="text-[10px] text-amber-700">holiday pay</div>}
                              {hoursOff > 0 && <div className="text-[10px] font-semibold text-red-500" title="Hours off on the Days off calendar">{hoursOff}h off</div>}
                            </ShiftBlock>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2 text-center">
                        <div className="font-medium text-violet-700">{Math.round(units * 100) / 100} units</div>
                        <div className="text-slate-400 text-[10px]">{round2(weekTotalHrs)}h</div>
                        <ProductionActual
                          value={sumActuals(thisWeekDates.map(iso => actualFor(m.name, iso)))}
                          loading={resinActuals.loading}
                          unit="u"
                          drill={{ name: m.name, start: thisWeekDates[0], end: thisWeekDates[6], department: RESIN_MT_DEPARTMENT }}
                        />
                      </td>
                    </tr>
                  );
                  });
                })()}
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Planned total</td>
                  {[0,1,2,3,4,5,6].map(di => {
                    const dayTotal = roster.reduce((s, m) => s + getDH(m.id, thisWeekOffset, di), 0);
                    const dayUnits = roster.reduce((s, m) => s + (m.ratio > 0 ? getDH(m.id, thisWeekOffset, di) / m.ratio : 0), 0);
                    const dayCost  = roster.reduce((s, m) => s + dailyCost(m, thisWeekOffset, di), 0);
                    const isHoliday = isHolidayColumn(thisWeekOffset, di);
                    return (
                      <td key={di} className={`px-2 py-2 text-center text-xs text-purple-700 ${isHoliday ? 'bg-amber-50/50' : ''}`}>
                        {dayTotal > 0 ? <><div>{dayTotal.toFixed(1)}h</div><div className="text-[10px]">{dayUnits.toFixed(1)}u</div></> : <span className="text-slate-300">—</span>}
                        {isHoliday && dayCost > 0 && <div className="text-[9px] text-amber-600">${dayCost.toFixed(2)} paid</div>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-2 text-center text-xs text-purple-700">
                    {weeklyCapacity(thisWeekOffset) > 0 ? `${weeklyCapacity(thisWeekOffset).toFixed(0)}u` : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
                <tr className="border-t-2 border-sky-200 bg-sky-50/60 font-semibold">
                  <td className="sticky left-0 bg-sky-50 px-4 py-2 text-xs text-sky-800">
                    <div>Actual total</div>
                    <div className="text-[9px] font-normal text-sky-600">MT production</div>
                  </td>
                  {thisWeekDates.map(iso => (
                    <td key={iso} className="px-2 py-2 text-center">
                      <ProductionActual
                        value={sumActuals(productionRoster.map(m => actualFor(m.name, iso)))}
                        loading={resinActuals.loading}
                        unit="u"
                      />
                    </td>
                  ))}
                  <td className="px-2 py-2 text-center">
                    <ProductionActual
                      value={sumActuals(productionRoster.flatMap(m => thisWeekDates.map(iso => actualFor(m.name, iso))))}
                      loading={resinActuals.loading}
                      unit="u"
                    />
                  </td>
                </tr>
                {/* CPO — team labor cost ÷ planned units per day, moved out of Day
                    total; the week cell averages the days that have one. */}
                {hasRates && (() => {
                  const dayCPOs = [0,1,2,3,4,5,6].map(di => {
                    const dayUnits = roster.reduce((s, m) => s + (m.ratio > 0 ? getDH(m.id, thisWeekOffset, di) / m.ratio : 0), 0);
                    const dayCost  = roster.reduce((s, m) => s + dailyCost(m, thisWeekOffset, di), 0);
                    return dayUnits > 0 && dayCost > 0 ? dayCost / dayUnits : null;
                  });
                  const withCPO = dayCPOs.filter((c): c is number => c !== null);
                  const avgCPO = withCPO.length > 0 ? withCPO.reduce((s, c) => s + c, 0) / withCPO.length : null;
                  return (
                    <tr className="border-t border-slate-200 bg-white">
                      <td className="sticky left-0 bg-white px-4 py-2 text-xs font-semibold text-slate-600">
                        <div>CPO</div>
                        <div className="text-[9px] font-normal text-slate-400">planned</div>
                      </td>
                      {dayCPOs.map((c, di) => (
                        <td key={di} className={`px-2 py-2 text-center ${isHolidayColumn(thisWeekOffset, di) ? 'bg-amber-50/50' : ''}`}>
                          {c !== null ? <div className="font-semibold text-amber-700">${c.toFixed(2)}</div> : <div className="text-slate-300">—</div>}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {avgCPO !== null ? <div className="font-semibold text-amber-700">${avgCPO.toFixed(2)}</div> : <div className="text-slate-300">—</div>}
                        <div className="text-[10px] text-slate-400">day avg</div>
                      </td>
                    </tr>
                  );
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 52-WEEK PLANNER TAB ─────────────────────────────────────────────── */}
      {activeTab === 'schedule' && (
        <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-wrap gap-2">
            <div className="flex items-center gap-4">
              <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="sched.hoursPerMember">Hours per team member per week</HelpTip></h3>
              {hasRates && (
                <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                  <input type="checkbox" checked={showCPO} onChange={e => setShowCPO(e.target.checked)} className="rounded" />
                  Show CPO
                </label>
              )}
            </div>
            <div className="flex items-center gap-2">
              <InputModeToggle mode={resinInputMode} onChange={setResinInputMode} unitLabel="Orders" />
              <button
                onClick={() => setWeekOffset(Math.max(0, weekOffset - WINDOW))}
                disabled={weekOffset === 0}
                className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30"
              >← Prev</button>
              <span className="text-xs text-slate-400">
                {getWeekLabel(weekOffset)} – {getWeekLabel(weekOffset + WINDOW - 1)}
              </span>
              <button
                onClick={() => setWeekOffset(Math.min(WEEKS - WINDOW, weekOffset + WINDOW))}
                disabled={weekOffset + WINDOW >= WEEKS}
                className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30"
              >Next →</button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[160px]">
                    Team Member
                  </th>
                  {windowWeeks.map(w => (
                    <th key={w} className="px-1 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[110px]">
                      <WeekHead label={getWeekLabel(w)} now={w === 0} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {productionRoster.map((m, mi) => (
                  <tr key={m.id} className={`border-b border-slate-50 ${mi % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                    <td className="sticky left-0 z-10 bg-white px-4 py-2 whitespace-nowrap">
                      <PersonCell name={m.name}>
                        <MemberTierBadges name={m.name} location="Utah" dept="Resin" fallbackRole={m.role} fallbackIsManager={m.isManager} />
                      </PersonCell>
                    </td>
                    {windowWeeks.map(w => {
                      const h    = memberWeekHours(w, m);
                      const units = m.ratio > 0 ? h / m.ratio : 0;
                      const { cpo }  = weekMemberStats(w, m);
                      const totalH = m.isManager ? resolveMgrTotalWeekHours(w, m, h) : h;
                      return (
                        <td key={w} className="p-1 align-top">
                          <WeekCell tone="resin" mode={resinInputMode} hours={h} output={units} outputUnit="units"
                            totalHours={m.isManager ? totalH : undefined}
                            cpo={showCPO && cpo !== null ? `$${cpo.toFixed(2)}` : null} />
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Totals row */}
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600">Week total</td>
                  {windowWeeks.map(w => {
                    const cap = weeklyCapacity(w);
                    const { totalCPO } = weekTotals(w);
                    return (
                      <td key={w} className="px-3 py-2 text-center text-xs text-purple-700">
                        {cap > 0 ? `${cap.toFixed(0)}u` : <span className="text-slate-300">—</span>}
                        {showCPO && totalCPO !== null && <div className="text-[10px]">${totalCPO.toFixed(2)}</div>}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── QUEUE & TURNAROUND TAB ────────────────────────────────────────────── */}
      {activeTab === 'queue' && (
        <div className="space-y-4">

          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-100 rounded-xl p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Resin Queue</p>
              <p className="text-xl font-semibold text-purple-700">
                {queueLoading ? '…' : (queueSummary?.totalUnits ?? 0).toLocaleString()}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">unfulfilled resin units</p>
            </div>

            <div className="bg-white border border-slate-100 rounded-xl p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Avg capacity</p>
              <p className="text-xl font-semibold text-slate-700">
                {avgWeeklyCapacity.toFixed(0)}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">units/week (next 8 wks)</p>
            </div>

            <div className="bg-white border border-slate-100 rounded-xl p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400 mb-1">Utah origin</p>
              <p className="text-xl font-semibold text-slate-700">
                {queueLoading ? '…' : (queueSummary?.utahOrigin ?? 0).toLocaleString()}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">started in Utah</p>
            </div>

            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-amber-500 mb-1">Georgia origin</p>
              <p className="text-xl font-semibold text-amber-700">
                {queueLoading ? '…' : (queueSummary?.georgiaOrigin ?? 0).toLocaleString()}
              </p>
              <p className="text-xs text-amber-500 mt-0.5">need to transfer to Utah</p>
            </div>
          </div>

          {/* Hiring plan */}
          <div className="bg-white border border-slate-100 rounded-xl p-5">
            <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
              <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="sched.hiring">Hiring plan — hypothetical new hires</HelpTip></h3>
            </div>
            <p className="text-xs text-slate-400 mb-3">
              Hours/wk a hypothetical new hire starting that week would average (at {RESIN_NEW_HIRE_RATIO} hrs/unit). Affects the
              Planned rows below for that intake week and for every cohort already waiting in the queue — a hire made now can pull
              in turnaround for orders already on the shelf, not just future ones.
            </p>
            <div className="overflow-x-auto -mx-1 pb-1">
              <div className="flex gap-1.5" style={{ width: 'max-content' }}>
                {Array.from({ length: WEEKS }, (_, w) => w).map(w => {
                  const weekIso = isoMonday(w);
                  const hireCum = hireHoursByWeek[w];
                  return (
                    <div key={w} className={`flex flex-col items-center gap-0.5 px-1 py-1 rounded ${w === 0 ? 'bg-indigo-50/60' : ''}`}>
                      <span className="text-[9px] text-slate-400 whitespace-nowrap">{getWeekLabel(w)}</span>
                      <input
                        type="number" step="1" placeholder="0"
                        value={newHireHours[weekIso] ?? ''}
                        onChange={e => setNewHireHours(weekIso, parseFloat(e.target.value) || 0)}
                        className="w-12 border border-slate-200 rounded px-1 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
                        title={`Hours/wk a hypothetical new hire starting ${mondayOf(weekIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} would average (negative to remove hours)`}
                      />
                      {hireCum !== 0 && (
                        <span className={`text-[9px] whitespace-nowrap ${hireCum > 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                          {hireCum > 0 ? '+' : ''}{Math.round(hireCum)}h
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Turnaround bars */}
          <div className="bg-white border border-slate-100 rounded-xl p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
              <h3 className="text-sm font-semibold text-slate-700">
                <HelpTip id="resin.turnaround">Turnaround — by event-date intake week</HelpTip>
              </h3>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 shrink-0">
                Currently designing as of
                <input
                  type="date"
                  value={queueFrontWeek ?? ''}
                  onChange={e => setQueueFrontWeek(e.target.value ? mondayOf(e.target.value).toISOString().split('T')[0] : null)}
                  title="Any date within the current intake week works — it's rounded to that week's Monday. Cohorts before that week are treated as stuck stragglers and excluded from the turnaround math below, not the real backlog"
                  className="border border-slate-200 rounded px-2 py-1 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
                />
              </label>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Based on {activeCohorts.reduce((s, c) => s + c.units, 0).toLocaleString()} active units in queue
              · per-week scheduled capacity from the 52-week planner · FIFO sort.
              Intake week = event date + {queueSummary?.offsetDays ?? 4} days (falls back to order date when an order has no event-date tag).
              Weeks marked <span className="bg-slate-100 text-slate-500 rounded px-1 py-px">est.</span> have no real order yet — projected at the recent average intake pace out to a 52-week horizon.
              {!queueFrontWeek && queueSummary?.oldestEventDate && (
                <> Oldest still-open order has an event date of <strong>{new Date(queueSummary.oldestEventDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</strong> — set &quot;Currently designing as of&quot; above once you know the real front, so stuck stragglers like that one stop anchoring the math.</>
              )}
            </p>

            {cohortRows.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">
                No queue data yet — click &quot;Sync Queue&quot; to pull from Shopify
              </p>
            ) : (
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100 sticky top-0">
                      <th className="px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap">Intake week</th>
                      <th className="px-3 py-2 text-right font-medium text-slate-500">Orders received</th>
                      <th className="px-3 py-2 text-right font-medium text-slate-500">Status</th>
                      <th className="px-3 py-2 text-left font-medium text-slate-500 min-w-[160px]">Weeks until made</th>
                      <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap"
                        title="Full turnaround, arrival to completion — weeks already elapsed since this intake week plus weeks still left">
                        Total turnaround
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohortRows.map(row => {
                      const wks = row.weeksToComplete;
                      const wksPlanned = row.weeksToCompletePlanned;
                      const totalTurnaround = wks !== null ? row.weeksElapsed + wks : null;
                      const totalPlanned = wksPlanned !== null ? row.weeksElapsed + wksPlanned : null;
                      const tone = (n: number) => n <= 6 ? 'emerald' : n <= 12 ? 'yellow' : 'red';
                      const bar = (label: string, labelClass: string, n: number) => (
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] w-14 shrink-0 ${labelClass}`}>{label}</span>
                          {n === 0 ? (
                            <span className="text-xs font-semibold text-indigo-700">this week</span>
                          ) : (
                            <>
                              <div className="flex-1 bg-slate-100 rounded-full h-1.5 max-w-24">
                                <div className={`h-1.5 rounded-full ${tone(n) === 'emerald' ? 'bg-emerald-400' : tone(n) === 'yellow' ? 'bg-yellow-400' : 'bg-red-400'}`}
                                  style={{ width: `${Math.min(100, (n / 24) * 100)}%` }} />
                              </div>
                              <span className={`text-[10px] font-medium whitespace-nowrap ${tone(n) === 'emerald' ? 'text-emerald-700' : tone(n) === 'yellow' ? 'text-yellow-700' : 'text-red-700'}`}>
                                ~{n} wk{n !== 1 ? 's' : ''}
                              </span>
                            </>
                          )}
                        </div>
                      );
                      const showPlanned = wksPlanned !== wks;
                      return (
                        <tr key={row.weekOf} className={`border-b border-slate-50 ${wks === 0 ? 'bg-indigo-50/40' : row.estimated ? 'bg-slate-50/40' : 'hover:bg-slate-50'}`}>
                          <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                            {row.weekLabel}
                            {row.estimated && <span className="ml-2 text-[10px] bg-slate-100 text-slate-400 rounded px-1 py-px" title="No real order yet for this week — projected at the recent average intake pace">est.</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-600">{row.units}</td>
                          <td className="px-3 py-2 text-right">
                            {wks === 0 ? (
                              <span className="text-indigo-700 text-[10px] bg-indigo-100 rounded px-1.5 py-0.5">making now</span>
                            ) : (
                              <span className="text-slate-500 text-[10px]">in queue</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="space-y-1">
                              {wks === null ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-slate-400 w-14 shrink-0">Scheduled</span>
                                  <span className="text-xs text-red-400 italic">not cleared in {WEEKS * 2} wks</span>
                                </div>
                              ) : bar('Scheduled', 'text-slate-400', wks)}
                              {showPlanned && (wksPlanned === null ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-emerald-600 w-14 shrink-0">Planned</span>
                                  <span className="text-xs text-red-400 italic">not cleared in {WEEKS * 2} wks</span>
                                </div>
                              ) : bar('Planned', 'text-emerald-600', wksPlanned))}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <div className="space-y-0.5">
                              {totalTurnaround !== null ? (
                                <div className={`text-xs font-semibold ${totalTurnaround <= 6 ? 'text-emerald-700' : totalTurnaround <= 12 ? 'text-yellow-700' : 'text-red-700'}`}>
                                  ~{totalTurnaround} wks
                                </div>
                              ) : (
                                <div className="text-xs text-slate-400">TBD</div>
                              )}
                              {showPlanned && (
                                <div className="text-[10px] text-emerald-600 whitespace-nowrap">
                                  Planned: {totalPlanned !== null ? `~${totalPlanned} wks` : 'TBD'}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {stragglerCohorts.length > 0 && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-xs font-medium text-slate-500 mb-2">
                  {stragglerCohorts.reduce((s, c) => s + c.units, 0)} units in {stragglerCohorts.length} cohort{stragglerCohorts.length === 1 ? '' : 's'} predate &quot;currently designing as of&quot; — treated as already completed in resin, excluded from the turnaround math above. Still shown in the queue table below in case one needs a second look.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {stragglerCohorts.map(c => (
                    <span key={c.weekOf} className="text-[10px] bg-slate-50 border border-slate-200 text-slate-500 rounded px-1.5 py-0.5">
                      {mondayOf(c.weekOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: {c.units}u
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Full queue table */}
          <ResinQueueTable queueFrontWeek={queueFrontWeek} />
        </div>
      )}

      {/* ── HISTORICALS TAB ───────────────────────────────────────────────────── */}
      {activeTab === 'historicals' && (
        <HistoricalsSection
          department="resin"
          location="Utah"
          members={productionRoster.map(m => ({
            id: m.id, name: m.name, payType: m.payType, hourlyRate: m.hourlyRate, annualSalary: m.annualSalary, isManager: m.isManager,
          }))}
          ordersLabel="pieces"
          onRatioUpdate={(id, ratio) => updateRosterField(id, 'ratio', ratio)}
          canSeeManagerCPO={canSeeManagerCPO}
        />
      )}
    </div>
  );
}

// ─── Queue table sub-component ─────────────────────────────────────────────────

function ResinQueueTable({ queueFrontWeek }: { queueFrontWeek: string | null }) {
  const [orders, setOrders] = useState<ResinQueueRow[]>([]);
  const [total, setTotal]   = useState(0);
  const [page, setPage]     = useState(1);
  const [loading, setLoading] = useState(true);

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const params = queueFrontWeek ? `&frontWeek=${queueFrontWeek}` : '';
      const res = await fetch(`/api/resin/queue?page=${p}&pageSize=50${params}`);
      const d   = await res.json();
      setOrders(d.orders ?? []);
      setTotal(d.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [queueFrontWeek]);

  useEffect(() => { setPage(1); fetchPage(1); }, [fetchPage]);

  if (loading) return (
    <div className="bg-white border border-slate-100 rounded-xl p-8 text-center">
      <div className="w-4 h-4 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin mx-auto" />
    </div>
  );

  if (orders.length === 0) return (
    <div className="bg-white border border-slate-100 rounded-xl p-8 text-center text-sm text-slate-400">
      No resin orders in queue. Sync the queue to pull from Shopify.
    </div>
  );

  const totalPages = Math.ceil(total / 50);

  return (
    <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="resin.queue">Queue — all {total.toLocaleString()} units</HelpTip></h3>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <button onClick={() => { setPage(p => Math.max(1, p - 1)); fetchPage(Math.max(1, page - 1)); }}
            disabled={page === 1} className="disabled:opacity-30 hover:text-slate-600">← Prev</button>
          <span>p.{page}/{totalPages}</span>
          <button onClick={() => { setPage(p => Math.min(totalPages, p + 1)); fetchPage(Math.min(totalPages, page + 1)); }}
            disabled={page === totalPages} className="disabled:opacity-30 hover:text-slate-600">Next →</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="px-4 py-2 text-left font-medium text-slate-500">Order #</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Product</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500" title="Recreate from photo = no physical delivery to wait on. Send own = customer is mailing something in, still waits like a normal order.">Source</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">PF Status</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Origin</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500" title="Event date + 4 days — what actually drives this order's intake week/cohort. Falls back to order date only when there's no event-date tag.">Intake date</th>
              <th className="px-3 py-2 text-center font-medium text-slate-500">Qty</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500" title="Read-only — reflects whatever your team sets directly in Shopify, never written by the dashboard">Transfer status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o, i) => (
              <tr key={o.line_item_id} className={`border-b border-slate-50 ${i % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                <td className="px-4 py-1.5 font-medium text-slate-700">#{o.shopify_order_number}</td>
                <td className="px-3 py-1.5 text-slate-600">
                  {o.line_item_title}
                  {o.variant_title && <span className="text-slate-400"> · {o.variant_title}</span>}
                </td>
                <td className="px-3 py-1.5">
                  {o.blooms_process_type === 'recreate' ? (
                    <span className="text-[10px] text-sky-700 bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5 whitespace-nowrap"
                      title="Customer supplied a photo — no physical delivery to wait on">
                      Recreate from photo
                    </span>
                  ) : o.blooms_process_type === 'send_own' ? (
                    <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 whitespace-nowrap"
                      title="Customer is mailing something in — still waits on a physical delivery like a normal order">
                      Send own{o.event_date ? ` — event ${o.event_date}` : ''}
                    </span>
                  ) : o.event_date ? (
                    <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 whitespace-nowrap"
                      title="No Blooms Process add-on, but this order has an event-date tag — real wedding flowers are expected, same wait as a Blooms Process 'send own' item">
                      Real flowers — event {o.event_date}
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-300">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  <span className="bg-purple-50 text-purple-700 rounded px-1.5 py-0.5 text-[10px]">
                    {o.pf_status ?? '—'}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  {o.origin_location === 'Georgia'
                    ? <span className="text-amber-600 font-medium">Georgia</span>
                    : <span className="text-slate-500">{o.origin_location ?? '—'}</span>
                  }
                </td>
                <td className="px-3 py-1.5 text-slate-500">
                  {o.event_date ? (
                    <div title={`Event date tag: ${o.event_date}${o.order_date ? ` · order date: ${o.order_date}` : ''}`}>
                      {addDays(o.event_date, EVENT_TO_INTAKE_OFFSET_DAYS)}
                      <span className="text-[10px] text-slate-300"> (event {o.event_date})</span>
                    </div>
                  ) : (o.order_date ?? '—')}
                </td>
                <td className="px-3 py-1.5 text-center text-slate-600">{o.quantity}</td>
                <td className="px-3 py-1.5">
                  {o.transferred_to_utah_at ? (
                    <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 whitespace-nowrap"
                      title="Fulfillment location manually moved to Utah in Shopify — detected on a later sync. The dashboard never makes this change itself.">
                      Transferred to UT on {new Date(o.transferred_to_utah_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  ) : o.origin_location === 'Georgia' ? (
                    <span className="text-[10px] text-slate-300">still in Georgia</span>
                  ) : (
                    <span className="text-[10px] text-slate-300">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Local type for queue rows ─────────────────────────────────────────────────

interface ResinQueueRow {
  line_item_id:        string;
  shopify_order_id:    string;
  shopify_order_number: string;
  line_item_title:     string;
  variant_title:       string | null;
  pf_status:           string | null;
  origin_location:     string | null;
  order_date:          string | null;
  event_date:          string | null;
  quantity:            number;
  transferred_to_utah_at: string | null;
  // 'recreate' = customer supplied a photo, no delivery to wait on.
  // 'send_own' = customer is mailing something in, still waits like normal.
  // null = no Blooms Process item on this order.
  blooms_process_type: 'recreate' | 'send_own' | null;
}

// 3-6 day event-to-intake lag, matching the offset baked into resin_queue's
// cohorting on the server (EVENT_TO_INTAKE_OFFSET_DAYS in the API route).
const EVENT_TO_INTAKE_OFFSET_DAYS = 4;

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

