'use client';

// Read-only cells for the 52-week grids (Weekly Schedule / Resin 52-week
// planner), drawn with the same blocks, avatars and today-pill as the This
// Week tabs so the two views look alike. Hours are set on the Roster or the
// This Week tab, never here.

import { ShiftBlock, type ShiftTone } from './ScheduleBlocks';
import { round2, type InputMode } from './InputModeToggle';

const READONLY_TITLE = 'Set on the Roster (standard schedule) or the This Week tab (one-off exceptions) — Weekly Schedule is a read-only view';

// "Nov 2" header; this week gets the filled pill like This Week's today.
export function WeekHead({ label, now }: { label: string; now?: boolean }) {
  return (
    <span className={`rounded-full px-3 py-1 text-[13px] whitespace-nowrap ${now ? 'bg-sky-500 text-white font-semibold' : 'text-slate-600 font-medium'}`}>
      {label}
    </span>
  );
}

export function WeekCell({ tone, mode, hours, output, outputUnit, totalHours, paidHours, cpo }: {
  tone:        ShiftTone;
  mode:        InputMode;
  hours:       number;
  output:      number;
  outputUnit:  string;
  totalHours?: number;       // managers: production + managerial, shown when it differs
  paidHours?:  number;       // hourly staff: shown when pay exceeds production (holidays)
  cpo?:        string | null;
}) {
  const working = hours > 0 || (totalHours ?? 0) > 0;
  const hoursLine  = <span className="block text-xs font-semibold">{round2(hours)}h</span>;
  const outputLine = <span className="block text-xs font-semibold">{round2(output)} {outputUnit}</span>;
  return (
    <div title={READONLY_TITLE}>
      <ShiftBlock tone={working ? tone : null}>
        {hours > 0 ? (
          mode === 'output' ? (
            <>{outputLine}<span className="block opacity-70">{round2(hours)}h</span></>
          ) : (
            <>{hoursLine}<span className="block opacity-70">{round2(output)} {outputUnit}</span></>
          )
        ) : (
          <span className="block py-1">{working ? 'No production' : 'No hours'}</span>
        )}
        {totalHours !== undefined && totalHours !== hours && totalHours > 0 && (
          <span className="mt-0.5 block text-[10px] font-medium text-violet-700">{round2(totalHours)}h total</span>
        )}
        {paidHours !== undefined && paidHours > hours && (
          <span className="mt-0.5 block text-[10px] font-medium text-violet-700">{round2(paidHours)}h paid</span>
        )}
        {cpo && <span className="mt-0.5 block text-[10px] text-amber-700">{cpo}</span>}
      </ShiftBlock>
    </div>
  );
}
