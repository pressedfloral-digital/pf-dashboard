'use client';

// "View" menu for the schedule grids: pick which details each day square
// shows. Choices are per viewer (localStorage) and shared across departments;
// "Availability" is the same setting the old Show availability checkbox used.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useShowAvailability } from './Unavailability';

export type GridViewKey = 'times' | 'hours' | 'output' | 'mgrTotal' | 'actuals' | 'checks' | 'weekend';
export type GridView = Record<GridViewKey, boolean>;

const LABELS: Record<GridViewKey | 'availability', { label: string; hint: string }> = {
  times:        { label: 'Hours scheduled',     hint: 'Start–end time box' },
  hours:        { label: 'Hours',               hint: 'Hours worked that day' },
  output:       { label: 'Frames / orders',     hint: 'Output from each person’s ratio' },
  mgrTotal:     { label: 'Manager total hours', hint: 'Production + managerial' },
  actuals:      { label: 'Actuals',             hint: 'Live counts from production' },
  checks:       { label: 'Check hours',         hint: 'Preservation checks' },
  weekend:      { label: 'Weekends',            hint: 'Sat & Sun columns' },
  availability: { label: 'Availability',        hint: 'Available / unavailable, and people with no hours' },
};

const DEFAULT_VIEW: GridView = { times: true, hours: true, output: true, mgrTotal: true, actuals: true, checks: true, weekend: true };
const VIEW_KEY = 'pf-grid-view';
const VIEW_EVENT = 'pf-grid-view-change';

// Kept in memory too, so the menu still works when storage is blocked.
let viewMemo: GridView | null = null;

function readView(): GridView {
  if (viewMemo === null) {
    try { viewMemo = { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') }; }
    catch { viewMemo = DEFAULT_VIEW; }
  }
  return viewMemo!;
}

function subscribeView(cb: () => void) {
  window.addEventListener(VIEW_EVENT, cb);
  return () => window.removeEventListener(VIEW_EVENT, cb);
}

export function useGridView(): GridView {
  return useSyncExternalStore(subscribeView, readView, () => DEFAULT_VIEW);
}

function setViewOption(key: GridViewKey, on: boolean) {
  viewMemo = { ...readView(), [key]: on };
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewMemo)); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(VIEW_EVENT));
}

export function GridViewMenu({ options }: { options: GridViewKey[] }) {
  const view = useGridView();
  const [showAvail, setShowAvail] = useShowAvailability();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const hiddenCount = options.filter(k => !view[k]).length + (showAvail ? 0 : 1);
  const row = (key: GridViewKey | 'availability', checked: boolean, onToggle: (v: boolean) => void) => (
    <label key={key} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-slate-50">
      <input type="checkbox" checked={checked} onChange={e => onToggle(e.target.checked)} className="mt-0.5 rounded" />
      <span>
        <span className="block text-xs font-medium text-slate-700">{LABELS[key].label}</span>
        <span className="block text-[10px] text-slate-400">{LABELS[key].hint}</span>
      </span>
    </label>
  );

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="px-2.5 py-1 text-xs font-medium border border-slate-200 rounded text-slate-700 hover:bg-slate-50">
        View{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''} ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
          {options.map(k => row(k, view[k], v => setViewOption(k, v)))}
          {row('availability', showAvail, setShowAvail)}
        </div>
      )}
    </div>
  );
}
