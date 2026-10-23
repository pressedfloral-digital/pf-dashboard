'use client';

// "At a Glance" — the Design department's one-screen summary on the
// Scheduling tab. Everything here is a read-only view over numbers the other
// Design tabs already compute (monthly KPIs, the week's resolved daily hours,
// MT production counts, Must design); SchedulePage resolves them and passes
// plain values in so this view can never disagree with the detail tabs.

import { fmtRatio, fmtCPO, fmtUnits } from '@/hooks/useKpiMetrics';

export interface GlanceDay {
  iso:     string;
  label:   string;   // "Mon"
  dateStr: string;   // "Oct 20"
  isHoliday: boolean;
}

export interface GlancePersonDay {
  hours:        number;          // scheduled production hours
  usualHours:   number;          // standard-template hours for this day
  actualFrames: number | null;   // MT production; null = no data
}

export interface GlancePerson {
  id:        string;
  name:      string;
  ratio:     number;   // hours per frame
  isManager: boolean;
  days:      GlancePersonDay[];
}

interface MonthKpi { ratio: number | null; cpo: number | null; production: number }

export interface DesignAtAGlanceProps {
  location:     string;
  weekLabel:    string;
  weekOffset:   number;
  maxWeekOffset: number;
  onWeekOffsetChange: (n: number) => void;
  todayIso:     string;
  days:         GlanceDay[];
  people:       GlancePerson[];
  actualsLoading: boolean;
  kpiLoading:   boolean;
  mtd:          MonthKpi | null;
  goal:         MonthKpi | null;
  expected:     MonthKpi | null;
  showCPO:      boolean;
  plannedFrames: number;   // scheduled frames for the week
  mustFrames:    number;   // Must design — minimum to keep client promises
  hoursPerFrame: number;   // blended h/f used to turn a frame gap into hours
  onOpenThisWeek: () => void;
}

// A completed day counts as "behind" when the frames someone finished cover
// less than this share of the hours they were scheduled. Frames land in
// lumps (a frame started Monday may be finished Tuesday), so a little slack
// keeps the flags meaningful.
const BEHIND_THRESHOLD = 0.85;
// Half an hour of slack before a cut day or a short team day is flagged.
const HOURS_SLACK = 0.5;

type Status = 'good' | 'warn' | 'bad' | 'none';

const STATUS_STYLE: Record<Status, { pill: string; icon: string; bar: string }> = {
  good: { pill: 'bg-green-50 text-green-700 border-green-200', icon: '✓', bar: 'bg-green-500' },
  warn: { pill: 'bg-amber-50 text-amber-700 border-amber-200', icon: '!', bar: 'bg-amber-500' },
  bad:  { pill: 'bg-red-50 text-red-700 border-red-200',       icon: '✕', bar: 'bg-red-500' },
  none: { pill: 'bg-slate-50 text-slate-500 border-slate-200', icon: '–', bar: 'bg-slate-300' },
};

function r1(n: number) { return Math.round(n * 10) / 10; }
function hrs(n: number) { return `${r1(n)}h`; }

