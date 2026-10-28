'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HelpTip } from './HelpTip';
import { statusHelpKey } from './dashboardHelp';

interface PipelineCount {
  status: string;
  location: string;
  count: number;
}

const STATUS_LABELS: Record<string, string> = {
  orderReceived:         'Order Received',
  bouquetReceived:       'Bouquet Received',
  checkedOn:             'Checked On',
  progress:              'In Progress',
  almostReadyToFrame:    'Almost Ready to Frame',
  readyToFrame:          'Ready to Frame',
  frameCompleted:        'No Response',
  approved:              'Approved',
  disapproved:           'Disapproved',
  readyToSeal:           'Ready to Seal',
  glued:                 'Glued',
  readyToPackage:        'Ready to Package',
  readyToFulfill:        'Ready to Fulfill',
  preparingToBeShipped:  'Preparing to Ship',
};

const DEPT_STATUSES: Record<string, string[]> = {
  Preservation: ['bouquetReceived', 'checkedOn', 'progress', 'almostReadyToFrame'],
  Design:       ['readyToFrame', 'frameCompleted', 'disapproved', 'approved'],
  Fulfillment:  ['readyToSeal', 'glued', 'readyToPackage', 'readyToFulfill', 'preparingToBeShipped'],
};

const DEPT_COLORS: Record<string, string> = {
  Preservation: 'bg-green-50 border-green-200',
  Design:       'bg-indigo-50 border-indigo-200',
  Fulfillment:  'bg-amber-50 border-amber-200',
};

const DEPT_TEXT: Record<string, string> = {
  Preservation: 'text-green-800',
  Design:       'text-indigo-800',
  Fulfillment:  'text-amber-800',
};

type SortCol = 'num' | 'name' | 'variant' | 'staff' | 'eventDate' | 'orderDate' | 'enteredAt';
type SortDir = 'asc' | 'desc';

type ShopifyFlagRow = {
  num: string;
  name: string;
  variant: string;
  pfStatus: string;
  location: string;
  eventDate: string;
  orderDate: string;
  flags: string[];
};

