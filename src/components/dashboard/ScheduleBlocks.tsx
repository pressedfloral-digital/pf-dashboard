'use client';

// Shared pieces for the shift-block schedule grids (department This Week
// tabs and the Master Schedule): avatar + name column, day headers with a
// pill on today, and coloured day blocks that turn into an input on click.

import { useState, type ReactNode } from 'react';

export type ShiftTone = 'design' | 'preservation' | 'fulfillment' | 'resin';

export const SHIFT_TONE: Record<ShiftTone, string> = {
  design:       'bg-sky-100 border-sky-200 text-sky-900',
  preservation: 'bg-emerald-100 border-emerald-200 text-emerald-900',
  fulfillment:  'bg-amber-100 border-amber-200 text-amber-900',
  resin:        'bg-violet-100 border-violet-200 text-violet-900',
};

export const SHIFT_LABEL: Record<ShiftTone, string> = {
  design: 'Design', preservation: 'Preservation', fulfillment: 'Fulfillment', resin: 'Resin',
};

const AVATAR_TONES = [
  'bg-sky-100 text-sky-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-700',
  'bg-violet-100 text-violet-700', 'bg-rose-100 text-rose-700', 'bg-teal-100 text-teal-700',
  'bg-orange-100 text-orange-700', 'bg-indigo-100 text-indigo-700',
];

export function PersonAvatar({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const initials = ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${AVATAR_TONES[hash % AVATAR_TONES.length]}`}>
      {initials}
    </span>
  );
}

// Name column: avatar, name, then whatever badges the caller passes.
export function PersonCell({ name, grip, children }: { name: string; grip?: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      {grip && <span className="-ml-2 select-none text-sm leading-none text-slate-300" aria-hidden>⠿</span>}
      <PersonAvatar name={name} />
      <div className="min-w-0">
        <div className="font-medium text-slate-800 text-[13px] leading-tight">{name}</div>
        {children}
      </div>
    </div>
  );
}

// "Mon 10/26" header; today gets the filled pill, holidays go amber.
export function DayHead({ label, iso, today, holiday }: { label: string; iso: string; today?: boolean; holiday?: boolean }) {
  const [, m, d] = iso.split('-');
  const text = `${label} ${Number(m)}/${Number(d)}`;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`rounded-full px-3 py-1 text-[13px] whitespace-nowrap ${
        today ? 'bg-sky-500 text-white font-semibold' : holiday ? 'text-amber-700 font-medium' : 'text-slate-600 font-medium'
      }`}>{text}</span>
      {holiday && <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-600">Holiday</span>}
    </div>
  );
}

// Shows its children as a button; clicking swaps in a number input that
// edits live (same as the old always-on inputs) until blur / Enter / Esc.
export function InlineNumber({ value, onChange, step = '0.5', placeholder = '0', title, className = '', inputClassName = '', children }: {
  value:           number | string;
  onChange:        (n: number) => void;
  step?:           string;
  placeholder?:    string;
  title?:          string;
  className?:      string;
  inputClassName?: string;
  children:        ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input type="number" autoFocus min="0" step={step} value={value} placeholder={placeholder} title={title}
        onFocus={e => e.target.select()}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        onBlur={() => setEditing(false)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        className={`w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-center text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-300 ${inputClassName}`} />
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} title={title}
      className={`text-left cursor-text rounded hover:bg-white/60 ${className}`}>
      {children}
    </button>
  );
}

// One person-day. `tone` null = nothing scheduled (dashed "Available").
// `edited` marks a one-off override of the standard schedule.
const STATUS_TONE = {
  holiday:     'border-amber-200 bg-amber-50 text-amber-800',
  unavailable: 'border-red-200 bg-red-50/60 text-red-600',
  preferred:   'border-teal-300 bg-white text-teal-700',
};

export function ShiftBlock({ tone, edited, compact, children }: { tone: ShiftTone | keyof typeof STATUS_TONE | null; edited?: boolean; compact?: boolean; children: ReactNode }) {
  const cls = tone === null
    ? 'border-dashed border-slate-200 bg-white text-slate-400'
    : tone in STATUS_TONE
      ? STATUS_TONE[tone as keyof typeof STATUS_TONE]
      : SHIFT_TONE[tone as ShiftTone];
  return (
    <div className={`relative ${compact ? '' : 'min-h-[52px]'} rounded-lg border px-2 py-1.5 text-left text-[11px] leading-snug ${cls}`}>
      {edited && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-current opacity-50" title="Changed for this day only" />}
      {children}
    </div>
  );
}

// Red outlined "Unavailable" cell for days off.
export function OffBlock({ label = 'Unavailable', sub }: { label?: string; sub?: string }) {
  return (
    <div className="flex min-h-[52px] flex-col items-center justify-center rounded-lg border border-red-200 bg-red-50/60 px-2 py-1.5 text-center text-[11px] leading-snug">
      <span className="font-semibold text-red-600">{label}</span>
      {sub && <span className="text-[10px] text-red-400">{sub}</span>}
    </div>
  );
}

// Archive button for roster rows — archiving hides the member from the
// schedule but keeps their history (it's the roster's `_removed` flag).
export function ArchiveButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Archive team member" aria-label="Archive team member"
      className="flex items-center justify-center text-slate-300 hover:text-amber-600 transition-colors">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
        <rect x="2.5" y="3.5" width="15" height="4" rx="1" />
        <path d="M4 7.5v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8M8 11h4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

// Collapsible list of archived members under a roster, each with Restore.
export function ArchivedMembers({ members, onRestore }: { members: { id: string; name: string }[]; onRestore: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (members.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-slate-100">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50">
        <span>Archived team members ({members.length})</span>
        <span className="text-slate-400">{open ? '▲ Hide' : '▼ Show'}</span>
      </button>
      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {members.map(m => (
            <li key={m.id} className="flex items-center gap-2.5 px-3 py-2">
              <PersonAvatar name={m.name} />
              <span className="flex-1 text-sm text-slate-500">{m.name}</span>
              <button type="button" onClick={() => onRestore(m.id)}
                className="rounded border border-slate-200 px-2 py-0.5 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600">
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