function StatusPill({ status, children }: { status: Status; children: React.ReactNode }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.pill}`}>
      <span aria-hidden>{s.icon}</span>{children}
    </span>
  );
}

function ProgressBar({ value, max, status, marker }: { value: number; max: number; status: Status; marker?: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const markerPct = marker != null && max > 0 ? Math.min(100, (marker / max) * 100) : null;
  return (
    <div className="relative mt-3 h-2 rounded-full bg-slate-100">
      <div className={`h-2 rounded-full ${STATUS_STYLE[status].bar}`} style={{ width: `${pct}%` }} />
      {markerPct != null && (
        <div className="absolute -top-1 h-4 w-0.5 bg-slate-700" style={{ left: `calc(${markerPct}% - 1px)` }} title="Where you should be by today" />
      )}
    </div>
  );
}

function GoalCard({ title, value, goalText, status, statusText, children }: {
  title: string; value: string; goalText: string; status: Status; statusText: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
        <StatusPill status={status}>{statusText}</StatusPill>
      </div>
      <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{value}</p>
      <p className="mt-0.5 text-sm text-slate-500">{goalText}</p>
      {children}
    </div>
  );
}

interface Flag { status: 'bad' | 'warn'; who: string; text: string }

export function DesignAtAGlance(p: DesignAtAGlanceProps) {
  const { days, people, todayIso } = p;

  // Only show weekend columns when someone is actually on.
  const visibleDays = days
    .map((d, i) => ({ ...d, i }))
    .filter(d => d.i < 5 || people.some(person => (person.days[d.i]?.hours ?? 0) > 0));

  const isPast  = (iso: string) => iso < todayIso;
  const isToday = (iso: string) => iso === todayIso;

  // ── Per-cell evaluation ──────────────────────────────────────────────────
  function cellInfo(person: GlancePerson, di: number) {
    const day = person.days[di];
    const iso = days[di].iso;
    const cut = day.usualHours - day.hours > HOURS_SLACK;
    // Hours "earned" = frames finished × that designer's hours-per-frame.
    // Managers are skipped — their output is a rough proxy (same rule as the
    // h/f ratio everywhere else).
    const earned = !person.isManager && day.actualFrames != null && person.ratio > 0
      ? day.actualFrames * person.ratio : null;
    const behind = isPast(iso) && day.hours > 0 && earned != null && earned < day.hours * BEHIND_THRESHOLD;
    const hit    = (isPast(iso) || isToday(iso)) && day.hours > 0 && earned != null && earned >= day.hours * BEHIND_THRESHOLD;
    return { day, cut, earned, behind, hit };
  }

  // ── Team totals per day ──────────────────────────────────────────────────
  const teamDay = days.map((_, di) => {
    const scheduled = people.reduce((s, x) => s + (x.days[di]?.hours ?? 0), 0);
    const usual     = people.reduce((s, x) => s + (x.days[di]?.usualHours ?? 0), 0);
    return { scheduled, usual, short: usual - scheduled > HOURS_SLACK ? usual - scheduled : 0 };
  });
  const weekScheduledHours = teamDay.reduce((s, d) => s + d.scheduled, 0);
  const weekUsualHours     = teamDay.reduce((s, d) => s + d.usual, 0);

  // ── Week frames ──────────────────────────────────────────────────────────
  const frameGap   = Math.max(0, p.mustFrames - p.plannedFrames);
  const hoursGap   = frameGap * (p.hoursPerFrame || 1);
  const weekActual = people.reduce((s, x) => s + x.days.reduce((t, d) => t + (d.actualFrames ?? 0), 0), 0);
  const hasActuals = people.some(x => x.days.some(d => d.actualFrames != null));
  const weekTarget = Math.max(p.mustFrames, p.plannedFrames);
  // Planned frames that should be finished by end of yesterday — the
  // "where you should be" marker on the frames bar.
  const plannedToDate = people.reduce((s, x) => s + (x.ratio > 0
    ? x.days.reduce((t, d, di) => t + (isPast(days[di].iso) ? d.hours / x.ratio : 0), 0) : 0), 0);

  // This week's pace in h/f (non-managers, completed days only).
  let paceHours = 0, paceFrames = 0;
  people.forEach(x => {
    if (x.isManager) return;
    x.days.forEach((d, di) => {
      if (!isPast(days[di].iso) || d.actualFrames == null) return;
      paceHours += d.hours; paceFrames += d.actualFrames;
    });
  });
  const weekPace = paceFrames > 0 ? paceHours / paceFrames : null;

  // ── Flags ────────────────────────────────────────────────────────────────
  const flags: Flag[] = [];
  if (frameGap > 0.5) {
    flags.push({ status: 'bad', who: 'Team', text: `Not enough hours this week — ${hrs(hoursGap)} (${Math.round(frameGap)} frames) short of what's needed to keep client promises.` });
  }
  visibleDays.forEach(d => {
    const t = teamDay[d.i];
    if (t.short > 0 && !d.isHoliday) {
      flags.push({ status: 'warn', who: `${d.label} ${d.dateStr}`, text: `Team scheduled ${hrs(t.scheduled)} — ${hrs(t.short)} less than a normal ${d.label} (${hrs(t.usual)}).` });
    }
  });
  people.forEach(x => {
    visibleDays.forEach(d => {
      const c = cellInfo(x, d.i);
      if (c.behind) {
        flags.push({ status: 'bad', who: x.name, text: `${d.label}: didn't hit their hours — ${c.day.actualFrames} frames covers ${hrs(c.earned ?? 0)} of ${hrs(c.day.hours)} scheduled.` });
      } else if (c.cut && !d.isHoliday) {
        flags.push({ status: 'warn', who: x.name, text: `${d.label}: scheduled ${c.day.hours > 0 ? hrs(c.day.hours) : 'off'} — usually ${hrs(c.day.usualHours)}.` });
      }
    });
  });
  flags.sort((a, b) => (a.status === b.status ? 0 : a.status === 'bad' ? -1 : 1));

  // ── KPI statuses ─────────────────────────────────────────────────────────
  const ratioStatus: Status = p.mtd?.ratio == null || p.goal?.ratio == null ? 'none'
    : p.mtd.ratio <= p.goal.ratio ? 'good'
    : p.expected?.ratio != null && p.mtd.ratio <= p.expected.ratio ? 'warn' : 'bad';
  const cpoStatus: Status = p.mtd?.cpo == null || p.goal?.cpo == null ? 'none'
    : p.mtd.cpo <= p.goal.cpo ? 'good'
    : p.expected?.cpo != null && p.mtd.cpo <= p.expected.cpo ? 'warn' : 'bad';
  const framesStatus: Status = frameGap > 0.5 ? 'bad'
    : !hasActuals || plannedToDate === 0 ? 'none'
    : weekActual >= plannedToDate * BEHIND_THRESHOLD ? 'good' : 'warn';
  const hoursStatus: Status = frameGap > 0.5 ? 'bad'
    : weekUsualHours - weekScheduledHours > HOURS_SLACK ? 'warn' : 'good';

  const statusWord = (s: Status, good = 'On goal') =>
    s === 'good' ? good : s === 'warn' ? 'Watch' : s === 'bad' ? 'Off goal' : 'No data';

  return (
    <div className="space-y-5">
      {/* ── Header / week picker ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Design · {p.location} — {p.weekLabel}</h2>
          <p className="text-sm text-slate-500">{days[0]?.dateStr} – {days[4]?.dateStr}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => p.onWeekOffsetChange(Math.max(0, p.weekOffset - 1))} disabled={p.weekOffset === 0}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30">← Prev week</button>
          {p.weekOffset !== 0 && (
            <button onClick={() => p.onWeekOffsetChange(0)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">This week</button>
          )}
          <button onClick={() => p.onWeekOffsetChange(Math.min(p.maxWeekOffset, p.weekOffset + 1))} disabled={p.weekOffset >= p.maxWeekOffset}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-30">Next week →</button>
        </div>
      </div>

      {/* ── Goals bar ────────────────────────────────────────────────────── */}
      <div className={`grid gap-3 sm:grid-cols-2 ${p.showCPO ? 'xl:grid-cols-4' : 'xl:grid-cols-3'}`}>
        <GoalCard
          title="Frames this week"
          value={hasActuals ? `${fmtUnits(weekActual)} / ${fmtUnits(weekTarget)}` : `${fmtUnits(weekTarget)}`}
          goalText={frameGap > 0.5
            ? `Need ${Math.round(p.mustFrames)} to keep promises · only ${Math.round(p.plannedFrames)} scheduled`
            : hasActuals ? `Done so far / goal for the week` : `Frames scheduled for the week`}
          status={framesStatus}
          statusText={frameGap > 0.5 ? 'Short' : statusWord(framesStatus, 'On pace')}>
          {hasActuals && <ProgressBar value={weekActual} max={weekTarget} status={framesStatus} marker={plannedToDate > 0 ? plannedToDate : undefined} />}
        </GoalCard>

        <GoalCard
          title="Hours scheduled this week"
          value={hrs(weekScheduledHours)}
          goalText={frameGap > 0.5
            ? `Need about ${hrs(weekScheduledHours + hoursGap)} — add ${hrs(hoursGap)}`
            : `Normal week: ${hrs(weekUsualHours)}`}
          status={hoursStatus}
          statusText={hoursStatus === 'bad' ? 'Not enough' : hoursStatus === 'warn' ? 'Below normal' : 'Covered'}>
          <ProgressBar value={weekScheduledHours} max={Math.max(weekScheduledHours + hoursGap, weekUsualHours, 1)} status={hoursStatus} />
        </GoalCard>

        <GoalCard
          title="Hours per frame · month"
          value={p.kpiLoading ? '…' : fmtRatio(p.mtd?.ratio ?? null)}
          goalText={`Goal ${fmtRatio(p.goal?.ratio ?? null)} · lower is better${weekPace != null ? ` · this week ${fmtRatio(weekPace)}` : ''}`}
          status={ratioStatus}
          statusText={statusWord(ratioStatus)} />

        {p.showCPO && (
          <GoalCard
            title="Cost per frame · month"
            value={p.kpiLoading ? '…' : fmtCPO(p.mtd?.cpo ?? null)}
            goalText={`Goal ${fmtCPO(p.goal?.cpo ?? null)} · lower is better`}
            status={cpoStatus}
            statusText={statusWord(cpoStatus)} />
        )}
      </div>

      {/* ── Needs attention ──────────────────────────────────────────────── */}
      <div className={`rounded-xl border p-4 ${flags.length === 0 ? 'border-green-200 bg-green-50/50' : 'border-slate-200 bg-white'}`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">
            {flags.length === 0 ? '✓ Nothing needs attention' : `Needs attention (${flags.length})`}
          </h3>
          {p.actualsLoading && <span className="text-xs text-slate-400">Loading production…</span>}
        </div>
        {flags.length > 0 && (
          <ul className="mt-3 space-y-2">
            {flags.map((f, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <StatusPill status={f.status}>{f.status === 'bad' ? 'Action' : 'Heads up'}</StatusPill>
                <span><span className="font-semibold text-slate-800">{f.who}</span> <span className="text-slate-600">— {f.text}</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Who's working when ───────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">Who&apos;s working when</h3>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-indigo-100 ring-1 ring-indigo-200" />Scheduled</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-amber-100 ring-1 ring-amber-300" />Fewer hours than usual</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-slate-100 ring-1 ring-slate-200" />Off</span>
            <span className="flex items-center gap-1"><span className="font-semibold text-green-700">✓</span>Hit hours</span>
            <span className="flex items-center gap-1"><span className="font-semibold text-red-600">✕</span>Behind</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="sticky left-0 z-10 min-w-[160px] bg-slate-50 px-4 py-2 text-left font-medium text-slate-500">Designer</th>
                {visibleDays.map(d => (
                  <th key={d.iso} className={`min-w-[96px] px-2 py-2 text-center font-medium ${isToday(d.iso) ? 'text-indigo-700' : d.isHoliday ? 'text-amber-700' : 'text-slate-500'}`}>
                    <div>{d.label}{isToday(d.iso) && <span className="ml-1 rounded bg-indigo-600 px-1 text-[10px] text-white">Today</span>}</div>
                    <div className="text-xs font-normal">{d.isHoliday ? 'Holiday' : d.dateStr}</div>
                  </th>
                ))}
                <th className="min-w-[96px] px-3 py-2 text-center font-medium text-slate-500">Week</th>
              </tr>
            </thead>
            <tbody>
              {people.map(x => {
                const weekHours = visibleDays.reduce((s, d) => s + x.days[d.i].hours, 0);
                const weekUsual = visibleDays.reduce((s, d) => s + x.days[d.i].usualHours, 0);
                const weekCut   = weekUsual - weekHours > HOURS_SLACK;
                return (
                  <tr key={x.id} className="border-b border-slate-50">
                    <td className="sticky left-0 z-10 bg-white px-4 py-2">
                      <div className="font-medium text-slate-800">{x.name}</div>
                      {x.isManager && <div className="text-xs text-violet-600">Manager</div>}
                    </td>
                    {visibleDays.map(d => {
                      const c = cellInfo(x, d.i);
                      const off = c.day.hours <= 0;
                      const box = off
                        ? (c.cut && !d.isHoliday ? 'bg-amber-50 text-amber-700 ring-amber-300' : 'bg-slate-50 text-slate-400 ring-slate-200')
                        : c.cut ? 'bg-amber-100 text-amber-800 ring-amber-300' : 'bg-indigo-50 text-indigo-800 ring-indigo-200';
                      const tip = [
                        off ? 'Off' : `Scheduled ${hrs(c.day.hours)}`,
                        c.day.usualHours > 0 ? `usual ${hrs(c.day.usualHours)}` : null,
                        c.day.actualFrames != null ? `${c.day.actualFrames} frames done` : null,
                        c.earned != null ? `= ${hrs(c.earned)} of work` : null,
                      ].filter(Boolean).join(' · ');
                      return (
                        <td key={d.iso} className={`px-2 py-2 text-center ${isToday(d.iso) ? 'bg-indigo-50/40' : ''}`} title={tip}>
                          <div className={`mx-auto w-20 rounded-lg px-2 py-1.5 ring-1 ${box}`}>
                            <div className="font-semibold tabular-nums">{off ? (d.isHoliday ? 'Holiday' : 'Off') : hrs(c.day.hours)}</div>
                            {c.cut && !d.isHoliday && <div className="text-[11px]">usually {hrs(c.day.usualHours)}</div>}
                          </div>
                          {c.behind && <div className="mt-1 text-xs font-semibold text-red-600">✕ {r1(c.earned ?? 0)} of {hrs(c.day.hours)}</div>}
                          {c.hit && <div className="mt-1 text-xs font-semibold text-green-700">✓ {c.day.actualFrames} frames</div>}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-center">
                      <div className="font-semibold tabular-nums text-slate-800">{hrs(weekHours)}</div>
                      {weekCut && <div className="text-xs text-amber-700">usually {hrs(weekUsual)}</div>}
                    </td>
                  </tr>
                );
              })}
              {/* Team coverage row */}
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="sticky left-0 z-10 bg-slate-50 px-4 py-2">
                  <div className="font-semibold text-slate-800">Team hours</div>
                  <div className="text-xs text-slate-500">scheduled vs normal day</div>
                </td>
                {visibleDays.map(d => {
                  const t = teamDay[d.i];
                  const short = t.short > 0 && !d.isHoliday;
                  return (
                    <td key={d.iso} className="px-2 py-2 text-center">
                      <div className={`font-semibold tabular-nums ${short ? 'text-red-700' : 'text-slate-800'}`}>{hrs(t.scheduled)}</div>
                      {short
                        ? <div className="text-xs font-semibold text-red-600">✕ {hrs(t.short)} short</div>
                        : t.scheduled > 0 && <div className="text-xs text-green-700">✓ covered</div>}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-center">
                  <div className="font-semibold tabular-nums text-slate-800">{hrs(weekScheduledHours)}</div>
                  {frameGap > 0.5 && <div className="text-xs font-semibold text-red-600">need +{hrs(hoursGap)}</div>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Hours come from the roster and any one-off changes on{' '}
          <button onClick={p.onOpenThisWeek} className="font-medium text-indigo-600 hover:text-indigo-800">This Week</button>
          {' '}— edit there. &ldquo;Hit hours&rdquo; compares frames finished (MT production × each designer&apos;s hours-per-frame) to hours scheduled.
        </div>
      </div>
    </div>
  );
}
