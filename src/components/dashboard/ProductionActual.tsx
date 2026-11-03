'use client';

// Live "Actual" readouts shown under the planned numbers on each department's
// This Week grid — counts come from useProductionAssignmentCounts.

import { useState } from 'react';
import type { AssignmentDepartment } from '@/lib/assignment-counts';
import { SyncedOrdersPopover } from './SyncedOrdersPopover';

export function sumActuals(values: (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length > 0 ? available.reduce((sum, value) => sum + value, 0) : null;
}

// A single person's count can open the orders behind it; team totals can't.
interface ActualDrill { name: string; start: string; end: string; department: AssignmentDepartment }

export function ProductionActual({ value, loading, unit, drill }: { value: number | null; loading: boolean; unit: string; drill?: ActualDrill }) {
  const [open, setOpen] = useState(false);
  const label = `Actual ${loading && value === null ? '…' : `${value ?? '—'}${value === null ? '' : unit}`}`;
  const cls = 'mt-0.5 text-[10px] font-semibold text-sky-600 tabular-nums';
  if (!drill || !value) return <div className={cls} title="Live assignment count from the production app">{label}</div>;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={`${cls} block mx-auto underline decoration-dotted underline-offset-2 hover:text-sky-800 cursor-pointer`}
        title="Live assignment count from the production app — click to see the orders">
        {label}
      </button>
      {open && (
        <SyncedOrdersPopover name={drill.name} department={drill.department} start={drill.start} end={drill.end}
          syncedCount={value} countLabel="actual" onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function ProductionActualsStatus({ loading, error, refreshedAt }: { loading: boolean; error: string | null; refreshedAt: string | null }) {
  if (error) return <span className="text-[11px] font-medium text-red-600" title={error}>Production actuals unavailable</span>;
  if (loading) return <span className="text-[11px] text-slate-400">Loading production actuals…</span>;
  if (!refreshedAt) return null;
  return (
    <span className="text-[11px] text-sky-600" title="Uses the same MT assignment totals as Support Assistant">
      MT actuals · updated {new Date(refreshedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
    </span>
  );
}
