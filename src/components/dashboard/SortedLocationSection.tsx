'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from './HelpTip';
import { statusHelpKey, type HelpKey } from './dashboardHelp';

interface UuidOrderEntry {
  uuid:      string;
  orderNum:  string;
  status:    string;
  location:  string | null;
  staffName: string | null;
  orderDate: string | null;
}

interface UnsortedOrder {
  orderNum:         string;
  statuses:         string[];
  assumedCancelled: boolean;
}

interface LocationData {
  Utah:                 Record<string, number>;
  Georgia:              Record<string, number>;
  UtahOrders:           Record<string, UuidOrderEntry[]>;
  GeorgiaOrders:        Record<string, UuidOrderEntry[]>;
  unsortedOrders:       UnsortedOrder[];
  totalUnsorted:        number;
  genuinelyUnsorted:    number;
  assumedCancelledCount: number;
  pfTotal:              number;
  lastSynced:           string;
}

const STATUS_LABELS: Record<string, string> = {
  bouquetReceived:      'Bouquet Received',
  checkedOn:            'Checked On',
  progress:             'In Progress',
  almostReadyToFrame:   'Almost Ready to Frame',
  readyToFrame:         'Ready to Frame',
  frameCompleted:       'Frame Completed',
  disapproved:          'Disapproved',
  approved:             'Approved',
  noResponse:           'No Response',
  readyToSeal:          'Ready to Seal',
  glued:                'Glued',
  readyToPackage:       'Ready to Package',
  readyToFulfill:       'Ready to Fulfill',
  preparingToBeShipped: 'Preparing to Ship',
};

const DEPT_STATUSES: Record<string, string[]> = {
  Preservation: ['bouquetReceived', 'checkedOn', 'progress', 'almostReadyToFrame'],
  Design:       ['readyToFrame', 'frameCompleted', 'disapproved', 'approved'],
  Fulfillment:  ['readyToSeal', 'glued', 'readyToPackage', 'readyToFulfill', 'preparingToBeShipped'],
};

const DEPT_COLORS: Record<string, string> = {
  Preservation: 'border-green-200 bg-green-50',
  Design:       'border-indigo-200 bg-indigo-50/50',
  Fulfillment:  'border-amber-200 bg-amber-50/50',
};

const DEPT_TEXT: Record<string, string> = {
  Preservation: 'text-green-700',
  Design:       'text-indigo-700',
  Fulfillment:  'text-amber-700',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return iso; }
}

