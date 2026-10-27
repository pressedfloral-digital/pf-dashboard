'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveDayHours, isWithinEmployment, type DailyHoursMap, type ScheduleRule } from '@/lib/scheduleResolution';

// Days-off calendar shown under each department's roster editor. A day off
// is stored on the roster member (daysOff, ISO dates) and resolves to 0
// scheduled hours ahead of any template, rule or "This Week" entry — see
// isDayOff in src/lib/scheduleResolution.ts. Actuals never read the
// schedule, so marking (or unmarking) a past day off can't change them.
//
// Cells only show availability, never hours: red = requested off, yellow =
// not scheduled that day anyway (template/rule/override resolves to 0),
// blank = scheduled.

export interface TimeOffMember {
  id:                   string;
  name:                 string;
  standardWeeklyHours?: number[];
  scheduleRules?:       ScheduleRule[];
  startDate?:           string;
  endDate?:             string;
  daysOff?:             string[];
}

type View = 'month' | 'week';
type Paint = { memberId: string; off: boolean; dates: Set<string> };

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}
function mondayOf(iso: string): string {
  const day = new Date(iso + 'T12:00:00').getDay();
  return addDays(iso, day === 0 ? -6 : 1 - day);
}
function localTodayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmt(iso: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', opts);
}

export function TimeOffCalendar({ members, dailyMap, holidays, canEdit, onChange }: {
  members:  TimeOffMember[];
  // The department's "This Week" daily map, keyed `${weekIso}-${memberId}`,
  // used to tell scheduled days from unscheduled ones.
  dailyMap: DailyHoursMap;
  holidays: string[];
  canEdit:  boolean;
  // Mark (off=true) or clear (off=false) these dates for one member.
  onChange: (memberId: string, dates: string[], off: boolean) => void;
}) {
  const today = localTodayIso();
  const [view, setView]     = useState<View>('month');
  const [anchor, setAnchor] = useState(today);

  // Click-and-drag painting along one person's row: the first cell decides
  // whether the drag marks days off or clears them.
  const [paint, setPaint] = useState<Paint | null>(null);
  const paintRef = useRef(paint);
  useEffect(() => { paintRef.current = paint; }, [paint]);
  useEffect(() => {
    function finish() {
      const p = paintRef.current;
      if (!p) return;
      setPaint(null);
      if (p.dates.size) onChange(p.memberId, [...p.dates], p.off);
    }
    window.addEventListener('mouseup', finish);
    return () => window.removeEventListener('mouseup', finish);
  }, [onChange]);

  const dates = useMemo(() => {
    if (view === 'week') {
      const mon = mondayOf(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    }
    const first = anchor.slice(0, 8) + '01';
    const out: string[] = [];
    for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) out.push(d);
    return out;
  }, [view, anchor]);

  function shift(dir: -1 | 1) {
    if (view === 'week') { setAnchor(addDays(anchor, 7 * dir)); return; }
    const d = new Date(anchor.slice(0, 8) + '01T12:00:00');
    d.setMonth(d.getMonth() + dir);
    setAnchor(d.toISOString().split('T')[0]);
  }

  const title = view === 'week'
    ? `${fmt(dates[0], { month: 'short', day: 'numeric' })} – ${fmt(dates[6], { month: 'short', day: 'numeric', year: 'numeric' })}`
    : fmt(dates[0], { month: 'long', year: 'numeric' });

  // A requested day off always reads as off, even on a day that wasn't
  // going to be worked anyway; otherwise scheduled vs not comes from the
  // same resolution This Week uses.
  function cellState(m: TimeOffMember, iso: string): 'off' | 'unscheduled' | 'scheduled' | 'unemployed' {
    const weekIso = mondayOf(iso);
    const di = (new Date(iso + 'T12:00:00').getDay() + 6) % 7;
    const employment = { weekIso, startDate: m.startDate, endDate: m.endDate, rules: m.scheduleRules };
    if (!isWithinEmployment(di, employment)) return 'unemployed';
    if (m.daysOff?.includes(iso)) return 'off';
    const { hours } = resolveDayHours(dailyMap, `${weekIso}-${m.id}`, di, m.standardWeeklyHours, employment, holidays);
    return hours > 0 ? 'scheduled' : 'unscheduled';
  }

  const compact = view === 'month';
  const cellW = compact ? 'min-w-[28px] w-[28px]' : 'min-w-[64px]';
  const offCount = (iso: string) => members.filter(m => m.daysOff?.includes(iso)).length;

  return (
    <div className="border border-slate-100 rounded-xl">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h4 className="text-sm font-semibold text-slate-700">Days off</h4>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {canEdit ? 'Click a day to mark it off, or drag across a row to mark several. ' : ''}
            Days off schedule 0 hours and override This Week. Actuals aren’t affected.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            {(['month', 'week'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-3 py-1.5 capitalize ${view === v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                {v}
              </button>
            ))}
          </div>
          <button onClick={() => shift(-1)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">←</button>
          <button onClick={() => setAnchor(today)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">Today</button>
          <button onClick={() => shift(1)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50">→</button>
          <span className="text-sm font-medium text-slate-700 min-w-[9rem] text-right">{title}</span>
        </div>
      </div>

      <div className="overflow-x-auto select-none">
        <table className={`text-xs border-collapse ${compact ? '' : 'w-full'}`}>
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium text-slate-500 min-w-[150px]">Team member</th>
              {dates.map(iso => {
                const dow = new Date(iso + 'T12:00:00').getDay();
                const weekend = dow === 0 || dow === 6;
                const holiday = holidays.includes(iso);
                return (
                  <th key={iso} title={holiday ? 'Paid holiday' : undefined}
                    className={`${cellW} px-0.5 py-1.5 text-center font-medium ${holiday ? 'text-amber-700' : weekend ? 'text-slate-400' : 'text-slate-500'}`}>
                    <div className="text-[9px] uppercase">{fmt(iso, { weekday: compact ? 'narrow' : 'short' })}</div>
                    <div className={iso === today ? 'inline-block rounded-full bg-indigo-600 text-white px-1' : ''}>
                      {compact ? Number(iso.slice(8)) : fmt(iso, { month: 'short', day: 'numeric' })}
                    </div>
                    {holiday && <div className="text-[8px] font-semibold text-amber-600">HOL</div>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {members.map(m => {
              const offInView = dates.filter(iso => m.daysOff?.includes(iso)).length;
              return (
                <tr key={m.id} className="border-t border-slate-50">
                  <td className="sticky left-0 z-10 bg-white px-3 py-1 text-slate-700 whitespace-nowrap">
                    {m.name}
                    {offInView > 0 && <span className="ml-1.5 text-[10px] text-red-500">{offInView} off</span>}
                  </td>
                  {dates.map(iso => {
                    const saved = cellState(m, iso);
                    const painting = paint?.memberId === m.id && paint.dates.has(iso);
                    // While dragging, preview the result: marking shows red,
                    // clearing shows the day as scheduled.
                    const state = painting
                      ? (paint!.off ? 'off' : saved === 'off' ? 'scheduled' : saved)
                      : saved;
                    const employed = state !== 'unemployed';
                    const label = `${m.name} · ${fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' })}: ${
                      state === 'off' ? 'requested off' : state === 'unscheduled' ? 'not scheduled' : state === 'unemployed' ? 'not employed' : 'scheduled'}`;
                    return (
                      <td key={iso} className={`${cellW} p-0.5`}>
                        <button type="button" disabled={!canEdit || !employed} title={label} aria-label={label} aria-pressed={state === 'off'}
                          onMouseDown={e => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            setPaint({ memberId: m.id, off: saved !== 'off', dates: new Set([iso]) });
                          }}
                          onMouseEnter={() => {
                            if (paint?.memberId !== m.id || paint.dates.has(iso)) return;
                            setPaint({ ...paint, dates: new Set([...paint.dates, iso]) });
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(m.id, [iso], saved !== 'off'); }
                          }}
                          className={`w-full ${compact ? 'h-6' : 'h-8'} rounded text-[10px] leading-none transition-colors border ${
                            state === 'unemployed' ? 'bg-slate-100 border-transparent cursor-not-allowed'
                            : state === 'off' ? 'bg-red-100 border-red-300 text-red-600 font-semibold'
                            : state === 'unscheduled' ? 'bg-yellow-100 border-yellow-200'
                            : 'bg-white border-slate-200'
                          } ${canEdit && employed ? 'hover:border-indigo-400 cursor-pointer' : ''} ${painting ? 'ring-1 ring-indigo-400' : ''}`}>
                          {state === 'off' ? 'Off' : ''}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="border-t border-slate-200">
              <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-[10px] font-medium text-slate-400">People off</td>
              {dates.map(iso => {
                const n = offCount(iso);
                return <td key={iso} className={`${cellW} text-center text-[10px] ${n ? 'text-red-500 font-semibold' : 'text-slate-300'}`}>{n || '·'}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2.5 border-t border-slate-100 flex items-center gap-4 flex-wrap text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-100 border border-red-300" /> Requested off</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-yellow-100 border border-yellow-200" /> Not scheduled</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-white border border-slate-200" /> Scheduled</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-slate-100" /> Not employed yet / anymore</span>
      </div>
    </div>
  );
}

// Builds a calendar row from any department's roster entry.
export function toTimeOffMember(id: string, name: string, r?: Omit<TimeOffMember, 'id' | 'name'>): TimeOffMember {
  return {
    id, name,
    standardWeeklyHours: r?.standardWeeklyHours, scheduleRules: r?.scheduleRules,
    startDate: r?.startDate, endDate: r?.endDate, daysOff: r?.daysOff,
  };
}

// Applies a mark/clear to a member's stored daysOff list.
export function applyDaysOff(list: string[] | undefined, dates: string[], off: boolean): string[] | undefined {
  const set = new Set(list ?? []);
  dates.forEach(d => (off ? set.add(d) : set.delete(d)));
  return set.size ? [...set].sort() : undefined;
}
