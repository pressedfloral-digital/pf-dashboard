'use client';

// Unavailability & preferred hours — "can't work then" / "would like to work
// then" markers that sit on the schedule grids. Unlike Time Off (daysOff /
// hoursOff on the roster), these never change scheduled hours or pay: they're
// a visual signal, and a manager can still schedule over them, in which case
// the cell shows a conflict.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { WEEKDAY_LABELS } from '@/lib/scheduleResolution';
import { SHIFT_TONE, type ShiftTone } from './ScheduleBlocks';

export interface UnavailabilityEntry {
  id:         string;
  personId:   string;
  personName: string;
  kind:       'unavailable' | 'preferred';   // 'preferred' is shown as Available
  date:       string;                // ISO; first occurrence when repeating
  repeat:     'none' | 'weekly';
  weekdays?:  number[];              // weekly only: 0=Mon … 6=Sun; unset = weekday of `date`
  until?:     string;                // inclusive last date for weekly; blank = no end
  skip?:      string[];              // weekly dates removed individually
  allDay:     boolean;
  start?:     string;                // 'HH:MM' when !allDay
  end?:       string;
  note?:      string;
  createdAt:  string;
  fromStandard?: boolean;            // derived from the roster's standard schedule, never saved
  fromDefault?:  boolean;            // derived "unavailable" for a day with no available time, never saved
}

export interface AvailabilityPerson { id: string; name: string; group?: string }

