'use client';

// Bloom Stock Historicals — the same team × week grid as Design's
// HistoricalsSection, over Bloom Stock's own tables (bloom_stock_week_actuals,
// bloom_stock_completions). A cell's production is the items credited to that
// person that week, so it changes by adding or removing orders rather than
// typing over the number.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isoMonday } from '@/lib/weekDates';
import { DEPARTMENT_MANAGERS, STANDARD_WEEKLY_HOURS } from '@/lib/managers';
import { BLOOM_STOCK_LABEL, type BloomStockProductKey } from '@/lib/bloomStock';
import { useVisibleManagerCPO } from '@/hooks/useVisibleManagerCPO';
import { HelpTip } from './HelpTip';
import { MemberTierBadges } from './MemberTierBadge';

const LOCATION = 'Utah';
const FIRST_WEEK = '2025-12-29';  // where Design's Historicals start

const RANGE_OPTIONS: { value: number | 'all'; label: string }[] = [
  { value: 8,     label: '8 wks' },
  { value: 12,    label: '12 wks' },
  { value: 26,    label: '6 mo' },
  { value: 'all', label: 'All' },
];

interface Completion {
  id: string; week_of: string; member_name: string; order_name: string; order_id: string;
  line_item_id: string; product_key: BloomStockProductKey; units: number;
  auto: boolean;  // from the Monday PF sync — corrected in the PF app, not here
}
interface HoursRow { week_of: string; member_name: string; hours: number }
interface PayrollRow { week_of: string; member_name: string; cost: number }
type CellRef = { name: string; weekOf: string };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function fmtWeek(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function monthKey(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function fmt$(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const key = (weekOf: string, name: string) => `${weekOf}|${name}`;

function managerFor(name: string, weekOf: string) {
  const n = name.trim().toLowerCase();
  return DEPARTMENT_MANAGERS.find(m => m.location === LOCATION && m.name.trim().toLowerCase() === n
    && (!m.from || weekOf >= m.from) && (!m.to || weekOf <= m.to));
}

export function BloomStockHistoricals({ rosterNames, canEdit, canViewCPO }: {
  rosterNames: string[];
  canEdit:     boolean;
  canViewCPO:  boolean;
}) {
  const { canSeeManagerCPO } = useVisibleManagerCPO();
  const allWeeks = useMemo(() => {
    const weeks: string[] = [];
    for (let w = FIRST_WEEK; w <= isoMonday(0); w = addDays(w, 7)) weeks.push(w);
    return weeks;
  }, []);
  const thisMonday = allWeeks[allWeeks.length - 1];

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoursRows, setHoursRows] = useState<HoursRow[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  // Recreation-department gross pay from the Rippling earnings upload (only
  // sent to people who can see CPO).
  const [payroll, setPayroll] = useState<PayrollRow[]>([]);
  const [ripplingRates, setRipplingRates] = useState<Map<string, number>>(new Map());
  const [range, setRange] = useState<number | 'all'>(12);
  const [showInactive, setShowInactive] = useState(false);
  const [hoursDraft, setHoursDraft] = useState<{ key: string; text: string } | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CellRef | null>(null);
  const [addPick, setAddPick] = useState<CellRef | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch(`/api/bloom-stock/actuals?weeks=${allWeeks.length + 2}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    setHoursRows(json.hours ?? []);
    setCompletions(json.completions ?? []);
    setPayroll(json.payroll ?? []);
  }, [allWeeks.length]);

  useEffect(() => {
    reload().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false));
  }, [reload]);

  useEffect(() => {
    fetch(`/api/admin/employees-upload?location=${LOCATION}`)
      .then(r => r.json())
      .then((d: { employees?: { full_name: string; hourly_rate: number; annual_salary: number }[] }) => {
        const m = new Map<string, number>();
        for (const e of d.employees ?? []) {
          m.set(e.full_name.trim().toLowerCase(), e.hourly_rate > 0 ? e.hourly_rate : e.annual_salary > 0 ? e.annual_salary / 2080 : 0);
        }
        setRipplingRates(m);
      })
      .catch(() => {});
  }, []);

  const visibleWeeks = useMemo(() => (range === 'all' ? allWeeks : allWeeks.slice(-range)), [allWeeks, range]);
  const visibleMonths = useMemo(() => [...new Set(visibleWeeks.map(monthKey))], [visibleWeeks]);
  const monthStarts = useMemo(() => new Set(
    visibleWeeks.filter((w, i) => i === 0 || monthKey(visibleWeeks[i - 1]) !== monthKey(w)),
  ), [visibleWeeks]);

  // Newest weeks are on the right, so open scrolled all the way there.
  const weeklyScroll = useRef<HTMLDivElement>(null);
  const monthlyScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (loading) return;
    for (const el of [weeklyScroll.current, monthlyScroll.current]) if (el) el.scrollLeft = el.scrollWidth;
  }, [loading, range]);

  const { hoursBy, completionsBy, payBy, memberNames } = useMemo(() => {
    const hoursBy = new Map(hoursRows.map(r => [key(r.week_of, r.member_name), r.hours]));
    const payBy = new Map(payroll.map(r => [key(r.week_of, r.member_name), r.cost]));
    const completionsBy = new Map<string, Completion[]>();
    for (const c of completions) {
      const k = key(c.week_of, c.member_name);
      completionsBy.set(k, [...(completionsBy.get(k) ?? []), c]);
    }
    const names = [...rosterNames];
    for (const r of [...hoursRows, ...completions, ...payroll]) if (!names.includes(r.member_name)) names.push(r.member_name);
    return { hoursBy, completionsBy, payBy, memberNames: names };
  }, [hoursRows, completions, payroll, rosterNames]);

  function cell(weekOf: string, name: string) {
    const k = key(weekOf, name);
    const comps = completionsBy.get(k) ?? [];
    const items = comps.reduce((t, c) => t + c.units, 0);
    const hours = hoursBy.get(k) ?? 0;
    const paid = payBy.get(k);
    // Actual Recreation payroll for anyone paid under it that week; everyone
    // else (e.g. Jennika, who clocks under Design) is hours × rate. Salaried
    // managers use the same hourly as Design: salary ÷ 52 ÷ 40.
    const mgr = managerFor(name, weekOf);
    const rate = mgr ? mgr.annualSalary / 52 / STANDARD_WEEKLY_HOURS : ripplingRates.get(name.trim().toLowerCase()) ?? 0;
    const cost = paid ?? hours * rate;
    return { comps, items, hours, cost, isActual: paid !== undefined, synced: comps.some(c => c.auto), isManager: !!mgr };
  }

  function totals(weeks: string[], names: string[]) {
    let items = 0, hours = 0, cost = 0, allActual = true;
    for (const w of weeks) for (const n of names) {
      const c = cell(w, n);
      items += c.items; hours += c.hours; cost += c.cost;
      if (c.hours > 0 && !c.isActual) allActual = false;
    }
    return { items, hours, cost, allActual, ratio: items > 0 && hours > 0 ? hours / items : null, cpo: items > 0 && cost > 0 ? cost / items : null };
  }

  async function saveHours(name: string, weekOf: string, text: string) {
    const hours = Math.max(0, parseFloat(text) || 0);
    if (hours === (hoursBy.get(key(weekOf, name)) ?? 0)) return;
    setSavingKey(key(weekOf, name));
    setError(null);
    try {
      const res = await fetch('/api/bloom-stock/actuals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'hours', weekOf, memberName: name, hours }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setHoursRows(rows => [...rows.filter(r => !(r.week_of === weekOf && r.member_name === name)), { week_of: weekOf, member_name: name, hours }]);
    } catch (e) {
      setError(`Couldn't save ${name}'s hours: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) return <div className="text-xs text-slate-400 p-4">Loading historicals…</div>;

  const activeNames = memberNames.filter(n => visibleWeeks.some(w => { const c = cell(w, n); return c.hours > 0 || c.items > 0; }));
  const rowNames = showInactive ? memberNames : activeNames;
  const inactiveCount = memberNames.length - activeNames.length;
  const canSeeCpo = (name: string, weekOf: string) => canViewCPO && (!managerFor(name, weekOf) || canSeeManagerCPO(name));
  const weeksInMonth = (mk: string) => allWeeks.filter(w => monthKey(w) === mk);

  return (
    <div className="space-y-6">
      {detail && (
        <OrdersPopover
          {...detail}
          completions={cell(detail.weekOf, detail.name).comps}
          canEdit={canEdit}
          onChanged={reload}
          onClose={() => setDetail(null)}
        />
      )}

      {addPick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={() => setAddPick(null)}>
          <form
            className="w-full max-w-xs rounded-xl bg-white shadow-xl border border-slate-200 p-4 space-y-3 text-xs"
            onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); if (addPick.name) { setDetail(addPick); setAddPick(null); } }}
          >
            <h3 className="text-sm font-semibold text-slate-700">Add an order number</h3>
            <label className="block">
              <span className="text-slate-500">Who did the work</span>
              <select value={addPick.name} onChange={e => setAddPick({ ...addPick, name: e.target.value })}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5">
                <option value="">Choose a person…</option>
                {[...memberNames].sort().map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-slate-500">Week</span>
              <select value={addPick.weekOf} onChange={e => setAddPick({ ...addPick, weekOf: e.target.value })}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5">
                {[...allWeeks].reverse().map(w => <option key={w} value={w}>Week of {fmtWeek(w)}</option>)}
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAddPick(null)} className="px-3 py-1.5 text-slate-500 hover:text-slate-700">Cancel</button>
              <button type="submit" disabled={!addPick.name}
                className="rounded bg-violet-600 px-3 py-1.5 font-medium text-white hover:bg-violet-700 disabled:opacity-50">Next</button>
            </div>
          </form>
        </div>
      )}

      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="bloom.hours">Weekly — bloom stock · {LOCATION}</HelpTip></h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Oldest → newest. <span className="text-amber-600 font-medium">Amber</span> = missing actuals.{' '}
              <span className="text-sky-600 font-medium">Blue items</span> = auto-synced from the production app.{' '}
              <span className="text-indigo-700 font-medium">Indigo items</span> = logged by hand. Click a number to see its orders{canEdit ? ' and add more' : ''}.{' '}
              <span className="text-green-600 font-medium">Green CPO</span> = from Rippling payroll.{' '}
              <span className="text-amber-600 font-medium">Amber CPO</span> = estimated from rate.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {savingKey && <span className="text-xs text-slate-400 italic">Saving…</span>}
            {canEdit && (
              <button type="button" onClick={() => setAddPick({ name: '', weekOf: thisMonday })}
                className="text-xs font-medium text-violet-600 hover:text-violet-800 border border-violet-200 rounded-lg px-2.5 py-1 whitespace-nowrap">
                + Add order #
              </button>
            )}
            {inactiveCount > 0 && (
              <button type="button" onClick={() => setShowInactive(v => !v)}
                className="text-xs text-slate-500 hover:text-slate-700 underline-offset-2 hover:underline whitespace-nowrap">
                {showInactive ? `Hide ${inactiveCount} inactive` : `Show ${inactiveCount} inactive`}
              </button>
            )}
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {RANGE_OPTIONS.map(o => (
                <button key={String(o.value)} type="button" onClick={() => setRange(o.value)}
                  className={`px-2.5 py-1 text-xs rounded-md whitespace-nowrap ${range === o.value ? 'bg-white text-slate-800 font-medium shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {error && <div className="px-5 py-2 text-xs text-rose-700 bg-rose-50">{error}</div>}

        <style>{`
          .bloom-hist-input::-webkit-inner-spin-button,
          .bloom-hist-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
          .bloom-hist-input { -moz-appearance: textfield; }
        `}</style>

        <div ref={weeklyScroll} className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[150px] border-b border-r border-slate-200">Member</th>
                {visibleWeeks.map(w => (
                  <th key={w} className={`px-2 py-1.5 text-center whitespace-nowrap min-w-[68px] border-b border-slate-200 ${monthStarts.has(w) ? 'border-l-2 border-l-slate-300' : 'border-l border-l-slate-100'}`}>
                    <div className="font-medium text-slate-600">{fmtWeek(w)}</div>
                    {monthStarts.has(w) && <div className="text-[9px] text-indigo-500 font-semibold">{monthKey(w).split(' ')[0].toUpperCase()}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowNames.map((name, i) => {
                const notOnRoster = !rosterNames.includes(name);
                return (
                  <tr key={name} className={`${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'} ${notOnRoster ? 'border-t border-dashed border-slate-200' : ''}`}>
                    <td className={`sticky left-0 z-10 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'} px-4 py-2 whitespace-nowrap border-r border-slate-200 border-b border-b-slate-100`}>
                      <div className="font-medium text-slate-700">{name}</div>
                      <MemberTierBadges name={name} location={LOCATION} dept="Bloom Stock" notOnRoster={notOnRoster} />
                    </td>
                    {visibleWeeks.map(w => {
                      const c = cell(w, name);
                      const k = key(w, name);
                      const hasData = c.hours > 0 || c.items > 0;
                      const cpo = c.items > 0 && c.cost > 0 && canSeeCpo(name, w) ? c.cost / c.items : null;
                      return (
                        <td key={w} className={`p-0 border-b border-b-slate-100 focus-within:bg-indigo-50 ${monthStarts.has(w) ? 'border-l-2 border-l-slate-200' : 'border-l border-l-slate-100'} ${hasData ? '' : 'bg-amber-50'} ${savingKey === k ? 'opacity-50' : ''}`}>
                          <div className="flex flex-col">
                            <button type="button" disabled={!canEdit && c.items === 0}
                              onClick={() => setDetail({ name, weekOf: w })}
                              title={c.items > 0 ? 'See the orders behind this number' : 'Add an order'}
                              className={`group w-full min-h-[24px] px-2 py-1 text-center text-[11px] font-semibold hover:bg-indigo-50 ${c.synced ? 'text-sky-600' : 'text-indigo-700'}`}>
                              {c.items > 0 ? c.items : canEdit && <span className="text-amber-500 opacity-0 group-hover:opacity-100">+</span>}
                              {c.synced && <span className="block text-[8px] leading-none font-normal text-sky-500 underline decoration-dotted underline-offset-2">synced</span>}
                            </button>
                            <input type="number" min="0" step="0.25" readOnly={!canEdit}
                              value={hoursDraft?.key === k ? hoursDraft.text : c.hours > 0 ? round2(c.hours) : ''}
                              onChange={e => setHoursDraft({ key: k, text: e.target.value })}
                              onBlur={e => { saveHours(name, w, e.target.value); setHoursDraft(null); }}
                              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                              className={`bloom-hist-input w-full px-2 py-0.5 text-center text-[10px] bg-transparent border-none outline-none border-t border-t-slate-100 focus:bg-indigo-50 ${c.hours > 0 && c.isActual ? 'text-green-600 font-medium' : 'text-slate-400'}`}
                            />
                            {c.items > 0 && c.hours === 0 && (
                              <div className="text-[8px] leading-none text-amber-500 text-center pb-0.5" title="Items were credited this week, but no Bloom Stock hours are logged. Type hours here to calculate hrs/item.">
                                no hours logged
                              </div>
                            )}
                            {c.items > 0 && c.hours > 0 && (
                              <div className="text-[9px] px-1 text-center text-slate-500">{(c.hours / c.items).toFixed(2)} h/item</div>
                            )}
                            {cpo !== null && (
                              <div className={`text-[9px] px-1 pb-0.5 text-center font-semibold ${c.isActual ? 'text-green-700' : 'text-amber-600'}`}>{fmt$(cpo)}</div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              <tr className="bg-slate-50 font-semibold border-t-2 border-slate-200">
                <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600 border-r border-slate-200">Week total</td>
                {visibleWeeks.map(w => {
                  const t = totals([w], memberNames);
                  return (
                    <td key={w} className={`px-2 py-2 text-center ${monthStarts.has(w) ? 'border-l-2 border-l-slate-300' : 'border-l border-l-slate-100'}`}>
                      {t.items > 0 ? (
                        <>
                          <div className="text-indigo-700">{t.items}</div>
                          {t.ratio !== null && <div className="text-[9px] text-slate-500">{t.ratio.toFixed(2)} h/item</div>}
                          {canViewCPO && t.cpo !== null && <div className={`text-[9px] font-semibold ${t.allActual ? 'text-green-700' : 'text-amber-600'}`}>{fmt$(t.cpo)}</div>}
                        </>
                      ) : <span className="text-slate-200">—</span>}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700"><HelpTip id="sched.monthlySummary">Monthly summary</HelpTip></h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Total items, hours, ratio. <span className="text-green-600 font-medium">Green CPO</span> = from Rippling payroll. <span className="text-amber-600 font-medium">Amber</span> = estimated.
          </p>
        </div>
        <div ref={monthlyScroll} className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[150px] border-r border-slate-200">Member</th>
                {visibleMonths.map(mk => (
                  <th key={mk} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px] border-l border-slate-100">{mk.split(' ')[0]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowNames.map((name, i) => (
                <tr key={name} className={`border-b border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                  <td className={`sticky left-0 z-10 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50'} px-4 py-2 whitespace-nowrap border-r border-slate-200 font-medium text-slate-700`}>{name}</td>
                  {visibleMonths.map(mk => {
                    const weeks = weeksInMonth(mk);
                    const t = totals(weeks, [name]);
                    if (t.items === 0 && t.hours === 0) return <td key={mk} className="px-3 py-2 text-center text-slate-200 border-l border-slate-100">—</td>;
                    return (
                      <td key={mk} className="px-3 py-2 text-center border-l border-slate-100">
                        {t.items > 0 && <div className="font-semibold text-indigo-700">{t.items}</div>}
                        {t.hours > 0 && <div className="text-slate-400">{Math.round(t.hours * 10) / 10}h</div>}
                        {t.ratio !== null && <div className="text-[10px] text-slate-500">{t.ratio.toFixed(2)} h/item</div>}
                        {t.cpo !== null && weeks.every(w => canSeeCpo(name, w)) && (
                          <div className={`text-[10px] font-semibold ${t.allActual ? 'text-green-700' : 'text-amber-600'}`}>{fmt$(t.cpo)}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-indigo-50/30 font-semibold">
                <td className="sticky left-0 bg-indigo-50/30 px-4 py-2 text-slate-700 border-r border-slate-200">Month total</td>
                {visibleMonths.map(mk => {
                  const t = totals(weeksInMonth(mk), memberNames);
                  return (
                    <td key={mk} className="px-3 py-2 text-center border-l border-slate-100">
                      <div className="text-indigo-700">{t.items || '—'}</div>
                      {t.ratio !== null && <div className="text-[10px] text-slate-500">{t.ratio.toFixed(2)} h/item</div>}
                      {canViewCPO && t.cpo !== null && <div className={`text-[11px] font-semibold ${t.allActual ? 'text-green-700' : 'text-amber-600'}`}>{fmt$(t.cpo)}</div>}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// The orders behind one cell, with the form to add more.
function OrdersPopover({ name, weekOf, completions, canEdit, onChanged, onClose }: CellRef & {
  completions: Completion[];
  canEdit:     boolean;
  onChanged:   () => Promise<void>;
  onClose:     () => void;
}) {
  const [orders, setOrders] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const numbers = orders.split(/[\s,]+/).filter(Boolean);
    if (numbers.length === 0) return;
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    const messages: string[] = [];
    for (const orderNumber of numbers) {
      const res = await fetch('/api/bloom-stock/actuals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'order', weekOf, memberName: name, orderNumber }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        failed.push(orderNumber);
        messages.push(json.error ?? `Order ${orderNumber}: HTTP ${res.status}`);
      }
    }
    setOrders(failed.join(' '));
    if (messages.length) setError(messages.join(' · '));
    await onChanged().catch(() => {});
    setBusy(false);
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/bloom-stock/actuals?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) setError(`Couldn't remove that order (HTTP ${res.status})`);
    await onChanged().catch(() => {});
    setBusy(false);
  }

  const items = completions.reduce((t, c) => t + c.units, 0);
  const sorted = [...completions].sort((a, b) => a.order_name.localeCompare(b.order_name, undefined, { numeric: true }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[80vh] flex flex-col rounded-xl bg-white shadow-xl border border-slate-200" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">{name} · Bloom Stock</h3>
            <p className="text-xs text-slate-400 mt-0.5">Week of {fmtWeek(weekOf)} – {fmtWeek(addDays(weekOf, 6))} · {items} item{items === 1 ? '' : 's'}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">×</button>
        </div>
        <div className="overflow-y-auto px-5 py-3 text-xs">
          {canEdit && (
            <form onSubmit={add} className="mb-3 rounded-lg border border-violet-200 bg-violet-50/50 px-3 py-2">
              <p className="text-[11px] font-semibold text-violet-700">Add orders</p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input value={orders} onChange={e => setOrders(e.target.value)} placeholder="Order #s, e.g. 41234 41301"
                  className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px]" />
                <button type="submit" disabled={busy || !orders.trim()}
                  className="rounded bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-700 disabled:opacity-50">Add order</button>
              </div>
              {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
            </form>
          )}
          {!canEdit && error && <p className="mb-2 text-[11px] text-red-600">{error}</p>}
          {sorted.length === 0 ? (
            <p className="text-slate-400 italic">No orders credited this week.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {sorted.map(c => (
                <li key={c.id} className="py-1.5 flex items-baseline justify-between gap-2">
                  <span>
                    <span className="font-semibold text-slate-700">{c.order_name}</span>
                    {c.units !== 1 && <span className="ml-1 text-slate-400">×{c.units}</span>}
                    <span className="block text-[11px] text-slate-500">{BLOOM_STOCK_LABEL[c.product_key]}</span>
                  </span>
                  {c.auto ? (
                    <span className="shrink-0 text-[10px] text-sky-600" title="To change this, reassign the designer in the production app. The next sync picks it up.">synced</span>
                  ) : canEdit && (
                    <button type="button" disabled={busy} onClick={() => remove(c.id)}
                      className="shrink-0 text-[10px] text-red-500 hover:text-red-700 underline disabled:opacity-50">Remove</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sorted.some(c => c.auto) && (
            <p className="mt-2 text-[10px] text-slate-400">Synced orders come from the production app. To change one, reassign the designer there and the next sync picks it up.</p>
          )}
        </div>
      </div>
    </div>
  );
}
