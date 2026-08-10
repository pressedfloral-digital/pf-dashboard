'use client';

import { useState } from 'react';

// Collapsed by default — most roster members never have either date set, so
// showing two empty date pickers per person on every roster (× 4 departments)
// is pure clutter. Each side reveals its own input on click and collapses
// back to a "+ Set …" link when cleared. See src/lib/scheduleResolution.ts
// for how startDate/endDate drive automatic hour zeroing.
export function EmploymentDatesEditor({ startDate, endDate, onStartDateChange, onEndDateChange }: {
  startDate?: string;
  endDate?:   string;
  onStartDateChange: (value: string) => void;
  onEndDateChange:   (value: string) => void;
}) {
  const [startRevealed, setStartRevealed] = useState(false);
  const [endRevealed,   setEndRevealed]   = useState(false);
  const showStart = startRevealed || !!startDate;
  const showEnd   = endRevealed   || !!endDate;

  if (!showStart && !showEnd) {
    return (
      <div className="flex items-center gap-3">
        <button onClick={() => setStartRevealed(true)} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Set start date</button>
        <button onClick={() => setEndRevealed(true)} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Set last day</button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {showStart ? (
        <label className="flex items-center gap-1">
          <span className="text-[9px] text-slate-300">Start</span>
          <input type="date" value={startDate ?? ''}
            onChange={e => onStartDateChange(e.target.value)}
            title="First scheduled day — hours are 0 before this date"
            className="border border-slate-200 rounded px-1.5 py-0.5 text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          <button onClick={() => { onStartDateChange(''); setStartRevealed(false); }}
            title="Clear start date" className="text-slate-300 hover:text-red-400 text-xs leading-none px-0.5">×</button>
        </label>
      ) : (
        <button onClick={() => setStartRevealed(true)} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Set start date</button>
      )}
      {showEnd ? (
        <label className="flex items-center gap-1">
          <span className="text-[9px] text-slate-300">Last day</span>
          <input type="date" value={endDate ?? ''}
            onChange={e => onEndDateChange(e.target.value)}
            title="Last scheduled day — hours automatically go to 0 after this date"
            className="border border-slate-200 rounded px-1.5 py-0.5 text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
          <button onClick={() => { onEndDateChange(''); setEndRevealed(false); }}
            title="Clear last day" className="text-slate-300 hover:text-red-400 text-xs leading-none px-0.5">×</button>
        </label>
      ) : (
        <button onClick={() => setEndRevealed(true)} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Set last day</button>
      )}
    </div>
  );
}