function OrderPanel({ status, orders, onClose }: {
  status: string;
  orders: UuidOrderEntry[];
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(o =>
      o.orderNum.includes(q) ||
      o.uuid.toLowerCase().includes(q) ||
      (o.staffName ?? '').toLowerCase().includes(q)
    );
  }, [orders, search]);

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50">
        <span className="text-xs font-semibold text-slate-600">
          {STATUS_LABELS[status] ?? status} — {orders.length} order products
        </span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">×</button>
      </div>
      <div className="px-3 py-2 border-b border-slate-100">
        <input
          type="text"
          placeholder="Search order #, UUID, staff…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
          className="w-full border border-slate-200 rounded px-2 py-1.5 text-xs text-slate-700 bg-white placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-300"
        />
        {search && <p className="text-xs text-slate-400 mt-1">{filtered.length} of {orders.length}</p>}
      </div>
      <div className="overflow-auto max-h-72">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 border-b border-slate-100">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium text-slate-500">Order #</th>
              <th className="px-3 py-1.5 text-left font-medium text-slate-500">UUID</th>
              <th className="px-3 py-1.5 text-left font-medium text-slate-500">Staff</th>
              <th className="px-3 py-1.5 text-left font-medium text-slate-500">Order Date</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-400 italic">No results</td></tr>
            ) : filtered.map(o => (
              <tr key={o.uuid} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                <td className="px-3 py-1.5 font-mono text-indigo-700 whitespace-nowrap">#{o.orderNum}</td>
                <td className="px-3 py-1.5 font-mono text-slate-400 whitespace-nowrap text-[10px]">{o.uuid}</td>
                <td className="px-3 py-1.5 text-slate-600 whitespace-nowrap">
                  {o.staffName || <span className="text-slate-300 italic">unassigned</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{fmtDate(o.orderDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LocationColumn({
  name, counts, orders,
}: {
  name: string;
  counts: Record<string, number>;
  orders: Record<string, UuidOrderEntry[]>;
}) {
  const [expandedStatus, setExpandedStatus] = useState<string | null>(null);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <HelpTip id="sorted.location" className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-slate-700">{name}</h3>
          <span className="text-xs text-slate-400">{total.toLocaleString()} total</span>
        </HelpTip>
      </div>
      {Object.entries(DEPT_STATUSES).map(([dept, statuses]) => {
        const deptTotal = statuses.reduce((s, st) => s + (counts[st] ?? 0), 0);
        return (
          <Card key={dept} className={`border ${DEPT_COLORS[dept]}`}>
            <CardHeader className="pb-1 pt-3 px-4">
              <CardTitle className={`text-xs font-semibold uppercase tracking-wide ${DEPT_TEXT[dept]}`}>
                <HelpTip id={`pipeline.dept.${dept}` as HelpKey}>{dept} — {deptTotal.toLocaleString()}</HelpTip>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1">
              {statuses.map(st => {
                const count        = counts[st] ?? 0;
                const isExpanded   = expandedStatus === st;
                const statusOrders = orders[st] ?? [];
                return (
                  <div key={st}>
                    <div className="flex justify-between items-center text-xs">
                      <HelpTip id={statusHelpKey(st) ?? 'sorted.location'} className="text-slate-600">{STATUS_LABELS[st] ?? st}</HelpTip>
                      {count > 0 ? (
                        <button
                          onClick={() => setExpandedStatus(prev => prev === st ? null : st)}
                          className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors cursor-pointer ${
                            isExpanded
                              ? 'bg-indigo-200 text-indigo-800'
                              : 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                          }`}
                        >
                          {count.toLocaleString()}
                          {statusOrders.length > 0 && statusOrders.length !== count && (
                            <span className="ml-1 text-[10px] opacity-60">({statusOrders.length} listed)</span>
                          )}
                        </button>
                      ) : (
                        <span className="text-slate-300 font-semibold text-xs">0</span>
                      )}
                    </div>
                    {isExpanded && statusOrders.length > 0 && (
                      <OrderPanel
                        status={st}
                        orders={statusOrders}
                        onClose={() => setExpandedStatus(null)}
                      />
                    )}
                    {isExpanded && statusOrders.length === 0 && (
                      <div className="mt-2 px-3 py-3 text-xs text-slate-400 italic border border-slate-200 rounded-lg bg-white">
                        No orders in cache yet — run the UUID sync to populate.
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
  );
}

function UnsortedPanel({ orders, genuinelyUnsorted, assumedCancelledCount }: {
  orders: UnsortedOrder[];
  genuinelyUnsorted: number;
  assumedCancelledCount: number;
}) {
  const [search,    setSearch]    = useState('');
  const [tab,       setTab]       = useState<'unresolved' | 'cancelled'>('unresolved');

  const activeOrders = useMemo(() =>
    orders.filter(o => tab === 'cancelled' ? o.assumedCancelled : !o.assumedCancelled),
    [orders, tab]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activeOrders;
    return activeOrders.filter(o => o.orderNum.includes(q));
  }, [activeOrders, search]);

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-orange-200 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <span className="text-xs font-semibold text-orange-700">
            {genuinelyUnsorted} unresolved · {assumedCancelledCount} assumed cancelled
          </span>
          <p className="text-xs text-orange-500 mt-0.5">
            Unresolved orders have no staff assigned in PF — assign a staff member to resolve.
            Assumed cancelled are old orders (pre-#22000) your team can clear from PF.
          </p>
        </div>
        <input
          type="text"
          placeholder="Search order #…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-orange-200 rounded px-2 py-1 text-xs bg-white text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-orange-300"
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-orange-200">
        <button
          onClick={() => setTab('unresolved')}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            tab === 'unresolved'
              ? 'bg-white text-orange-700 border-b-2 border-orange-400'
              : 'text-orange-500 hover:bg-orange-100/50'
          }`}
        >
          Unresolved ({genuinelyUnsorted})
        </button>
        <button
          onClick={() => setTab('cancelled')}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            tab === 'cancelled'
              ? 'bg-white text-slate-600 border-b-2 border-slate-400'
              : 'text-slate-400 hover:bg-orange-100/50'
          }`}
        >
          Assumed Cancelled ({assumedCancelledCount})
        </button>
      </div>

      {/* Table */}
      <div className="overflow-auto max-h-64">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-orange-50 border-b border-orange-100">
            <tr>
              <th className="px-4 py-1.5 text-left font-medium text-orange-700">Order #</th>
              <th className="px-4 py-1.5 text-left font-medium text-orange-700">Statuses</th>
              {tab === 'cancelled' && (
                <th className="px-4 py-1.5 text-left font-medium text-slate-400">Note</th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-4 text-center text-slate-400 italic">
                  {search ? 'No matching orders' : 'No orders in this category'}
                </td>
              </tr>
            ) : filtered.map(o => (
              <tr key={o.orderNum} className="border-b border-orange-50 last:border-0 hover:bg-orange-100/50">
                <td className="px-4 py-1.5 font-mono text-indigo-700 whitespace-nowrap">#{o.orderNum}</td>
                <td className="px-4 py-1.5 text-slate-500">
                  {o.statuses.map(s => STATUS_LABELS[s] ?? s).join(', ')}
                </td>
                {tab === 'cancelled' && (
                  <td className="px-4 py-1.5 text-slate-400 italic text-[10px]">
                    Pre-location tracking — likely cancelled
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SortedLocationSection() {
  const [data,         setData]         = useState<LocationData | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [syncing,      setSyncing]      = useState(false);
  const [syncMsg,      setSyncMsg]      = useState('');
  const [resolving,    setResolving]    = useState(false);
  const [resolveMsg,   setResolveMsg]   = useState('');
  const [showUnsorted, setShowUnsorted] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res  = await fetch('/api/location-counts');
      const json = await res.json() as LocationData & { error?: string };
      if (json.error) { setError(json.error); return; }
      setData(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    setSyncMsg('Syncing UUIDs from PF API… this takes 2–3 minutes');
    try {
      const res  = await fetch('/api/cron/uuid-location-sync', { method: 'GET' });
      const json = await res.json() as { message?: string; error?: string; synced?: number };
      if (json.error) {
        setSyncMsg(`Sync failed: ${json.error}`);
      } else {
        setSyncMsg(json.message ?? `Synced ${json.synced} UUIDs`);
        await load();
      }
    } catch (e) {
      setSyncMsg(`Sync failed: ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  async function resolveUnassigned() {
    setResolving(true);
    setResolveMsg('Resolving unassigned orders via staff lookup…');
    try {
      const res  = await fetch('/api/admin/resolve-unassigned', { method: 'POST' });
      const json = await res.json() as { message?: string; error?: string; resolved?: number; stillUnresolved?: number };
      if (json.error) {
        setResolveMsg(`Failed: ${json.error}`);
      } else {
        setResolveMsg(json.message ?? `Resolved ${json.resolved} orders`);
        await load();
      }
    } catch (e) {
      setResolveMsg(`Failed: ${String(e)}`);
    } finally {
      setResolving(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const globalResults = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    if (!q || !data) return [];
    const results: (UuidOrderEntry & { locationName: string })[] = [];
    (['Utah', 'Georgia'] as const).forEach(loc => {
      const ordersMap = loc === 'Utah' ? data.UtahOrders : data.GeorgiaOrders;
      Object.values(ordersMap ?? {}).forEach(entries => {
        entries.forEach(o => {
          if (
            o.orderNum.includes(q) ||
            o.uuid.toLowerCase().includes(q) ||
            (o.staffName ?? '').toLowerCase().includes(q)
          ) {
            results.push({ ...o, locationName: loc });
          }
        });
      });
    });
    return results.slice(0, 200);
  }, [globalSearch, data]);

  const unsortedButtonLabel = useMemo(() => {
    if (!data) return '';
    const parts = [];
    if (data.genuinelyUnsorted > 0) parts.push(`${data.genuinelyUnsorted} unresolved`);
    if (data.assumedCancelledCount > 0) parts.push(`${data.assumedCancelledCount} assumed cancelled`);
    return parts.join(' · ');
  }, [data]);

  return (
    <section className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            <HelpTip id="sorted.title">Sorted by Location</HelpTip>
          </h2>
          <HelpTip id="sorted.title" className="text-xs text-slate-400">PF counts + resolved unassigned orders</HelpTip>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {syncMsg    && <span className="text-xs text-slate-400 max-w-xs truncate">{syncMsg}</span>}
          {resolveMsg && <span className="text-xs text-indigo-500 max-w-xs truncate">{resolveMsg}</span>}

          {data && (data.totalUnsorted > 0) && (
            <button
              onClick={() => setShowUnsorted(p => !p)}
              className={`px-3 py-1 text-xs border rounded transition-colors ${
                showUnsorted
                  ? 'border-orange-400 bg-orange-100 text-orange-800'
                  : 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100'
              }`}
            >
              <HelpTip id="sorted.unsorted">{unsortedButtonLabel}</HelpTip>
            </button>
          )}

          <button
            onClick={() => void resolveUnassigned()}
            disabled={resolving}
            className="px-3 py-1 text-xs border border-amber-300 rounded text-amber-700 bg-amber-50 hover:bg-amber-100 disabled:opacity-40 transition-colors"
          >
            <HelpTip id="sorted.resolve">{resolving ? 'Resolving…' : 'Resolve Unassigned'}</HelpTip>
          </button>
          <button
            onClick={() => void runSync()}
            disabled={syncing}
            className="px-3 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            <HelpTip id="sorted.sync">{syncing ? 'Syncing…' : 'Sync UUIDs'}</HelpTip>
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-3 py-1 text-xs border border-slate-200 rounded text-slate-600 hover:bg-slate-100 disabled:opacity-50 transition-colors"
          >
            <HelpTip id="sorted.refresh">{loading ? 'Loading…' : 'Refresh'}</HelpTip>
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* Unsorted panel */}
      {showUnsorted && data?.unsortedOrders && data.unsortedOrders.length > 0 && (
        <UnsortedPanel
          orders={data.unsortedOrders}
          genuinelyUnsorted={data.genuinelyUnsorted ?? 0}
          assumedCancelledCount={data.assumedCancelledCount ?? 0}
        />
      )}

      {/* Global search */}
      <div className="relative">
        <input
          type="text"
          placeholder="Search by order #, UUID, or staff name…"
          value={globalSearch}
          onChange={e => setGlobalSearch(e.target.value)}
          className="w-full border border-slate-200 rounded-lg px-4 py-2.5 text-sm text-slate-700 bg-white placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
        {globalSearch && (
          <button
            onClick={() => setGlobalSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500 text-lg"
          >×</button>
        )}
      </div>

      {globalSearch.trim() && (
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-100 bg-slate-50">
            <span className="text-xs font-semibold text-slate-600">
              {globalResults.length} result{globalResults.length !== 1 ? 's' : ''} for &quot;{globalSearch}&quot;
              {globalResults.length === 200 && ' (showing first 200)'}
            </span>
          </div>
          {globalResults.length === 0 ? (
            <p className="px-4 py-4 text-xs text-slate-400 italic">No order products found.</p>
          ) : (
            <div className="overflow-auto max-h-80">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-slate-500">Order #</th>
                    <th className="px-4 py-2 text-left font-medium text-slate-500">UUID</th>
                    <th className="px-4 py-2 text-left font-medium text-slate-500">Location</th>
                    <th className="px-4 py-2 text-left font-medium text-slate-500">Status</th>
                    <th className="px-4 py-2 text-left font-medium text-slate-500">Staff</th>
                  </tr>
                </thead>
                <tbody>
                  {globalResults.map(r => (
                    <tr key={r.uuid} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                      <td className="px-4 py-2 font-mono text-indigo-700 whitespace-nowrap">#{r.orderNum}</td>
                      <td className="px-4 py-2 font-mono text-slate-400 whitespace-nowrap text-[10px]">{r.uuid}</td>
                      <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{r.locationName}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className="bg-slate-100 text-slate-700 rounded px-1.5 py-0.5">
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-600 whitespace-nowrap">
                        {r.staffName || <span className="text-slate-300 italic">unassigned</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {loading && <p className="text-sm text-slate-400 text-center py-6">Loading location data…</p>}

      {!loading && data && (
        <>
          {data.lastSynced === 'cache empty — run sync' && (
            <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
              Cache is empty — click <strong>Sync UUIDs</strong> to populate order lists for the first time.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <LocationColumn name="Utah"    counts={data.Utah    ?? {}} orders={data.UtahOrders    ?? {}} />
            <LocationColumn name="Georgia" counts={data.Georgia ?? {}} orders={data.GeorgiaOrders ?? {}} />
          </div>
        </>
      )}
    </section>
  );
}
