'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveDayHours, isWithinEmployment, type DailyHoursMap, type ScheduleRule } from '@/lib/scheduleResolution';

// Days-off calendar shown under each department's roster editor. A day off
// is stored on the roster member (daysOff, ISO dates) and resolves to 0
// scheduled hours ahead of any template, rule or "This Week" entry — see
// isDayOff in src/lib/scheduleResolution.ts. Actuals never read the
// schedule, so marking (or unmarking) a past day off can't change them.
//
// Collapsed by default under the roster. Cells only show time off: red for a
// whole day, light red with the hours for part of a day (hoursOff, set from
// the right-click menu). Hovering any day shows the hours it's scheduled for.

export interface TimeOffMember {
  id:                   string;
  name:                 string;
  standardWeeklyHours?: number[];
  scheduleRules?:       ScheduleRule[];
  startDate?:           string;
  endDate?:             string;
  daysOff?:             string[];
  hoursOff?:            Record<string, number>;
}

export type TimeOffPatch = { daysOff?: string[]; hoursOff?: Record<string, number> };

// One department's rows. The Master Schedule passes several; a roster
// passes its own members/dailyMap/onChange, wrapped as a single section.
export interface TimeOffSection {
  key:      string;
  label:    string;
  members:  TimeOffMember[];
  // The department's "This Week" daily map, keyed `${weekIso}-${memberId}`,
  // used for the scheduled hours shown on hover.
  dailyMap: DailyHoursMap;
  // The member's new daysOff/hoursOff — merge onto their roster entry.
  onChange: (memberId: string, next: TimeOffPatch) => void;
}

type View = 'month' | 'week';
type Paint = { section: string; memberId: string; off: boolean; dates: Set<string> };

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

