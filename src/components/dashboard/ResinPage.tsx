'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useScheduleSettings } from './useScheduleSettings';
import { getMondayDate, isoMonday, getWeekLabel } from '@/lib/weekDates';
import { InputModeToggle, round2, hoursFromOutput, type InputMode } from './InputModeToggle';
import { resolveDayHours, resolveWeekHours, baseDailyArray, WEEKDAY_LABELS, type DailyHoursMap } from '@/lib/scheduleResolution';
import { HistoricalsSection } from './HistoricalsSection';
import { EmployeeAutocomplete, type RipplingEmployee } from './EmployeeAutocomplete';
import { EmploymentDatesEditor } from './EmploymentDatesEditor';

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
  // Employment window, both ISO 'YYYY-MM-DD' and inclusive — see scheduleResolution.ts.
  startDate?: string;
  endDate?:   string;
}

interface CohortRow {
  weekOf:       string;   // ISO date — Monday of intake week
  weekLabel:    string;
  units:        number;   // resin units that entered queue this week
  weeksToComplete: number | null;
}

interface QueueSummary {
  totalUnits:    number;
  utahOrigin:    number;
  georgiaOrigin: number;
  unknownOrigin: number;
  cohorts:       { weekOf: string; units: number }[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const WEEKS = 52;
const WINDOW = 8;  // weeks visible in the schedule grid at once

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

  const resinDailyHours: DailyHoursMap = settings.resinDailyHours ?? {};

  function setResinDailyHours(h: DailyHoursMap) { update('resinDailyHours', h); }

    const roster: ResinMember[] = Array.isArray(settings.resinRoster)
    ? (settings.resinRoster as unknown as ResinMember[])
    : DEFAULT_RESIN_ROSTER;

  // Date-keyed: isoMonday -> { memberId -> hours }
  const hours: Record<string, Record<string, number>> = settings.resinHours ?? {};

  // Manager production-vs-total hours — shared keys with design/preservation/
  // fulfillment (member ids don't collide across departments), same pattern
  // used there: production hours drive units/ratio, total hours drive cost.
  const mgrTotalHours: Record<string, Record<string, number>> = settings.mgrTotalHours ?? {};
  const mgrTotalDailyHours: DailyHoursMap = settings.mgrTotalDailyHours ?? {};

  function setRoster(r: ResinMember[]) { update('resinRoster', r as unknown); }
  function setMgrTotalDailyHours(h: DailyHoursMap) { update('mgrTotalDailyHours', h); }
  // No longer written going forward (daily entries/template supersede it),
  // but a "reset to template" action still needs to be able to clear any
  // legacy value left over from before the daily-hours linkage existed —
  // otherwise it would keep outranking the template in resolveWeekHours.
  function setHours(h: Record<string, Record<string, number>>) { update('resinHours', h); }

  return {
    roster, setRoster, hours, setHours, resinDailyHours, setResinDailyHours,
    mgrTotalHours, mgrTotalDailyHours, setMgrTotalDailyHours,
    loading, saveState,
  };
}

// ─── Main component ────────────────────────────────────────────────────────────

interface ResinPageProps {
  resinQueue?: number;  // live count from dashboard (if wired up)
  canViewCPO?: boolean;
}

export default function ResinPage({ resinQueue, canViewCPO = true }: ResinPageProps) {
  const [activeTab, setActiveTab] = useState<'thisweek' | 'schedule' | 'queue' | 'historicals'>('thisweek');
  const [thisWeekOffset, setThisWeekOffset] = useState(0);
  const [weekOffset, setWeekOffset] = useState(0);
  const [showCPO, setShowCPO] = useState(false);
  const [resinInputMode, setResinInputMode] = useState<InputMode>('hours');
  const [queueSummary, setQueueSummary] = useState<QueueSummary | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveResult, setMoveResult] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const {
    roster, setRoster, hours, setHours, resinDailyHours, setResinDailyHours,
    mgrTotalHours, mgrTotalDailyHours, setMgrTotalDailyHours,
    loading, saveState,
  } = useResinSettings();

