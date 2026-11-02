// Read-only lookalikes of the This Week inputs, so the 52-week grids' cells
// match the This Week "bubbles" without being editable.
const WEEKLY_READONLY_TITLE = 'Set on the Roster (standard schedule) or the This Week tab (one-off exceptions) — Weekly Schedule is a read-only view';

export function WeekBubble({ value }: { value: number }) {
  return (
    <div title={WEEKLY_READONLY_TITLE}
      className={`w-14 mx-auto border rounded px-1.5 py-1 text-center bg-white tabular-nums ${value ? 'border-slate-200 text-slate-700' : 'border-slate-100 text-slate-300'}`}>
      {value || 0}
    </div>
  );
}

export function WeekTotalBubble({ value }: { value: number }) {
  return (
    <div title="Total hours (production + managerial)"
      className="w-14 mx-auto mt-0.5 border border-violet-200 rounded px-1.5 py-0.5 text-center text-[10px] text-violet-600 bg-violet-50 tabular-nums">
      {value}h
    </div>
  );
}
