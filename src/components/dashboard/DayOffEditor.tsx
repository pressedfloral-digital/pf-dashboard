'use client';

import { useState } from 'react';

// Lets a manager record specific dates a roster member has requested off.
// Adding a date zeroes that day's hours in the department's DailyHoursMap
// (via onAdd, wired up in SchedulePage.tsx) so it shows up as 0 hours on
// both "This Week" and the read-only Weekly Schedule / 52-week planner —
// both already resolve through that same map, see
// src/lib/scheduleResolution.ts. Removing a date reverts that day back to
// the standard schedule (unless it's since been hand-edited to something
// other than 0, in which case only the request itself is cleared).
export function DayOffEditor({ dates, onAdd, onRemove }: {
  dates: string[];
  onAdd:    (dateIso: string) => void;
  onRemove: (dateIso: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState('');

  function submit() {
    if (!pending) return;
    onAdd(pending);
    setPending('');
    setAdding(false);
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {dates.map(dateIso => (
        <span key={dateIso}
          className="flex items-center gap-1 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 whitespace-nowrap">
          {new Date(dateIso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          <button onClick={() => onRemove(dateIso)} title="Cancel this day off"
            className="text-amber-400 hover:text-red-500 leading-none">×</button>
        </span>
      ))}
      {adding ? (
        <span className="flex items-center gap-1">
          <input type="date" value={pending} autoFocus
            onChange={e => setPending(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setAdding(false); setPending(''); } }}
            className="border border-slate-200 rounded px-1.5 py-0.5 text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          <button onClick={submit} className="text-[10px] text-indigo-600 hover:text-indigo-800 font-medium">Add</button>
          <button onClick={() => { setAdding(false); setPending(''); }}
            title="Cancel" className="text-slate-300 hover:text-red-400 text-xs leading-none px-0.5">×</button>
        </span>
      ) : (
        <button onClick={() => setAdding(true)} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Request day off</button>
      )}
    </div>
  );
}
