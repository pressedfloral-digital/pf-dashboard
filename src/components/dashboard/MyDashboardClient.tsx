'use client';
import { useState, useEffect } from "react";
import { getWeekLabel, isoMonday } from "@/lib/weekDates";
import { useProductionAssignmentCounts } from "@/hooks/useProductionAssignmentCounts";
import type { AssignmentDepartment } from "@/lib/assignment-counts";
import { PersonCell, DayHead, ShiftBlock, OffBlock, SHIFT_LABEL, SHIFT_TONE, type ShiftTone } from "./ScheduleBlocks";
import { AddUnavailabilityButton, AvailabilityChips, fitShift, entriesOn, withStandardPreferred, withDefaultUnavailable, type UnavailabilityEntry } from "./Unavailability";

type UserProfile = {
  clerk_user_id: string;
  email: string;
  full_name: string;
  role: string;
  location: string | null;
  department: string | null;
  team_member_name: string | null;
};

interface ThisWeek {
  weekOf: string;
  scheduledHours: number | null;
  ordersAssigned: number | null;
  actualHours: number | null;
  targetRatio: number | null;
  crossDeptHours?: { dept: string; hours: number }[];
  crossDeptDaily?: { dept: string; daily: number[] }[];
}

interface HistoricalRow {
  weekOf: string;
  hours: number | null;
  orders: number | null;
  ratio: number | null;
  department?: string | null;
}

interface UpcomingWeek {
  weekOf: string;
  scheduledHours: number | null;
  crossDept?: { dept: string; hours: number }[];
}

interface DeptSchedule {
  dept: string;
  memberId?: string;
  isHome: boolean;
  ratio: number | null;
  weeks: { weekOf: string; hours: number }[];
  thisWeekDaily?: number[];
  thisWeekOff?: { iso: string; dayOff: boolean; hoursOff: number; standardHours?: number }[];
}

interface DashboardData {
  dailyHours: number[];
  memberName: string;
  location: string;
  department: string;
  thisWeek: ThisWeek | null;
  historicals: HistoricalRow[];
  upcomingWeeks: UpcomingWeek[];
  deptSchedules?: DeptSchedule[];
  paidHolidays?: string[];
  unavailability?: UnavailabilityEntry[];
  availabilityPeople?: { dept: string; id: string }[];
  avgHours: number | null;
  avgOrders: number | null;
  homeDepartment?: string | null;
}

const TABS = ["This Week", "52-Week Planner", "My Historicals", "My Scorecard"] as const;
type Tab = typeof TABS[number];

