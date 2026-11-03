'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import type { TimeOffPatch } from './TimeOffCalendar';
import { parseTimeOffRows, matchPerson, rowToDays, type TimeOffSheet, type TimeOffSheetRow } from '@/lib/timeOffImport';

// "+ Time off" button beside "+ Add availability" on the department This Week
// grids. Writes the same roster daysOff / hoursOff the Time Off calendar uses,
// so a whole day off resolves to 0 scheduled hours and a partial day takes its
// hours off the shift (see isDayOff / hoursOffOn in src/lib/scheduleResolution.ts).
// A Rippling time-off export can be uploaded here too: approved requests for
// people on this team are ticked to add, anything not approved is flagged.

export interface TimeOffPerson {
  id:        string;
  name:      string;
  daysOff?:  string[];
  hoursOff?: Record<string, number>;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

interface ImportItem {
  key:     string;
  row:     TimeOffSheetRow;
  person:  TimeOffPerson | null;
  days:    { date: string; hoursOff: number | null }[];
  already: boolean;               // every day is already off on the roster
}

function readSheet(file: File): Promise<TimeOffSheet> {
  return file.arrayBuffer().then(buf => {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
    return parseTimeOffRows(XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' }));
  });
}

function rangeLabel(r: TimeOffSheetRow): string {
  return r.start === r.end ? fmtDate(r.start) : `${fmtDate(r.start)} – ${fmtDate(r.end)}`;
}

export function AddTimeOffButton({ people, onSave, defaultDate, disabled = false }: {
  people:       TimeOffPerson[];
  onSave:       (patches: Record<string, TimeOffPatch>) => void;   // one call, every changed person
  defaultDate?: string;
  disabled?:    boolean;
}) {
  const [open, setOpen] = useState(false);
  if (disabled) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded text-slate-700 hover:bg-slate-50">
        + Time off
      </button>
      {open && (
        <TimeOffModal people={people} defaultDate={defaultDate} onClose={() => setOpen(false)}
          onSave={patches => { onSave(patches); setOpen(false); }} />
      )}
    </>
  );
}

function TimeOffModal({ people, defaultDate, onClose, onSave }: {
  people:       TimeOffPerson[];
  defaultDate?: string;
  onClose:      () => void;
  onSave:       (patches: Record<string, TimeOffPatch>) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [from,     setFrom]     = useState(defaultDate ?? '');
  const [to,       setTo]       = useState('');
  const [allDay,   setAllDay]   = useState(true);
  const [hours,    setHours]    = useState('4');
  // Removals staged in the modal, saved together with any new time off
  const [removed,  setRemoved]  = useState<Record<string, string[]>>({});
  const [sheet,    setSheet]    = useState<{ fileName: string; data: TimeOffSheet } | null>(null);
  const [sheetErr, setSheetErr] = useState<string | null>(null);
  const [picked,   setPicked]   = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const imports: ImportItem[] = useMemo(() => (sheet?.data.rows ?? []).map(row => {
    const person = matchPerson(row.name, people);
    const days = rowToDays(row);
    const already = !!person && days.every(d => person.daysOff?.includes(d.date) || (d.hoursOff != null && (person.hoursOff?.[d.date] ?? 0) >= d.hoursOff));
    return { key: `${row.rowNumber}`, row, person, days, already };
  }), [sheet, people]);
  const onTeam    = imports.filter(i => i.person);
  const notOnTeam = imports.filter(i => !i.person);

  async function loadFile(file: File) {
    setSheetErr(null);
    try {
      const data = await readSheet(file);
      if (!data.columns.name || !data.columns.start) {
        setSheet(null);
        setSheetErr(`Couldn't find ${!data.columns.name ? 'an employee name' : 'a start date'} column in ${file.name}.`);
        return;
      }
      setSheet({ fileName: file.name, data });
      // Approved requests for people on this team start ticked
      setPicked(new Set(data.rows.flatMap(row => {
        const person = matchPerson(row.name, people);
        return person && row.status === 'approved' ? [`${row.rowNumber}`] : [];
      })));
    } catch (e) {
      setSheet(null);
      setSheetErr(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const today = defaultDate ?? new Date().toISOString().slice(0, 10);
  // Upcoming time off already on the roster, soonest first
  const upcoming = useMemo(() => people.flatMap(p => {
    const dates = new Set([...(p.daysOff ?? []), ...Object.keys(p.hoursOff ?? {}).filter(d => (p.hoursOff?.[d] ?? 0) > 0)]);
    return [...dates].filter(d => d >= today && !removed[p.id]?.includes(d)).map(d => ({
      person: p, date: d, hours: p.daysOff?.includes(d) ? null : p.hoursOff?.[d] ?? null,
    }));
  }).sort((a, b) => a.date.localeCompare(b.date) || a.person.name.localeCompare(b.person.name)), [people, removed, today]);

  const hoursNum = parseFloat(hours);
  const adding = selected.length > 0;
  const importing = onTeam.filter(i => picked.has(i.key) && !i.already && i.row.status !== 'denied');
  const error =
    !adding && importing.length === 0 && Object.keys(removed).length === 0 ? (sheet ? 'Tick at least one request' : 'Pick at least one person')
    : adding && !from ? 'Pick a date'
    : adding && to && to < from ? '"Through" must be on or after the first day'
    : adding && !allDay && !(hoursNum > 0) ? 'Enter the hours off'
    : null;

  function save() {
    if (error) return;
    const dates: string[] = [];
    if (adding) for (let d = from, end = to || from; d <= end && dates.length < 366; d = addDays(d, 1)) dates.push(d);
    const patches: Record<string, TimeOffPatch> = {};
    for (const p of people) {
      const isNew = selected.includes(p.id);
      const drop  = removed[p.id] ?? [];
      const fromSheet = importing.filter(i => i.person?.id === p.id);
      if (!isNew && drop.length === 0 && fromSheet.length === 0) continue;
      const daysOff  = new Set((p.daysOff ?? []).filter(d => !drop.includes(d)));
      const hoursOff = Object.fromEntries(Object.entries(p.hoursOff ?? {}).filter(([d]) => !drop.includes(d)));
      if (isNew) for (const d of dates) {
        if (allDay) { daysOff.add(d); delete hoursOff[d]; }
        else        { daysOff.delete(d); hoursOff[d] = hoursNum; }
      }
      // Sheet rows never shrink time off that's already there
      for (const i of fromSheet) for (const d of i.days) {
        if (daysOff.has(d.date)) continue;
        if (d.hoursOff == null) { daysOff.add(d.date); delete hoursOff[d.date]; }
        else hoursOff[d.date] = Math.max(hoursOff[d.date] ?? 0, d.hoursOff);
      }
      patches[p.id] = { daysOff: [...daysOff].sort(), hoursOff };
    }
    onSave(patches);
  }

  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const input = 'w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-200';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="w-[460px] max-w-full max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-slate-800">Add time off</h3>
        <p className="mt-0.5 text-xs text-slate-400">Takes the hours off their schedule — a whole day counts as 0 scheduled hours.</p>

        <div className="mt-4 rounded-md border border-dashed border-slate-300 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-600">From a Rippling time-off export</span>
            <button type="button" onClick={() => fileRef.current?.click()}
              className="ml-auto rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50">
              {sheet ? 'Choose another file' : 'Upload sheet'}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ''; }} />
          </div>
          {sheetErr && <p className="mt-2 text-xs text-red-600">{sheetErr}</p>}
          {sheet && (
            <div className="mt-2">
              <p className="text-[11px] text-slate-400">
                {sheet.fileName} · read {Object.entries(sheet.data.columns).map(([k, h]) => `${k}: “${h}”`).join(', ')}
                {sheet.data.skipped > 0 && ` · ${sheet.data.skipped} blank rows skipped`}
              </p>
              {!sheet.data.columns.status && (
                <p className="mt-1 text-[11px] font-medium text-amber-600">No status column found — every request is flagged as not approved.</p>
              )}
              {onTeam.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">No one on this sheet is on this team.</p>
              ) : (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
                  {onTeam.map(i => {
                    const denied = i.row.status === 'denied';
                    const flagged = i.row.status === 'pending' || i.row.status === 'unknown';
                    const hoursNote = i.days.some(d => d.hoursOff != null) ? `${i.days[0].hoursOff}h/day` : 'Whole day' + (i.days.length > 1 ? 's' : '');
                    return (
                      <label key={i.key} className={`flex items-start gap-2 px-2 py-1.5 text-xs ${flagged ? 'bg-amber-50' : ''} ${denied || i.already ? 'text-slate-400' : 'text-slate-600 cursor-pointer'}`}>
                        <input type="checkbox" className="mt-0.5 rounded" disabled={denied || i.already}
                          checked={picked.has(i.key) && !denied && !i.already}
                          onChange={() => setPicked(s => { const n = new Set(s); if (n.has(i.key)) n.delete(i.key); else n.add(i.key); return n; })} />
                        <span className="flex-1">
                          <span className="font-medium text-slate-700">{i.person!.name}</span> · {rangeLabel(i.row)} · {hoursNote}
                          {i.row.policy && <span className="text-slate-400"> · {i.row.policy}</span>}
                        </span>
                        {i.already ? <span className="shrink-0 text-[10px]">Already added</span>
                          : denied ? <span className="shrink-0 text-[10px]">{i.row.rawStatus || 'Declined'} — not added</span>
                          : flagged ? <span className="shrink-0 rounded bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-700">⚠ Not approved{i.row.rawStatus ? ` · ${i.row.rawStatus}` : ''}</span>
                          : <span className="shrink-0 text-[10px] font-medium text-green-600">Approved</span>}
                      </label>
                    );
                  })}
                </div>
              )}
              {notOnTeam.length > 0 && (
                <details className="mt-1.5 text-[11px] text-slate-400">
                  <summary className="cursor-pointer">{notOnTeam.length} request{notOnTeam.length === 1 ? '' : 's'} for people not on this team</summary>
                  <p className="mt-1">{[...new Set(notOnTeam.map(i => i.row.name))].join(', ')}</p>
                </details>
              )}
            </div>
          )}
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
            {people.map(p => (
              <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} className="rounded" />
                {p.name}
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-slate-600">First day
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={`mt-1 ${input}`} />
          </label>
          <label className="text-xs font-medium text-slate-600">Through <span className="font-normal text-slate-400">(optional)</span>
            <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className={`mt-1 ${input}`} />
          </label>
        </div>

        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} className="rounded" />
            Whole day
          </label>
          {!allDay && (
            <label className="mt-2 block text-xs font-medium text-slate-600">Hours off each day
              <input type="number" min="0.5" step="0.5" value={hours} onChange={e => setHours(e.target.value)} className={`mt-1 w-24 ${input}`} />
            </label>
          )}
        </div>

        {upcoming.length > 0 && (
          <div className="mt-5">
            <span className="text-xs font-medium text-slate-600">Upcoming time off</span>
            <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
              {upcoming.map(u => (
                <div key={`${u.person.id}-${u.date}`} className="flex items-center gap-2 px-2 py-1 text-xs text-slate-600">
                  <span className="font-medium text-slate-700">{u.person.name}</span>
                  <span>{fmtDate(u.date)}</span>
                  <span className="text-red-500">{u.hours == null ? 'Day off' : `${u.hours}h off`}</span>
                  <button type="button" onClick={() => setRemoved(r => ({ ...r, [u.person.id]: [...(r[u.person.id] ?? []), u.date] }))}
                    className="ml-auto text-slate-400 hover:text-red-600">Remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {error && <span className="mr-auto text-xs text-slate-400">{error}</span>}
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={save} disabled={!!error}
            className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40">
            Save time off
          </button>
        </div>
      </div>
    </div>
  );
}
