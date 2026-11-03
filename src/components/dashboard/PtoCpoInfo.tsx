'use client';

import { useEffect, useRef, useState } from 'react';
import type { PtoAdjustment } from '@/lib/managers';

// Info bubble on a CPO (Historicals Week total, All KPIs cells) when a
// salaried manager had recorded PTO in that period (MANAGER_PTO in src/lib/managers.ts). Walks through
// how their cost was adjusted — see ptoAdjustmentDetail — and what the CPO
// would be with their full weekly pay. Positioned `fixed` off the button so
// the table's horizontal scroll container can't clip it.

const fmt$ = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function PtoCpoInfo({ periodLabel, department, adjustments, totalOrders, adjustedCpo, fullCpo, size = 'sm' }: {
  periodLabel: string;  // e.g. "week of Oct 5" / "W/C Oct 5" / "Sep 2026"
  department:  string;  // Title Case, e.g. 'Fulfillment'
  // weekOf is set when the period spans weeks, to label each one.
  adjustments: (PtoAdjustment & { weekOf?: string })[];
  totalOrders: number;
  adjustedCpo: number;
  fullCpo:     number;
  size?:       'sm' | 'md';
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover]   = useState(false);
  const [pos, setPos]       = useState<{ top: number; left: number } | null>(null);
  const open = pinned || hover;

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const width = 300;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
    const below = r.bottom + 6;
    setPos({ top: below + 320 > window.innerHeight ? Math.max(8, r.top - 326) : below, left });
  }, [open]);

  useEffect(() => {
    if (!pinned) return;
    const close = (e: MouseEvent) => { if (!btnRef.current?.contains(e.target as Node)) setPinned(false); };
    const esc   = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinned(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [pinned]);

  const weeks = new Set(adjustments.map(a => a.weekOf).filter(Boolean));
  const weekLabel = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const anyChange = adjustments.some(a => !a.capped);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="How PTO changed this week's CPO"
        onClick={() => setPinned(p => !p)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className={`inline-flex items-center justify-center ml-1 rounded-full bg-sky-100 text-sky-700 font-bold leading-none align-middle hover:bg-sky-200 ${size === 'md' ? 'w-4 h-4 text-[10px]' : 'w-3 h-3 text-[8px]'}`}
      >
        i
      </button>
      {open && pos && (
        <div
          role="dialog"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 300, zIndex: 60 }}
          className="rounded-lg border border-slate-200 bg-white p-3 text-left text-[11px] font-normal text-slate-600 shadow-lg"
          onMouseDown={e => e.stopPropagation()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <div className="mb-2 text-xs font-semibold text-slate-800">Manager PTO · {periodLabel}</div>
          {adjustments.map(a => {
            const workedShare = 1 - a.ptoShare;
            const ptoCharge   = a.ptoShare * a.normalRate * a.weekOrders;
            return (
              <div key={`${a.name}|${a.weekOf ?? ''}`} className="mb-2 space-y-1">
                <div className="font-semibold text-slate-700">
                  {a.name} · {a.ptoHours}h PTO ({Math.round(a.ptoShare * 100)}% of the week{weeks.size > 1 && a.weekOf ? ` of ${weekLabel(a.weekOf)}` : ''})
                </div>
                <div>Normally costs <b>{fmt$(a.normalRate)}</b> per {department} order (avg of {a.rateWeeks} weeks before, PTO weeks skipped).</div>
                <table className="w-full tabular-nums">
                  <tbody>
                    <tr><td>PTO hours: {fmt$(a.normalRate)} × {Math.round(a.weekOrders)} orders{a.ptoShare < 1 ? ` × ${Math.round(a.ptoShare * 100)}%` : ''}</td><td className="text-right">{fmt0(ptoCharge)}</td></tr>
                    {workedShare > 0 && (
                      <tr><td>Worked hours: {Math.round(workedShare * 100)}% × {fmt0(a.fullCost)} salary</td><td className="text-right">{fmt0(workedShare * a.fullCost)}</td></tr>
                    )}
                    <tr className="border-t border-slate-100 font-semibold text-slate-800">
                      <td>Charged to {department}</td>
                      <td className="text-right">{fmt0(a.adjustedCost)} <span className="font-normal text-slate-400">vs {fmt0(a.fullCost)}</span></td>
                    </tr>
                  </tbody>
                </table>
                {a.capped && (
                  <div className="rounded bg-slate-50 px-2 py-1 text-slate-500">
                    Busy week: the per-order charge ({fmt0(ptoCharge + workedShare * a.fullCost)}) would be more than their normal pay, so normal pay is kept. PTO never raises a week&apos;s cost.
                  </div>
                )}
              </div>
            );
          })}
          <div className="mt-2 border-t border-slate-100 pt-2">
            <div className="flex justify-between font-semibold text-slate-800"><span>Team CPO</span><span>{fmt$(adjustedCpo)}</span></div>
            <div className="flex justify-between text-slate-400"><span>With full manager pay</span><span>{fmt$(fullCpo)}</span></div>
            <div className="mt-1 text-[10px] text-slate-400">
              {anyChange
                ? `Across ${Math.round(totalOrders)} orders. PTO hours are charged at the manager's usual cost per order, so a week off costs the team what that manager normally costs for that much output.`
                : `Across ${Math.round(totalOrders)} orders — unchanged.`}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