function fmt(n: number | null, decimals = 1): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(decimals);
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function MyDashboardClient({ profile }: { profile: UserProfile }) {
  const [tab, setTab] = useState<Tab>("This Week");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const weekIso = isoMonday(0);
  const weekDays = Array.from({ length: 5 }, (_, i) => addDaysIso(weekIso, i));
  const actuals = useProductionAssignmentCounts({
    names: data?.memberName ? [data.memberName] : [],
    dates: weekDays,
    enabled: tab === "This Week" && !!data?.memberName && (data?.deptSchedules ?? []).length > 0,
  });

  const name = profile.full_name.split(" ")[0];
  const location = profile.location ?? "";
  const department = profile.department ?? "";

  useEffect(() => {
    const params = new URLSearchParams();
    if (profile.team_member_name) params.set("memberName", profile.team_member_name);
    if (profile.location)         params.set("location",   profile.location);
    if (profile.department)       params.set("department", profile.department);
    fetch(`/api/my-dashboard?${params.toString()}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [profile.team_member_name, profile.location, profile.department]);

  const [availError, setAvailError] = useState<string | null>(null);
  // Team members add/remove only their own availability — the API keeps
  // everyone else's entries (see /api/my-dashboard/availability)
  const saveAvailability = async (next: UnavailabilityEntry[]) => {
    const prev = data?.unavailability ?? [];
    const named = next.map(e => ({ ...e, personName: data?.memberName ?? e.personName }));
    setData(d => d ? { ...d, unavailability: named } : d);
    setAvailError(null);
    const res = await fetch("/api/my-dashboard/availability", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberName: profile.team_member_name ?? undefined,
        location:   profile.location ?? undefined,
        department: profile.department ?? undefined,
        entries:    named,
      }),
    }).catch(() => null);
    if (!res?.ok) {
      setData(d => d ? { ...d, unavailability: prev } : d);
      setAvailError((await res?.json().catch(() => null))?.error ?? "Couldn't save availability");
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Hi, {name} 👋</h1>
          <p className="text-sm text-gray-500 mt-0.5 capitalize">{department} · {location}</p>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Week of</div>
          <div className="text-sm font-medium text-gray-700">
            {data?.thisWeek?.weekOf ? fmtDate(data.thisWeek.weekOf) : new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? "border-[#703C2E] text-[#703C2E]" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-gray-400 py-12 text-center">Loading your data...</div>
      ) : (
        <>
          {/* This Week */}
          {tab === "This Week" && (
            <div className="space-y-4">
              {(data?.thisWeek?.crossDeptHours ?? []).length > 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <span>⚠ Scheduled in multiple departments this week:</span>
                  {(data?.thisWeek?.crossDeptHours ?? []).map((cd, i) => (
                    <span key={i} className="font-medium capitalize">{cd.dept} ({cd.hours}h)</span>
                  ))}
                </div>
              )}
              {(data?.deptSchedules ?? []).some(d => (d.weeks[0]?.hours ?? 0) > 0) ? (
                <LiveStatCards
                  memberName={data?.memberName ?? ""}
                  deptSchedules={data?.deptSchedules ?? []}
                  scheduledHours={data?.thisWeek?.scheduledHours ?? null}
                  actuals={actuals}
                />
              ) : (
                <div className="grid grid-cols-3 gap-4">
                <StatCard label="Scheduled Hours" value={fmt(data?.thisWeek?.scheduledHours ?? null)} sub="all depts this week" />
                <StatCard
                  label={`${({ design: 'Frames', resin: 'Units' } as Record<string, string>)[data?.homeDepartment ?? data?.department ?? ''] ?? 'Orders'} This Week`}
                  value={data?.thisWeek?.scheduledHours && data?.thisWeek?.targetRatio
                    ? String(Math.round(data.thisWeek.scheduledHours / data.thisWeek.targetRatio))
                    : "—"}
                  sub={data?.thisWeek?.targetRatio ? `based on ${data.thisWeek.targetRatio} hrs/${({ design: 'frame', resin: 'unit' } as Record<string, string>)[data?.homeDepartment ?? data?.department ?? ''] ?? 'order'} ratio` : "based on scheduled hours"}
                />
                <StatCard label="Target Ratio" value={fmt(data?.thisWeek?.targetRatio ?? null, 2)} sub="hrs / order" />
              </div>
              )}
              <MyDayTable
                memberName={data?.memberName ?? ""}
                deptSchedules={data?.deptSchedules ?? []}
                paidHolidays={data?.paidHolidays ?? []}
                unavailability={data?.unavailability ?? []}
                availabilityPeople={data?.availabilityPeople ?? []}
                onUnavailabilityChange={saveAvailability}
                availError={availError}
              />
            </div>
          )}

          {/* 52-Week Planner */}
          {tab === "52-Week Planner" && (
            <MyWeeklySchedule memberName={data?.memberName ?? ""} deptSchedules={data?.deptSchedules ?? []} paidHolidays={data?.paidHolidays ?? []} />
          )}

          {/* My Historicals */}
          {tab === "My Historicals" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <StatCard label="Avg Hours / Week" value={fmt(data?.avgHours ?? null)} sub="last 26 weeks" />
                <StatCard label="Avg Orders / Week" value={fmt(data?.avgOrders ?? null, 0)} sub="last 26 weeks" />
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="text-sm font-semibold text-gray-700 mb-4">Recent Weeks</h2>
                {(data?.historicals ?? []).length === 0 ? (
                  <p className="text-sm text-gray-400">No historical data yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-2 text-xs font-medium text-gray-400 uppercase">Week</th>
                        <th className="text-left py-2 text-xs font-medium text-gray-400 uppercase">Dept</th>
                        <th className="text-right py-2 text-xs font-medium text-gray-400 uppercase">Hours</th>
                        <th className="text-right py-2 text-xs font-medium text-gray-400 uppercase">Orders</th>
                        <th className="text-right py-2 text-xs font-medium text-gray-400 uppercase">Ratio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.historicals ?? []).map((r, i) => {
                        const isHome = !r.department || r.department?.toLowerCase() === (data?.homeDepartment ?? department).toLowerCase();
                        return (
                          <tr key={i} className="border-b border-gray-50 last:border-0">
                            <td className="py-2 text-gray-600">Week of {fmtDate(r.weekOf)}</td>
                            <td className="py-2">
                              {isHome ? (
                                <span className="text-xs text-gray-400 capitalize">{r.department ?? department}</span>
                              ) : (
                                <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 capitalize">{r.department}</span>
                              )}
                            </td>
                            <td className="py-2 text-right text-gray-700">{fmt(r.hours)}</td>
                            <td className="py-2 text-right text-gray-700">{fmt(r.orders, 0)}</td>
                            <td className="py-2 text-right text-gray-700">{fmt(r.ratio)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* My Scorecard */}
          {tab === "My Scorecard" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <StatCard label="Disapproval Rate" value="—" sub="last 30 days" />
                <StatCard label="Avg Monthly Ratio" value={fmt(data?.thisWeek?.targetRatio ?? null)} sub="last 3 months" />
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="text-sm font-semibold text-gray-700 mb-4">Monthly Ratio History</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-2 text-xs font-medium text-gray-400 uppercase">Month</th>
                      <th className="text-right py-2 text-xs font-medium text-gray-400 uppercase">Ratio</th>
                      <th className="text-right py-2 text-xs font-medium text-gray-400 uppercase">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buildMonthlyRollup(data?.historicals ?? []).map((m, i) => (
                      <tr key={i} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 text-gray-600">{m.month}</td>
                        <td className="py-2 text-right text-gray-700">{fmt(m.ratio)}</td>
                        <td className="py-2 text-right text-gray-700">{fmt(m.orders, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function buildMonthlyRollup(historicals: HistoricalRow[]) {
  const map: Record<string, { hours: number; orders: number }> = {};
  historicals.forEach(r => {
    const month = new Date(r.weekOf + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (!map[month]) map[month] = { hours: 0, orders: 0 };
    map[month].hours  += r.hours  ?? 0;
    map[month].orders += r.orders ?? 0;
  });
  return Object.entries(map).map(([month, d]) => ({
    month,
    ratio:  d.hours > 0 && d.orders > 0 ? Math.round((d.hours / d.orders) * 100) / 100 : null,
    orders: d.orders,
  }));
}

const UNIT_SHORT: Record<string, string> = { design: "f", resin: "units" };
const WEEKS = 52;
const WINDOW = 8;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const LIVE_DEPTS: AssignmentDepartment[] = ["design", "preservation", "fulfillment"];

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same thresholds as the Scheduling tab's actual-vs-goal colouring
function paceTone(actual: number, goal: number): { text: string; pill: string; label: string } {
  const pct = goal > 0 ? actual / goal : actual > 0 ? 1 : 0;
  if (pct >= 1)   return { text: "text-green-600", pill: "bg-green-50 text-green-700 border-green-200", label: "On track" };
  if (pct >= 0.9) return { text: "text-amber-500", pill: "bg-amber-50 text-amber-700 border-amber-200", label: "Slightly behind" };
  return { text: "text-red-600", pill: "bg-red-50 text-red-700 border-red-200", label: "Behind" };
}

type WeekActuals = ReturnType<typeof useProductionAssignmentCounts>;

// One department's week so far: goal, live MT actual, pace and live ratio.
function deptPace(d: DeptSchedule, memberName: string, actuals: WeekActuals) {
  const days = Array.from({ length: 5 }, (_, i) => addDaysIso(isoMonday(0), i));
  // Mon=0..Fri=4; weekend counts the whole work week as elapsed
  const dow = new Date().getDay();
  const weekend = dow === 0 || dow === 6;
  const todayIdx = weekend ? 4 : dow - 1;
  const unit = UNIT_SHORT[d.dept] ?? "ord";
  const fmtU = (n: number) => `${round1(n)}${unit === "f" ? "f" : ` ${unit}`}`;
  const unitPer = unit === "units" ? "unit" : unit === "f" ? "frame" : "order";
  const ratio = d.ratio && d.ratio > 0 ? d.ratio : null;
  const weekHours = d.weeks[0]?.hours ?? 0;
  const hoursSoFar = weekend ? weekHours : (d.thisWeekDaily ?? []).slice(0, todayIdx + 1).reduce((s, h) => s + (h ?? 0), 0);
  const weekGoal = ratio ? weekHours / ratio : null;
  const goalSoFar = ratio ? hoursSoFar / ratio : null;
  const live = LIVE_DEPTS.includes(d.dept as AssignmentDepartment);
  const counts = live ? days.slice(0, todayIdx + 1).map(day => actuals.getCount(memberName, day, d.dept as AssignmentDepartment)) : [];
  const actual = counts.some(c => c !== null) ? counts.reduce<number>((s, c) => s + (c ?? 0), 0) : null;
  const tone = actual !== null && goalSoFar !== null ? paceTone(actual, goalSoFar) : null;
  const diff = actual !== null && goalSoFar !== null ? Math.round(actual - goalSoFar) : null;
  const paceLabel = diff === null ? null : diff > 0 ? `${fmtU(diff)} ahead` : diff < 0 ? `${fmtU(-diff)} behind` : "on plan";
  const liveRatio = actual && actual > 0 && hoursSoFar > 0 ? hoursSoFar / actual : null;
  // Lower hours per unit is better
  const ratioTone = liveRatio !== null && ratio !== null
    ? liveRatio <= ratio ? "text-green-600" : liveRatio <= ratio * 1.1 ? "text-amber-500" : "text-red-600"
    : "text-gray-400";
  return { unit, unitPer, fmtU, ratio, weekHours, weekGoal, live, actual, tone, paceLabel, liveRatio, ratioTone };
}

// The This Week stat squares with live MT actuals folded in — goal vs actual
// and target vs live ratio, one line per department when they flex.
function LiveStatCards({ memberName, deptSchedules, scheduledHours, actuals }: {
  memberName: string;
  deptSchedules: DeptSchedule[];
  scheduledHours: number | null;
  actuals: WeekActuals;
}) {
  const rows = deptSchedules.filter(d => (d.weeks[0]?.hours ?? 0) > 0).map(d => ({ d, p: deptPace(d, memberName, actuals) }));
  const flex = rows.length > 1;
  const single = rows[0];
  const status = actuals.error
    ? <span className="text-red-600" title={actuals.error}>live numbers unavailable</span>
    : actuals.loading ? "loading live numbers…"
    : actuals.refreshedAt ? `live · updated ${new Date(actuals.refreshedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : null;
  const actualText = (p: ReturnType<typeof deptPace>) =>
    !p.live ? "no live count" : p.actual !== null ? `Actual ${p.fmtU(p.actual)}` : actuals.loading ? "Actual …" : "Actual —";

  return (
    <div className="grid grid-cols-3 gap-4">
      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Scheduled Hours</div>
        <div className="text-2xl font-semibold text-gray-900">{fmt(scheduledHours)}</div>
        {flex ? (
          <div className="mt-1 space-y-0.5">
            {rows.map(({ d, p }) => (
              <div key={d.dept} className="text-xs text-gray-500"><span className="capitalize">{d.dept}</span> · {round1(p.weekHours)}h</div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-gray-400 mt-0.5">all depts this week</div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">
          {flex ? "Goals This Week" : `${single.d.dept === "design" ? "Frames" : single.d.dept === "resin" ? "Units" : "Orders"} This Week`}
        </div>
        {flex ? (
          <div className="space-y-2">
            {rows.map(({ d, p }) => (
              <div key={d.dept}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-gray-600 capitalize">{d.dept}</span>
                  <span className="text-lg font-semibold text-gray-900">{p.weekGoal !== null ? p.fmtU(p.weekGoal) : "—"}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-sky-600 font-medium">{actualText(p)}</span>
                  {p.paceLabel && <span className={`font-semibold ${p.tone?.text ?? ""}`}>{p.paceLabel}</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="text-2xl font-semibold text-gray-900">{single.p.weekGoal !== null ? round1(single.p.weekGoal) : "—"}</div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="text-sky-600 font-medium">{actualText(single.p)}</span>
              {single.p.paceLabel && <span className={`font-semibold ${single.p.tone?.text ?? ""}`}>{single.p.paceLabel}</span>}
            </div>
          </>
        )}
        {status && <div className="text-[10px] text-gray-400 mt-1">{status}</div>}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">{flex ? "Target Ratios" : "Target Ratio"}</div>
        {flex ? (
          <div className="space-y-2">
            {rows.map(({ d, p }) => (
              <div key={d.dept}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-gray-600 capitalize">{d.dept}</span>
                  <span className="text-lg font-semibold text-gray-900 whitespace-nowrap">{p.ratio !== null ? p.ratio.toFixed(2) : "—"} <span className="text-xs font-normal text-gray-400">h/{p.unitPer}</span></span>
                </div>
                <div className={`text-right text-xs font-medium ${p.ratioTone}`}>Live {p.liveRatio !== null ? p.liveRatio.toFixed(2) : "—"}</div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="text-2xl font-semibold text-gray-900">{single.p.ratio !== null ? single.p.ratio.toFixed(2) : "—"}</div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs">
              <span className="text-gray-400">hrs / {single.p.unitPer}</span>
              <span className={`font-medium ${single.p.ratioTone}`}>Live {single.p.liveRatio !== null ? single.p.liveRatio.toFixed(2) : "—"}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Read-only copy of the managers' This Week shift-block grid on the
// Scheduling tab, limited to this person — one row per department they're
// scheduled in this week.
const PLAN_UNIT: Record<string, string> = { design: "f", resin: " units" };
const OUTPUT_WORD: Record<string, string> = { design: "frames", resin: "units" };
const isShiftTone = (dept: string): dept is ShiftTone => dept in SHIFT_LABEL;

// Goals only — live actuals are in the progress cards above.
function MyDayTable({ memberName, deptSchedules, paidHolidays, unavailability, availabilityPeople, onUnavailabilityChange, availError }: {
  memberName: string;
  deptSchedules: DeptSchedule[];
  paidHolidays: string[];
  unavailability: UnavailabilityEntry[];
  availabilityPeople: { dept: string; id: string }[];
  onUnavailabilityChange: (next: UnavailabilityEntry[]) => void;
  availError: string | null;
}) {
  const weekIso = isoMonday(0);
  const days = Array.from({ length: 5 }, (_, i) => {
    const iso = addDaysIso(weekIso, i);
    return { iso, label: new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" }) };
  });
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const isHolidayDay = (di: number) => paidHolidays.includes(days[di]?.iso ?? "");
  const rows = deptSchedules.filter(d => (d.weeks[0]?.hours ?? 0) > 0);

  // Shift times are derived from hours (see fitShift). When someone works two
  // departments the same day, start the later row's shift where the earlier
  // one ends so the two don't overlap.
  const shiftTimes = (() => {
    const lastEnd: (number | null)[] = days.map(() => null);
    return rows.map(d => days.map((day, di) => {
      const off = d.thisWeekOff?.[di];
      const h = d.thisWeekDaily?.[di] ?? 0;
      if (off?.dayOff || h <= 0) return null;
      const id = d.memberId ?? "";
      const entries = withStandardPreferred(entriesOn(unavailability, id, day.iso), id, memberName, day.iso, off?.standardHours ?? 0);
      const fit = fitShift(entries, h);
      if (!fit) return null;
      const prev = lastEnd[di];
      const shift = prev !== null && fit.start < prev ? { start: prev, end: prev + (fit.end - fit.start) } : fit;
      lastEnd[di] = shift.end;
      return shift;
    }));
  })();

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-slate-100">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Your schedule — this week</h3>
          {availError && <p className="text-[11px] font-medium text-red-600">{availError}</p>}
        </div>
        {availabilityPeople.length > 0 && (
          // "People" here are this person's departments — pick which the time applies to
          <AddUnavailabilityButton
            people={availabilityPeople.map(p => ({ id: p.id, name: isShiftTone(p.dept) ? SHIFT_LABEL[p.dept] : p.dept }))}
            list={unavailability}
            onChange={onUnavailabilityChange}
            defaultDate={days.find(day => day.iso >= todayIso)?.iso ?? days[0]?.iso}
          />
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 px-5 py-6">No shifts scheduled this week.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="sticky left-0 z-10 bg-white px-4 py-3 text-left text-[13px] font-medium text-slate-500 min-w-[190px]">Department</th>
                {days.map((d, i) => (
                  <th key={d.iso} className="px-1.5 py-3 min-w-[104px]">
                    <DayHead label={d.label} iso={d.iso} today={d.iso === todayIso} holiday={isHolidayDay(i)} />
                  </th>
                ))}
                <th className="px-3 py-3 text-center text-[13px] font-medium text-slate-500 whitespace-nowrap">Week total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, ri) => {
                const tone: ShiftTone = isShiftTone(d.dept) ? d.dept : "design";
                const ratio = d.ratio && d.ratio > 0 ? d.ratio : null;
                const planUnit = PLAN_UNIT[d.dept] ?? " ord";
                const daily = d.thisWeekDaily ?? [];
                const outOf = (h: number) => (ratio && h > 0 ? h / ratio : 0);
                const weekHrs = daily.reduce((s, h) => s + (h ?? 0), 0);
                const weekOut = daily.reduce((s, h) => s + outOf(h ?? 0), 0);
                return (
                  <tr key={d.dept} className="border-b border-slate-100">
                    <td className="sticky left-0 z-10 bg-white px-4 py-2 whitespace-nowrap">
                      <PersonCell name={memberName}>
                        <span className={`mt-0.5 inline-block rounded px-1.5 py-px text-[10px] font-medium border ${SHIFT_TONE_BADGE[tone]}`}>{SHIFT_LABEL[tone]}</span>
                        {ratio && <div className="text-[10px] text-slate-400">{ratio} h/{planUnit.trim() === "f" ? "f" : planUnit.trim().replace(/s$/, "")}</div>}
                      </PersonCell>
                    </td>
                    {days.map((day, di) => {
                      const h = daily[di] ?? 0;
                      const out = outOf(h);
                      const holiday = isHolidayDay(di);
                      const off = d.thisWeekOff?.[di];
                      const hoursOff = off?.hoursOff ?? 0;
                      if (off?.dayOff) {
                        return <td key={day.iso} className="p-1 align-top"><OffBlock sub={holiday ? "Holiday" : "Time off"} /></td>;
                      }
                      const id = d.memberId ?? "";
                      const dayEntries = withDefaultUnavailable(withStandardPreferred(entriesOn(unavailability, id, day.iso), id, memberName, day.iso, off?.standardHours ?? 0), id, memberName, day.iso);
                      const unav = dayEntries.filter(e => e.kind === "unavailable");
                      const working = h > 0;
                      return (
                        <td key={day.iso} className="p-1 align-top">
                          {shiftTimes[ri]?.[di] && (
                            <div className={`mb-1 rounded-md border px-1.5 py-0.5 text-left leading-tight ${SHIFT_TONE[tone]}`}>
                              <div className="text-[9px] font-medium uppercase tracking-wide opacity-60">Hours scheduled</div>
                              <div className="text-[11px] font-semibold">{fmtMin(shiftTimes[ri][di]!.start)}–{fmtMin(shiftTimes[ri][di]!.end)}</div>
                            </div>
                          )}
                          <ShiftBlock tone={working ? tone : holiday ? "holiday" : unav.length ? "unavailable" : dayEntries.length ? "preferred" : null}>
                            {working ? (
                              // Team members see their goal, not hours (hours only when there's no ratio)
                              <span className="block text-xs font-semibold">
                                {out > 0 ? `${round2(out)} ${OUTPUT_WORD[d.dept] ?? "orders"}` : `${round2(h)}h`}
                              </span>
                            ) : (
                              <span className="block py-1">{holiday ? "Holiday" : unav.length ? "Unavailable" : dayEntries.length ? "Available" : "Not scheduled"}</span>
                            )}
                            <AvailabilityChips entries={dayEntries} iso={day.iso} scheduled={working} list={unavailability} onChange={onUnavailabilityChange} />
                            {holiday && <div className="text-[10px] text-amber-700">holiday pay</div>}
                            {hoursOff > 0 && <div className="text-[10px] font-semibold text-red-500" title="Hours off on the Days off calendar">{hoursOff}h off</div>}
                          </ShiftBlock>
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center">
                      <div className="font-medium text-indigo-700">{weekOut > 0 ? `${round2(weekOut)}${planUnit}` : `${round2(weekHrs)}h`}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtMin(min: number) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

const SHIFT_TONE_BADGE: Record<ShiftTone, string> = {
  design:       "bg-sky-50 border-sky-200 text-sky-700",
  preservation: "bg-emerald-50 border-emerald-200 text-emerald-700",
  fulfillment:  "bg-amber-50 border-amber-200 text-amber-700",
  resin:        "bg-violet-50 border-violet-200 text-violet-700",
};

// The team member's own rows from each department's Weekly Schedule, in the
// same shift-block layout as This Week — weeks across instead of days.
function MyWeeklySchedule({ memberName, deptSchedules, paidHolidays }: {
  memberName: string;
  deptSchedules: DeptSchedule[];
  paidHolidays: string[];
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => {
    const w = weekOffset + i;
    const iso = isoMonday(w);
    const holiday = paidHolidays.some(h => h >= iso && h <= addDaysIso(iso, 6));
    return { w, iso, holiday };
  });

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Your schedule — by week</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">Goal for each week you&apos;re scheduled. Future weeks are tentative.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset(Math.max(0, weekOffset - WINDOW))} disabled={weekOffset === 0}
            className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev</button>
          <span className="text-xs text-slate-400">
            {getWeekLabel(weekOffset)} – {getWeekLabel(weekOffset + WINDOW - 1)}
          </span>
          <button onClick={() => setWeekOffset(Math.min(WEEKS - WINDOW, weekOffset + WINDOW))} disabled={weekOffset + WINDOW >= WEEKS}
            className="px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next →</button>
        </div>
      </div>
      {deptSchedules.length === 0 ? (
        <p className="text-sm text-gray-400 px-5 py-6">No scheduled shifts found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="sticky left-0 z-10 bg-white px-4 py-3 text-left text-[13px] font-medium text-slate-500 min-w-[190px]">Department</th>
                {windowWeeks.map(({ w, iso, holiday }) => (
                  <th key={w} className="px-1.5 py-3 min-w-[96px]">
                    <DayHead label="Wk" iso={iso} today={w === 0} holiday={holiday} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deptSchedules.map(d => {
                const tone: ShiftTone = isShiftTone(d.dept) ? d.dept : "design";
                const ratio = d.ratio && d.ratio > 0 ? d.ratio : null;
                const planUnit = PLAN_UNIT[d.dept] ?? " ord";
                return (
                  <tr key={d.dept} className="border-b border-slate-100">
                    <td className="sticky left-0 z-10 bg-white px-4 py-2 whitespace-nowrap">
                      <PersonCell name={memberName}>
                        <span className={`mt-0.5 inline-block rounded px-1.5 py-px text-[10px] font-medium border ${SHIFT_TONE_BADGE[tone]}`}>{SHIFT_LABEL[tone]}</span>
                        {ratio && <div className="text-[10px] text-slate-400">{ratio} h/{planUnit.trim() === "f" ? "f" : planUnit.trim().replace(/s$/, "")}</div>}
                      </PersonCell>
                    </td>
                    {windowWeeks.map(({ w }) => {
                      const hours = d.weeks[w]?.hours ?? 0;
                      const out = ratio && hours > 0 ? hours / ratio : 0;
                      return (
                        <td key={w} className="p-1 align-top">
                          <ShiftBlock tone={hours > 0 ? tone : null}>
                            {hours > 0 ? (
                              // Goal only, like This Week (hours only when there's no ratio)
                              <span className="block text-xs font-semibold">
                                {out > 0 ? `${round1(out)} ${OUTPUT_WORD[d.dept] ?? "orders"}` : `${round1(hours)}h`}
                              </span>
                            ) : (
                              <span className="block py-1">Not scheduled</span>
                            )}
                          </ShiftBlock>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-5 py-4">
      <div className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}

