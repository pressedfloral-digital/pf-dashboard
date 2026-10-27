'use client';

// Bloom Stock Products (Utah) — Handprint / Paw Print / Footprint frames and
// Bloom Arrangement Recreation, made from Pressed Floral's own pressed flower
// stock (see src/lib/bloomStock.ts). Built like the Design tab: This Week,
// Weekly Schedule, Queue & Turnaround, Roster and Historicals — but its own
// roster, its own payroll department and one hours-per-item ratio for every
// product. No drying stage, so turnaround is order placed → finished.
//
// Everything here is stored in schedule_settings (bloomStock* keys) and the
// bloom_stock_* tables; it never reads or writes the Design data.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useScheduleSettings, usePaidHolidays, type ScheduleSettings } from './useScheduleSettings';
import { isoMonday, getWeekLabel, isoMondayFromDate, getISOWeekNumber } from '@/lib/weekDates';
import { resolveDayHours, WEEKDAY_LABELS, type DailyHoursMap } from '@/lib/scheduleResolution';
import { EmployeeAutocomplete, type RipplingEmployee } from './EmployeeAutocomplete';
import { EmploymentDatesEditor } from './EmploymentDatesEditor';
import { ScheduleRulesEditor } from './ScheduleRulesEditor';
import { MemberTierBadges } from './MemberTierBadge';
import { buildActiveMemberIds, InactiveToggle } from './memberActivity';
import { DEPARTMENT_MANAGERS, STANDARD_WEEKLY_HOURS } from '@/lib/managers';
import {
  BLOOM_STOCK_PRODUCTS, BLOOM_STOCK_LABEL, DEFAULT_BLOOM_STOCK_ROSTER, emptyByProduct, bloomStockDoneWeeks,
  BLOOM_STOCK_STATUSES, BLOOM_STOCK_TYPE_LABEL, QUEUE_STATUSES, forecastBloomStockWeek, type BloomStockWeekForecast,
  type BloomStockProductKey, type BloomStockQueueResponse, type BloomStockMember, type BloomStockQueueItem,
  type BloomStockStatus, type BloomStockType,
  type BloomStockScenario, type BloomStockDeadline,
} from '@/lib/bloomStock';

const WEEKS = 52;
const WINDOW = 8;            // weeks visible in the Weekly Schedule grid at once
const HIST_WEEKS = 12;
const RATIO_WEEKS = 8;     // Historicals weeks averaged into a roster ratio
const DEFAULT_DEADLINE: BloomStockDeadline = { orderCutoff: '2026-12-01', dueBy: '2026-12-25' };
const SHORT: Record<BloomStockProductKey, string> = { handprint: 'hand', pawprint: 'paw', footprint: 'foot', recreation: 'recreation' };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtShort(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmt$(n: number): string { return `$${n.toFixed(2)}`; }
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime()) / 86_400_000);
}
function r1(n: number): number { return Math.round(n * 10) / 10; }
function todayIdx(): number { const d = new Date().getDay(); return d === 0 ? 6 : d - 1; }
function sum(a: (number | null | undefined)[] | undefined): number { return (a ?? []).reduce<number>((t, v) => t + (v || 0), 0); }


const card = 'bg-white border border-slate-100 rounded-xl overflow-hidden';
const cardHead = 'flex items-center justify-between flex-wrap gap-2 px-5 py-3 border-b border-slate-100';
const numInput = 'w-14 px-1 py-1 text-center border border-slate-200 rounded text-xs';
const navBtn = 'px-2 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-50 disabled:opacity-30';

// ─── Shared state ──────────────────────────────────────────────────────────────