// 0=Mon … 6=Sun, matching WEEKDAY_LABELS and the roster rules
function weekdayOf(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

export function weekdaysOf(e: UnavailabilityEntry): number[] {
  return e.weekdays?.length ? e.weekdays : [weekdayOf(e.date)];
}

export function entriesOn(list: UnavailabilityEntry[] | undefined, personId: string, iso: string): UnavailabilityEntry[] {
  if (!list?.length) return [];
  return list.filter(e => {
    if (e.personId !== personId) return false;
    if (e.repeat === 'none') return e.date === iso;
    if (iso < e.date || (e.until && iso > e.until) || e.skip?.includes(iso)) return false;
    return weekdaysOf(e).includes(weekdayOf(iso));
  });
}

// The roster's standard schedule counts as the preferred schedule: a day with
// standard hours and no hand-entered preference becomes "prefers 9am + those hours".
export function withStandardPreferred(entries: UnavailabilityEntry[], personId: string, personName: string, iso: string, standardHours: number): UnavailabilityEntry[] {
  if (!(standardHours > 0) || entries.some(e => e.kind === 'preferred')) return entries;
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const start = 9 * 60;
  return [...entries, {
    id: `std-${personId}-${iso}`, personId, personName, kind: 'preferred', date: iso, repeat: 'none',
    allDay: false, start: hhmm(start), end: hhmm(start + Math.round(standardHours * 4) * 15), createdAt: '', fromStandard: true,
  }];
}

// A day with no available time (none entered, no standard-schedule hours) is
// unavailable. Derived only — it never moves a shift (see fitShift).
export function withDefaultUnavailable(entries: UnavailabilityEntry[], personId: string, personName: string, iso: string): UnavailabilityEntry[] {
  if (entries.some(e => e.kind === 'preferred' || (e.kind === 'unavailable' && e.allDay))) return entries;
  return [...entries, {
    id: `none-${personId}-${iso}`, personId, personName, kind: 'unavailable', date: iso, repeat: 'none',
    allDay: true, createdAt: '', fromDefault: true,
  }];
}

export function isUnavailableAllDay(list: UnavailabilityEntry[] | undefined, personId: string, iso: string) {
  return entriesOn(list, personId, iso).some(e => e.kind === 'unavailable' && e.allDay);
}

function fmtTime(t?: string) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

export function entryTimeLabel(e: UnavailabilityEntry) {
  return e.allDay ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`;
}

// "Full day" / "Partial day · 3pm–6pm" — how unavailability reads on hover
function unavailableSpan(e: UnavailabilityEntry) {
  return e.allDay ? 'Full day' : `Partial day · ${fmtTime(e.start)}–${fmtTime(e.end)}`;
}

// ── Show/hide toggle (per viewer, like Connecteam's "availability status") ──

const SHOW_KEY = 'pf-show-availability';
const SHOW_EVENT = 'pf-show-availability-change';

// Kept in memory too, so the toggle still works when storage is blocked.
let showMemo: boolean | null = null;

function readShow() {
  if (showMemo === null) {
    try { showMemo = localStorage.getItem(SHOW_KEY) !== '0'; } catch { showMemo = true; }
  }
  return showMemo;
}

function subscribeShow(cb: () => void) {
  window.addEventListener(SHOW_EVENT, cb);
  return () => window.removeEventListener(SHOW_EVENT, cb);
}

export function useShowAvailability(): [boolean, (v: boolean) => void] {
  const show = useSyncExternalStore(subscribeShow, readShow, () => true);
  const set = (v: boolean) => {
    showMemo = v;
    try { localStorage.setItem(SHOW_KEY, v ? '1' : '0'); } catch { /* storage blocked */ }
    window.dispatchEvent(new Event(SHOW_EVENT));
  };
  return [show, set];
}

export function AvailabilityToggle() {
  const [show, setShow] = useShowAvailability();
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none" title="Show or hide unavailability and preferred hours on the grid">
      <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} className="rounded" />
      Show availability
    </label>
  );
}

// ── Chips inside a day cell ─────────────────────────────────────────────────

export function AvailabilityChips({ entries, iso, scheduled, onChange, list, hoverReveal = false }: {
  entries:   UnavailabilityEntry[];
  hoverReveal?: boolean;           // details appear only while the day square is hovered (Master Schedule)
  iso:       string;
  scheduled: boolean;              // person has hours that day → unavailable is a conflict
  list:      UnavailabilityEntry[];
  onChange:  (next: UnavailabilityEntry[]) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  // On a scheduled day only real unavailability matters (as a conflict);
  // available time and the automatic "no available time" marker are hidden.
  const shown = scheduled ? entries.filter(e => e.kind === 'unavailable' && !e.fromDefault) : entries;
  if (shown.length === 0) return null;
  const remove   = (id: string) => onChange(list.filter(e => e.id !== id));
  const skipDay  = (id: string) => onChange(list.map(e => e.id === id ? { ...e, skip: [...(e.skip ?? []), iso] } : e));
  return (
    <div className="mt-1 space-y-0.5">
      {shown.map(e => {
        const unav = e.kind === 'unavailable';
        const tone = unav
          ? (scheduled ? 'bg-red-100 text-red-700 border-red-300' : 'bg-red-50 text-red-600 border-red-200')
          : 'bg-white text-teal-700 border-teal-300';
        return (
          <div key={e.id} className={hoverReveal && (!unav || !scheduled) && openId !== e.id
            // Details float just under the block while the day square is hovered —
            // except unavailable-but-scheduled, which stays visible as a conflict warning
            ? 'absolute inset-x-0 top-full z-20 mt-0.5 hidden rounded bg-white shadow-md group-hover:block'
            : 'relative'}>
            <button type="button" onClick={() => setOpenId(openId === e.id ? null : e.id)}
              title={`${unav ? `Unavailable · ${unavailableSpan(e)}` : `Available · ${entryTimeLabel(e)}`}${e.note ? ` · ${e.note}` : ''} — click for options`}
              className={`block w-full rounded border px-1 py-px text-left text-[10px] font-medium leading-tight ${tone}`}>
              {unav && scheduled ? (
                // Conflict stays visible in red; full/partial day shows on hover
                <>
                  ⚠ Unavailable
                  <span className={hoverReveal ? 'hidden group-hover:block' : 'block'}>{unavailableSpan(e)}{e.repeat === 'weekly' && <span className="ml-0.5 opacity-60">↻</span>}</span>
                  {e.note && <span className={`truncate font-normal opacity-80 ${hoverReveal ? 'hidden group-hover:block' : 'block'}`}>{e.note}</span>}
                </>
              ) : (
                <>
                  {unav ? (e.fromDefault ? 'No available time' : unavailableSpan(e)) : `Available · ${entryTimeLabel(e)}`}
                  {e.repeat === 'weekly' && <span className="ml-0.5 opacity-60" title="Repeats weekly">↻</span>}
                  {e.note && <span className="block truncate font-normal opacity-80">{e.note}</span>}
                </>
              )}
            </button>
            {openId === e.id && (
              <div className="absolute left-0 top-full z-30 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-2 text-left text-[11px] text-slate-600 shadow-lg">
                <div className="font-semibold text-slate-800">{unav ? 'Unavailable' : 'Available'}</div>
                <div>{unav ? unavailableSpan(e) : entryTimeLabel(e)}{e.repeat === 'weekly' ? ` · every ${weekdaysOf(e).map(d => WEEKDAY_LABELS[d]).join(', ')} from ${e.date}${e.until ? ` until ${e.until}` : ''}` : ''}</div>
                {e.note && <div className="mt-0.5 italic text-slate-500">{e.note}</div>}
                {e.fromStandard && <div className="mt-0.5 text-slate-500">From their standard schedule — change it on the roster.</div>}
                {e.fromDefault && <div className="mt-0.5 text-slate-500">No available time set for this day — use + Add availability to add some.</div>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {!e.fromStandard && !e.fromDefault && e.repeat === 'weekly' && (
                    <button type="button" onClick={() => { skipDay(e.id); setOpenId(null); }}
                      className="rounded border border-slate-200 px-1.5 py-0.5 hover:bg-slate-50">Remove this day</button>
                  )}
                  {!e.fromStandard && !e.fromDefault && <button type="button" onClick={() => { remove(e.id); setOpenId(null); }}
                    className="rounded border border-red-200 px-1.5 py-0.5 text-red-600 hover:bg-red-50">
                    {e.repeat === 'weekly' ? 'Delete every week' : 'Delete'}
                  </button>}
                  <button type="button" onClick={() => setOpenId(null)} className="ml-auto px-1 text-slate-400 hover:text-slate-600">Close</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Add button + modal ──────────────────────────────────────────────────────

export function AddUnavailabilityButton({ people, list, onChange, defaultDate }: {
  people:       AvailabilityPerson[];
  list:         UnavailabilityEntry[];
  onChange:     (next: UnavailabilityEntry[]) => void;
  defaultDate?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded text-slate-700 hover:bg-slate-50">
        + Add availability
      </button>
      {open && (
        <UnavailabilityModal people={people} defaultDate={defaultDate} onClose={() => setOpen(false)}
          onSave={entries => { onChange([...list, ...entries]); setOpen(false); }} />
      )}
    </>
  );
}

function UnavailabilityModal({ people, defaultDate, onClose, onSave }: {
  people:       AvailabilityPerson[];
  defaultDate?: string;
  onClose:      () => void;
  onSave:       (entries: UnavailabilityEntry[]) => void;
}) {
  const [kind,     setKind]     = useState<'unavailable' | 'preferred'>('preferred');
  const [selected, setSelected] = useState<string[]>([]);
  const [date,     setDate]     = useState(defaultDate ?? '');
  const [allDay,   setAllDay]   = useState(true);
  const [start,    setStart]    = useState('09:00');
  const [end,      setEnd]      = useState('17:00');
  const [repeat,   setRepeat]   = useState<'none' | 'weekly'>('none');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [until,    setUntil]    = useState('');
  const [note,     setNote]     = useState('');

  const groups = useMemo(() => {
    const m = new Map<string, AvailabilityPerson[]>();
    people.forEach(p => { const g = p.group ?? ''; m.set(g, [...(m.get(g) ?? []), p]); });
    return [...m.entries()];
  }, [people]);

  const error =
    selected.length === 0 ? 'Pick at least one person'
    : !date ? (repeat === 'weekly' ? 'Pick a start date' : 'Pick a date')
    : repeat === 'weekly' && weekdays.length === 0 ? 'Pick at least one day of the week'
    : !allDay && (!start || !end || start >= end) ? 'End time must be after start time'
    : repeat === 'weekly' && until && until < date ? '"Until" must be on or after the date'
    : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save() {
    if (error) return;
    const now = new Date().toISOString();
    onSave(selected.map(personId => ({
      id: crypto.randomUUID(), personId, personName: people.find(p => p.id === personId)?.name ?? '',
      kind, date, repeat,
      weekdays: repeat === 'weekly' ? [...weekdays].sort((a, b) => a - b) : undefined,
      until: repeat === 'weekly' && until ? until : undefined,
      allDay, start: allDay ? undefined : start, end: allDay ? undefined : end,
      note: note.trim() || undefined, createdAt: now,
    })));
  }

  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const input = 'w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-200';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="w-[460px] max-w-full max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-slate-800">Add availability</h3>
        <p className="mt-0.5 text-xs text-slate-400">Shows on the schedule only — it doesn&apos;t change scheduled hours or pay. Use Time Off for that.</p>

        <div className="mt-4 inline-flex rounded-lg border border-slate-200 p-0.5 text-xs">
          {([['preferred', 'Available'], ['unavailable', 'Unavailable']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1 font-medium ${kind === k ? (k === 'unavailable' ? 'bg-red-50 text-red-600' : 'bg-teal-50 text-teal-700') : 'text-slate-500'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">Team members</span>
            <button type="button" className="text-[11px] text-sky-600 hover:underline"
              onClick={() => setSelected(selected.length === people.length ? [] : people.map(p => p.id))}>
              {selected.length === people.length ? 'Clear' : 'Select all'}
            </button>
          </div>
          <div className="max-h-44 overflow-y-auto rounded-md border border-slate-200 p-2">
            {groups.map(([g, ps]) => (
              <div key={g} className="mb-1">
                {g && <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{g}</div>}
                {ps.map(p => (
                  <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} className="rounded" />
                    {p.name}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs">
            {([['none', 'Specific date'], ['weekly', 'Days of the week']] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setRepeat(k)}
                className={`rounded-md px-3 py-1 font-medium ${repeat === k ? 'bg-slate-100 text-slate-800' : 'text-slate-500'}`}>
                {label}
              </button>
            ))}
          </div>
          {repeat === 'none' ? (
            <label className="mt-3 block text-xs font-medium text-slate-600">Date
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`mt-1 ${input}`} />
            </label>
          ) : (
            <>
              <div className="mt-3 flex gap-1">
                {WEEKDAY_LABELS.map((label, di) => {
                  const on = weekdays.includes(di);
                  return (
                    <button key={di} type="button"
                      onClick={() => setWeekdays(w => on ? w.filter(x => x !== di) : [...w, di])}
                      className={`flex-1 rounded-md border py-1.5 text-xs font-medium ${on ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-slate-600">Starting
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`mt-1 ${input}`} />
                </label>
                <label className="text-xs font-medium text-slate-600">Until <span className="font-normal text-slate-400">(optional)</span>
                  <input type="date" value={until} min={date} onChange={e => setUntil(e.target.value)} className={`mt-1 ${input}`} />
                </label>
              </div>
            </>
          )}
        </div>

        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} className="rounded" />
            All day
          </label>
          {!allDay && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="text-xs font-medium text-slate-600">From
                <input type="time" value={start} onChange={e => setStart(e.target.value)} className={`mt-1 ${input}`} />
              </label>
              <label className="text-xs font-medium text-slate-600">To
                <input type="time" value={end} onChange={e => setEnd(e.target.value)} className={`mt-1 ${input}`} />
              </label>
            </div>
          )}
        </div>

        <label className="mt-4 block text-xs font-medium text-slate-600">Note <span className="font-normal text-slate-400">(optional)</span>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. class, appointment" className={`mt-1 ${input}`} />
        </label>

        <div className="mt-5 flex items-center justify-end gap-2">
          {error && <span className="mr-auto text-xs text-slate-400">{error}</span>}
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={save} disabled={!!error}
            className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40">
            Save {kind === 'unavailable' ? 'unavailability' : 'availability'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Hours scheduled: place a day's hours on the clock ───────────────────────
// Hours are stored as a number per day, not a start/end, so the time shown is
// derived: start at the person's preferred-to-work time for that day, or 9–5
// when there isn't one, and step past any partial-day unavailability.

const DEFAULT_WINDOW = { start: 9 * 60, end: 17 * 60 };

const toMin = (t?: string) => { const [h, m] = (t ?? '0:0').split(':').map(Number); return h * 60 + (m || 0); };

function fmtMin(min: number) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

export function fitShift(entries: UnavailabilityEntry[], hours: number): { start: number; end: number; source: 'preferred' | 'default' } | null {
  if (hours <= 0) return null;
  if (entries.some(e => e.kind === 'unavailable' && e.allDay && !e.fromDefault)) return null;
  const pref = entries.find(e => e.kind === 'preferred' && !e.allDay && e.start && e.end);
  const source = pref ? 'preferred' as const : 'default' as const;
  let start = pref ? toMin(pref.start) : DEFAULT_WINDOW.start;
  const dur = Math.round(hours * 4) * 15; // nearest quarter hour
  const blocks = entries
    .filter(e => e.kind === 'unavailable' && !e.allDay && e.start && e.end)
    .map(e => ({ s: toMin(e.start), e: toMin(e.end) }))
    .sort((a, b) => a.s - b.s);
  // Push the start past any unavailable block the shift would overlap
  for (const b of blocks) if (start < b.e && start + dur > b.s) start = b.e;
  return { start, end: start + dur, source };
}

export function ScheduledTimeBox({ entries, hours, tone }: { entries: UnavailabilityEntry[]; hours: number; tone: ShiftTone }) {
  const fit = fitShift(entries, hours);
  if (!fit) return null;
  return (
    <div className={`mb-1 rounded-md border px-1.5 py-0.5 text-left leading-tight ${SHIFT_TONE[tone]}`}
      title={fit.source === 'preferred' ? 'Hours scheduled — placed in their available time' : 'Hours scheduled — no preferred time, so placed from 9am'}>
      <div className="text-[9px] font-medium uppercase tracking-wide opacity-60">Hours scheduled</div>
      <div className="text-[11px] font-semibold">{fmtMin(fit.start)}–{fmtMin(fit.end)}</div>
    </div>
  );
}