export function PipelineSection({ pipeline, location, departmentFilter }: { pipeline: PipelineCount[] | null; location: string; departmentFilter?: string | null }) {
  type OrderRow = { id: string; num: string; name: string; variant: string; orderDate: string; eventDate: string; staff: string; enteredAt: string; days: number; daysLabel: string };

  const [expanded, setExpanded]     = useState<string | null>(null);
  const [orders, setOrders]         = useState<Record<string, OrderRow[]>>({});
  const [loading, setLoading]       = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch]         = useState('');
  const [sortCol, setSortCol]       = useState<SortCol>('eventDate');
  const [sortDir, setSortDir]       = useState<SortDir>('asc');
  const [holdCount, setHoldCount]   = useState<number | null>(null);
  const [holdOrders, setHoldOrders] = useState<{ name: string; customer: string | null; tags: string }[]>([]);
  const [holdExpanded, setHoldExpanded] = useState(false);
  const [shopifyChecking, setShopifyChecking] = useState(false);
  const [shopifyResults, setShopifyResults]   = useState<{ flagged: ShopifyFlagRow[]; total: number; flaggedCount: number } | null>(null);
  const [shopifyError, setShopifyError]       = useState<string | null>(null);

  // Reset expanded orders when location changes
  useEffect(() => {
    setExpanded(null);
    setOrders({});
  }, [location]);

  // Fetch Shopify hold count + orders whenever location changes
  useEffect(() => {
    setHoldCount(null);
    setHoldOrders([]);
    setHoldExpanded(false);
    fetch(`/api/shopify-hold-count?location=${encodeURIComponent(location)}`)
      .then(r => r.json())
      .then((d: { count?: number; orders?: { name: string; customer: string | null; tags: string }[] }) => {
        setHoldCount(d.count ?? 0);
        setHoldOrders(d.orders ?? []);
      })
      .catch(() => setHoldCount(0));
  }, [location]);

  if (!pipeline) return null;

  // Build counts for the selected location (or sum all if 'All')
  const counts: Record<string, number> = {};
  pipeline.forEach(row => {
    if (location === 'All' || row.location === location) {
      counts[row.status] = (counts[row.status] ?? 0) + row.count;
    }
  });

  const inQueue = counts['orderReceived'] ?? 0;

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  async function handleStatusClick(status: string) {
    if (expanded === status) {
      setExpanded(null);
      return;
    }

    setExpanded(status);
    setSearch('');
    setSortCol('eventDate');
    setSortDir('asc');
    setFetchError(null);

    if (orders[status]) return;

    setLoading(status);
    try {
      const res  = await fetch(`/api/pipeline-orders?status=${status}&location=${encodeURIComponent(location)}`);
      const json = await res.json();
      if (json.error) {
        setFetchError(json.error);
      } else {
        setOrders(prev => ({ ...prev, [status]: json.orders ?? [] }));
        setFetchError(null);
      }
    } catch {
      setFetchError('Failed to load orders');
    }
    setLoading(null);
  }

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <span className="ml-1 text-slate-300">↕</span>;
    return <span className="ml-1 text-slate-600">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  function ThBtn({ col, label, className }: { col: SortCol; label: string; className?: string }) {
    return (
      <th
        className={`px-3 py-1.5 font-medium text-slate-500 whitespace-nowrap cursor-pointer select-none hover:text-slate-700 ${className ?? ''}`}
        onClick={() => handleSort(col)}
      >
        {label}<SortIcon col={col} />
      </th>
    );
  }

  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch('/api/export-orders');
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pf-export-ready-orders-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed — please try again.');
    }
    setExporting(false);
  }

  async function handleShopifyCheck() {
    if (shopifyResults) {
      setShopifyResults(null);
      return;
    }
    setShopifyChecking(true);
    setShopifyError(null);
    try {
      const res = await fetch('/api/shopify-status-check');
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setShopifyResults(json);
    } catch (e) {
      setShopifyError(e instanceof Error ? e.message : 'Check failed');
    }
    setShopifyChecking(false);
  }

  const FLAG_COLORS: Record<string, string> = {
    'Cancelled':      'bg-red-100 text-red-700',
    'Refunded':       'bg-orange-100 text-orange-700',
    'Fulfilled':      'bg-blue-100 text-blue-700',
    'Pickup in Store': 'bg-teal-100 text-teal-700',
    '$0 Order':        'bg-cyan-100 text-cyan-700',
    'Order > 12 mo':  'bg-amber-100 text-amber-700',
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          <HelpTip id="pipeline.title">Pipeline — {location}</HelpTip>
        </h2>
        <HelpTip id="pipeline.inQueue" className="text-xs text-slate-400">
          {inQueue.toLocaleString()} orders in queue (awaiting bouquet)
        </HelpTip>
        <div className="ml-auto flex gap-2">
          <button
            onClick={handleShopifyCheck}
            disabled={shopifyChecking}
            className="text-xs font-medium px-3 py-1 rounded border border-violet-300 bg-white text-violet-600 hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <HelpTip id="pipeline.shopifyCheck">{shopifyChecking ? 'Checking Shopify…' : shopifyResults ? 'Hide Shopify Check' : 'Check Shopify Status'}</HelpTip>
          </button>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="text-xs font-medium px-3 py-1 rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <HelpTip id="pipeline.export">{exporting ? 'Exporting…' : 'Export Ready to Frame + Seal'}</HelpTip>
          </button>
        </div>
      </div>

      {shopifyError && (
        <p className="mb-3 text-sm text-red-500">{shopifyError}</p>
      )}

      {shopifyResults && (
        <div className="mb-4 rounded border border-violet-200 bg-violet-50">
          <div className="px-4 py-2 border-b border-violet-200 flex items-center gap-3">
            <span className="text-sm font-semibold text-violet-800">Shopify Status Check</span>
            <span className="text-xs text-violet-500">
              {shopifyResults.flaggedCount} of {shopifyResults.total} Ready to Frame/Seal orders have a mismatch in Shopify
            </span>
          </div>
          {shopifyResults.flaggedCount === 0 ? (
            <p className="px-4 py-3 text-sm text-violet-600 italic">No mismatches found — all orders look clean.</p>
          ) : (
            <div className="overflow-auto max-h-80">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="bg-violet-100 border-b border-violet-200 text-left">
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Order #</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Customer</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Frame</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">PF Status</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Location</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Order Date</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Event Date</th>
                    <th className="px-3 py-2 font-medium text-violet-700 whitespace-nowrap">Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {shopifyResults.flagged.map(o => (
                    <tr key={`${o.num}|${o.variant}`} className="border-b border-violet-100 last:border-0 hover:bg-violet-100/50">
                      <td className="px-3 py-1.5 font-mono text-violet-700 whitespace-nowrap">#{o.num}</td>
                      <td className="px-3 py-1.5 text-slate-700 whitespace-nowrap">{o.name || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{o.variant || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{o.pfStatus}</td>
                      <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{o.location || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{o.orderDate || '—'}</td>
                      <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{o.eventDate || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap flex gap-1">
                        {o.flags.map(f => (
                          <span key={f} className={`px-1.5 py-0.5 rounded text-xs font-medium ${FLAG_COLORS[f] ?? 'bg-slate-100 text-slate-600'}`}>
                            {f}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Object.entries(DEPT_STATUSES).filter(([dept]) => !departmentFilter || dept.toLowerCase() === departmentFilter.toLowerCase()).map(([dept, statuses]) => {
          const total = statuses.reduce((s, st) => s + (counts[st] ?? 0), 0);
          return (
            <Card key={dept} className={`border ${DEPT_COLORS[dept]}`}>
              <CardHeader className="pb-2">
                <HelpTip id={`pipeline.dept.${dept}` as 'pipeline.dept.Design'} className="block">
                  <CardTitle className={`text-base font-semibold ${DEPT_TEXT[dept]}`}>{dept}</CardTitle>
                  <p className="text-2xl font-bold text-slate-900">{total.toLocaleString()}</p>
                </HelpTip>
                {dept === 'Fulfillment' && holdCount !== null && holdCount > 0 && (
                  <div className="mt-0.5">
                    <button
                      onClick={() => setHoldExpanded(e => !e)}
                      className="text-xs font-medium text-rose-600 hover:text-rose-800 transition-colors"
                    >
                      <HelpTip id="pipeline.onHold">{holdCount.toLocaleString()} on hold (Shopify) {holdExpanded ? '▲' : '▼'}</HelpTip>
                    </button>
                    {holdExpanded && (
                      <div className="mt-1 rounded border border-rose-100 bg-white overflow-auto max-h-48">
                        <table className="min-w-full text-xs">
                          <thead>
                            <tr className="bg-rose-50 border-b border-rose-100 text-left">
                              <th className="px-3 py-1.5 font-medium text-rose-700 whitespace-nowrap">Order</th>
                              <th className="px-3 py-1.5 font-medium text-rose-700 whitespace-nowrap">Customer</th>
                              <th className="px-3 py-1.5 font-medium text-rose-700 whitespace-nowrap">Tags</th>
                            </tr>
                          </thead>
                          <tbody>
                            {holdOrders.map(o => (
                              <tr key={o.name} className="border-b border-rose-50 last:border-0 hover:bg-rose-50">
                                <td className="px-3 py-1.5 font-mono text-rose-700 whitespace-nowrap">{o.name}</td>
                                <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{o.customer || '—'}</td>
                                <td className="px-3 py-1.5 text-slate-400">{o.tags}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-1">
                {statuses.map(st => {
                  const count = counts[st] ?? 0;
                  const isExpanded = expanded === st;
                  const isLoading  = loading === st;
                  const rawRows    = orders[st] ?? [];

                  const q = search.trim().toLowerCase();
                  const filtered = q
                    ? rawRows.filter(o =>
                        o.num.includes(q) ||
                        o.name.toLowerCase().includes(q) ||
                        o.variant.toLowerCase().includes(q) ||
                        o.staff.toLowerCase().includes(q)
                      )
                    : rawRows;

                  const sorted = [...filtered].sort((a, b) => {
                    const va = a[sortCol] ?? '';
                    const vb = b[sortCol] ?? '';
                    if (sortCol === 'num') {
                      const diff = Number(va) - Number(vb);
                      return sortDir === 'asc' ? diff : -diff;
                    }
                    const cmp = String(va).localeCompare(String(vb));
                    return sortDir === 'asc' ? cmp : -cmp;
                  });

                  return (
                    <div key={st}>
                      <div className="flex justify-between items-center text-sm">
                        <StatusLabel status={st} />
                        {count > 0 ? (
                          <button
                            onClick={() => handleStatusClick(st)}
                            className="rounded px-2 py-0.5 text-xs font-semibold bg-slate-200 hover:bg-slate-300 text-slate-700 transition-colors cursor-pointer"
                          >
                            {isLoading ? '…' : count.toLocaleString()}
                          </button>
                        ) : (
                          <Badge variant="secondary">0</Badge>
                        )}
                      </div>
                      {isExpanded && (
                        <div className="mt-1 mb-2 ml-1 rounded border border-slate-200 bg-white text-xs">
                          {isLoading ? (
                            <p className="p-3 italic text-slate-400">Loading orders… (scanning up to 30 months)</p>
                          ) : fetchError ? (
                            <p className="p-3 text-red-500">{fetchError}</p>
                          ) : rawRows.length === 0 ? (
                            <p className="p-3 italic text-slate-400">No orders found in last 48 months</p>
                          ) : (
                            <>
                              <div className="px-3 pt-2 pb-1 border-b border-slate-100 flex items-center gap-2">
                                <input
                                  type="text"
                                  placeholder="Search order #, customer, frame, staff…"
                                  value={search}
                                  onChange={e => setSearch(e.target.value)}
                                  className="flex-1 border border-slate-200 rounded px-2 py-1 text-xs text-slate-700 bg-white placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                                />
                                {q && (
                                  <span className="text-slate-400 whitespace-nowrap">
                                    {sorted.length} of {rawRows.length}
                                  </span>
                                )}
                              </div>
                              <div className="overflow-auto max-h-64">
                                <table className="min-w-full" style={{borderCollapse:'separate', borderSpacing:0}}>
                                  <thead>
                                    <tr className="bg-slate-50 border-b border-slate-200 text-left">
                                      <ThBtn col="num"       label="Order #"    className="sticky left-0 bg-slate-50" />
                                      <ThBtn col="name"      label="Customer" />
                                      <ThBtn col="variant"   label="Frame" />
                                      <ThBtn col="staff"     label="Staff" />
                                      <ThBtn col="enteredAt" label="In Status Since" />
                                      <ThBtn col="eventDate" label="Event Date" />
                                      <ThBtn col="orderDate" label="Ordered" />
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sorted.length === 0 ? (
                                      <tr>
                                        <td colSpan={7} className="px-3 py-3 text-center text-slate-400 italic">No results</td>
                                      </tr>
                                    ) : sorted.map(o => (
                                      <tr key={o.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                                        <td className="px-3 py-1.5 font-mono text-indigo-700 whitespace-nowrap sticky left-0 bg-white">#{o.num}</td>
                                        <td className="px-3 py-1.5 text-slate-700 whitespace-nowrap">{o.name}</td>
                                        <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{o.variant}</td>
                                        <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">{o.staff || <span className="text-slate-300 italic">unassigned</span>}</td>
                                        <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{o.enteredAt || '—'}</td>
                                        <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{o.eventDate || '—'}</td>
                                        <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{o.orderDate}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function StatusLabel({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;
  const key   = statusHelpKey(status);
  return key
    ? <HelpTip id={key} className="text-slate-600">{label}</HelpTip>
    : <span className="text-slate-600">{label}</span>;
}
