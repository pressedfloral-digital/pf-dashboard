'use client';

import { DEFAULT_FLOW_DAY_PCTS, TURNAROUND_LABEL, type FlowDay, type FlowWeek, type TurnaroundStatus } from '@/lib/preservationFlow';
import { getWeekLabel } from '@/lib/weekDates';
import { HelpTip } from './HelpTip';

// Preservation → Daily Flow: the Preservation Team Hours Calculator,
// live. Each week's scheduled hours (the 52-week planner) and bouquet
// estimate are spread across the days and pressed oldest first; days already
// past this week use actual received / pressed counts.

export interface PresFlowWeek extends FlowWeek {
  weekIso:    string;
  carryTyped: boolean;   // carry-in typed by hand rather than rolled from last week
}

const STATUS_STYLE: Record<TurnaroundStatus, { chip: string; bar: string; dot: string }> = {
  onTarget: { chip: 'bg-green-50 text-green-700 border-green-200', bar: '#fcd34d', dot: 'bg-green-500' },
  day2:     { chip: 'bg-amber-50 text-amber-700 border-amber-200', bar: '#f59e0b', dot: 'bg-amber-500' },
  past2:    { chip: 'bg-red-50 text-red-600 border-red-200',       bar: '#ef4444', dot: 'bg-red-500' },
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r0 = (n: number) => Math.round(n);

function dayName(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
}

function dayDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

// Five dots, Mon–Fri — shared with the Staffing Check table.
export function TurnaroundDots({ days }: { days: FlowDay[] }) {
  return (
    <span className="inline-flex gap-1">
      {days.map(d => (
        <span key={d.iso} title={`${dayName(d.iso)}: ${TURNAROUND_LABEL[d.status]}`} className={`h-2.5 w-2.5 rounded-full ${STATUS_STYLE[d.status].dot}`} />
      ))}
    </span>
  );
}

function Card({ label, value, sub, tone = 'text-slate-800' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

// Each day: a bar of everything waiting at the start of the day, split into
// what gets pressed (green) and what's still waiting (amber/red by
// turnaround), with the day's press capacity as a dashed line.
function FlowChart({ days }: { days: FlowDay[] }) {
  const W = 640, H = 220, padL = 36, padB = 34, padT = 12;
  const max = Math.max(1, ...days.map(d => Math.max(d.start, d.capacity))) * 1.12;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const slot = (W - padL) / Math.max(1, days.length);
  const barW = Math.min(64, slot * 0.55);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(max / 1.12 * t));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-h-64" role="img" aria-label="Bouquets waiting vs. press capacity by day">
      {ticks.map(t => (
        <g key={t}>
          <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="#f1f5f9" />
          <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{t}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const cx = padL + slot * i + slot / 2;
        const x = cx - barW / 2;
        const capY = y(d.capacity);
        return (
          <g key={d.iso}>
            <rect x={x} y={y(d.done)} width={barW} height={y(0) - y(d.done)} fill="#34d399" rx="2">
              <title>{`${d.actual ? 'Pressed' : 'Pressed (plan)'}: ${r1(d.done)}`}</title>
            </rect>
            {d.remaining > 0.05 && (
              <rect x={x} y={y(d.start)} width={barW} height={y(d.done) - y(d.start)} fill={STATUS_STYLE[d.status].bar} rx="2">
                <title>{`Still waiting at end of day: ${r1(d.remaining)}`}</title>
              </rect>
            )}
            {!d.actual && (
              <line x1={x - 8} x2={x + barW + 8} y1={capY} y2={capY} stroke="#4f46e5" strokeWidth="2" strokeDasharray="4 3">
                <title>{`Press capacity: ${r1(d.capacity)}`}</title>
              </line>
            )}
            <text x={cx} y={y(Math.max(d.start, d.actual ? 0 : d.capacity)) - 5} textAnchor="middle" fontSize="10" fontWeight="600" fill="#334155">{r0(d.start)}</text>
            <text x={cx} y={H - padB + 14} textAnchor="middle" fontSize="10" fill="#475569">{dayName(d.iso)} {dayDate(d.iso)}</text>
            {d.actual && <text x={cx} y={H - padB + 26} textAnchor="middle" fontSize="8" fill="#059669">actual</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function PreservationFlowTab({ location, weeks, offset, onOffsetChange, dayPcts, onDayPctsChange, onCarryInChange, useActuals, onUseActualsChange }: {
  location:         'Utah' | 'Georgia';
  weeks:            PresFlowWeek[];
  offset:           number;
  onOffsetChange:   (w: number) => void;
  dayPcts:          number[];
  onDayPctsChange:  (pcts: number[] | undefined) => void;
  onCarryInChange:  (weekIso: string, n: number | undefined) => void;
  useActuals:       boolean;   // days already past this week use actual received / pressed
  onUseActualsChange: (v: boolean) => void;
}) {
  const week = weeks[offset];
  if (!week) return null;
  const pctTotal = dayPcts.reduce((s, p) => s + p, 0);
  const isDefaultMix = dayPcts.every((p, i) => p === DEFAULT_FLOW_DAY_PCTS[i]);
  const short = week.overShort < -0.05;
  const rows: { label: string; sub?: string; cell: (d: FlowDay) => string; total?: string; strong?: boolean }[] = [
    { label: 'Bouquets coming in', sub: 'est. from the weekly mix, actual for days past', cell: d => String(r1(d.arrivals)), total: String(r1(week.arrivals)) },
    { label: 'Left from previous day', cell: d => String(r1(d.leftIn)) },
    { label: 'Total at start of day', cell: d => String(r1(d.start)), strong: true },
    { label: 'Press capacity', sub: 'scheduled hours ÷ ratio', cell: d => String(r1(d.capacity)), total: String(r1(week.capacity)) },
    { label: 'Pressed', sub: 'plan, or photo uploaded for days past', cell: d => String(r1(d.done)) },
    { label: 'Left at end of day', cell: d => String(r1(d.remaining)), total: `${r1(week.carryOut)} → next wk`, strong: true },
    { label: 'Scheduled hours', cell: d => `${r1(d.hours)}h`, total: `${r1(week.scheduledHours)}h` },
    { label: 'Hours used pressing', cell: d => `${r1(d.hoursUsed)}h` },
    { label: 'Leftover hours', sub: 'scheduled but not needed', cell: d => d.hoursIdle > 0.05 ? `${r1(d.hoursIdle)}h` : '—', total: `${r1(week.hoursIdle)}h` },
    { label: 'Hours short', sub: 'to clear what’s still waiting', cell: d => d.hoursShort > 0.05 ? `${r1(d.hoursShort)}h` : '—' },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-100 rounded-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-slate-700"><HelpTip id="sched.tab.flow">Daily flow — can we press each day&apos;s bouquets within 2 days?</HelpTip></h2>
            <p className="text-xs text-slate-400 mt-1 max-w-3xl">
              The Preservation Team Hours Calculator, live for {location}. Each week&apos;s bouquet estimate is spread across the days by the mix
              below and pressed oldest first, using the hours on the 52-week planner. Anything left on Friday rolls into the next week.
              Days already past this week use actual received and pressed counts. Nothing here changes the schedule, staffing check or historicals.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => onOffsetChange(Math.max(0, offset - 1))} disabled={offset === 0}
              className="px-2 py-1 text-sm rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30">‹</button>
            <span className="px-2 text-sm font-medium text-slate-700 whitespace-nowrap">Week of {getWeekLabel(offset)}</span>
            <button onClick={() => onOffsetChange(Math.min(weeks.length - 1, offset + 1))} disabled={offset >= weeks.length - 1}
              className="px-2 py-1 text-sm rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30">›</button>
            {offset > 0 && <button onClick={() => onOffsetChange(0)} className="ml-1 text-xs text-indigo-600 underline">This week</button>}
            {offset === 0 && (
              <div className="ml-2 flex rounded-lg border border-slate-200 overflow-hidden" title="For days already past this week">
                {([[true, 'Actuals'], [false, 'Plan']] as const).map(([v, name]) => (
                  <button key={name} onClick={() => onUseActualsChange(v)}
                    className={`px-2.5 py-1 text-xs font-medium ${useActuals === v ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
          <div className="rounded-xl border border-slate-100 bg-white px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Waiting Monday morning</div>
            <input
              type="number" min="0" step="1"
              value={week.carryTyped ? r1(week.carryIn) : ''}
              placeholder={String(r1(week.carryIn))}
              onChange={e => onCarryInChange(week.weekIso, e.target.value === '' ? undefined : Math.max(0, parseFloat(e.target.value) || 0))}
              className="mt-0.5 w-20 border border-slate-200 rounded px-1.5 py-0.5 text-lg font-semibold text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-300"
            />
            <div className="text-[10px] text-slate-400">{week.carryTyped ? 'typed in · clear to roll forward' : offset === 0 ? 'type what’s left from last week' : 'rolled from last Friday'}</div>
          </div>
          <Card label="Scheduled hours" value={`${r1(week.scheduledHours)}h`} sub={`${r1(week.capacity)} bouquets capacity`} />
          <Card label="Hours needed" value={`${r1(week.hoursNeeded)}h`} sub={`${r0(week.arrivals)} coming in + ${r0(week.carryIn)} waiting`} />
          <Card label={short ? 'Hours short' : 'Hours over'} value={`${short ? '' : '+'}${r1(Math.abs(week.overShort))}h`} tone={short ? 'text-red-600' : 'text-green-700'} />
          <Card label="Capacity used" value={week.capacityUsed === null ? '—' : `${r0(week.capacityUsed * 100)}%`} sub={`${r1(week.hoursIdle)}h scheduled but unused`} />
          <Card label="Carry into next week" value={`${r1(week.carryOut)}`} sub="bouquets still waiting Friday" tone={week.carryOut > 0.5 ? 'text-amber-600' : 'text-slate-800'} />
          <Card label="Days past 2-day limit" value={String(week.daysPast2)} tone={week.daysPast2 ? 'text-red-600' : 'text-green-700'} />
        </div>

        <div className="rounded-xl border border-slate-100 p-3">
          <FlowChart days={week.days} />
          <div className="flex flex-wrap gap-4 px-2 pt-1 text-[10px] text-slate-500">
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Pressed that day</span>
            <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" /> Still waiting (amber = day 2, red = past 2 days)</span>
            <span className="inline-flex items-center gap-1"><span className="w-4 border-t-2 border-dashed border-indigo-600" /> Press capacity</span>
            <span>Number on top = total waiting at start of day</span>
          </div>
        </div>

        <div className="overflow-x-auto -mx-1">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="text-left font-medium px-2 py-1.5">Daily output</th>
                {week.days.map(d => (
                  <th key={d.iso} className="font-medium px-2 py-1.5 text-center whitespace-nowrap">
                    {dayName(d.iso)} <span className="text-slate-300">{dayDate(d.iso)}</span>
                    {d.actual && <div className="text-[9px] font-normal text-emerald-600">actual</div>}
                  </th>
                ))}
                <th className="font-medium px-2 py-1.5 text-center">Week</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.label} className={`border-t border-slate-50 ${row.strong ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
                  <td className="px-2 py-1.5">
                    {row.label}
                    {row.sub && <div className="text-[9px] font-normal text-slate-400">{row.sub}</div>}
                  </td>
                  {week.days.map(d => <td key={d.iso} className="px-2 py-1.5 text-center">{row.cell(d)}</td>)}
                  <td className="px-2 py-1.5 text-center">{row.total ?? ''}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-100">
                <td className="px-2 py-1.5 text-slate-600">
                  Turnaround
                  <div className="text-[9px] text-slate-400">1-day target, 2-day limit</div>
                </td>
                {week.days.map(d => (
                  <td key={d.iso} className="px-2 py-1.5 text-center">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${STATUS_STYLE[d.status].chip}`}>{TURNAROUND_LABEL[d.status]}</span>
                  </td>
                ))}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-100 rounded-xl p-5">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold text-slate-700">Daily order mix</span>
          <span className="text-[10px] text-slate-400">% of each week&apos;s bouquets arriving each day (both locations)</span>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d, i) => (
            <label key={d} className="flex items-center gap-1 text-xs text-slate-500">
              {d}
              <input
                type="number" min="0" max="100" step="1"
                value={dayPcts[i] ?? 0}
                onChange={e => {
                  const next = [...dayPcts];
                  next[i] = Math.max(0, parseFloat(e.target.value) || 0);
                  onDayPctsChange(next);
                }}
                className="w-12 border border-slate-200 rounded px-1 py-0.5 text-center text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-300"
              />%
            </label>
          ))}
          <span className={`text-xs font-semibold ${pctTotal === 100 ? 'text-green-700' : 'text-red-600'}`}>{pctTotal}%</span>
          {!isDefaultMix && <button onClick={() => onDayPctsChange(undefined)} className="text-xs text-indigo-600 underline">Reset to 5 / 50 / 25 / 15 / 5</button>}
        </div>
      </div>
    </div>
  );
}
