'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveDayHours, isWithinEmployment, type DailyHoursMap, type ScheduleRule } from '@/lib/scheduleResolution';

// Time Off — one calendar for marking whole days off across every
// department's roster. A day off is stored on the roster member (daysOff, ISO
// dates) and resolves to 0 scheduled hours ahead of any template, rule or
// "This Week" entry — see isDayOff in src/lib/scheduleResolution.ts. Actuals
// never read the schedule, so marking (or unmarking) a past day off can't
// change them.
//
// The same person can sit on more than one roster (e.g. a manager on Design
// and Resin); the parent applies a change to every roster entry with the
// same name, so someone off is off everywhere.

export interface TimeOffMember {
  id:                   string;
  name:                 string;
  standardWeeklyHours?: number[];
  scheduleRules?:       ScheduleRule[];
  startDate?:           string;
  endDate?:             string;
  daysOff?:             string[];
}

export interface TimeOffDept {
  key:      string;
  label:    string;
  members:  TimeOffMember[];
  // The department's "This Week" daily map, keyed `${weekIso}-${memberId}`,
  // so each cell can show the hours that day would otherwise have.
  dailyMap: DailyHoursMap;
}

type View = 'month' | 'week';

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
const round1 = (n: number) => Math.round(n * 10) / 10;

