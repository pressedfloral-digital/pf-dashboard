'use client';

// ─── Shared "Monthly Summary" tab ───────────────────────────────────────────────
// Aggregates a 52-week schedule into calendar months. Used by Design, Preservation,
// Fulfillment, and Resin — each department builds its own MonthlyDatum[] from its
// own week/roster model, then hands it to this component to render.

export interface MonthlyMemberStats {
  units: number;
  cost:  number;
  hrs:   number;
}

export interface MonthlyDatum {
  monthKey:     string;
  weeks:        number;
  totalUnits:   number;
  totalHours:   number;
  totalCost:    number;
  monthlyRatio: number | null;
  monthlyCPO:   number | null;
  byMember:     Record<string, MonthlyMemberStats>;
}

function fmt$(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

export function MonthlySummarySection({
  monthlyData,
  members,
  unitLabel,
  unitAbbrev,
  hasRates,
  memberColumnLabel = 'Team member',
  breakdownTitle,
}: {
  monthlyData: MonthlyDatum[];
  members: { id: string; name: string; payType?: 'hourly' | 'salary' }[];
  unitLabel: string;
  unitAbbrev: string;
  hasRates: boolean;
  memberColumnLabel?: string;
  breakdownTitle?: string;
}) {
  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">Monthly summary</h2>
          <p className="text-xs text-slate-400 mt-0.5">Each week attributed to the month of its Monday. Monthly ratio = total hours ÷ total {unitLabel}.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-2 text-left font-medium text-slate-500">Month</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Weeks</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Total {unitLabel}</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Total hours</th>
                <th className="px-3 py-2 text-right font-medium text-slate-500">Monthly ratio</th>
                {hasRates && <th className="px-3 py-2 text-right font-medium text-slate-500">Total labor</th>}
                {hasRates && <th className="px-3 py-2 text-right font-medium text-slate-500">Monthly CPO</th>}
              </tr>
            </thead>
            <tbody>
              {monthlyData.map((m, i) => (
                <tr key={m.monthKey} className={`border-b border-slate-50 ${i === 0 ? 'bg-indigo-50/40' : 'hover:bg-slate-50'}`}>
                  <td className="px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                    {m.monthKey}
                    {i === 0 && <span className="ml-2 text-[10px] bg-indigo-100 text-indigo-600 rounded px-1 py-px">current</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-500">{m.weeks}</td>
                  <td className="px-3 py-2 text-right font-medium text-indigo-700">{Math.round(m.totalUnits)}</td>
                  <td className="px-3 py-2 text-right text-slate-500">{Math.round(m.totalHours)}</td>
                  <td className="px-3 py-2 text-right font-medium text-slate-700">
                    {m.monthlyRatio !== null ? `${Math.round(m.monthlyRatio * 100) / 100} hrs/${unitAbbrev === 'f' ? 'frame' : unitLabel.replace(/s$/, '')}` : '—'}
                  </td>
                  {hasRates && <td className="px-3 py-2 text-right text-slate-500">{m.totalCost > 0 ? fmt$(m.totalCost) : '—'}</td>}
                  {hasRates && <td className="px-3 py-2 text-right font-medium text-amber-700">{m.monthlyCPO !== null ? fmt$(m.monthlyCPO) : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">{breakdownTitle ?? `Per-${memberColumnLabel.toLowerCase()} monthly breakdown`}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="sticky left-0 bg-slate-50 px-4 py-2 text-left font-medium text-slate-500 whitespace-nowrap">{memberColumnLabel}</th>
                {monthlyData.slice(0, 6).map(m => (
                  <th key={m.monthKey} className="px-3 py-2 text-center font-medium text-slate-500 whitespace-nowrap min-w-[120px]">
                    {m.monthKey.split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((mem, mi) => (
                <tr key={mem.id} className={mi % 2 === 0 ? '' : 'bg-slate-50/40'}>
                  <td className="sticky left-0 bg-inherit px-4 py-2 font-medium text-slate-700 whitespace-nowrap">
                    {mem.name}
                    {mem.payType === 'salary' && <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-700 rounded px-1 py-px">salary</span>}
                  </td>
                  {monthlyData.slice(0, 6).map(m => {
                    const s = m.byMember[mem.id];
                    if (!s || s.units === 0) return <td key={m.monthKey} className="px-3 py-2 text-center text-slate-200">—</td>;
                    const mCPO = s.cost > 0 && s.units > 0 ? s.cost / s.units : null;
                    return (
                      <td key={m.monthKey} className="px-3 py-2 text-center">
                        <div className="font-medium text-indigo-700">{Math.round(s.units)}{unitAbbrev}</div>
                        <div className="text-slate-400">{Math.round(s.hrs)}h</div>
                        {hasRates && mCPO !== null && <div className="text-amber-600">{fmt$(mCPO)}</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