export function TimeOffCalendar({ members, dailyMap, onChange, sections, title: dropdownTitle = 'Days off', holidays, canEdit }: {
  members?:  TimeOffMember[];
  dailyMap?: DailyHoursMap;
  onChange?: (memberId: string, next: TimeOffPatch) => void;
  // Several departments at once, each under its own heading (Master Schedule).
  sections?: TimeOffSection[];
  title?:    string;
  holidays:  string[];
  canEdit:   boolean;
}) {
  const groups: TimeOffSection[] = sections
    ?? [{ key: '', label: '', members: members ?? [], dailyMap: dailyMap ?? {}, onChange: onChange ?? (() => {}) }];
  const today = localTodayIso();
  const [open, setOpen]     = useState(false);
  const [view, setView]     = useState<View>('month');
  // Hover tooltip, positioned against the viewport so the table's
  // horizontal scroll container can't clip it.
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [anchor, setAnchor] = useState(today);

  // Click-and-drag painting along one person's row: the first cell decides
  // whether the drag marks days off or clears them.
  const [paint, setPaint] = useState<Paint | null>(null);
  const paintRef = useRef(paint);
  const groupsRef = useRef(groups);
  useEffect(() => { paintRef.current = paint; groupsRef.current = groups; });

  // Whole days off and partial hours off never overlap on one date: setting
  // either clears the other for that date.
  function setTimeOff(section: string, memberId: string, dates: string[], value: 'day' | number | null) {
    const g = groupsRef.current.find(x => x.key === section);
    const m = g?.members.find(x => x.id === memberId);
    if (!g || !m) return;
    const days = new Set(m.daysOff ?? []);
    const hrsOff = { ...(m.hoursOff ?? {}) };
    for (const d of dates) {
      days.delete(d);
      delete hrsOff[d];
      if (value === 'day') days.add(d);
      else if (typeof value === 'number' && value > 0) hrsOff[d] = value;
    }
    g.onChange(memberId, {
      daysOff:  days.size ? [...days].sort() : undefined,
      hoursOff: Object.keys(hrsOff).length ? hrsOff : undefined,
    });
  }
  const setTimeOffRef = useRef(setTimeOff);
  useEffect(() => { setTimeOffRef.current = setTimeOff; });
  useEffect(() => {
    function finish() {
      const p = paintRef.current;
      if (!p) return;
      setPaint(null);
      if (p.dates.size) setTimeOffRef.current(p.section, p.memberId, [...p.dates], p.off ? 'day' : null);
    }
    window.addEventListener('mouseup', finish);
    return () => window.removeEventListener('mouseup', finish);
  }, []);

  // Right-click menu for taking part of a day off.
  const [menu, setMenu] = useState<{ section: string; memberId: string; name: string; iso: string; scheduled: number; value: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest?.('[data-timeoff-menu]')) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close); };
  }, [menu]);

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

  // `hours` is what the day is scheduled for ignoring the day off (the same
  // resolution This Week uses), so an off day can say what it removes.
  function cellState(m: TimeOffMember, iso: string, dailyMap: DailyHoursMap): { state: 'off' | 'partial' | 'open' | 'unemployed'; hours: number; partial: number } {
    const weekIso = mondayOf(iso);
    const di = (new Date(iso + 'T12:00:00').getDay() + 6) % 7;
    const employment = { weekIso, startDate: m.startDate, endDate: m.endDate, rules: m.scheduleRules };
    if (!isWithinEmployment(di, employment)) return { state: 'unemployed', hours: 0, partial: 0 };
    const { hours } = resolveDayHours(dailyMap, `${weekIso}-${m.id}`, di, m.standardWeeklyHours, employment, holidays);
    const partial = m.hoursOff?.[iso] ?? 0;
    return { state: m.daysOff?.includes(iso) ? 'off' : partial > 0 ? 'partial' : 'open', hours, partial };
  }
  const hrs = (h: number) => `${Math.round(h * 100) / 100}h`;

  const allMembers = groups.flatMap(g => g.members);
  const upcomingOff = allMembers.reduce((n, m) =>
    n + (m.daysOff ?? []).filter(d => d >= today).length + Object.keys(m.hoursOff ?? {}).filter(d => d >= today).length, 0);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
        ▼ {dropdownTitle}{upcomingOff > 0 && <span className="ml-1.5 text-xs font-normal text-red-500">{upcomingOff} upcoming</span>}
      </button>
    );
  }

  const compact = view === 'month';
  const cellW = compact ? 'min-w-[28px] w-[28px]' : 'min-w-[64px]';
  // Someone on two rosters counts once.
  const offCount = (iso: string) => new Set(allMembers.filter(m => m.daysOff?.includes(iso)).map(m => m.name.trim().toLowerCase())).size;

  return (
    <div className="border border-slate-100 rounded-xl">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => { setOpen(false); setTip(null); }} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
            ▲ {dropdownTitle}
          </button>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {canEdit ? 'Click a day to mark it off, drag across a row to mark several, or right-click to take some hours off. Hover a day to see its scheduled hours. ' : 'Hover a day to see its scheduled hours. '}
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
            {groups.filter(g => g.members.length > 0).flatMap(g => [
              g.label ? (
                <tr key={`h-${g.key}`}>
                  <td colSpan={dates.length + 1} className="sticky left-0 bg-slate-50/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{g.label}</td>
                </tr>
              ) : null,
              ...g.members.map(m => {
              const offInView = dates.filter(iso => m.daysOff?.includes(iso)).length;
              return (
                <tr key={`${g.key}:${m.id}`} className="border-t border-slate-50">
                  <td className="sticky left-0 z-10 bg-white px-3 py-1 text-slate-700 whitespace-nowrap">
                    {m.name}
                    {offInView > 0 && <span className="ml-1.5 text-[10px] text-red-500">{offInView} off</span>}
                  </td>
                  {dates.map(iso => {
                    const { state: saved, hours, partial } = cellState(m, iso, g.dailyMap);
                    const sameRow = paint?.section === g.key && paint.memberId === m.id;
                    const painting = sameRow && paint!.dates.has(iso);
                    // While dragging, preview the result of the drag.
                    const state = painting ? (paint!.off ? 'off' : 'open') : saved;
                    const employed = state !== 'unemployed';
                    const day = fmt(iso, { weekday: 'short', month: 'short', day: 'numeric' });
                    const holiday = holidays.includes(iso) ? ' · paid holiday' : '';
                    const label = `${m.name} · ${day}: ${
                      state === 'unemployed' ? 'not employed'
                      : state === 'off' ? `requested off${hours > 0 ? ` (was ${hrs(hours)} scheduled)` : ''}`
                      : state === 'partial' ? `${hrs(partial)} off · ${hrs(Math.max(0, hours - partial))} of ${hrs(hours)} scheduled`
                      : hours > 0 ? `${hrs(hours)} scheduled` : 'not scheduled'}${holiday}`;
                    return (
                      <td key={iso} className={`${cellW} p-0.5`}
                        onMouseEnter={e => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setTip({ text: label, x: r.left + r.width / 2, y: r.top });
                        }}
                        onMouseLeave={() => setTip(null)}
                        onContextMenu={e => {
                          if (!canEdit || !employed) return;
                          e.preventDefault();
                          setTip(null);
                          setMenu({ section: g.key, memberId: m.id, name: m.name, iso, scheduled: hours, value: partial ? String(partial) : '',
                            x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 170) });
                        }}>
                        <button type="button" disabled={!canEdit || !employed} aria-label={label} aria-pressed={state === 'off'}
                          onMouseDown={e => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            setPaint({ section: g.key, memberId: m.id, off: saved !== 'off', dates: new Set([iso]) });
                          }}
                          onMouseEnter={() => {
                            if (!sameRow || paint!.dates.has(iso)) return;
                            setPaint({ ...paint!, dates: new Set([...paint!.dates, iso]) });
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTimeOff(g.key, m.id, [iso], saved === 'off' ? null : 'day'); }
                          }}
                          className={`w-full ${compact ? 'h-6' : 'h-8'} rounded text-[10px] leading-none transition-colors border ${
                            state === 'unemployed' ? 'bg-slate-100 border-transparent cursor-not-allowed'
                            : state === 'off' ? 'bg-red-100 border-red-300 text-red-600 font-semibold'
                            : state === 'partial' ? 'bg-red-50 border-red-200 text-red-500'
                            : 'bg-white border-slate-200'
                          } ${canEdit && employed ? 'hover:border-indigo-400 cursor-pointer' : ''} ${painting ? 'ring-1 ring-indigo-400' : ''}`}>
                          {state === 'off' ? 'Off' : state === 'partial' ? `−${Math.round(partial * 10) / 10}` : ''}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
              }),
            ])}
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
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-50 border border-red-200" /> Hours off (right-click)</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-white border border-slate-200" /> Available — hover for scheduled hours</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-slate-100" /> Not employed yet / anymore</span>
      </div>
      {menu && (() => {
        const n = parseFloat(menu.value);
        const valid = n > 0;
        const save = () => { if (valid) { setTimeOff(menu.section, menu.memberId, [menu.iso], n); setMenu(null); } };
        return (
          <div data-timeoff-menu style={{ left: menu.x, top: menu.y }}
            className="fixed z-50 w-56 rounded-lg border border-slate-200 bg-white p-3 shadow-lg text-xs">
            <div className="font-medium text-slate-700">{menu.name}</div>
            <div className="text-slate-400 mb-2">
              {fmt(menu.iso, { weekday: 'short', month: 'short', day: 'numeric' })} · {menu.scheduled > 0 ? `${hrs(menu.scheduled)} scheduled` : 'not scheduled'}
            </div>
            <label className="flex items-center gap-2 mb-2">
              <span className="text-slate-500">Hours off</span>
              <input type="number" min="0" step="0.5" autoFocus value={menu.value}
                onChange={e => setMenu({ ...menu, value: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') save(); }}
                className="w-16 border border-slate-200 rounded px-1.5 py-1 text-center text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300" />
              <button onClick={save} disabled={!valid}
                className="px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-40">Save</button>
            </label>
            <div className="flex gap-2">
              <button onClick={() => { setTimeOff(menu.section, menu.memberId, [menu.iso], 'day'); setMenu(null); }}
                className="flex-1 px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50">Whole day off</button>
              <button onClick={() => { setTimeOff(menu.section, menu.memberId, [menu.iso], null); setMenu(null); }}
                className="flex-1 px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Clear</button>
            </div>
          </div>
        );
      })()}
      {tip && !paint && (
        <div role="tooltip" style={{ left: tip.x, top: tip.y - 6 }}
          className="fixed z-50 -translate-x-1/2 -translate-y-full pointer-events-none whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-[11px] text-white shadow">
          {tip.text}
        </div>
      )}
    </div>
  );
}

// Builds a calendar row from any department's roster entry.
export function toTimeOffMember(id: string, name: string, r?: Omit<TimeOffMember, 'id' | 'name'>): TimeOffMember {
  return {
    id, name,
    standardWeeklyHours: r?.standardWeeklyHours, scheduleRules: r?.scheduleRules,
    startDate: r?.startDate, endDate: r?.endDate, daysOff: r?.daysOff, hoursOff: r?.hoursOff,
  };
}