  // Fetch queue summary
  useEffect(() => {
    fetch('/api/resin/queue?summary=true')
      .then(r => r.json())
      .then(d => setQueueSummary(d))
      .catch(() => {})
      .finally(() => setQueueLoading(false));
  }, []);

  // ── Derived: weekly capacity ───────────────────────────────────────────────
  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => weekOffset + i);

  function memberWeekHours(weekIdx: number, m: ResinMember): number {
    const weekIso = isoMonday(weekIdx);
    return resolveWeekHours({
      dailyMap: resinDailyHours, weekKey: `${weekIso}-${m.id}`,
      legacyWeeklyValue: hours[weekIso]?.[m.id],
      standardWeeklyHours: m.standardWeeklyHours,
      employment: { weekIso, startDate: m.startDate, endDate: m.endDate },
    });
  }

  function weeklyCapacity(weekIdx: number): number {
    return roster.reduce((sum, m) => sum + (m.ratio > 0 ? memberWeekHours(weekIdx, m) / m.ratio : 0), 0);
  }

  // Same idea as Design's resolveMgrTotalWeekHours: a day's fallback is that
  // day's already-resolved PRODUCTION hours, not a flat template.
  function resolveMgrTotalWeekHours(weekIdx: number, m: ResinMember, productionHrs: number): number {
    const weekIso = isoMonday(weekIdx);
    const weekKey = `${weekIso}-${m.id}`;
    const dailyOverrides = mgrTotalDailyHours[weekKey];
    if (dailyOverrides !== undefined) {
      let sum = 0;
      for (let day = 0; day < 7; day++) {
        const override = dailyOverrides[day];
        sum += override != null ? override : resolveDayHours(resinDailyHours, weekKey, day, m.standardWeeklyHours,
          { weekIso, startDate: m.startDate, endDate: m.endDate }).hours;
      }
      return sum;
    }
    return mgrTotalHours[m.id]?.[weekIso] ?? productionHrs;
  }

  // Production hours drive units/ratio; managers' total hours (production +
  // managerial) drive cost instead, and managers are excluded from CPO since
  // their per-unit number isn't meaningful. Mirrors Design's weekStats.
  function weekMemberStats(weekIdx: number, m: ResinMember) {
    const hrs      = memberWeekHours(weekIdx, m);
    const units    = m.ratio > 0 ? hrs / m.ratio : 0;
    const totalHrs = m.isManager ? resolveMgrTotalWeekHours(weekIdx, m, hrs) : hrs;
    const cost     = m.payType === 'salary' ? m.annualSalary / 52 : totalHrs * m.hourlyRate;
    const cpo      = !m.isManager && units > 0 && cost > 0 ? cost / units : null;
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

  // ── Derived: turnaround simulation ────────────────────────────────────────
  const cohortRows: CohortRow[] = (() => {
    if (!queueSummary) return [];

    const now = getMondayDate(0);
    let queueRemaining = queueSummary.totalUnits;
    const cap = avgWeeklyCapacity > 0 ? avgWeeklyCapacity : 1;

    return queueSummary.cohorts.map(({ weekOf, units }) => {
      const cohortMonday = mondayOf(weekOf);
      const weeksBehindNow = Math.round(
        (now.getTime() - cohortMonday.getTime()) / (7 * 24 * 60 * 60 * 1000)
      );

      // How many weeks from now until this cohort is reached?
      // FIFO: weeks to reach = queueRemaining / capacity (at start of this cohort's turn)
      const weeksFromNow = queueRemaining > 0 ? Math.ceil(queueRemaining / cap) : 0;
      const weeksToComplete = weeksBehindNow + weeksFromNow;

      // After this cohort is "used up", reduce the queue
      queueRemaining = Math.max(0, queueRemaining - units);

      return {
        weekOf,
        weekLabel: cohortMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        units,
        weeksToComplete: weeksToComplete > 0 ? weeksToComplete : null,
      };
    });
  })();

  // ── Handlers ──────────────────────────────────────────────────────────────

  function getDH(memberId: string, weekIdx: number, di: number): number {
    const m = roster.find(m => m.id === memberId);
    const weekIso = isoMonday(weekIdx);
    return resolveDayHours(resinDailyHours, `${weekIso}-${memberId}`, di, m?.standardWeeklyHours,
      { weekIso, startDate: m?.startDate, endDate: m?.endDate }).hours;
  }

  function isDHOverride(memberId: string, weekIdx: number, di: number): boolean {
    const m = roster.find(m => m.id === memberId);
    const weekIso = isoMonday(weekIdx);
    return resolveDayHours(resinDailyHours, `${weekIso}-${memberId}`, di, m?.standardWeeklyHours,
      { weekIso, startDate: m?.startDate, endDate: m?.endDate }).isOverride;
  }

  function setDH(memberId: string, weekIdx: number, di: number, val: number) {
    const weekIso = isoMonday(weekIdx);
    const key = `${weekIso}-${memberId}`;
    const padded = [...baseDailyArray(resinDailyHours, key, hours[weekIso]?.[memberId], isoMonday(0))];
    padded[di] = val;
    setResinDailyHours({ ...resinDailyHours, [key]: padded });
  }

  function getMgrTotalDH(memberId: string, weekIdx: number, di: number): number {
    const override = mgrTotalDailyHours[`${isoMonday(weekIdx)}-${memberId}`]?.[di];
    return override != null ? override : getDH(memberId, weekIdx, di);
  }

  function setMgrTotalDH(memberId: string, weekIdx: number, di: number, val: number) {
    const key = `${isoMonday(weekIdx)}-${memberId}`;
    const prev = mgrTotalDailyHours[key] ?? [null, null, null, null, null, null, null];
    const padded = Array.from({ length: 7 }, (_, j) => prev[j] ?? null);
    padded[di] = val;
    setMgrTotalDailyHours({ ...mgrTotalDailyHours, [key]: padded });
  }

  function dailyCost(m: ResinMember, weekIdx: number, di: number): number {
    const h = m.isManager ? getMgrTotalDH(m.id, weekIdx, di) : getDH(m.id, weekIdx, di);
    return m.payType === 'salary' ? m.annualSalary / 260 : h * m.hourlyRate;
  }

  function updateRosterField(id: string, field: keyof ResinMember, val: string | number | boolean) {
    setRoster(roster.map(m => m.id === id ? { ...m, [field]: val } : m));
  }

  function updateTemplate(id: string, dayIdx: number, value: number) {
    setRoster(roster.map(m => {
      if (m.id !== id) return m;
      const prevTemplate = m.standardWeeklyHours ?? [0, 0, 0, 0, 0, 0, 0];
      return { ...m, standardWeeklyHours: prevTemplate.map((h, j) => j === dayIdx ? value : h) };
    }));
  }
  // Clears every frozen day/week override for this member from the current
  // week forward (past weeks untouched) so they fall back to the template.
  function resetMemberToTemplate(id: string) {
    if (!window.confirm('Clear this person’s scheduled hours from this week forward and go back to following their standard schedule? Past weeks are not affected.')) return;
    const newDaily = { ...resinDailyHours };
    let changedDaily = false;
    // `hours` is date-keyed (isoMonday -> { memberId -> hours }), the inverse
    // shape of the other three departments' legacy weekly maps.
    const newWeekly = { ...hours };
    let changedWeekly = false;
    for (let w = 0; w < WEEKS; w++) {
      const weekIso = isoMonday(w);
      const dailyKey = `${weekIso}-${id}`;
      if (newDaily[dailyKey]) { delete newDaily[dailyKey]; changedDaily = true; }
      if (newWeekly[weekIso]?.[id] !== undefined) {
        newWeekly[weekIso] = { ...newWeekly[weekIso] };
        delete newWeekly[weekIso][id];
        changedWeekly = true;
      }
    }
    if (changedDaily) setResinDailyHours(newDaily);
    if (changedWeekly) setHours(newWeekly);
  }

  function addMember() {
    const id = `resin-${Date.now()}`;
    setRoster([...roster, { id, name: 'Team Member', ratio: 1.5, payType: 'hourly', hourlyRate: 0, annualSalary: 0 }]);
  }

  function removeMember(id: string) {
    setRoster(roster.filter(m => m.id !== id));
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
      setSyncResult(`Synced ${d.synced ?? 0} resin items (${d.skipped ?? 0} skipped — not yet bouquetReceived)`);
      // Refresh summary
      const s = await fetch('/api/resin/queue?summary=true').then(r => r.json());
      setQueueSummary(s);
    } catch (e) {
      setSyncResult('Sync failed — check console');
    } finally {
      setSyncLoading(false);
    }
  }

  async function moveGeorgiaToUtah(dryRun = false) {
    setMoveLoading(true);
    setMoveResult(null);
    try {
      const res = await fetch(
        `/api/admin/sync-resin-locations${dryRun ? '?dryRun=true' : ''}`,
        { method: 'POST' }
      );
      const d = await res.json();
      setMoveResult(
        dryRun
          ? `Dry run: ${d.moved ?? 0} orders would be moved, ${d.cannotMove ?? 0} cannot be moved, ${d.alreadyUtah ?? 0} already Utah`
          : `Moved ${d.moved ?? 0} orders to Utah, ${d.cannotMove ?? 0} cannot be moved (already fulfilled)`
      );
    } catch {
      setMoveResult('Move failed — check console');
    } finally {
      setMoveLoading(false);
    }
  }

  const hasRates = canViewCPO && roster.some(m => m.hourlyRate > 0 || m.annualSalary > 0);

  const TABS = [
    { id: 'thisweek'    as const, label: 'This week' },
    { id: 'schedule'    as const, label: '52-week planner' },
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
          <h2 className="text-sm font-semibold text-slate-700">Resin Scheduling</h2>
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

      {/* ── Georgia transfer section ───────────────────────────────────────────── */}
      {(queueSummary?.georgiaOrigin ?? 0) > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">
              {queueSummary!.georgiaOrigin} resin orders originated in Georgia
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              All resin orders are completed in Utah. Use the button to bulk-move Georgia orders
              to the Utah fulfillment location in Shopify.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => moveGeorgiaToUtah(true)}
              disabled={moveLoading}
              className="text-xs border border-amber-300 bg-white text-amber-700 rounded px-3 py-1.5 hover:bg-amber-50 disabled:opacity-50"
            >
              Dry Run
            </button>
            <button
              onClick={() => moveGeorgiaToUtah(false)}
              disabled={moveLoading}
              className="text-xs bg-amber-600 text-white rounded px-3 py-1.5 hover:bg-amber-700 disabled:opacity-50"
            >
              {moveLoading ? 'Moving…' : 'Move to Utah'}
            </button>
          </div>
          {moveResult && (
            <p className="w-full text-xs text-amber-700 mt-1">{moveResult}</p>
          )}
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
            <div className="grid grid-cols-[1fr_80px_90px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
              <span>Name</span>
              <span className="text-center">Role</span>
              <span className="text-center">Ratio</span>
              <span />
            </div>
            <div className="space-y-3">
              {roster.map(m => (
                <div key={m.id} className="space-y-1.5">
                <div className="grid grid-cols-[1fr_80px_90px_20px] gap-2 items-center">
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
                    {m.isManager && (
                      <span className="shrink-0 text-[9px] font-medium text-violet-600 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5">Manager</span>
                    )}
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
                  {roster.length > 1 ? (
                    <button onClick={() => removeMember(m.id)} className="text-slate-300 hover:text-red-400 transition-colors text-xl leading-none text-center">×</button>
                  ) : <span />}
                </div>
                <div className="flex items-center gap-1.5 pl-1">
                  <span className="text-[10px] text-slate-400 w-32 shrink-0">
                    Standard schedule{!m.standardWeeklyHours && <span className="text-amber-500"> — not set</span>}
                  </span>
                  {WEEKDAY_LABELS.map((label, di) => (
                    <label key={di} className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] text-slate-300">{label[0]}</span>
                      <input type="number" min="0" step="0.5" placeholder="0"
                        value={m.standardWeeklyHours?.[di] || ''}
                        onChange={e => updateTemplate(m.id, di, parseFloat(e.target.value) || 0)}
                        title={`${label} standard hours`}
                        className="w-10 border border-slate-200 rounded px-1 py-0.5 text-center text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                    </label>
                  ))}
                  <button onClick={() => resetMemberToTemplate(m.id)}
                    title="Clear scheduled hours from this week forward and go back to following this template"
                    className="text-[10px] text-slate-400 hover:text-indigo-600 whitespace-nowrap ml-1">
                    ↺ Reset to template
                  </button>
                </div>
                <div className="flex items-center gap-1.5 pl-1">
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
            <button onClick={addMember}
              className="mt-3 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">
              + Add member
            </button>
            <p className="mt-3 text-xs text-slate-400">Pay rates &amp; titles come from Rippling upload. Ratio = hours per unit.</p>
          </div>
        )}
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────────── */}
      <div className="border-b border-slate-100">
        <div className="flex gap-0">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                activeTab === id
                  ? 'border-purple-600 text-purple-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── THIS WEEK TAB ────────────────────────────────────────────────────── */}
      {activeTab === 'thisweek' && (
        <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-700">
              Hours — {thisWeekOffset === 0 ? 'this week' : thisWeekOffset === 1 ? 'next week' : `week +${thisWeekOffset}`}
            </h3>
            <div className="flex items-center gap-2">
              {hasRates && <span className="text-xs text-slate-400 mr-2">CPO shown when rate is set</span>}
              <InputModeToggle mode={resinInputMode} onChange={setResinInputMode} unitLabel="Orders" />
              <button onClick={() => setThisWeekOffset(Math.max(0, thisWeekOffset - 1))} disabled={thisWeekOffset === 0}
                className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
              <button onClick={() => setThisWeekOffset(Math.min(WEEKS - 1, thisWeekOffset + 1))} disabled={thisWeekOffset >= WEEKS - 1}
                className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[160px]">Team Member</th>
                  {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d => (
                    <th key={d} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[70px]">{d}</th>
                  ))}
                  <th className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap">Week total</th>
                </tr>
              </thead>
              <tbody>
                {roster.map((m, mi) => {
                  const weekTotal = [0,1,2,3,4,5,6].reduce((s, di) => s + getDH(m.id, thisWeekOffset, di), 0);
                  const units = m.ratio > 0 ? weekTotal / m.ratio : 0;
                  const weekCost = [0,1,2,3,4,5,6].reduce((s, di) => s + dailyCost(m, thisWeekOffset, di), 0);
                  const weekCPO = !m.isManager && units > 0 && weekCost > 0 ? weekCost / units : null;
                  return (
                    <tr key={m.id} className={`border-b border-slate-50 ${mi % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                      <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                        {m.name}
                        <div className="text-[10px] text-slate-400 font-normal">{m.ratio}h/unit</div>
                      </td>
                      {[0,1,2,3,4,5,6].map(di => {
                        const dayVal = getDH(m.id, thisWeekOffset, di);
                        const isOverride = isDHOverride(m.id, thisWeekOffset, di);
                        const dayUnits = m.ratio > 0 ? dayVal / m.ratio : 0;
                        const totalDayVal = m.isManager ? getMgrTotalDH(m.id, thisWeekOffset, di) : dayVal;
                        const cost = dailyCost(m, thisWeekOffset, di);
                        const cpo = !m.isManager && dayUnits > 0 && cost > 0 ? cost / dayUnits : null;
                        return (
                          <td key={di} className={`px-1 py-1.5 text-center ${di === 0 ? 'bg-indigo-50/20' : ''}`}>
                            <input type="number"
                              value={resinInputMode === 'output' ? (dayUnits ? round2(dayUnits) : '') : (dayVal || '')}
                              placeholder="0" min={0} step={resinInputMode === 'output' ? 0.1 : 0.5}
                              title={isOverride ? 'Explicit override for this day' : 'Following the standard weekly schedule — edit to override just this day'}
                              onChange={e => {
                                const raw = parseFloat(e.target.value) || 0;
                                const newHours = resinInputMode === 'output' ? hoursFromOutput(raw, m.ratio) : raw;
                                setDH(m.id, thisWeekOffset, di, newHours);
                              }}
                              className={`w-12 text-center border rounded px-1 py-1 text-xs focus:outline-none ${
                                isOverride ? 'bg-white border-slate-100 hover:border-purple-300 focus:border-purple-400 text-slate-700'
                                           : 'bg-white border-slate-50 text-slate-400 italic hover:border-purple-300 focus:border-purple-400'
                              }`} />
                            {m.isManager && (
                              <input type="number" value={totalDayVal || ''} min={0} step={0.5} placeholder="total h"
                                title="Total hours (production + managerial)"
                                onChange={e => setMgrTotalDH(m.id, thisWeekOffset, di, parseFloat(e.target.value) || 0)}
                                className="w-12 mt-0.5 text-center bg-violet-50 border border-violet-200 rounded px-1 py-0.5 text-[10px] text-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-300" />
                            )}
                            {resinInputMode === 'output'
                              ? (dayVal > 0 && <div className="text-[10px] text-slate-400 mt-0.5">{round2(dayVal)}h</div>)
                              : (dayUnits > 0 && <div className="text-[10px] text-slate-400 mt-0.5">{round2(dayUnits)}u</div>)}
                            {hasRates && cpo !== null && <div className="text-[10px] text-purple-500">${cpo.toFixed(2)}</div>}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1.5 text-center text-xs font-medium text-indigo-700">
                        {weekTotal > 0 ? weekTotal.toFixed(1) : '—'}
                        {units > 0 && <div className="text-[10px] text-slate-400">{units.toFixed(1)}u</div>}
                        {hasRates && weekCPO !== null && <div className="text-[10px] text-purple-500">${weekCPO.toFixed(2)}</div>}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-purple-50 border-t border-purple-100 font-medium">
                  <td className="sticky left-0 bg-purple-50 px-4 py-2 text-xs text-purple-700">Day total</td>
                  {[0,1,2,3,4,5,6].map(di => {
                    const dayTotal = roster.reduce((s, m) => s + getDH(m.id, thisWeekOffset, di), 0);
                    const dayUnits = roster.reduce((s, m) => s + (m.ratio > 0 ? getDH(m.id, thisWeekOffset, di) / m.ratio : 0), 0);
                    const dayCost  = roster.reduce((s, m) => s + dailyCost(m, thisWeekOffset, di), 0);
                    const dayCPO   = dayUnits > 0 && dayCost > 0 ? dayCost / dayUnits : null;
                    return (
                      <td key={di} className="px-2 py-2 text-center text-xs text-purple-700">
                        {dayTotal > 0 ? <><div>{dayTotal.toFixed(1)}h</div><div className="text-[10px]">{dayUnits.toFixed(1)}u</div></> : <span className="text-slate-300">—</span>}
                        {hasRates && dayCPO !== null && <div className="text-[10px]">${dayCPO.toFixed(2)}</div>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-2 text-center text-xs text-purple-700">
                    {weeklyCapacity(thisWeekOffset) > 0 ? `${weeklyCapacity(thisWeekOffset).toFixed(0)}u` : <span className="text-slate-300">—</span>}
                  </td>
                </tr>
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
              <h3 className="text-sm font-semibold text-slate-700">Hours per team member per week</h3>
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
                    <th key={w} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px]">
                      {getWeekLabel(w)}
                      {w === 0 && <span className="ml-1 text-[10px] bg-purple-100 text-purple-600 rounded px-1">now</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {roster.map((m, mi) => (
                  <tr key={m.id} className={`border-b border-slate-50 ${mi % 2 === 0 ? '' : 'bg-slate-50/40'}`}>
                    <td className="sticky left-0 bg-white px-4 py-1.5 font-medium text-slate-700 whitespace-nowrap">
                      {m.name}
                      <div className="text-[10px] text-slate-400 font-normal">{m.ratio}h/unit</div>
                    </td>
                    {windowWeeks.map(w => {
                      const h    = memberWeekHours(w, m);
                      const units = m.ratio > 0 ? h / m.ratio : 0;
                      const { cpo }  = weekMemberStats(w, m);
                      const totalH = m.isManager ? resolveMgrTotalWeekHours(w, m, h) : h;
                      return (
                        <td key={w} className="px-1 py-1 text-center">
                          <div className="text-slate-700 font-medium" title="Set on the Roster (standard schedule) or the This week tab (one-off exceptions) — the 52-week planner is a read-only view">
                            {resinInputMode === 'output' ? round2(units) : round2(h)}
                          </div>
                          {m.isManager && totalH !== h && (
                            <div className="text-[10px] text-violet-600">{round2(totalH)}h total</div>
                          )}
                          {resinInputMode === 'output'
                            ? (h > 0 && <div className="text-[10px] text-slate-400 mt-0.5">{round2(h)}h</div>)
                            : (h > 0 && (
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {units.toFixed(0)}u
                                {showCPO && cpo !== null && (
                                  <span className="ml-1 text-purple-500">${cpo.toFixed(2)}</span>
                                )}
                              </div>
                            ))}
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Totals row */}
                <tr className="bg-purple-50 border-t border-purple-100 font-medium">
                  <td className="sticky left-0 bg-purple-50 px-4 py-2 text-xs text-purple-700">Week total</td>
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

          {/* Turnaround bars */}
          <div className="bg-white border border-slate-100 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-slate-700 mb-1">
              Turnaround — by order intake week
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              Based on {(queueSummary?.totalUnits ?? 0).toLocaleString()} units in queue
              · {avgWeeklyCapacity.toFixed(0)} units/week avg capacity · FIFO sort
            </p>

            {cohortRows.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">
                No queue data yet — click "Sync Queue" to pull from Shopify
              </p>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                {[...cohortRows].reverse().map(row => {
                  const wks = row.weeksToComplete;
                  const barColor =
                    wks === null     ? 'bg-slate-200' :
                    wks <= 6         ? 'bg-emerald-400' :
                    wks <= 12        ? 'bg-yellow-400' :
                    'bg-red-400';
                  const labelColor =
                    wks === null     ? 'text-slate-400' :
                    wks <= 6         ? 'text-emerald-700' :
                    wks <= 12        ? 'text-yellow-700' :
                    'text-red-700';
                  const maxWks = Math.max(...cohortRows.map(r => r.weeksToComplete ?? 0), 1);
                  const barWidth = wks !== null ? `${Math.min(100, (wks / maxWks) * 100)}%` : '4px';

                  return (
                    <div key={row.weekOf} className="flex items-center gap-3">
                      <span className="text-xs text-slate-500 w-20 shrink-0 text-right">
                        {row.weekLabel}
                      </span>
                      <div className="flex-1 flex items-center gap-2">
                        <div className="flex-1 bg-slate-50 rounded-full h-5 relative overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${barColor}`}
                            style={{ width: barWidth }}
                          />
                        </div>
                        <span className={`text-xs font-medium w-16 shrink-0 ${labelColor}`}>
                          {wks !== null ? `${wks} wks` : '—'}
                        </span>
                        <span className="text-xs text-slate-400 w-12 shrink-0 text-right">
                          {row.units}u
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Legend */}
            <div className="flex gap-4 mt-4 flex-wrap">
              {[
                { color: 'bg-emerald-400', label: '≤6 wks — on track' },
                { color: 'bg-yellow-400',  label: '7–12 wks — backlog' },
                { color: 'bg-red-400',     label: '13+ wks — behind' },
              ].map(({ color, label }) => (
                <span key={label} className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span className={`w-2.5 h-2.5 rounded-full ${color} inline-block`} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          {/* Full queue table */}
          <ResinQueueTable />
        </div>
      )}

      {/* ── HISTORICALS TAB ───────────────────────────────────────────────────── */}
      {activeTab === 'historicals' && (
        <HistoricalsSection
          department="resin"
          location="Utah"
          members={roster.map(m => ({
            id: m.id, name: m.name, payType: m.payType, hourlyRate: m.hourlyRate, annualSalary: m.annualSalary, isManager: m.isManager,
          }))}
          ordersLabel="pieces"
          onRatioUpdate={(id, ratio) => updateRosterField(id, 'ratio', ratio)}
        />
      )}
    </div>
  );
}

// ─── Queue table sub-component ─────────────────────────────────────────────────

function ResinQueueTable() {
  const [orders, setOrders] = useState<ResinQueueRow[]>([]);
  const [total, setTotal]   = useState(0);
  const [page, setPage]     = useState(1);
  const [loading, setLoading] = useState(true);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveResults, setMoveResults] = useState<Record<string, 'moved' | 'error'>>({});

  async function moveToUtah(order: ResinQueueRow) {
    setMovingId(order.line_item_id);
    try {
      const res = await fetch('/api/admin/sync-resin-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopifyOrderId: order.shopify_order_id, lineItemId: order.line_item_id }),
      });
      const d = await res.json();
      if (d.moved >= 1 || d.alreadyUtah >= 1) {
        setMoveResults(r => ({ ...r, [order.line_item_id]: 'moved' }));
        setOrders(prev => prev.map(o =>
          o.line_item_id === order.line_item_id ? { ...o, origin_location: 'Utah' } : o
        ));
      } else {
        setMoveResults(r => ({ ...r, [order.line_item_id]: 'error' }));
      }
    } catch {
      setMoveResults(r => ({ ...r, [order.line_item_id]: 'error' }));
    } finally {
      setMovingId(null);
    }
  }

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/resin/queue?page=${p}&pageSize=50`);
      const d   = await res.json();
      setOrders(d.orders ?? []);
      setTotal(d.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPage(1); }, [fetchPage]);

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
        <h3 className="text-sm font-semibold text-slate-700">Queue — all {total.toLocaleString()} units</h3>
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
              <th className="px-3 py-2 text-left font-medium text-slate-500">PF Status</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Origin</th>
              <th className="px-3 py-2 text-left font-medium text-slate-500">Order date</th>
              <th className="px-3 py-2 text-center font-medium text-slate-500">Qty</th>
              <th className="px-3 py-2 text-center font-medium text-slate-500">Location</th>
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
                <td className="px-3 py-1.5 text-slate-500">{o.order_date ?? '—'}</td>
                <td className="px-3 py-1.5 text-center text-slate-600">{o.quantity}</td>
                <td className="px-3 py-1.5 text-center">
                  {o.origin_location === 'Georgia' && moveResults[o.line_item_id] !== 'moved' ? (
                    <button
                      onClick={() => moveToUtah(o)}
                      disabled={movingId === o.line_item_id}
                      className="text-[10px] bg-amber-500 hover:bg-amber-600 text-white rounded px-2 py-1 disabled:opacity-50 whitespace-nowrap"
                    >
                      {movingId === o.line_item_id ? '…' : 'Move to UT'}
                    </button>
                  ) : moveResults[o.line_item_id] === 'moved' ? (
                    <span className="text-[10px] text-emerald-600 font-medium">✓ Moved</span>
                  ) : moveResults[o.line_item_id] === 'error' ? (
                    <span className="text-[10px] text-red-500">Failed</span>
                  ) : null}
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
  quantity:            number;
}

