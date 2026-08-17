'use client';

import { useState, useMemo, useRef } from 'react';
import { useActualsWithPayroll } from './useActualsWithPayroll';
import type { EnrichedActual } from './useActualsWithPayroll';
import { getMondayDate } from '@/lib/weekDates';

interface TeamMember {
  id:           string;
  name:         string;
  payType:      'hourly' | 'salary';
  hourlyRate:   number;
  annualSalary: number;
  isManager?:        boolean;
  excludeFromCPO?:   boolean;
}

interface HistoricalsSectionProps {
  excludeFromCPONames?: string[];
  department:    'design' | 'preservation' | 'fulfillment' | 'resin';
  location:      'Utah' | 'Georgia';
  members:       TeamMember[];
  ordersLabel:   string;
  onRatioUpdate?: (memberId: string, ratio: number) => void;
  presActuals?:  Record<string, number>;
  onReceivedSaved?: () => void;
}

function fmt$(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function isoDate(d: Date): string { return d.toISOString().split('T')[0]; }

function fmtWeek(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getMonthKey(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function getAllWeeks(): string[] {
  const start = new Date('2025-12-29T12:00:00');
  const thisMonday = getMondayDate(0);
  const weeks: string[] = [];
  const cur = new Date(start);
  while (cur <= thisMonday) {
    weeks.push(isoDate(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return weeks;
}

export function HistoricalsSection({ department, location, members, ordersLabel, onRatioUpdate, excludeFromCPONames = [], presActuals = {}, onReceivedSaved }: HistoricalsSectionProps) {
  const { enrichedActuals, loading, refresh, getWeekCosts } = useActualsWithPayroll(location);
  // team_member_week_actuals stores resin rows as 'Resin' (capitalized) — the
  // other three departments store lowercase. This is the one place that
  // casing difference needs to be bridged.
  const actualsDept = department === 'resin' ? 'Resin' : department;
  const [localEdits, setLocalEdits] = useState<Record<string, Record<string, { hours: number; orders: number }>>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [managerHours, setManagerHours] = useState<Record<string, number>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const [receivedEdits, setReceivedEdits] = useState<Record<string, number>>({});
  const [savingReceived, setSavingReceived] = useState<string | null>(null);
  const receivedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Compute sum of presSettings.dailyReceived for a given week
  // (passed in via presActuals prop pathway — we use a simple sum of Mon-Fri)
  function getDailySum(weekOf: string): number | null {
    // presActuals keyed by week_of won't have daily data here;
    // daily sums are computed from presSettings.dailyReceived passed via parent
    // For now we return null (parent can override via presActuals)
    return null;
  }

  function handleReceivedEdit(weekOf: string, val: number) {
    setReceivedEdits(prev => ({ ...prev, [weekOf]: val }));
    if (receivedTimers.current[weekOf]) clearTimeout(receivedTimers.current[weekOf]);
    receivedTimers.current[weekOf] = setTimeout(async () => {
      setSavingReceived(weekOf);
      try {
        await fetch('/api/actuals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'preservation', location, weekOf, received: val }),
        });
        onReceivedSaved?.();
      } catch {}
      setSavingReceived(null);
    }, 800);
  }

  const allWeeks = useMemo(() => getAllWeeks(), []);
  const today = getMondayDate(0);

  // Filter to this dept — for preservation also include checks_unboxing rows
  const deptActuals = useMemo(() =>
    enrichedActuals.filter(r =>
      r.department === actualsDept ||
      (department === 'preservation' && r.department === 'checks_unboxing')
    ),
    [enrichedActuals, department, actualsDept]
  );

  // Separate checks_unboxing rows for display tinting
  const checksUnboxingActuals = useMemo(() =>
    department === 'preservation'
      ? enrichedActuals.filter(r => r.department === 'checks_unboxing')
      : [],
    [enrichedActuals, department]
  );

  // Auto-update roster ratios
  useMemo(() => {
    if (!onRatioUpdate || deptActuals.length === 0) return;
    const todayIso = new Date().toISOString().split('T')[0];
    members.forEach(m => {
      const last4 = deptActuals
        .filter(r => r.week_of < todayIso && r.member_name === m.name)
        .sort((a, b) => b.week_of.localeCompare(a.week_of))
        .slice(0, 4);
      const totalHours  = last4.reduce((s, r) => s + r.actual_hours, 0);
      const totalOrders = last4.reduce((s, r) => s + r.actual_orders, 0);
      if (totalOrders > 0 && totalHours > 0) {
        onRatioUpdate(m.id, Math.round((totalHours / totalOrders) * 100) / 100);
      }
    });
  }, [deptActuals]); // eslint-disable-line react-hooks/exhaustive-deps

  function getActual(weekOf: string, name: string): EnrichedActual | undefined {
    return deptActuals.find(r => r.week_of === weekOf && r.member_name === name);
  }

  function getEntry(weekOf: string, name: string): { hours: number; orders: number; cost: number; isActual: boolean } {
    const edit = localEdits[weekOf]?.[name];
    const actual = getActual(weekOf, name);
    const hours  = edit?.hours  ?? actual?.actual_hours  ?? 0;
    const orders = edit?.orders ?? actual?.actual_orders ?? 0;
    const isActual = !edit && (actual?.isActual ?? false);
    // Cost: use enriched cost if actual, else estimate from rate
    let cost = 0;
    if (isActual && actual) {
      cost = actual.cost;
    } else {
      const m = members.find(m => m.name === name);
      if (m) {
        if (m.payType === 'salary') cost = m.annualSalary / 52;
        else cost = hours * m.hourlyRate;
        if (m.isManager) {
          const extraHrs = managerHours[`${weekOf}:${name}`] ?? 0;
          if (m.payType === 'hourly') cost = (hours + extraHrs) * m.hourlyRate;
        }
      }
    }
    return { hours, orders, cost, isActual };
  }

  function handleEdit(weekOf: string, name: string, field: 'hours' | 'orders', val: number) {
    const existing = getEntry(weekOf, name);
    const updated = { hours: existing.hours, orders: existing.orders, [field]: val };
    setLocalEdits(prev => ({ ...prev, [weekOf]: { ...(prev[weekOf] ?? {}), [name]: updated } }));
    const key = `${weekOf}:${name}`;
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(async () => {
      setSavingKey(key);
      try {
        await fetch('/api/actuals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'team', location, weekOf, department: actualsDept, memberName: name, actualHours: updated.hours, actualOrders: updated.orders }),
        });
        // No refresh() — localEdits already reflects the change, avoids disrupting input focus
      } catch {}
      setSavingKey(null);
    }, 800);
  }

  const hasRates = members.some(m =>
    (m.payType === 'hourly' && m.hourlyRate > 0) || (m.payType === 'salary' && m.annualSalary > 0)
  );

  // Also include flex workers (people with hours in this dept not on roster)
  const flexNames = useMemo(() => {
    const rosterNames = new Set(members.map(m => m.name));
    return [...new Set(deptActuals.filter(r => r.actual_hours > 0 && !rosterNames.has(r.member_name)).map(r => r.member_name))];
  }, [deptActuals, members]);

  // Monthly aggregation
  const monthlyData = useMemo(() => {
    const map: Record<string, {
      byMember: Record<string, { hours: number; orders: number; cost: number; isActual: boolean }>;
      totalOrders: number; totalCost: number; totalHours: number; allActual: boolean;
    }> = {};
    allWeeks.forEach(w => {
      const mk = getMonthKey(w);
      if (!map[mk]) map[mk] = { byMember: {}, totalOrders: 0, totalCost: 0, totalHours: 0, allActual: true };
      [...members, ...flexNames.map(n => ({ id: n, name: n, payType: 'hourly' as const, hourlyRate: 0, annualSalary: 0 }))].forEach(m => {
        const e = getEntry(w, m.name);
        if (!map[mk].byMember[m.name]) map[mk].byMember[m.name] = { hours: 0, orders: 0, cost: 0, isActual: true };
        map[mk].byMember[m.name].hours  += e.hours;
        map[mk].byMember[m.name].orders += e.orders;
        map[mk].byMember[m.name].cost   += e.cost;
        if (!e.isActual && e.hours > 0) map[mk].byMember[m.name].isActual = false;
        map[mk].totalOrders += e.orders;
        map[mk].totalCost   += e.cost;
        map[mk].totalHours  += e.hours;
        if (!e.isActual && e.hours > 0) map[mk].allActual = false;
      });
    });
    return map;
  }, [allWeeks, deptActuals, localEdits, members, managerHours, flexNames]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="text-xs text-slate-400 p-4">Loading historicals…</div>;

  const allDisplayMembers = [...members.map(m => m.name), ...flexNames];



  return (
    <div className="space-y-6">

      {/* ── WEEKLY TABLE ── */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">All weeks — {department} · {location}</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Oldest → newest. <span className="text-amber-600 font-medium">Amber</span> = missing actuals.{' '}
              <span className="text-green-600 font-medium">Green CPO</span> = from Rippling payroll.{' '}
              <span className="text-amber-600 font-medium">Amber CPO</span> = estimated from rate.
            </p>
          </div>
          {savingKey && <span className="text-xs text-slate-400 italic">Saving…</span>}
        </div>

        <style>{`
          .hist-input::-webkit-inner-spin-button,
          .hist-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
          .hist-input { -moz-appearance: textfield; }
          .hist-cell:focus-within { background: #eef2ff; }
        `}</style>

        <div className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[150px] border-b border-r border-slate-200">Member</th>
                {allWeeks.map(w => {
                  const mk = getMonthKey(w);
                  const isFirst = allWeeks.filter(x => getMonthKey(x) === mk)[0] === w;
                  return (
                    <th key={w} className={`px-2 py-1.5 text-center whitespace-nowrap min-w-[68px] border-b border-slate-200 ${isFirst ? 'border-l-2 border-l-slate-300' : 'border-l border-l-slate-100'}`}>
                      <div className="font-medium text-slate-600">{fmtWeek(w)}</div>
                      {isFirst && <div className="text-[9px] text-indigo-500 font-semibold">{mk.split(' ')[0].toUpperCase()}</div>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {allDisplayMembers.map((name, mi) => {
                const isFlex = !members.find(m => m.name === name);
                const member = members.find(m => m.name === name);
                return (
                  <tr key={name} className={`${mi % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'} ${isFlex ? 'border-t border-dashed border-slate-200' : ''}`}>
                    <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap border-r border-slate-200 border-b border-b-slate-100">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-700">{name}</span>
                        {member?.isManager && <span className="text-[9px] bg-violet-100 text-violet-700 rounded px-1 py-px font-semibold">MGR</span>}
                        {isFlex && <span className="text-[9px] bg-indigo-50 text-indigo-500 rounded px-1 py-px">flex</span>}
                      </div>
                      {member?.payType === 'salary' && <div className="text-[10px] text-amber-600">salary</div>}
                    </td>
                    {allWeeks.map(w => {
                      const isPast = new Date(w + 'T12:00:00') <= today;
                      const e = getEntry(w, name);
                      // Check if this member has checks_unboxing hours this week
                      const cuHours = department === 'preservation'
                        ? checksUnboxingActuals.filter(r => r.week_of === w && r.member_name === name).reduce((s, r) => s + r.actual_hours, 0)
                        : 0;
                      const hasData = e.hours > 0 || e.orders > 0;
                      const isMissing = isPast && !hasData;
                      const isSaving = savingKey === `${w}:${name}`;
                      const isFirst = allWeeks.filter(x => getMonthKey(x) === getMonthKey(w))[0] === w;
                      const cpo = e.orders > 0 && e.cost > 0 ? e.cost / e.orders : null;
                      return (
                        <td key={w}
                          className={`hist-cell p-0 border-b border-b-slate-100 ${isFirst ? 'border-l-2 border-l-slate-200' : 'border-l border-l-slate-100'} ${isMissing ? 'bg-amber-50' : ''} ${isSaving ? 'opacity-50' : ''}`}>
                          <div className="flex flex-col">
                            <input type="number" min="0"
                              value={e.orders > 0 ? e.orders : ''}
                              placeholder=""
                              onChange={ev => handleEdit(w, name, 'orders', parseInt(ev.target.value) || 0)}
                              className={`hist-input w-full px-2 py-1 text-center text-[11px] font-semibold bg-transparent border-none outline-none focus:bg-indigo-50 ${isMissing && !hasData ? 'text-amber-400' : 'text-indigo-700'}`}
                            />
                            <input type="number" min="0" step="0.5"
                              value={e.hours > 0 ? e.hours : ''}
                              placeholder=""
                              onChange={ev => handleEdit(w, name, 'hours', parseFloat(ev.target.value) || 0)}
                              className={`hist-input w-full px-2 py-0.5 text-center text-[10px] bg-transparent border-none outline-none border-t border-t-slate-100 focus:bg-indigo-50 ${e.hours > 0 && e.isActual ? 'text-green-600 font-medium' : isMissing && !hasData ? 'text-amber-300' : 'text-slate-400'}`}
                            />
                            {e.hours > 0 && e.orders > 0 && (
                              <div className={`text-[9px] px-1 text-center ${(e.hours / e.orders) <= 1.0 ? 'text-green-700' : (e.hours / e.orders) <= 2.0 ? 'text-amber-700' : 'text-red-700'}`}>
                                {(e.hours / e.orders).toFixed(2)} h/ord
                              </div>
                            )}
                            {cpo !== null && hasRates && (
                              <div className={`text-[9px] px-1 pb-0.5 text-center font-semibold ${e.isActual ? 'text-green-700' : 'text-amber-600'}`}>
                                {fmt$(cpo)}
                              </div>
                            )}
                            {member?.isManager && member.payType === 'hourly' && (
                              <input type="number" min="0" step="0.5"
                                value={managerHours[`${w}:${name}`] ?? ''}
                                placeholder="mgr h"
                                title="Additional manager hours (non-production)"
                                onChange={ev => setManagerHours(prev => ({ ...prev, [`${w}:${name}`]: parseFloat(ev.target.value) || 0 }))}
                                className="hist-input w-full px-2 py-0.5 text-center text-[9px] bg-violet-50 border-none outline-none border-t border-t-violet-100 text-violet-500 placeholder:text-violet-300"
                              />
                            )}
                            {cuHours > 0 && (
                              <div className="w-full px-2 py-0.5 text-center text-[9px] bg-teal-50 border-t border-t-teal-100 text-teal-600 font-medium" title="Checks & Unboxing hours">
                                +{cuHours.toFixed(1)}h C&U
                              </div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {/* Bouquets received row — preservation only */}
              {department === 'preservation' && (
                <tr className="bg-emerald-50/40 border-t-2 border-emerald-100">
                  <td className="sticky left-0 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700 border-r border-slate-200 whitespace-nowrap">
                    Bouquets received
                  </td>
                  {allWeeks.map(w => {
                    const isPast = new Date(w + 'T12:00:00') <= today;
                    const weekTotal = allDisplayMembers.reduce((s, name) => s + getEntry(w, name).orders, 0);
                    const isOverridden = receivedEdits[w] !== undefined || presActuals[w] !== undefined;
                    const val = receivedEdits[w] ?? presActuals[w] ?? weekTotal;
                    const isSavingThis = savingReceived === w;
                    const isFirst = allWeeks.filter(x => getMonthKey(x) === getMonthKey(w))[0] === w;
                    return (
                      <td key={w} className={`p-0 ${isFirst ? 'border-l-2 border-l-slate-300' : 'border-l border-l-slate-100'} ${isSavingThis ? 'opacity-50' : ''}`}>
                        {isPast ? (
                          <input
                            type="number" min="0"
                            value={val > 0 ? val : ''}
                            placeholder=""
                            onChange={ev => handleReceivedEdit(w, parseInt(ev.target.value) || 0)}
                            className={`hist-input w-full px-2 py-2 text-center text-[11px] font-semibold bg-transparent border-none outline-none focus:bg-emerald-100 ${isOverridden ? 'text-emerald-700' : 'text-indigo-400'}`}
                          />
                        ) : (
                          <span className="block text-center text-slate-200 py-2">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              )}

              {/* Week totals */}
              <tr className="bg-slate-50 font-semibold border-t-2 border-slate-200">
                <td className="sticky left-0 bg-slate-50 px-4 py-2 text-xs text-slate-600 border-r border-slate-200">Week total</td>
                {allWeeks.map(w => {
                  const totalOrders = allDisplayMembers.reduce((s, name) => s + getEntry(w, name).orders, 0);
                  const nonMgrOrders = allDisplayMembers.reduce((s, name) => {
                    const m = members.find(m => m.name === name);
                    if (m?.isManager) return s;
                    return s + getEntry(w, name).orders;
                  }, 0);
                  const nonMgrHours = allDisplayMembers.reduce((s, name) => {
                    const m = members.find(m => m.name === name);
                    if (m?.isManager) return s;
                    // Include checks_unboxing hours in ratio calc for preservation
                    const cuH = department === 'preservation'
                      ? checksUnboxingActuals.filter(r => r.week_of === w && r.member_name === name).reduce((acc, r) => acc + r.actual_hours, 0)
                      : 0;
                    return s + getEntry(w, name).hours + cuH;
                  }, 0);
                  const weekRatio = nonMgrOrders > 0 && nonMgrHours > 0 ? nonMgrHours / nonMgrOrders : null;
                  // Get total dept cost from weekly_labor_cost via getWeekCosts, plus salary managers
                  const weekCosts = getWeekCosts(w);
                  const deptKey = department.charAt(0).toUpperCase() + department.slice(1);
                  const deptCost = weekCosts.find(wc => wc.department === deptKey)?.totalCost ?? 0;
                  // Fall back to summing individual costs if no labor upload data
                  const memberCost = allDisplayMembers.reduce((s, name) => {
                    const m = members.find(m => m.name === name);
                    if (m?.excludeFromCPO) return s;
                    if (excludeFromCPONames.includes(name)) return s;
                    return s + getEntry(w, name).cost;
                  }, 0);
                  const excludedCost = excludeFromCPONames.reduce((s, name) => s + getEntry(w, name).cost, 0);
                  const totalCost = deptCost > 0 ? Math.max(0, deptCost - excludedCost) : memberCost;
                  const allActual = weekCosts.length > 0 && (weekCosts.find(wc => wc.department === deptKey)?.isActual ?? false);
                  const teamCPO = totalOrders > 0 && totalCost > 0 ? totalCost / totalOrders : null;
                  const isFirst = allWeeks.filter(x => getMonthKey(x) === getMonthKey(w))[0] === w;
                  return (
                    <td key={w} className={`px-2 py-2 text-center ${isFirst ? 'border-l-2 border-l-slate-300' : 'border-l border-l-slate-100'}`}>
                      {totalOrders > 0 ? (
                        <>
                          <div className="text-indigo-700">{totalOrders}</div>
                          {weekRatio !== null && (
                            <div className={`text-[9px] ${weekRatio <= 1.0 ? 'text-green-700' : weekRatio <= 2.0 ? 'text-amber-700' : 'text-red-700'}`}>
                              {weekRatio.toFixed(2)} h/ord
                            </div>
                          )}
                          {hasRates && teamCPO !== null && (
                            <div className={`text-[9px] font-semibold ${allActual ? 'text-green-700' : 'text-amber-600'}`}>
                              {fmt$(teamCPO)}
                            </div>
                          )}
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

      {/* ── MONTHLY SUMMARY ── */}
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">Monthly summary</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Total {ordersLabel}, hours, ratio. <span className="text-green-600 font-medium">Green CPO</span> = from Rippling payroll. <span className="text-amber-600 font-medium">Amber</span> = estimated.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap min-w-[150px] border-r border-slate-200">Member</th>
                {Object.keys(monthlyData).map(mk => (
                  <th key={mk} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px] border-l border-slate-100">
                    {mk.split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allDisplayMembers.map((name, mi) => {
                const isFlex = !members.find(m => m.name === name);
                const member = members.find(m => m.name === name);
                return (
                  <tr key={name} className={`border-b border-slate-100 ${mi % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                    <td className="sticky left-0 bg-inherit px-4 py-2 whitespace-nowrap border-r border-slate-200">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-700">{name}</span>
                        {member?.isManager && <span className="text-[9px] bg-violet-100 text-violet-700 rounded px-1 py-px font-semibold">MGR</span>}
                        {isFlex && <span className="text-[9px] bg-indigo-50 text-indigo-500 rounded px-1 py-px">flex</span>}
                      </div>
                    </td>
                    {Object.entries(monthlyData).map(([mk, md]) => {
                      const d = md.byMember[name];
                      if (!d || (d.orders === 0 && d.hours === 0)) return <td key={mk} className="px-3 py-2 text-center text-slate-200 border-l border-slate-100">—</td>;
                      const ratio = d.hours > 0 && d.orders > 0 ? d.hours / d.orders : null;
                      const cpo   = d.orders > 0 && d.cost > 0 ? d.cost / d.orders : null;
                      return (
                        <td key={mk} className="px-3 py-2 text-center border-l border-slate-100">
                          {d.orders > 0 && <div className="font-semibold text-indigo-700">{d.orders}</div>}
                          {d.hours > 0 && <div className="text-slate-400">{Math.round(d.hours * 10) / 10}h</div>}
                          {ratio !== null && (
                            <div className={`text-[10px] ${ratio <= 1.0 ? 'text-green-700' : ratio <= 2.0 ? 'text-amber-700' : 'text-red-700'}`}>
                              {ratio.toFixed(2)} h/ord
                            </div>
                          )}
                          {cpo !== null && (
                            <div className={`text-[10px] font-semibold ${d.isActual ? 'text-green-700' : 'text-amber-600'}`}>
                              {fmt$(cpo)}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {/* Monthly team totals */}
              <tr className="border-t-2 border-slate-200 bg-indigo-50/30 font-semibold">
                <td className="sticky left-0 bg-indigo-50/30 px-4 py-2 text-slate-700 border-r border-slate-200">Month total</td>
                {Object.entries(monthlyData).map(([mk, md]) => {
                  const cpo   = md.totalOrders > 0 && md.totalCost > 0 ? md.totalCost / md.totalOrders : null;
                  const ratio = md.totalOrders > 0 && md.totalHours > 0 ? md.totalHours / md.totalOrders : null;
                  return (
                    <td key={mk} className="px-3 py-2 text-center border-l border-slate-100">
                      <div className="text-indigo-700">{md.totalOrders || '—'}</div>
                      {ratio !== null && (
                        <div className={`text-[10px] ${ratio <= 1.0 ? 'text-green-700' : ratio <= 2.0 ? 'text-amber-700' : 'text-red-700'}`}>
                          {ratio.toFixed(2)} h/ord
                        </div>
                      )}
                      {cpo !== null && (
                        <div className={`text-[11px] font-semibold ${md.allActual ? 'text-green-700' : 'text-amber-600'}`}>
                          {fmt$(cpo)}
                        </div>
                      )}
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
