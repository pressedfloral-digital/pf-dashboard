'use client';

import { WEEKDAY_LABELS, type ScheduleRule } from '@/lib/scheduleResolution';

// Per-member schedule rules — date-bounded replacements for the standard
// schedule ("Feb–May: Mon/Wed/Fri only") that a manager can switch on and
// off without deleting them. Like EmploymentDatesEditor this stays collapsed
// to a single "+ Add rule" link until a member actually has one. See
// ScheduleRule in src/lib/scheduleResolution.ts for how rules resolve: a
// blank day follows the standard schedule, 0 is a day off, and an explicit
// "This Week" entry always wins over a rule.

const todayIso = () => new Date().toISOString().split('T')[0];

function newRuleId() {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isActiveToday(r: ScheduleRule): boolean {
  const t = todayIso();
  return r.enabled && (!r.startDate || r.startDate <= t) && (!r.endDate || r.endDate >= t);
}

export function ScheduleRulesEditor({ rules, standardWeeklyHours, onChange }: {
  rules?: ScheduleRule[];
  standardWeeklyHours?: number[];
  onChange: (rules: ScheduleRule[]) => void;
}) {
  const list = rules ?? [];

  function patch(id: string, p: Partial<ScheduleRule>) {
    onChange(list.map(r => (r.id === id ? { ...r, ...p } : r)));
  }
  function setDay(r: ScheduleRule, di: number, value: number | null) {
    patch(r.id, { hours: Array.from({ length: 7 }, (_, j) => (j === di ? value : r.hours[j] ?? null)) });
  }
  function addRule() {
    onChange([...list, { id: newRuleId(), label: '', enabled: true, startDate: todayIso(), hours: [null, null, null, null, null, null, null] }]);
  }

  if (list.length === 0) {
    return <button onClick={addRule} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Add rule</button>;
  }

  return (
    <div className="space-y-1.5 min-w-0">
      {list.map(r => {
        const active = isActiveToday(r);
        return (
          <div key={r.id}
            className={`flex items-center gap-2 flex-wrap rounded border px-2 py-1 ${r.enabled ? 'border-indigo-100 bg-indigo-50/40' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
            <label className="flex items-center gap-1 cursor-pointer" title={r.enabled ? 'Rule is on — click to pause it' : 'Rule is off — click to turn it on'}>
              <input type="checkbox" checked={r.enabled} onChange={e => patch(r.id, { enabled: e.target.checked })}
                className="accent-indigo-500" />
              <span className={`text-[10px] font-medium ${r.enabled ? 'text-indigo-600' : 'text-slate-400'}`}>{r.enabled ? 'On' : 'Off'}</span>
            </label>
            <input type="text" value={r.label ?? ''} placeholder="Rule name (e.g. Spring semester)"
              onChange={e => patch(r.id, { label: e.target.value })}
              className="w-40 border border-slate-200 rounded px-1.5 py-0.5 text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            <label className="flex items-center gap-1">
              <span className="text-[9px] text-slate-400">From</span>
              <input type="date" value={r.startDate ?? ''} onChange={e => patch(r.id, { startDate: e.target.value || undefined })}
                className="border border-slate-200 rounded px-1 py-0.5 text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-[9px] text-slate-400">To</span>
              <input type="date" value={r.endDate ?? ''} onChange={e => patch(r.id, { endDate: e.target.value || undefined })}
                title="Leave blank to keep the rule going with no end date"
                className="border border-slate-200 rounded px-1 py-0.5 text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
            </label>
            <div className="flex items-end gap-1">
              {WEEKDAY_LABELS.map((label, di) => {
                const v = r.hours[di];
                const std = standardWeeklyHours?.[di] ?? 0;
                return (
                  <label key={di} className="flex flex-col items-center gap-0.5">
                    <button type="button"
                      onClick={() => setDay(r, di, v === 0 ? null : 0)}
                      title={v === 0 ? `${label}: day off — click to follow the standard schedule` : `${label}: click to make this a day off`}
                      className={`text-[9px] leading-none ${v === 0 ? 'text-red-400 line-through' : 'text-slate-400 hover:text-indigo-600'}`}>
                      {label[0]}
                    </button>
                    <input type="number" min="0" step="0.5"
                      value={v == null ? '' : v}
                      placeholder={String(std || 0)}
                      onChange={e => setDay(r, di, e.target.value === '' ? null : (parseFloat(e.target.value) || 0))}
                      title={`${label}: blank follows the standard schedule (${std}h), 0 is a day off`}
                      className={`w-9 border rounded px-0.5 py-0.5 text-center text-[11px] bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 placeholder:text-slate-300 ${v == null ? 'border-slate-200 text-slate-400' : v === 0 ? 'border-red-200 text-red-400' : 'border-indigo-200 text-indigo-600'}`} />
                  </label>
                );
              })}
            </div>
            <button type="button"
              onClick={() => patch(r.id, { hours: [0, 0, 0, 0, 0, 0, 0] })}
              title="Every day off for this date range"
              className="text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 bg-white hover:border-indigo-300 hover:text-indigo-600">
              Off
            </button>
            {active && <span className="text-[9px] font-medium text-emerald-600 bg-emerald-50 rounded px-1">active now</span>}
            <button onClick={() => onChange(list.filter(x => x.id !== r.id))}
              title="Delete this rule" className="ml-auto text-slate-300 hover:text-red-400 text-sm leading-none px-0.5">×</button>
          </div>
        );
      })}
      <button onClick={addRule} className="text-[10px] text-slate-400 hover:text-indigo-600">+ Add another rule</button>
    </div>
  );
}