export function TimeOffCalendar({ depts, holidays, canEdit, onChange }: {
  depts:    TimeOffDept[];
  holidays: string[];
  canEdit:  boolean;
  // Mark (off=true) or clear (off=false) these dates for everyone named `name`.
  onChange: (name: string, dates: string[], off: boolean) => void;
}) {
  const today = localTodayIso();
  const [view, setView]     = useState<View>('month');
  const [anchor, setAnchor] = useState(today);

  // Click-and-drag painting along one person's row: the first cell decides
  // whether the drag marks days off or clears them.
  const [paint, setPaint] = useState<{ rowKey: string; name: string; off: boolean; dates: Set<string> } | null>(null);
  const paintRef = useRef(paint);
  useEffect(() => { paintRef.current = paint; }, [paint]);
  useEffect(() => {
    function finish() {
      const p = paintRef.current;
      if (!p) return;
      setPaint(null);
      if (p.dates.size) onChange(p.name, [...p.dates], p.off);
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

  // Hours the member would be scheduled that day, ignoring their days off —
  // shown in each cell so a manager can see what marking it off removes.
  function cellInfo(dept: TimeOffDept, m: TimeOffMember, iso: string) {
    const weekIso = mondayOf(iso);
    const di = (new Date(iso + 'T12:00:00').getDay() + 6) % 7;
    const employment = { weekIso, startDate: m.startDate, endDate: m.endDate, rules: m.scheduleRules };
    const employed = isWithinEmployment(di, employment);
    const { hours } = resolveDayHours(dept.dailyMap, `${weekIso}-${m.id}`, di, m.standardWeeklyHours, employment, holidays);
    return { employed, hours, off: !!m.daysOff?.includes(iso) };
  }

  const compact = view === 'month';
  const cellW = compact ? 'min-w-[30px] w-[30px]' : 'min-w-[72px]';

  const offCountByDate = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const dept of depts) for (const m of dept.members) for (const d of m.daysOff ?? []) {
      if (!names.has(d)) names.set(d, new Set());
      names.get(d)!.add(m.name.trim().toLowerCase());
    }
    return names;
  }, [depts]);

  return (
    <div className="bg-white border border-slate-100 rounded-xl">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Time off</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {canEdit ? 'Click a day to mark it off, or drag across a row to mark several. ' : ''}
            Days off schedule 0 hours and override anything entered in This Week. Actuals aren’t affected.
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
              <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-medium text-slate-500 min-w-[160px]">Team member</th>
              {dates.map(iso => {
                const dow = new Date(iso + 'T12:00:00').getDay();
                const weekend = dow === 0 || dow === 6;
                const holiday = holidays.includes(iso);
                return (
                  <th key={iso} title={holiday ? 'Paid holiday' : undefined}
                    className={`${cellW} px-0.5 py-1.5 text-center font-medium ${holiday ? 'bg-amber-50 text-amber-700' : weekend ? 'bg-slate-50 text-slate-400' : 'text-slate-500'} ${iso === today ? 'text-indigo-600' : ''}`}>
                    <div className="text-[9px] uppercase">{fmt(iso, { weekday: compact ? 'narrow' : 'short' })}</div>
                    <div className={iso === today ? 'inline-block rounded-full bg-indigo-600 text-white px-1' : ''}>
                      {compact ? Number(iso.slice(8)) : fmt(iso, { month: 'short', day: 'numeric' })}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {depts.filter(d => d.members.length > 0).map(dept => (
              <DeptRows key={dept.key} dept={dept} dates={dates} cellW={cellW} compact={compact}
                holidays={holidays} canEdit={canEdit} paint={paint} setPaint={setPaint}
                cellInfo={cellInfo} onChange={onChange} />
            ))}
            <tr className="border-t border-slate-200">
              <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-[10px] font-medium text-slate-400">People off</td>
              {dates.map(iso => {
                const n = offCountByDate.get(iso)?.size ?? 0;
                return <td key={iso} className={`${cellW} text-center text-[10px] ${n ? 'text-red-500 font-semibold' : 'text-slate-300'}`}>{n || '·'}</td>;
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="px-5 py-3 border-t border-slate-100 flex items-center gap-4 flex-wrap text-[10px] text-slate-400">
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-100 border border-red-200" /> Off</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-white border border-slate-200" /> Scheduled hours</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-50 border border-amber-200" /> Paid holiday</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-slate-100" /> Not employed yet / anymore</span>
      </div>
    </div>
  );
}

function DeptRows({ dept, dates, cellW, compact, holidays, canEdit, paint, setPaint, cellInfo, onChange }: {
  dept:     TimeOffDept;
  dates:    string[];
  cellW:    string;
  compact:  boolean;
  holidays: string[];
  canEdit:  boolean;
  paint:    { rowKey: string; name: string; off: boolean; dates: Set<string> } | null;
  setPaint: (p: { rowKey: string; name: string; off: boolean; dates: Set<string> } | null) => void;
  cellInfo: (dept: TimeOffDept, m: TimeOffMember, iso: string) => { employed: boolean; hours: number; off: boolean };
  onChange: (name: string, dates: string[], off: boolean) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={dates.length + 1} className="sticky left-0 bg-slate-50/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {dept.label}
        </td>
      </tr>
      {dept.members.map(m => {
        const rowKey = `${dept.key}:${m.id}`;
        const offInView = dates.filter(iso => m.daysOff?.includes(iso)).length;
        return (
          <tr key={rowKey} className="border-t border-slate-50 hover:bg-slate-50/40">
            <td className="sticky left-0 z-10 bg-white px-3 py-1 text-slate-700 whitespace-nowrap">
              {m.name}
              {offInView > 0 && <span className="ml-1.5 text-[10px] text-red-500">{offInView} off</span>}
            </td>
            {dates.map(iso => {
              const { employed, hours, off: savedOff } = cellInfo(dept, m, iso);
              const painting = paint?.rowKey === rowKey && paint.dates.has(iso);
              const off = painting ? paint!.off : savedOff;
              const holiday = holidays.includes(iso);
              const label = `${m.name} · ${fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' })}: ${
                !employed ? 'not employed' : off ? 'off' : `${round1(hours)}h scheduled`}${holiday ? ' (paid holiday)' : ''}`;
              return (
                <td key={iso} className={`${cellW} p-0.5`}>
                  <button type="button" disabled={!canEdit || !employed} title={label} aria-label={label} aria-pressed={off}
                    onMouseDown={e => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      setPaint({ rowKey, name: m.name, off: !savedOff, dates: new Set([iso]) });
                    }}
                    onMouseEnter={() => {
                      if (paint?.rowKey !== rowKey || paint.dates.has(iso)) return;
                      setPaint({ ...paint, dates: new Set([...paint.dates, iso]) });
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(m.name, [iso], !savedOff); }
                    }}
                    className={`w-full ${compact ? 'h-6' : 'h-9'} rounded text-[10px] leading-none transition-colors border ${
                      !employed ? 'bg-slate-100 border-transparent cursor-not-allowed'
                      : off ? 'bg-red-100 border-red-200 text-red-600 font-semibold'
                      : holiday ? 'bg-amber-50 border-amber-100 text-amber-600'
                      : hours > 0 ? 'bg-white border-slate-200 text-slate-500'
                      : 'bg-white border-slate-100 text-slate-300'
                    } ${canEdit && employed ? 'hover:border-indigo-300 cursor-pointer' : ''} ${painting ? 'ring-1 ring-indigo-400' : ''}`}>
                    {!employed ? '' : off ? 'Off' : hours > 0 ? (compact ? round1(hours) : `${round1(hours)}h`) : ''}
                  </button>
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