function useBloomStock(settings: ScheduleSettings, update: (k: keyof ScheduleSettings, v: unknown) => void, holidays: string[]) {
  const roster: BloomStockMember[] = useMemo(() => Array.isArray(settings.bloomStockRoster)
    ? (settings.bloomStockRoster as BloomStockMember[]) : DEFAULT_BLOOM_STOCK_ROSTER, [settings.bloomStockRoster]);
  const daily: DailyHoursMap = useMemo(() => settings.bloomStockDailyHours ?? {}, [settings.bloomStockDailyHours]);
  const scenarios: BloomStockScenario[] = Array.isArray(settings.bloomStockScenarios) ? settings.bloomStockScenarios as BloomStockScenario[] : [];
  const deadline: BloomStockDeadline = (settings.bloomStockDeadline as BloomStockDeadline | null) ?? DEFAULT_DEADLINE;
  const weeklyEstimates: Record<string, number> = settings.bloomStockWeeklyEstimates ?? {};

  const dayHours = useCallback((m: BloomStockMember, weekIso: string, di: number) =>
    resolveDayHours(daily, `${weekIso}-${m.id}`, di, m.standardWeeklyHours,
      { weekIso, startDate: m.startDate, endDate: m.endDate, rules: m.scheduleRules }, holidays), [daily, holidays]);
  const weekHours = useCallback((m: BloomStockMember, weekIso: string, fromDay = 0) => {
    let h = 0;
    for (let di = fromDay; di < 7; di++) h += dayHours(m, weekIso, di).hours;
    return h;
  }, [dayHours]);

  // Team hours per week offset 0..51. Week 0 counts only today onward — the
  // queue already reflects work finished earlier this week.
  const hoursByWeek = useMemo(() => Array.from({ length: WEEKS }, (_, w) =>
    roster.reduce((t, m) => t + weekHours(m, isoMonday(w), w === 0 ? todayIdx() : 0), 0)
  ), [roster, weekHours]);

  // Each person's own ratio turns their hours into items; someone with no
  // ratio yet adds no capacity.
  const ratioOf = (m: BloomStockMember) => (m.ratio && m.ratio > 0 ? m.ratio : null);
  const itemsOf = useCallback((m: BloomStockMember, hours: number) => {
    const r = m.ratio && m.ratio > 0 ? m.ratio : null;
    return r && hours > 0 ? hours / r : 0;
  }, []);
  const itemsByWeek = useMemo(() => Array.from({ length: WEEKS }, (_, w) =>
    roster.reduce((t, m) => t + itemsOf(m, weekHours(m, isoMonday(w), w === 0 ? todayIdx() : 0)), 0)
  ), [roster, weekHours, itemsOf]);
  // Blended team ratio (standard hours ÷ the items they produce) — only for
  // turning item counts back into hours in summaries.
  const ratio = (() => {
    let h = 0, items = 0;
    for (const m of roster) {
      const r = ratioOf(m);
      const std = (m.standardWeeklyHours ?? []).reduce((a, b) => a + (b || 0), 0);
      if (r && std > 0) { h += std; items += std / r; }
    }
    if (items > 0) return Math.round((h / items) * 100) / 100;
    const rs = roster.map(ratioOf).filter((x): x is number => !!x);
    return rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
  })();

  // Day-by-day FIFO: workable orders oldest order date first, each day's
  // scheduled team hours ÷ ratio finishing items in that order. Returns the
  // day each line item's last unit is projected done (null = beyond 52 weeks
  // or no ratio/hours). Starts today; earlier days this week are past.
  const estimateFinish = useCallback((items: BloomStockQueueItem[]) => {
    const out = new Map<string, string | null>();
    const queue = items
      .filter(i => !i.assumedDone && QUEUE_STATUSES.has(i.status))
      .sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.orderNumber.localeCompare(b.orderNumber));
    let day = 0;          // days from this week's Monday
    let left = 0;         // item capacity left on `day`
    const startDay = todayIdx();
    const maxDay = WEEKS * 7;
    const capOn = (d: number) => {
      const wk = isoMonday(Math.floor(d / 7));
      return roster.reduce((t, m) => t + itemsOf(m, dayHours(m, wk, d % 7).hours), 0);
    };
    if (!roster.some(m => ratioOf(m))) return out;
    day = startDay; left = capOn(day);
    for (const it of queue) {
      let need = it.quantity;
      while (need > 1e-9 && day < maxDay) {
        if (left >= need - 1e-9) { left -= need; need = 0; break; }
        need -= left; day++; left = day < maxDay ? capOn(day) : 0;
      }
      out.set(it.lineItemId, need > 1e-9 ? null : addDaysIso(isoMonday(0), day));
    }
    return out;
  }, [roster, dayHours, itemsOf]);

  return {
    roster, daily, ratio, scenarios, deadline, weeklyEstimates, dayHours, weekHours, hoursByWeek, itemsOf, itemsByWeek, estimateFinish,
    setRoster:    (v: BloomStockMember[]) => update('bloomStockRoster', v),
    setDaily:     (v: DailyHoursMap) => update('bloomStockDailyHours', v),
    setScenarios: (v: BloomStockScenario[]) => update('bloomStockScenarios', v),
    setDeadline:  (v: BloomStockDeadline) => update('bloomStockDeadline', v),
    setWeeklyEstimate: (weekIso: string, v: number | null) => {
      const next = { ...weeklyEstimates };
      if (v === null) delete next[weekIso]; else next[weekIso] = v;
      update('bloomStockWeeklyEstimates', next);
    },
  };
}
type BS = ReturnType<typeof useBloomStock>;

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function BloomStockPage({ canEdit, canViewCPO }: { canEdit: boolean; canViewCPO: boolean }) {
  const { settings, loading, saveState, update } = useScheduleSettings('Utah');
  const { holidays } = usePaidHolidays();
  const bs = useBloomStock(settings, update, holidays);
  const queue = useBloomStockQueue();
  const unsorted = (queue.data?.items ?? []).filter(i => !i.sorted && !i.assumedDone).length;
  const [tab, setTab] = useState<'orders' | 'thisweek' | 'schedule' | 'queue' | 'historicals'>('orders');
  // Hide people with no schedule/hours lately (same rule as the other
  // departments, see memberActivity.tsx) — totals still use the full roster.
  const [showInactive, setShowInactive] = useState(false);
  const activeIds = buildActiveMemberIds(
    bs.roster.map(m => ({ id: m.id, name: m.name, standardWeeklyHours: m.standardWeeklyHours, endDate: m.endDate })),
    [], [bs.daily]);
  const visibleRoster = showInactive ? bs.roster : bs.roster.filter(m => activeIds.has(m.id));
  const inactiveCount = bs.roster.length - bs.roster.filter(m => activeIds.has(m.id)).length;

  // Ratio from the last RATIO_WEEKS complete weeks of Historicals: that
  // person's logged hours ÷ items they finished (null = not enough history).
  const historicalRatios = useCallback(async () => {
    const res = await fetch(`/api/bloom-stock/actuals?weeks=${RATIO_WEEKS + 2}`);
    if (!res.ok) return new Map<string, number>();
    const { hours = [], completions = [] } = await res.json() as {
      hours?: { week_of: string; member_name: string; hours: number }[];
      completions?: { week_of: string; member_name: string; units: number }[];
    };
    const from = isoMonday(-RATIO_WEEKS), to = isoMonday(0);
    const inWindow = (w: string) => w >= from && w < to;
    const h = new Map<string, number>(), u = new Map<string, number>();
    for (const r of hours) if (inWindow(r.week_of)) h.set(r.member_name, (h.get(r.member_name) ?? 0) + Number(r.hours));
    for (const c of completions) if (inWindow(c.week_of)) u.set(c.member_name, (u.get(c.member_name) ?? 0) + Number(c.units));
    const out = new Map<string, number>();
    for (const [name, hrs] of h) {
      const items = u.get(name) ?? 0;
      if (hrs > 0 && items > 0) out.set(name, Math.round((hrs / items) * 100) / 100);
    }
    return out;
  }, []);

  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  async function refreshRatio(m: BloomStockMember) {
    setRefreshingId(m.id);
    try {
      const r = (await historicalRatios()).get(m.name);
      if (r) bs.setRoster(bs.roster.map(x => (x.id === m.id ? { ...x, ratio: r, ratioUpdatedWeek: isoMonday(0) } : x)));
      else window.alert(`No Bloom Stock Historicals for ${m.name} in the last ${RATIO_WEEKS} weeks yet — log their hours and finished orders first.`);
    } finally { setRefreshingId(null); }
  }

  // Weekly automatic refresh: the first time someone who can edit opens this
  // tab in a new week, anyone with enough recent history gets their ratio
  // updated to the trailing average. People without history keep whatever
  // was entered by hand.
  const autoRan = useRef(false);
  useEffect(() => {
    if (loading || !canEdit || autoRan.current) return;
    const thisWeek = isoMonday(0);
    if (!bs.roster.some(m => m.ratioUpdatedWeek !== thisWeek)) return;
    autoRan.current = true;
    historicalRatios().then(ratios => {
      let changed = false;
      const next = bs.roster.map(m => {
        if (m.ratioUpdatedWeek === thisWeek) return m;
        const r = ratios.get(m.name);
        if (!r) return m;
        changed = true;
        return { ...m, ratio: r, ratioUpdatedWeek: thisWeek };
      });
      if (changed) bs.setRoster(next);
    }).catch(() => {});
  }, [loading, canEdit, bs, historicalRatios]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Bloom Stock Products — Utah</h2>
          <p className="text-xs text-slate-500">Handprint, Paw Print, Footprint frames &amp; Bloom Arrangement Recreations. No drying stage — worked oldest order date first.</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-500" title="Blended from each person's ratio on the roster">Team ratio <span className="font-semibold text-slate-700">{bs.ratio ?? '—'}</span> hrs / item</span>
          {loading && <span className="text-slate-400 italic">Loading…</span>}
          {saveState === 'saving' && <span className="text-slate-400">Saving…</span>}
          {saveState === 'saved' && <span className="text-green-600">✓ Saved</span>}
          {saveState === 'error' && <span className="text-red-500">Save failed</span>}
        </div>
      </div>

      <RosterPanel bs={bs} canEdit={canEdit} visibleRoster={visibleRoster}
        inactiveCount={inactiveCount} showInactive={showInactive} onToggleInactive={() => setShowInactive(v => !v)}
        onRefreshRatio={refreshRatio} refreshingId={refreshingId} />

      <div className="flex border-b border-slate-200">
        {([
          ['orders', 'Orders'],
          ['thisweek', 'This Week'],
          ['schedule', 'Weekly Schedule'],
          ['queue', 'Queue & Turnaround'],
          ['historicals', 'Historicals'],
        ] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {label}
            {id === 'orders' && unsorted > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-semibold"
                title={`${unsorted} new order${unsorted === 1 ? '' : 's'} to sort`}>{unsorted}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'orders'      && <OrdersTab bs={bs} canEdit={canEdit} queue={queue} />}
      {tab === 'thisweek'    && <ThisWeekTab bs={bs} roster={visibleRoster} canEdit={canEdit} holidays={holidays} />}
      {tab === 'schedule'    && <WeeklyScheduleTab bs={bs} roster={visibleRoster} />}
      {tab === 'queue'       && <QueueTab bs={bs} canEdit={canEdit} queue={queue} />}
      {tab === 'historicals' && <HistoricalsTab bs={bs} canViewCPO={canViewCPO} />}
    </div>
  );
}

// Short note under a forecast week ("LY ×2.1 · +3 switched"); the full
// per-product breakdown is in the tooltip.
function ForecastHint({ f }: { f: BloomStockWeekForecast }) {
  const detail = BLOOM_STOCK_PRODUCTS
    .filter(p => f.byProduct[p.key] >= 0.05)
    .map(p => {
      const b = f.basis[p.key];
      return b.method === 'seasonal'
        ? `${BLOOM_STOCK_LABEL[p.key]}: ${r1(f.byProduct[p.key])} (last year ${b.lastYear} × ${b.growth} growth)`
        : `${BLOOM_STOCK_LABEL[p.key]}: ${r1(f.byProduct[p.key])} (8-week average)`;
    });
  if (f.switched >= 0.05) detail.push(`Switched recreations: ${r1(f.switched)} (8-week average)`);
  const growth = BLOOM_STOCK_PRODUCTS.map(p => f.basis[p.key]).find(b => b.method === 'seasonal')?.growth;
  return (
    <span className="text-[10px] text-slate-400 whitespace-nowrap cursor-help"
      title={`Seasonal forecast — same week last year (5-wk smoothed) × growth over the last 12 weeks; newer products use their 8-week average.\n${detail.join('\n')}`}>
      {growth ? `LY ×${growth}` : '8-wk avg'}{f.switched >= 0.5 ? ` · +${Math.round(f.switched)} switched` : ''}
    </span>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? 'bg-indigo-50 border-indigo-100' : 'border-slate-100'}`}>
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${highlight ? 'text-indigo-700' : 'text-slate-800'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── This Week ─────────────────────────────────────────────────────────────────

function ThisWeekTab({ bs, roster, canEdit, holidays }: { bs: BS; roster: BloomStockMember[]; canEdit: boolean; holidays: string[] }) {
  const [offset, setOffset] = useState(0);
  const weekIso = isoMonday(offset);
  const teamDayItems = (di: number) => bs.roster.reduce((t, m) => t + bs.itemsOf(m, bs.dayHours(m, weekIso, di).hours), 0);

  function setDay(m: BloomStockMember, di: number, val: number | null) {
    const key = `${weekIso}-${m.id}`;
    const arr = [...(bs.daily[key] ?? [null, null, null, null, null, null, null])];
    arr[di] = val;
    bs.setDaily({ ...bs.daily, [key]: arr });
  }
  const teamDay = (di: number) => bs.roster.reduce((t, m) => t + bs.dayHours(m, weekIso, di).hours, 0);
  const teamWeek = WEEKDAY_LABELS.reduce((t, _, di) => t + teamDay(di), 0);

  return (
    <div className={card}>
      <div className={cardHead}>
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Hours per person per day — {offset === 0 ? 'this week' : offset === 1 ? 'next week' : `week of ${fmtShort(weekIso)}`}</h3>
          <p className="text-xs text-slate-400 mt-0.5">Blank days use the standard week from Roster. Items calculated from each person&apos;s ratio.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setOffset(Math.max(0, offset - 1))} disabled={offset === 0} className={navBtn}>← Prev</button>
          <button onClick={() => setOffset(Math.min(WEEKS - 1, offset + 1))} disabled={offset >= WEEKS - 1} className={navBtn}>Next →</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[150px]">Team member</th>
              {WEEKDAY_LABELS.map((l, di) => {
                const date = addDaysIso(weekIso, di);
                const hol = holidays.includes(date);
                return (
                  <th key={l} className={`px-2 py-2 text-center font-medium whitespace-nowrap ${hol ? 'bg-amber-50 text-amber-700' : 'text-slate-500'}`}>
                    {l}<br /><span className="font-normal text-[10px]">{fmtShort(date)}</span>
                    {hol && <div className="text-[9px] font-semibold text-amber-600">Holiday</div>}
                  </th>
                );
              })}
              <th className="px-3 py-2 text-center font-medium text-slate-500">Week total</th>
            </tr>
          </thead>
          <tbody>
            {roster.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400">No one on the roster — add people with “Edit bloom stock roster” above.</td></tr>}
            {roster.map((m, i) => {
              const wk = bs.weekHours(m, weekIso);
              return (
                <tr key={m.id} className={`border-b border-slate-50 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
                  <td className={`sticky left-0 z-10 ${i % 2 ? 'bg-slate-50' : 'bg-white'} px-4 py-2 font-medium text-slate-700 whitespace-nowrap`}>{m.name || '—'}</td>
                  {WEEKDAY_LABELS.map((_, di) => {
                    const r = bs.dayHours(m, weekIso, di);
                    return (
                      <td key={di} className="px-2 py-1.5 text-center">
                        {canEdit ? (
                          <input type="number" min="0" step="0.5" placeholder="0" value={r.hours || ''}
                            onChange={e => setDay(m, di, e.target.value === '' ? null : Math.max(0, parseFloat(e.target.value) || 0))}
                            className={`${numInput} ${r.isOverride ? 'border-indigo-300 bg-indigo-50/50' : ''}`} />
                        ) : <span className="text-slate-700">{r.hours || '—'}</span>}
                        {r.hours > 0 && m.ratio ? <div className="text-[10px] text-slate-400 mt-0.5">{r1(bs.itemsOf(m, r.hours))} items</div> : null}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center">
                    <div className="font-semibold text-slate-700">{r1(wk)}h</div>
                    {m.ratio && wk > 0 ? <div className="text-[10px] text-slate-400">{Math.round(bs.itemsOf(m, wk))} items</div> : null}
                  </td>
                </tr>
              );
            })}
            {roster.length > 0 && (
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="sticky left-0 bg-slate-50 px-4 py-2 text-slate-600">Planned total</td>
                {WEEKDAY_LABELS.map((_, di) => (
                  <td key={di} className="px-2 py-2 text-center text-indigo-700">
                    {r1(teamDay(di)) || '—'}
                    {teamDayItems(di) > 0 && <div className="text-[10px] font-normal text-slate-400">{r1(teamDayItems(di))} items</div>}
                  </td>
                ))}
                <td className="px-3 py-2 text-center text-indigo-700">
                  {r1(teamWeek)}h
                  {teamWeek > 0 && <div className="text-[10px] font-normal text-slate-400">{Math.round(WEEKDAY_LABELS.reduce((t, _, di) => t + teamDayItems(di), 0))} items</div>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Weekly Schedule (52 weeks, 8 at a time) ───────────────────────────────────

function WeeklyScheduleTab({ bs, roster }: { bs: BS; roster: BloomStockMember[] }) {
  const [offset, setOffset] = useState(0);
  const windowWeeks = Array.from({ length: WINDOW }, (_, i) => offset + i).filter(w => w < WEEKS);
  return (
    <div className={card}>
      <div className={cardHead}>
        <h2 className="text-sm font-semibold text-slate-700">Hours per person per week</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setOffset(Math.max(0, offset - WINDOW))} disabled={offset === 0} className={navBtn}>← Prev</button>
          <span className="text-xs text-slate-400">{getWeekLabel(offset)} – {getWeekLabel(offset + WINDOW - 1)}</span>
          <button onClick={() => setOffset(Math.min(WEEKS - WINDOW, offset + WINDOW))} disabled={offset + WINDOW >= WEEKS} className={navBtn}>Next →</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 min-w-[140px]">Team member</th>
              {windowWeeks.map(w => (
                <th key={w} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[90px]">
                  {getWeekLabel(w)}
                  {w === 0 && <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1">now</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roster.map((m, i) => (
              <tr key={m.id} className={`border-b border-slate-50 ${i % 2 ? 'bg-slate-50/40' : ''}`}>
                <td className={`sticky left-0 z-10 ${i % 2 ? 'bg-slate-50' : 'bg-white'} px-4 py-2 font-medium text-slate-700 whitespace-nowrap`}
                  title="Set on the Roster (standard week) or This Week (one-off changes)">{m.name || '—'}</td>
                {windowWeeks.map(w => {
                  const h = bs.weekHours(m, isoMonday(w));
                  return (
                    <td key={w} className={`px-2 py-1.5 text-center ${w === 0 ? 'bg-indigo-50/30' : ''}`}>
                      <div className="font-medium text-slate-700">{r1(h) || '—'}</div>
                      {m.ratio && h > 0 ? <div className="text-slate-400 mt-0.5">{Math.round(bs.itemsOf(m, h))} items</div> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
              <td className="sticky left-0 bg-slate-50 px-4 py-2 text-slate-600">Week total</td>
              {windowWeeks.map(w => {
                const h = bs.roster.reduce((t, m) => t + bs.weekHours(m, isoMonday(w)), 0);
                return (
                  <td key={w} className={`px-2 py-2 text-center ${w === 0 ? 'bg-indigo-50/50' : ''}`}>
                    <div className="text-indigo-700">{r1(h)}h</div>
                    {h > 0 && <div className="text-[10px] font-normal text-slate-500">{Math.round(bs.roster.reduce((t, m) => t + bs.itemsOf(m, bs.weekHours(m, isoMonday(w))), 0))} items</div>}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Queue & Turnaround ────────────────────────────────────────────────────────

function useBloomStockQueue() {
  const [data, setData] = useState<BloomStockQueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/bloom-stock/queue${refresh ? '?refresh=true' : ''}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json as BloomStockQueueResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(false); }, [load]);
  return { data, error, refreshing, load };
}

type QueueState = ReturnType<typeof useBloomStockQueue>;

function QueueTab({ bs, canEdit, queue }: { bs: BS; canEdit: boolean; queue: QueueState }) {
  const { data, error, refreshing, load } = queue;
  const [showItems, setShowItems] = useState(false);
  const [productFilter, setProductFilter] = useState<BloomStockProductKey | 'all'>('all');
  const ratio = bs.ratio;
  // Only workable orders count: not waiting on customer blooms/prints, not on
  // hold, and not an old order assumed finished (see the Orders tab).
  const items = useMemo(() => (data?.items ?? []).filter(i => !i.assumedDone && QUEUE_STATUSES.has(i.status)), [data]);
  const notCounted = useMemo(() => (data?.items ?? []).filter(i => !i.assumedDone && !QUEUE_STATUSES.has(i.status))
    .reduce((t, i) => t + i.quantity, 0), [data]);

  // Seasonal forecast of orders per week (last year × growth, per product —
  // see forecastBloomStockWeek), unless someone typed an estimate for that week.
  const forecasts = useMemo(() => {
    const history = new Map((data?.intakeByWeek ?? []).map(r => [r.weekOf, r.byProduct]));
    const switched = new Map((data?.switchedByWeek ?? []).map(r => [r.weekOf, r.units]));
    const thisMonday = isoMonday(0);
    return Array.from({ length: WEEKS }, (_, w) => forecastBloomStockWeek(history, isoMonday(w), thisMonday, switched));
  }, [data]);
  const ordersFor = (w: number) => bs.weeklyEstimates[isoMonday(w)] ?? forecasts[w].total;
  const nextWeek = forecasts[1];

  const backlog = useMemo(() => {
    const by = emptyByProduct();
    for (const i of items) by[i.productKey] += i.quantity;
    return by;
  }, [items]);
  const backlogUnits = BLOOM_STOCK_PRODUCTS.reduce((t, p) => t + backlog[p.key], 0);

  // Per week, in items: orders (baseline + enabled what-ifs) and capacity
  // (scheduled hours ÷ ratio). Week 0 only counts the rest of this week —
  // orders already placed are in the backlog.
  const weeks = useMemo(() => {
    const share0 = (7 - todayIdx()) / 7;
    return Array.from({ length: WEEKS }, (_, w) => {
      const iso = isoMonday(w);
      const share = w === 0 ? share0 : 1;
      const scenarioUnits = bs.scenarios
        .filter(sc => sc.enabled && iso >= sc.startWeek && iso <= sc.endWeek)
        .reduce((t, sc) => t + sc.unitsPerWeek * share, 0);
      return {
        w, iso,
        hours: bs.hoursByWeek[w],
        capacity: bs.itemsByWeek[w],
        baseUnits: ordersFor(w) * share,
        forecast: forecasts[w],
        override: bs.weeklyEstimates[iso],
        scenarioUnits,
        intake: ordersFor(w) * share + scenarioUnits,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bs.scenarios, bs.hoursByWeek, bs.itemsByWeek, forecasts, bs.weeklyEstimates]);

  const canProject = bs.itemsByWeek.some(c => c > 0);
  const doneWeeks = useMemo(() => canProject
    ? bloomStockDoneWeeks(backlogUnits, weeks.map(x => x.intake), weeks.map(x => x.capacity))
    : weeks.map(() => null), [canProject, backlogUnits, weeks]);

  // One flow, oldest first, like Design's "every intake week" table: order
  // weeks still in the queue (actual), then this week and the next 51
  // (estimated). doneIdx = week offset (0 = this week) the row's last item is
  // finished, FIFO against scheduled capacity.
  const flowRows = useMemo(() => {
    const thisMonday = isoMonday(0);
    const map = new Map<string, Record<BloomStockProductKey, number>>();
    for (const i of items) {
      const wk = isoMondayFromDate(new Date(i.orderDate + 'T12:00:00'));
      const row = map.get(wk) ?? emptyByProduct();
      row[i.productKey] += i.quantity;
      map.set(wk, row);
    }
    const unitsOf = (r: Record<BloomStockProductKey, number>) => BLOOM_STOCK_PRODUCTS.reduce((u, p) => u + r[p.key], 0);
    const cumCap: number[] = [];
    weeks.reduce((t, x, i) => (cumCap[i] = t + x.capacity), 0);
    const past: {
      weekOf: string; future: number | null; byProduct: Record<BloomStockProductKey, number> | null; units: number;
      estUnits: number; scenarioUnits: number; weeksElapsed: number; doneIdx: number | null;
      forecast?: BloomStockWeekForecast; override?: number;
    }[] = [];
    const pastWeeks = [...map.entries()].filter(([wk]) => wk < thisMonday).sort(([a], [b]) => a.localeCompare(b));
    for (let k = 0, cum = 0; k < pastWeeks.length; k++) {
      const [weekOf, byProduct] = pastWeeks[k];
      cum += unitsOf(byProduct);
      const need = cum;
      const t = canProject ? cumCap.findIndex(c => c >= need - 1e-9) : -1;
      past.push({
        weekOf, future: null, byProduct, units: unitsOf(byProduct),
        estUnits: 0, scenarioUnits: 0,
        weeksElapsed: Math.floor(daysBetween(weekOf, thisMonday) / 7),
        doneIdx: t >= 0 ? t : null,
      });
    }
    const upcoming = weeks.map(x => {
      const byProduct = map.get(x.iso) ?? null;
      return {
        weekOf: x.iso, future: x.w as number | null, byProduct, units: byProduct ? unitsOf(byProduct) : 0,
        estUnits: x.baseUnits, scenarioUnits: x.scenarioUnits, forecast: x.forecast, override: x.override,
        weeksElapsed: -x.w,
        doneIdx: doneWeeks[x.w],
      };
    });
    return [...past, ...upcoming];
  }, [items, weeks, canProject, doneWeeks]);

  // Deadline check — FIFO means only orders placed before the cutoff stand
  // ahead of the due date: backlog + orders before the cutoff vs capacity
  // through the due date.
  const deadline = useMemo(() => {
    const { orderCutoff, dueBy } = bs.deadline;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
    // Share of week w's window before `limit` (exclusive); week 0 starts today.
    const shareBefore = (w: number, iso: string, limit: string) => {
      const start = w === 0 ? today : iso;
      const span = daysBetween(start, addDaysIso(iso, 7));
      return span > 0 ? Math.max(0, Math.min(span, daysBetween(start, limit))) / span : 0;
    };
    let demand = backlogUnits, cap = 0, hours = 0;
    for (const x of weeks) {
      demand += x.intake * shareBefore(x.w, x.iso, orderCutoff);
      const s = shareBefore(x.w, x.iso, addDaysIso(dueBy, 1));
      cap += x.capacity * s;
      hours += x.hours * s;
    }
    const weeksLeft = Math.max(1, daysBetween(today, dueBy) / 7);
    const shortItems = demand - cap;
    return { demand, cap, hours, shortItems, extraHrsPerWeek: ratio ? (shortItems * ratio) / weeksLeft : 0 };
  }, [bs.deadline, weeks, backlogUnits, ratio]);

  function setScenario(id: string, patch: Partial<BloomStockScenario>) {
    bs.setScenarios(bs.scenarios.map(sc => (sc.id === id ? { ...sc, ...patch } : sc)));
  }
  const filtered = productFilter === 'all' ? items : items.filter(i => i.productKey === productFilter);
  const backlogClear = canProject ? doneWeeks[0] : null;
  const tone = (n: number) => (n <= 2 ? 'green' : n <= 4 ? 'amber' : n <= 8 ? 'orange' : 'red');
  const barCls = { green: 'bg-green-400', amber: 'bg-amber-400', orange: 'bg-orange-400', red: 'bg-red-500' };
  const txtCls = { green: 'text-green-700', amber: 'text-amber-700', orange: 'text-orange-700', red: 'text-red-700' };

  return (
    <div className="space-y-6">
      {/* ── Summary ──────────────────────────────────────────────────────── */}
      <div className={card}>
        <div className={cardHead}>
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Open orders</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              New, Ready to Design and Influencer orders from the Orders tab.{notCounted > 0 && ` ${notCounted} waiting / on hold not counted.`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data && <span className="text-xs text-slate-400">Shopify as of {new Date(data.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>}
            <button onClick={() => load(true)} disabled={refreshing}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {refreshing ? 'Refreshing…' : 'Refresh from Shopify'}
            </button>
          </div>
        </div>
        {error && <div className="px-5 py-3 text-sm text-rose-700 bg-rose-50">Couldn&apos;t load the queue from Shopify: {error}</div>}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 p-4">
          <Stat label="In queue" value={data ? `${backlogUnits}` : '…'} highlight
            sub={canProject ? `clears wk of ${backlogClear != null ? fmtShort(isoMonday(backlogClear)) : '52+ wks'}` : undefined} />
          {BLOOM_STOCK_PRODUCTS.map(p => (
            <Stat key={p.key} label={p.label} value={data ? `${backlog[p.key]}` : '…'} sub={`~${r1(nextWeek?.byProduct[p.key] ?? 0)} forecast next wk`} />
          ))}
          <Stat label="Capacity / week" value={canProject ? `${Math.round(bs.itemsByWeek[1] ?? 0)} items` : '—'}
            sub={`${r1(bs.hoursByWeek[1] ?? 0)} hrs next week`} />
        </div>
      </div>

      {/* ── What-ifs + deadline ──────────────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className={card}>
          <div className={cardHead}>
            <div>
              <h3 className="text-sm font-semibold text-slate-700">What-if launches</h3>
              <p className="text-xs text-slate-400 mt-0.5">Extra orders per week on top of the normal pace, at the same ratio. Toggle off to compare.</p>
            </div>
            {canEdit && (
              <button onClick={() => bs.setScenarios([...bs.scenarios, { id: `sc-${Date.now()}`, name: 'New product launch', startWeek: '2026-11-02', endWeek: '2026-11-30', unitsPerWeek: 20, enabled: true }])}
                className="px-3 py-1 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">+ Add</button>
            )}
          </div>
          <div className="divide-y divide-slate-50">
            {bs.scenarios.length === 0 && <div className="px-5 py-4 text-xs text-slate-400">No what-ifs yet — e.g. a new product launching in November.</div>}
            {bs.scenarios.map(sc => (
              <div key={sc.id} className="px-5 py-3 space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={sc.enabled} disabled={!canEdit} onChange={e => setScenario(sc.id, { enabled: e.target.checked })} />
                  <input value={sc.name} disabled={!canEdit} onChange={e => setScenario(sc.id, { name: e.target.value })}
                    className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs font-medium text-slate-700" />
                  {canEdit && <button onClick={() => bs.setScenarios(bs.scenarios.filter(x => x.id !== sc.id))} className="text-slate-400 hover:text-rose-600">Remove</button>}
                </div>
                <div className="flex items-center gap-2 flex-wrap text-slate-500">
                  <input type="number" min="0" value={sc.unitsPerWeek || ''} disabled={!canEdit}
                    onChange={e => setScenario(sc.id, { unitsPerWeek: Math.max(0, parseFloat(e.target.value) || 0) })} className={numInput} />
                  orders/week, weeks of
                  <input type="date" value={sc.startWeek} disabled={!canEdit}
                    onChange={e => e.target.value && setScenario(sc.id, { startWeek: isoMondayFromDate(new Date(e.target.value + 'T12:00:00')) })}
                    className="px-1 py-0.5 border border-slate-200 rounded" />
                  to
                  <input type="date" value={sc.endWeek} disabled={!canEdit}
                    onChange={e => e.target.value && setScenario(sc.id, { endWeek: isoMondayFromDate(new Date(e.target.value + 'T12:00:00')) })}
                    className="px-1 py-0.5 border border-slate-200 rounded" />
                  {ratio && <span>= {r1(sc.unitsPerWeek * ratio)} hrs/week</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={card}>
          <div className={cardHead}>
            <div>
              <h3 className="text-sm font-semibold text-slate-700">Deadline check</h3>
              <p className="text-xs text-slate-400 mt-0.5">Can everything ordered before the cutoff be finished by the due date? Leave time to ship.</p>
            </div>
          </div>
          <div className="px-5 py-4 space-y-3 text-xs">
            <div className="flex items-center gap-2 flex-wrap text-slate-500">
              Orders placed before
              <input type="date" value={bs.deadline.orderCutoff} disabled={!canEdit}
                onChange={e => e.target.value && bs.setDeadline({ ...bs.deadline, orderCutoff: e.target.value })}
                className="px-1 py-0.5 border border-slate-200 rounded" />
              finished by
              <input type="date" value={bs.deadline.dueBy} disabled={!canEdit}
                onChange={e => e.target.value && bs.setDeadline({ ...bs.deadline, dueBy: e.target.value })}
                className="px-1 py-0.5 border border-slate-200 rounded" />
            </div>
            {!canProject ? (
              <div className="text-amber-600">Set ratios and standard hours on the roster to run the check.</div>
            ) : deadline.shortItems <= 0 ? (
              <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-green-800">
                <span className="font-semibold">On track.</span> ~{Math.round(deadline.demand)} items to finish vs ~{Math.round(deadline.cap)} the team can do ({Math.round(deadline.hours)} hrs) — {Math.round(-deadline.shortItems)} items to spare.
              </div>
            ) : (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-red-800">
                <span className="font-semibold">Short ~{Math.round(deadline.shortItems)} items.</span> ~{Math.round(deadline.demand)} to finish vs ~{Math.round(deadline.cap)} the team can do ({Math.round(deadline.hours)} hrs) — add about {r1(deadline.extraHrsPerWeek)} hrs/week from now to the due date.
              </div>
            )}
            <div className="text-slate-400">Counts today&apos;s queue, normal weekly orders and any what-ifs switched on.</div>
          </div>
        </div>
      </div>

      {/* ── Queue & turnaround — same layout as Design's ───────────────── */}
      <div className={card}>
        <div className="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Queue &amp; turnaround — every order week, oldest first</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Open orders (actual) then upcoming weeks (seasonal forecast: same week last year × growth{bs.scenarios.some(sc => sc.enabled) ? ', plus what-ifs' : ''} — type over any week to override), worked oldest
              first on scheduled hours ÷ each person&apos;s ratio. Turnaround is order placed → finished.
            </p>
            {data && nextWeek && (
              <details className="mt-2 text-xs text-slate-500">
                <summary className="cursor-pointer text-indigo-600 hover:text-indigo-800">How future orders are estimated</summary>
                <div className="mt-1.5 space-y-1 pl-3 border-l-2 border-slate-100">
                  <p>Each product is estimated separately from Shopify order history, the same way bouquet arrivals are:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {BLOOM_STOCK_PRODUCTS.map(p => {
                      const b = nextWeek.basis[p.key];
                      return (
                        <li key={p.key}>
                          <span className="font-medium text-slate-600">{p.label}</span> — {b.method === 'seasonal'
                            ? <>the same week last year (averaged with the 2 weeks either side) × <span className="font-medium">{b.growth}</span> growth (its last 12 weeks vs the same 12 weeks a year ago). Follows last year&apos;s seasonality.</>
                            : <>not a full year of history yet, so its last 8 weeks&apos; average: <span className="font-medium">{r1(nextWeek.byProduct[p.key])}/wk</span>, flat.</>}
                        </li>
                      );
                    })}
                    <li><span className="font-medium text-slate-600">Switched recreations</span> (sold as a Pressed Frame etc., added on the Orders board) — last 8 weeks&apos; average: <span className="font-medium">{r1(nextWeek.switched)}/wk</span>, flat.</li>
                  </ul>
                  <p>Type over any week&apos;s number to override it (e.g. a promo or launch); ✕ goes back to the forecast. What-if launches add on top.</p>
                </div>
              </details>
            )}
            {!canProject && data && <p className="text-xs text-amber-600 mt-1">Set ratios and standard hours on the roster to see turnaround.</p>}
          </div>
          <button onClick={() => setShowItems(v => !v)}
            className="text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 whitespace-nowrap">
            {showItems ? 'Hide line items ▲' : `Show ${items.length} line items ▼`}
          </button>
        </div>
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 sticky top-0">
                <th className="px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap">Order week</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Orders</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Status</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500 whitespace-nowrap" title="Week the last order from this order week is projected to be finished">Finished by</th>
                <th className="px-3 py-2 text-left font-medium text-slate-500 min-w-[180px]" title="Order placed → finished, in weeks">Turnaround (order → finished)</th>
              </tr>
            </thead>
            <tbody>
              {!data && !error && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">Loading from Shopify…</td></tr>}
              {data && flowRows.map(r => {
                const notYet = r.future !== null && r.future > 0;
                const working = !notYet && r.doneIdx === 0;
                // Open rows: bar = weeks from today. Upcoming rows: bar = order → finished.
                // Turnaround = order week → finish week; for open orders that
                // includes the weeks they've already waited.
                const total = r.doneIdx == null ? null : r.weeksElapsed + r.doneIdx;
                const fromNow = r.doneIdx;
                return (
                  <tr key={r.weekOf} className={`border-b border-slate-50 ${r.scenarioUnits > 0 ? 'bg-violet-50/40' : working ? 'bg-indigo-50/40' : notYet ? 'bg-slate-50/40' : 'hover:bg-slate-50'}`}>
                    <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                      {fmtDate(r.weekOf)} <span className="font-normal text-slate-300">wk{getISOWeekNumber(r.weekOf)}</span>
                      {r.future === 0 && <span className="ml-2 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1 py-px">this week</span>}
                      {notYet && <span className="ml-2 text-[10px] bg-slate-100 text-slate-400 rounded px-1 py-px">est.</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      <div className="flex flex-col items-end">
                        {notYet ? (
                          <>
                            <div className="flex items-center gap-1">
                              {canEdit ? (
                                <input type="number" min="0" placeholder={String(Math.round(r.forecast?.total ?? 0))}
                                  value={r.override ?? Math.round(r.estUnits)}
                                  onChange={e => bs.setWeeklyEstimate(r.weekOf, e.target.value === '' ? null : Math.max(0, parseInt(e.target.value) || 0))}
                                  title="Estimated orders this week — edit to override the seasonal forecast"
                                  className="w-14 border border-slate-200 rounded px-1.5 py-0.5 text-center text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                              ) : <span className="text-slate-500">~{Math.round(r.estUnits)}</span>}
                            </div>
                            {r.override !== undefined ? (
                              <span className="flex items-center gap-1 text-[10px] text-amber-600 whitespace-nowrap" title="Manual override — the seasonal forecast is not being used this week">
                                manual override
                                {canEdit && <button onClick={() => bs.setWeeklyEstimate(r.weekOf, null)} className="text-slate-400 hover:text-red-500" title="Clear — use the seasonal forecast">✕</button>}
                              </span>
                            ) : r.forecast && <ForecastHint f={r.forecast} />}
                          </>
                        ) : (
                          <span className="font-medium text-slate-600">{r.units}{r.future === 0 && r.estUnits > 0 && <span className="font-normal text-slate-400"> + ~{Math.round(r.estUnits + r.scenarioUnits)} est.</span>}</span>
                        )}
                        {r.byProduct && r.units > 0 && (
                          <span className="text-[10px] text-slate-400 whitespace-nowrap">
                            {BLOOM_STOCK_PRODUCTS.filter(p => r.byProduct![p.key] > 0).map(p => `${r.byProduct![p.key]} ${SHORT[p.key]}`).join(' · ')}
                          </span>
                        )}
                        {r.scenarioUnits > 0 && <span className="text-[10px] text-violet-600 whitespace-nowrap">+{Math.round(r.scenarioUnits)} what-if</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {notYet ? <span className="text-slate-400 text-[10px] bg-slate-100 rounded px-1.5 py-0.5">not yet ordered</span>
                        : working ? <span className="text-indigo-700 text-[10px] bg-indigo-100 rounded px-1.5 py-0.5">working now</span>
                        : <span className="text-slate-500 text-[10px]">in queue</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {!canProject ? <span className="text-xs text-slate-300">—</span>
                        : fromNow == null ? <span className="text-xs text-red-400 italic">not within 52 wks</span>
                        : (
                          <div>
                            <span className="text-xs font-medium text-slate-700">wk of {fmtShort(isoMonday(fromNow))}</span>
                            <span className="block text-[10px] text-slate-400">{fromNow === 0 ? 'this week' : `${fromNow} wk${fromNow === 1 ? '' : 's'} from now`}</span>
                          </div>
                        )}
                    </td>
                    <td className="px-3 py-2">
                      {!canProject || total === null ? <span className="text-xs text-slate-400">{canProject ? '—' : 'TBD'}</span> : (
                        <div>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-slate-100 rounded-full h-1.5 max-w-24">
                              <div className={`h-1.5 rounded-full ${barCls[tone(total)]}`} style={{ width: `${Math.max(4, Math.min(100, (total / 10) * 100))}%` }} />
                            </div>
                            <span className={`text-xs font-semibold whitespace-nowrap ${txtCls[tone(total)]}`}>
                              {total === 0 ? 'same week' : `~${total} wk${total !== 1 ? 's' : ''}`}
                            </span>
                          </div>
                          {!notYet && r.weeksElapsed > 0 && (
                            <span className="text-[10px] text-slate-400">waited {r.weeksElapsed} wk{r.weeksElapsed === 1 ? '' : 's'} so far</span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {showItems && (
          <div className="border-t border-slate-100">
            <div className="flex gap-1.5 flex-wrap px-5 py-3">
              {([['all', 'All'], ...BLOOM_STOCK_PRODUCTS.map(p => [p.key, p.label] as const)] as const).map(([key, label]) => (
                <button key={key} onClick={() => setProductFilter(key as BloomStockProductKey | 'all')}
                  className={`px-3 py-1 text-xs rounded-full font-medium ${productFilter === key ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Order</th>
                    <th className="px-3 py-2 text-left font-medium">Ordered</th>
                    <th className="px-3 py-2 text-center font-medium">Days</th>
                    <th className="px-3 py-2 text-left font-medium">Product</th>
                    <th className="px-3 py-2 text-left font-medium">Variant</th>
                    <th className="px-3 py-2 text-center font-medium">Qty</th>
                    <th className="px-3 py-2 text-left font-medium">Tag</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filtered.map(i => (
                    <tr key={i.lineItemId}>
                      <td className="px-4 py-1.5">
                        <a href={`https://${data?.storeDomain}/admin/orders/${i.orderId}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{i.orderNumber}</a>
                      </td>
                      <td className="px-3 py-1.5 text-slate-600">{fmtDate(i.orderDate)}</td>
                      <td className="px-3 py-1.5 text-center text-slate-600">{daysBetween(i.orderDate, new Date().toISOString().split('T')[0])}</td>
                      <td className="px-3 py-1.5 text-slate-700">{BLOOM_STOCK_LABEL[i.productKey]}</td>
                      <td className="px-3 py-1.5 text-slate-500">{i.variantTitle ?? '—'}</td>
                      <td className="px-3 py-1.5 text-center text-slate-700">{i.quantity}</td>
                      <td className="px-3 py-1.5 text-slate-500">{i.location ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Orders board (replaces the team's tracking sheet) ────────────────────────

function OrdersTab({ bs, canEdit, queue }: { bs: BS; canEdit: boolean; queue: QueueState }) {
  const { data, error, refreshing, load } = queue;
  const [onlyUnsorted, setOnlyUnsorted] = useState(false);
  const [search, setSearch] = useState('');
  const [showAssumed, setShowAssumed] = useState(false);
  const [local, setLocal] = useState<Record<string, Partial<BloomStockQueueItem>>>({});
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [addNum, setAddNum] = useState('');
  const [addMsg, setAddMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function addOrder() {
    if (!addNum.trim()) return;
    setAddMsg(null);
    const res = await fetch('/api/bloom-stock/tracking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addOrderNumber: addNum }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { setAddMsg({ text: json.error ?? `Couldn't add (${res.status})`, ok: false }); return; }
    setAddMsg({ text: `Added #${addNum.replace(/^#/, '')} to New Orders`, ok: true });
    setAddNum('');
    setLocal({});
    load(true);
  }

  const all = useMemo(() => (data?.items ?? []).map(i => ({ ...i, ...local[i.lineItemId] })), [data, local]);
  const q = search.trim().toLowerCase();
  const needsSorting = all.filter(i => !i.sorted && !i.assumedDone);
  const finish = useMemo(() => bs.estimateFinish(all), [bs, all]);
  const searched = q ? all.filter(i => `${i.customer ?? ''} ${i.orderNumber} ${i.notes ?? ''} ${i.assignee ?? ''}`.toLowerCase().includes(q)) : all;
  const visible = onlyUnsorted ? searched.filter(i => !i.sorted && !i.assumedDone) : searched;
  const assumed = visible.filter(i => i.assumedDone);
  const active = visible.filter(i => !i.assumedDone);
  const rosterNames = bs.roster.map(m => m.name).filter(Boolean);

  async function save(i: BloomStockQueueItem, patch: { status?: BloomStockStatus; type?: BloomStockType | null; assignee?: string | null; notes?: string | null }) {
    setSaveErr(null);
    // Any edit to an assumed-finished order brings it back as tracked.
    setLocal(l => ({ ...l, [i.lineItemId]: { ...l[i.lineItemId], ...patch, assumedDone: false, sorted: true } }));
    const res = await fetch('/api/bloom-stock/tracking', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineItemId: i.lineItemId, orderId: i.orderId, orderName: i.orderNumber, productKey: i.productKey, units: i.quantity, ...patch }),
    });
    if (!res.ok) setSaveErr((await res.json().catch(() => ({}))).error ?? `Save failed (${res.status})`);
  }

  const section = (key: BloomStockStatus, label: string, rows: typeof all) => (
    <div key={key} className={card}>
      <div className="px-5 py-2.5 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{label} <span className="font-normal text-slate-400">· {rows.length}</span></h3>
        {QUEUE_STATUSES.has(key) && <span className="text-[10px] text-indigo-600">counts in queue</span>}
      </div>
      {rows.length > 0 && <OrdersTable rows={rows} finish={finish} storeDomain={data?.storeDomain ?? ''} rosterNames={rosterNames} canEdit={canEdit} onSave={save} />}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, order #, notes…"
            className="w-72 px-3 py-1.5 text-sm border border-slate-200 rounded-lg" />
          {canEdit && (
            <div className="flex items-center gap-1.5" title="For an order switched to a recreation after purchase (sold as a Pressed Frame, Mini Frame, Boutonniere Frame or Ornament)">
              <input value={addNum} onChange={e => setAddNum(e.target.value)} onKeyDown={e => e.key === 'Enter' && addOrder()}
                placeholder="Add order #" className="w-32 px-3 py-1.5 text-sm border border-slate-200 rounded-lg" />
              <button onClick={addOrder} disabled={!addNum.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">Add</button>
            </div>
          )}
          {addMsg && <span className={`text-xs ${addMsg.ok ? 'text-green-700' : 'text-rose-600'}`}>{addMsg.text}</span>}
        </div>
        <div className="flex items-center gap-3">
          {saveErr && <span className="text-xs text-rose-600">{saveErr}</span>}
          {data && <span className="text-xs text-slate-400">Shopify as of {new Date(data.fetchedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>}
          <button onClick={() => { setLocal({}); load(true); }} disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {refreshing ? 'Refreshing…' : 'Refresh from Shopify'}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Every open Shopify order with a Handprint, Paw Print, Footprint or Bloom Arrangement Recreation. Type comes from the order&apos;s Blooms Process choice; send-your-own orders start in Waiting.
        Set an order to Finished (with who did it) and it moves to Historicals for this week.
      </p>
      {data && needsSorting.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div>
            <p className="text-sm font-medium text-amber-800">{needsSorting.length} new order{needsSorting.length === 1 ? '' : 's'} to sort</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Came in from Shopify and haven&apos;t been reviewed. Set the status, type or assignee — or click ✓ Sorted if the guess is right.
            </p>
          </div>
          <button onClick={() => setOnlyUnsorted(v => !v)}
            className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-800 hover:bg-amber-100">
            {onlyUnsorted ? 'Show all orders' : 'Show only these'}
          </button>
        </div>
      )}
      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Couldn&apos;t load orders from Shopify: {error}</div>}
      {data && !bs.roster.some(m => m.ratio) && (
        <div className="rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-2 text-xs text-indigo-700">
          Enter each person&apos;s <span className="font-semibold">ratio (hrs / item)</span> on the roster above to see each order&apos;s estimated finish date and turnaround.
        </div>
      )}
      {!data && !error && <div className="py-10 text-center text-sm text-slate-400">Loading orders from Shopify…</div>}
      {data && BLOOM_STOCK_STATUSES.filter(st => st.key !== 'finished').map(st => section(st.key, st.label, active.filter(i => i.status === st.key)))}
      {data && assumed.length > 0 && (
        <div className={card}>
          <button onClick={() => setShowAssumed(v => !v)} className="w-full px-5 py-2.5 flex items-center justify-between bg-slate-50/60 text-left">
            <span className="text-sm font-semibold text-slate-500">Assumed finished (ordered before Jun 1) <span className="font-normal text-slate-400">· {assumed.length}</span></span>
            <span className="text-xs text-slate-400">{showAssumed ? 'Hide ▲' : 'Show ▼'} — still open in Shopify; change a status to track it again</span>
          </button>
          {showAssumed && <OrdersTable rows={assumed} finish={finish} storeDomain={data.storeDomain} rosterNames={rosterNames} canEdit={canEdit} onSave={save} />}
        </div>
      )}
    </div>
  );
}

function OrdersTable({ rows, finish, storeDomain, rosterNames, canEdit, onSave }: {
  rows: BloomStockQueueItem[]; finish: Map<string, string | null>; storeDomain: string; rosterNames: string[]; canEdit: boolean;
  onSave: (i: BloomStockQueueItem, patch: { status?: BloomStockStatus; type?: BloomStockType | null; assignee?: string | null; notes?: string | null }) => void;
}) {
  const today = new Date().toISOString().split('T')[0];
  const sel = 'px-1.5 py-1 border border-slate-200 rounded text-xs bg-white';
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 text-slate-500">
            <th className="px-4 py-2 text-left font-medium">Name</th>
            <th className="px-3 py-2 text-left font-medium">Order #</th>
            <th className="px-3 py-2 text-left font-medium">Ordered</th>
            <th className="px-3 py-2 text-left font-medium">Product</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-left font-medium">Assignee</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium whitespace-nowrap" title="Projected finish, FIFO by order date on scheduled hours ÷ ratio">Est. done</th>
            <th className="px-3 py-2 text-left font-medium min-w-[220px]">Notes</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map(i => (
            <tr key={i.lineItemId} className={`align-top ${!i.sorted && !i.assumedDone ? 'bg-amber-50/60' : 'hover:bg-slate-50/60'}`}>
              <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                {i.customer ?? '—'}
                {!i.sorted && !i.assumedDone && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 rounded px-1.5 py-px">Needs sorting</span>
                    {canEdit && (
                      <button onClick={() => onSave(i, { status: i.status })} title="The status/type shown are right — mark as reviewed"
                        className="text-[10px] text-amber-700 hover:text-amber-900 underline">✓ Sorted</button>
                    )}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <a href={`https://${storeDomain}/admin/orders/${i.orderId}`} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{i.orderNumber}</a>
                {i.location && <span className="ml-1 text-[10px] text-slate-400">{i.location === 'Georgia' ? 'GA' : 'UT'}</span>}
              </td>
              <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtDate(i.orderDate)}<div className="text-[10px] text-slate-400">{daysBetween(i.orderDate, today)} days</div></td>
              <td className="px-3 py-2 text-slate-700">
                {BLOOM_STOCK_LABEL[i.productKey]}{i.quantity > 1 ? ` ×${i.quantity}` : ''}
                {i.variantTitle && <div className="text-[10px] text-slate-400">{i.variantTitle}</div>}
              </td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <select value={i.type ?? ''} onChange={e => onSave(i, { type: (e.target.value || null) as BloomStockType | null })} className={sel}>
                    <option value="">?</option>
                    {(Object.keys(BLOOM_STOCK_TYPE_LABEL) as BloomStockType[]).map(t => <option key={t} value={t}>{BLOOM_STOCK_TYPE_LABEL[t]}</option>)}
                  </select>
                ) : (i.type ? BLOOM_STOCK_TYPE_LABEL[i.type] : '—')}
              </td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <select value={i.assignee ?? ''} onChange={e => onSave(i, { assignee: e.target.value || null })} className={sel}>
                    <option value="">—</option>
                    {[...new Set([...rosterNames, ...(i.assignee ? [i.assignee] : [])])].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                ) : (i.assignee ?? '—')}
              </td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <select value={i.assumedDone ? '' : i.status} onChange={e => e.target.value && onSave(i, { status: e.target.value as BloomStockStatus })} className={sel}>
                    {i.assumedDone && <option value="">Assumed finished</option>}
                    {BLOOM_STOCK_STATUSES.map(st => <option key={st.key} value={st.key}>{st.label}</option>)}
                  </select>
                ) : BLOOM_STOCK_STATUSES.find(st => st.key === i.status)?.label}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {(() => {
                  if (!finish.has(i.lineItemId)) return <span className="text-slate-300">—</span>;
                  const d = finish.get(i.lineItemId);
                  if (!d) return <span className="text-red-500 text-[11px]">52+ wks</span>;
                  const total = Math.ceil(daysBetween(i.orderDate, d) / 7);
                  const cls = total <= 2 ? 'text-green-700' : total <= 4 ? 'text-amber-700' : total <= 8 ? 'text-orange-700' : 'text-red-700';
                  return (
                    <span className={`font-semibold ${cls}`}>
                      {fmtShort(d)}<span className="block text-[10px] font-normal text-slate-400">{daysBetween(today, d) <= 0 ? 'today' : `in ${daysBetween(today, d)} days`} · {total} wk turnaround</span>
                    </span>
                  );
                })()}
              </td>
              <td className="px-3 py-2">
                {canEdit ? (
                  <NotesInput value={i.notes ?? ''} onCommit={v => onSave(i, { notes: v })} />
                ) : <span className="text-slate-500">{i.notes ?? ''}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotesInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); };
  return (
    <input value={draft ?? value} placeholder="Add a note"
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()}
      className="w-full px-2 py-1 border border-transparent hover:border-slate-200 focus:border-slate-300 rounded text-xs text-slate-600" />
  );
}

// ─── Roster ────────────────────────────────────────────────────────────────────

// Same layout and behaviour as the Resin roster: collapsible panel above
// the tabs, Rippling autocomplete, role tier, ratio with ↻ refresh, Mon–Sun
// standard schedule with reset-to-template, employment dates and an
// inactive toggle.
function RosterPanel({ bs, canEdit, visibleRoster, inactiveCount, showInactive, onToggleInactive, onRefreshRatio, refreshingId }: {
  bs: BS; canEdit: boolean;
  visibleRoster: BloomStockMember[]; inactiveCount: number; showInactive: boolean; onToggleInactive: () => void;
  onRefreshRatio: (m: BloomStockMember) => void; refreshingId: string | null;
}) {
  const [open, setOpen] = useState(false);
  function patch(id: string, p: Partial<BloomStockMember>) {
    bs.setRoster(bs.roster.map(m => (m.id === id ? { ...m, ...p } : m)));
  }
  function updateTemplate(id: string, di: number, v: number) {
    const m = bs.roster.find(x => x.id === id);
    const t = [...(m?.standardWeeklyHours ?? [0, 0, 0, 0, 0, 0, 0])];
    t[di] = v;
    patch(id, { standardWeeklyHours: t });
  }
  // Clears one-off day overrides from this week forward (past weeks kept) so
  // the person follows their standard schedule again.
  function resetToTemplate(id: string) {
    if (!window.confirm('Clear this person’s scheduled hours from this week forward and go back to following their standard schedule? Past weeks are not affected.')) return;
    const next = { ...bs.daily };
    let changed = false;
    for (let w = 0; w < WEEKS; w++) {
      const k = `${isoMonday(w)}-${id}`;
      if (next[k]) { delete next[k]; changed = true; }
    }
    if (changed) bs.setDaily(next);
  }
  const inputCls = 'border border-slate-200 rounded px-1.5 py-1.5 text-xs text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300';
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="text-sm text-indigo-600 hover:text-indigo-800 font-medium">
        {open ? '▲ Hide' : '▼ Edit'} bloom stock roster, ratios &amp; schedules
      </button>
      {open && (
        <div className="mt-3 bg-white border border-slate-100 rounded-xl p-5">
          <div className="grid grid-cols-[1fr_100px_100px_90px_20px] gap-2 mb-2 px-1 text-xs font-medium text-slate-400">
            <span>Name</span>
            <span className="text-center">Role</span>
            <span className="text-center" title="Hours per item. Refreshes each week from the last 8 weeks of Historicals">Ratio</span>
            <span className="text-center">Hrs / week</span>
            <span />
          </div>
          <div className="space-y-3">
            {visibleRoster.length === 0 && <p className="text-xs text-slate-400 px-1">No one on the roster yet.</p>}
            {visibleRoster.map(m => (
              <div key={m.id} className="space-y-1.5">
                <div className="grid grid-cols-[1fr_100px_100px_90px_20px] gap-2 items-center">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="flex-1 min-w-0">
                      {canEdit ? (
                        <EmployeeAutocomplete value={m.name} location="Utah" department="Bloom Stock"
                          onChange={v => patch(m.id, { name: v })}
                          onSelect={(e: RipplingEmployee) => patch(m.id, { name: e.full_name, role: e.role })} />
                      ) : <span className="text-sm font-medium text-slate-700">{m.name}</span>}
                    </div>
                    <MemberTierBadges name={m.name} location="Utah" dept="Bloom Stock" fallbackRole={m.role} className="inline-flex shrink-0" />
                  </div>
                  <select value={m.role ?? 'specialist'} disabled={!canEdit} onChange={e => patch(m.id, { role: e.target.value as BloomStockMember['role'] })} className={inputCls}>
                    <option value="specialist">Specialist</option>
                    <option value="senior">Senior</option>
                    <option value="master">Master</option>
                  </select>
                  <div className="flex items-center gap-1">
                    {canEdit ? (
                      <input type="number" value={m.ratio ?? ''} step="0.01" min="0.01" placeholder="set"
                        onChange={e => patch(m.id, { ratio: parseFloat(e.target.value) || undefined })}
                        className={`w-full border rounded px-2 py-1.5 text-sm text-center text-slate-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 ${m.ratio ? 'border-slate-200' : 'border-amber-300'}`} />
                    ) : <span className="w-full text-center text-sm">{m.ratio ?? '—'}</span>}
                    {canEdit && (
                      <button onClick={() => onRefreshRatio(m)} disabled={refreshingId === m.id}
                        title={`Update ratio from last ${RATIO_WEEKS} weeks of Historicals${m.ratioUpdatedWeek ? ` (auto-updated wk of ${fmtShort(m.ratioUpdatedWeek)})` : ''}`}
                        className="text-slate-300 hover:text-indigo-500 transition-colors text-sm shrink-0">{refreshingId === m.id ? '…' : '↻'}</button>
                    )}
                  </div>
                  <span className="text-center text-sm font-medium text-slate-700">
                    {r1(sum(m.standardWeeklyHours))}
                    {m.ratio && sum(m.standardWeeklyHours) > 0 ? <span className="block text-[10px] font-normal text-slate-400">{Math.round(bs.itemsOf(m, sum(m.standardWeeklyHours)))} items</span> : null}
                  </span>
                  {canEdit ? (
                    <button onClick={() => bs.setRoster(bs.roster.filter(x => x.id !== m.id))} className="text-slate-300 hover:text-red-400 transition-colors text-xl leading-none text-center">×</button>
                  ) : <span />}
                </div>
                <div className="flex items-center gap-1.5 pl-1 flex-wrap">
                  <span className="text-[10px] text-slate-400 w-32 shrink-0">
                    Standard schedule{!m.standardWeeklyHours && <span className="text-amber-500"> — not set</span>}
                  </span>
                  {WEEKDAY_LABELS.map((label, di) => (
                    <label key={di} className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] text-slate-300">{label[0]}</span>
                      <input type="number" min="0" step="0.5" placeholder="0" disabled={!canEdit}
                        value={m.standardWeeklyHours?.[di] || ''}
                        onChange={e => updateTemplate(m.id, di, parseFloat(e.target.value) || 0)}
                        title={`${label} standard hours`}
                        className="w-10 border border-slate-200 rounded px-1 py-0.5 text-center text-[11px] text-slate-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                    </label>
                  ))}
                  {canEdit && (
                    <button onClick={() => resetToTemplate(m.id)} title="Clear scheduled hours from this week forward and go back to following this template"
                      className="text-[10px] text-slate-400 hover:text-indigo-600 whitespace-nowrap ml-1">↺ Reset to template</button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 pl-1">
                  <span className="text-[10px] text-slate-400 w-32 shrink-0">Employment dates</span>
                  <EmploymentDatesEditor startDate={m.startDate} endDate={m.endDate}
                    onStartDateChange={v => patch(m.id, { startDate: v || undefined })}
                    onEndDateChange={v => patch(m.id, { endDate: v || undefined })} />
                </div>
                <div className="flex items-start gap-1.5 pl-1">
                  <span className="text-[10px] text-slate-400 w-32 shrink-0 pt-0.5">Schedule rules</span>
                  <ScheduleRulesEditor rules={m.scheduleRules} standardWeeklyHours={m.standardWeeklyHours}
                    onChange={rules => patch(m.id, { scheduleRules: rules })} />
                </div>
              </div>
            ))}
          </div>
          {canEdit && (
            <button onClick={() => bs.setRoster([...bs.roster, { id: `bs-${Date.now()}`, name: 'Team Member', role: 'specialist' }])}
              className="mt-3 text-xs px-3 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 transition-colors">+ Add member</button>
          )}
          <span className="ml-3"><InactiveToggle count={inactiveCount} showing={showInactive} onToggle={onToggleInactive} /></span>
          <p className="mt-3 text-xs text-slate-400">Pay comes from the Rippling upload (used for CPO, never shown here). Ratio = hours per item — refreshes automatically each week from the last {RATIO_WEEKS} weeks of Historicals (hours ÷ items logged); ↻ refreshes now.</p>
        </div>
      )}
    </div>
  );
}

// ─── Historicals: hours + completed order numbers → CPO ───────────────────────

interface Completion {
  id: string; week_of: string; member_name: string; order_name: string; order_id: string;
  line_item_id: string; product_key: BloomStockProductKey; units: number;
}
interface HoursRow { week_of: string; member_name: string; hours: number }

function HistoricalsTab({ bs, canViewCPO }: { bs: BS; canViewCPO: boolean }) {
  const weekOptions = useMemo(() => [isoMonday(0), ...Array.from({ length: HIST_WEEKS }, (_, i) => isoMonday(-(i + 1)))], []);
  const [week, setWeek] = useState(isoMonday(-1));
  const [hoursRows, setHoursRows] = useState<HoursRow[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  // Recreation-department gross pay per person/week from the Rippling
  // earnings upload (only sent to people who can see CPO).
  const [payroll, setPayroll] = useState<{ week_of: string; member_name: string; cost: number }[]>([]);
  const [hoursDraft, setHoursDraft] = useState<Record<string, string>>({});
  const [orderDraft, setOrderDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // Pay isn't on the roster. Salaried managers (Jennika) use the same hourly
  // Design does — that week's salary from managers.ts ÷ 52 ÷ 40 — so the
  // two departments cost her time identically; everyone else uses their
  // Rippling-upload rate.
  const [ripplingRates, setRipplingRates] = useState<Map<string, number>>(new Map());

  const reload = useCallback(async () => {
    const res = await fetch(`/api/bloom-stock/actuals?weeks=${HIST_WEEKS + 2}`);
    const json = await res.json();
    if (res.ok) { setHoursRows(json.hours ?? []); setCompletions(json.completions ?? []); setPayroll(json.payroll ?? []); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    fetch('/api/admin/employees-upload?location=Utah')
      .then(r => r.json())
      .then((d: { employees?: { full_name: string; pay_type: string; hourly_rate: number; annual_salary: number }[] }) => {
        const m = new Map<string, number>();
        for (const e of d.employees ?? []) {
          m.set(e.full_name.trim().toLowerCase(), e.hourly_rate > 0 ? e.hourly_rate : e.annual_salary > 0 ? e.annual_salary / 2080 : 0);
        }
        setRipplingRates(m);
      })
      .catch(() => {});
  }, []);

  // Everyone on the roster, plus anyone with logged history in this window.
  const memberNames = useMemo(() => {
    const names = bs.roster.map(m => m.name).filter(Boolean);
    for (const r of [...hoursRows, ...completions, ...payroll]) if (!names.includes(r.member_name)) names.push(r.member_name);
    return names;
  }, [bs.roster, hoursRows, completions, payroll]);
  const rateOf = (name: string, weekOf: string) => {
    const n = name.trim().toLowerCase();
    const mgr = DEPARTMENT_MANAGERS.find(m => m.location === 'Utah' && m.name.trim().toLowerCase() === n
      && (!m.from || weekOf >= m.from) && (!m.to || weekOf <= m.to));
    if (mgr) return mgr.annualSalary / 52 / STANDARD_WEEKLY_HOURS;
    return ripplingRates.get(n) ?? 0;
  };
  const hoursFor = (wk: string, name: string) => hoursRows.find(r => r.week_of === wk && r.member_name === name)?.hours ?? 0;

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/bloom-stock/actuals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await reload();
      return true;
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
      return false;
    } finally { setBusy(false); }
  }
  async function saveHours(name: string) {
    const raw = hoursDraft[name];
    if (raw === undefined) return;
    if (await post({ kind: 'hours', weekOf: week, memberName: name, hours: parseFloat(raw) || 0 })) {
      setHoursDraft(d => { const n = { ...d }; delete n[name]; return n; });
      setMsg({ text: `Saved ${name}'s hours`, ok: true });
    }
  }
  async function addOrders(name: string) {
    const nums = (orderDraft[name] ?? '').split(/[\s,]+/).filter(Boolean);
    if (nums.length === 0) return;
    let added = 0;
    for (const n of nums) if (await post({ kind: 'order', weekOf: week, memberName: name, orderNumber: n })) added++;
    if (added === nums.length) { setOrderDraft(d => ({ ...d, [name]: '' })); setMsg({ text: `Logged ${added} order${added === 1 ? '' : 's'}`, ok: true }); }
  }
  async function removeCompletion(id: string) {
    setBusy(true);
    await fetch(`/api/bloom-stock/actuals?id=${id}`, { method: 'DELETE' });
    await reload();
    setBusy(false);
  }

  function weekStats(wk: string) {
    const comps = completions.filter(c => c.week_of === wk);
    const units = emptyByProduct();
    for (const c of comps) units[c.product_key] += c.units;
    const totalUnits = BLOOM_STOCK_PRODUCTS.reduce((t, p) => t + units[p.key], 0);
    const hours = memberNames.reduce((t, n) => t + hoursFor(wk, n), 0);
    // Actual Recreation payroll for anyone paid under it that week; everyone
    // else (e.g. Jennika, who clocks under Design) is hours × rate.
    const cost = memberNames.reduce((t, n) => {
      const paid = payroll.find(p => p.week_of === wk && p.member_name === n);
      return t + (paid ? paid.cost : hoursFor(wk, n) * rateOf(n, wk));
    }, 0);
    return {
      comps, units, totalUnits, hours, cost,
      cpo: totalUnits > 0 && cost > 0 ? cost / totalUnits : null,
      ratio: totalUnits > 0 && hours > 0 ? hours / totalUnits : null,
    };
  }
  const cur = weekStats(week);

  return (
    <div className="space-y-6">
      <div className={card}>
        <div className={cardHead}>
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Hours &amp; completed orders</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              At the start of each week, log last week&apos;s order numbers per person. Hours fill in from Rippling&apos;s Recreation department when the hours report is uploaded — or type them here. Cost uses Recreation payroll from the earnings upload when there is one.
            </p>
          </div>
          <select value={week} onChange={e => setWeek(e.target.value)} className="px-2 py-1 text-xs border border-slate-200 rounded bg-white text-slate-700">
            {weekOptions.map(w => <option key={w} value={w}>Week of {fmtDate(w)}{w === isoMonday(0) ? ' (this week)' : ''}</option>)}
          </select>
        </div>
        {msg && <div className={`px-5 py-2 text-xs ${msg.ok ? 'text-green-700 bg-green-50' : 'text-rose-700 bg-rose-50'}`}>{msg.text}</div>}
        <div className="divide-y divide-slate-50">
          {memberNames.map(name => {
            const mine = cur.comps.filter(c => c.member_name === name);
            const myUnits = mine.reduce((t, c) => t + c.units, 0);
            const h = hoursDraft[name] ?? String(hoursFor(week, name) || '');
            const myRatio = myUnits > 0 && hoursFor(week, name) > 0 ? hoursFor(week, name) / myUnits : null;
            return (
              <div key={name} className="px-5 py-3 space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="font-medium text-sm text-slate-700 min-w-[140px]">{name}</div>
                  <label className="flex items-center gap-1.5 text-xs text-slate-500">
                    Hours
                    <input type="number" min="0" step="0.25" value={h} placeholder="0" disabled={busy}
                      onChange={e => setHoursDraft(d => ({ ...d, [name]: e.target.value }))}
                      onBlur={() => saveHours(name)}
                      onKeyDown={e => e.key === 'Enter' && saveHours(name)}
                      className="w-20 px-2 py-1 text-center border border-slate-200 rounded text-xs" />
                  </label>
                  <span className="text-xs text-slate-500">{myUnits} items{myRatio != null ? ` · ${r1(myRatio)} hrs/item` : ''}</span>
                  <div className="flex items-center gap-1.5 ml-auto">
                    <input value={orderDraft[name] ?? ''} placeholder="Order #s, e.g. 41234 41301" disabled={busy}
                      onChange={e => setOrderDraft(d => ({ ...d, [name]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && addOrders(name)}
                      className="w-56 px-2 py-1 border border-slate-200 rounded text-xs" />
                    <button onClick={() => addOrders(name)} disabled={busy || !(orderDraft[name] ?? '').trim()}
                      className="px-3 py-1 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">Log</button>
                  </div>
                </div>
                {mine.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {mine.map(c => (
                      <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[11px] text-slate-600">
                        {c.order_name} · {BLOOM_STOCK_LABEL[c.product_key]}{c.units !== 1 ? ` ×${c.units}` : ''}
                        <button onClick={() => removeCompletion(c.id)} disabled={busy} className="text-slate-400 hover:text-rose-600" title="Remove">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-t border-slate-100 bg-slate-50/50">
          <Stat label="Hours" value={`${r1(cur.hours)}`} />
          <Stat label="Items done" value={`${cur.totalUnits}`} sub={BLOOM_STOCK_PRODUCTS.filter(p => cur.units[p.key] > 0).map(p => `${cur.units[p.key]} ${SHORT[p.key]}`).join(' · ') || undefined} />
          <Stat label="Actual ratio" value={cur.ratio != null ? `${r1(cur.ratio)} hrs/item` : '—'} sub={bs.ratio ? `planning at ${bs.ratio}` : undefined} />
          {canViewCPO && <Stat label="CPO" value={cur.cpo != null ? fmt$(cur.cpo) : '—'} sub={cur.cost > 0 ? `${fmt$(cur.cost)} labor` : 'needs hours + pay rate'} highlight />}
        </div>
      </div>

      <div className={card}>
        <div className={cardHead}><h3 className="text-sm font-semibold text-slate-700">Last {HIST_WEEKS} weeks</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Week of</th>
                <th className="px-3 py-2 text-center font-medium">Hours</th>
                {BLOOM_STOCK_PRODUCTS.map(p => <th key={p.key} className="px-3 py-2 text-center font-medium">{p.label}</th>)}
                <th className="px-3 py-2 text-center font-medium">Items</th>
                <th className="px-3 py-2 text-center font-medium">Hrs / item</th>
                {canViewCPO && <th className="px-3 py-2 text-center font-medium">CPO</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {weekOptions.slice(1).map(wk => {
                const st = weekStats(wk);
                return (
                  <tr key={wk} className={wk === week ? 'bg-indigo-50/40' : ''}>
                    <td className="px-4 py-1.5 text-slate-700">{fmtDate(wk)}</td>
                    <td className="px-3 py-1.5 text-center text-slate-600">{r1(st.hours) || '—'}</td>
                    {BLOOM_STOCK_PRODUCTS.map(p => <td key={p.key} className="px-3 py-1.5 text-center text-slate-600">{st.units[p.key] || '—'}</td>)}
                    <td className="px-3 py-1.5 text-center font-medium text-slate-700">{st.totalUnits || '—'}</td>
                    <td className="px-3 py-1.5 text-center text-slate-600">{st.ratio != null ? r1(st.ratio) : '—'}</td>
                    {canViewCPO && <td className="px-3 py-1.5 text-center font-medium text-slate-800">{st.cpo != null ? fmt$(st.cpo) : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
