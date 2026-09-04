'use client';
import { useMemo, useState, useEffect } from 'react';
import { PipelineSection } from './PipelineSection';
import { ResponseTimeSection } from './ResponseTimeSection';
import { EventDateSection } from './EventDateSection';
import { SortedLocationSection } from './SortedLocationSection';
import ScorecardTab from "./ScorecardTab";
import AllKpisPage from "./AllKpisPage";
import { SchedulePage } from './SchedulePage';
import UserManagementPage from './UserManagementPage';
import MyDashboardClient from './MyDashboardClient';
import { useCurrentUser } from '@/hooks/useCurrentUser';

interface PipelineCount {
  status: string;
  location: string;
  count: number;
}

// Mirrors what /api/location-counts returns for status counts
interface LocationCounts {
  Utah:    Record<string, number>;
  Georgia: Record<string, number>;
}

export function DashboardClient({ pipeline }: { pipeline: PipelineCount[] }) {
  const [mainTab, setMainTab] = useState<'dashboard' | 'scheduling' | 'scorecards' | 'kpis' | 'team'>('dashboard');
  // Redirect user role to personal dashboard handled server-side
  const { user, loading: userLoading, error: userError } = useCurrentUser();

  // ── Shared location counts (used by both SortedLocationSection and SchedulePage) ──
  const [locationCounts, setLocationCounts] = useState<LocationCounts | null>(null);

  useEffect(() => {
    fetch('/api/location-counts')
      .then(r => r.json())
      .then((d: LocationCounts) => setLocationCounts(d))
      .catch(() => {/* leave null, each section handles its own fallback */});
  }, []);

  const locations = useMemo(() => {
    const locs = [...new Set(pipeline.map(r => r.location))].filter(Boolean).sort();
    return ['All', ...locs];
  }, [pipeline]);

  const [location, setLocation] = useState('Utah');

  if (userLoading) {
    return (
      <div className="py-16 text-center text-sm text-slate-500">
        Loading your dashboard…
      </div>
    );
  }

  if (userError || !user) {
    return (
      <div className="py-16 text-center text-sm text-rose-600">
        Unable to load your dashboard access. Please refresh and try again.
      </div>
    );
  }

  // ── Derived queue numbers passed into SchedulePage ──────────────────────────
  // Design queues: Ready to Frame + Almost Ready to Frame
  const utahDesignable    = (locationCounts?.Utah?.readyToFrame    ?? 0)
                          + (locationCounts?.Utah?.almostReadyToFrame ?? 0);
  const georgiaDesignable = (locationCounts?.Georgia?.readyToFrame    ?? 0)
                          + (locationCounts?.Georgia?.almostReadyToFrame ?? 0);

  // Preservation queues: Bouquet Received + Checked On + In Progress
  const utahPreservation    = (locationCounts?.Utah?.bouquetReceived ?? 0)
                            + (locationCounts?.Utah?.checkedOn       ?? 0)
                            + (locationCounts?.Utah?.progress        ?? 0);
  const georgiaPreservation = (locationCounts?.Georgia?.bouquetReceived ?? 0)
                            + (locationCounts?.Georgia?.checkedOn       ?? 0)
                            + (locationCounts?.Georgia?.progress        ?? 0);

  // Fulfillment queues: Approved + Glued (ready to seal)
  const utahFulfillment    = (locationCounts?.Utah?.approved    ?? 0)
                           + (locationCounts?.Utah?.glued       ?? 0);
  const georgiaFulfillment = (locationCounts?.Georgia?.approved    ?? 0)
                           + (locationCounts?.Georgia?.glued       ?? 0);

  // User role sees their personal dashboard inline
  if (user && user.profile.role === 'user') {
    return <MyDashboardClient profile={user.profile} />;
  }

  return (
    <div className="space-y-6">

      {/* ── Top-level tab bar ─────────────────────────────────────────────────── */}
      <div className="flex border-b border-slate-200">
        {([
          ['dashboard',  'Department Dashboard'],
          ...((user?.permissions.canViewScheduling ?? true) ? [['scheduling', 'Scheduling'] as const] : []),
          ...((user?.permissions.canViewScorecards ?? true) ? [['scorecards',  'Scorecards'] as const] : []),
          ...((user?.permissions.canViewScorecards ?? true) ? [['kpis', 'All KPIs'] as const] : []),
          ...(user?.permissions.canManageUsers    ? [['team', 'Team Access'] as const] : []),
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMainTab(id)}
            className={`px-6 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
              mainTab === id
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── DASHBOARD TAB ────────────────────────────────────────────────────── */}
      {mainTab === 'dashboard' && (
        <div className="space-y-8">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Location</span>
            <div className="flex gap-1.5 flex-wrap">
              {locations.map(loc => (
                <button
                  key={loc}
                  onClick={() => setLocation(loc)}
                  className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                    location === loc
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {loc}
                </button>
              ))}
            </div>
          </div>
          <PipelineSection pipeline={pipeline} location={location} departmentFilter={user?.profile.role === 'manager' ? user?.profile.department : null} />
          <SortedLocationSection />
          <EventDateSection />
          <ResponseTimeSection location={location} />
        </div>
      )}

      {/* ── SCORECARDS TAB ──────────────────────────────────────────────────── */}
      {mainTab === 'scorecards' && <ScorecardTab />}
      {/* ── ALL KPIs TAB ────────────────────────────────────────────────────────── */}
      {mainTab === 'kpis' && <AllKpisPage />}
      {/* ── TEAM ACCESS TAB ─────────────────────────────────────────────────── */}
      {mainTab === 'team' && <UserManagementPage />}
      {/* ── SCHEDULING TAB ───────────────────────────────────────────────────── */}
      {mainTab === 'scheduling' && (
        <SchedulePage
          utahDesignable={utahDesignable}
          georgiaDesignable={georgiaDesignable}
          utahPreservation={utahPreservation}
          georgiaPreservation={georgiaPreservation}
          utahFulfillment={utahFulfillment}
          georgiaFulfillment={georgiaFulfillment}
          countsLoading={locationCounts === null}
          canEditUtah={user?.permissions.canEditUtah ?? false}
          canEditGeorgia={user?.permissions.canEditGeorgia ?? false}
          canViewCPO={user?.permissions.canViewCPO ?? true}
          userLocation={user?.profile.location ?? null}
          userDepartment={user?.profile.department ?? null}
          userRole={user?.profile.role ?? 'admin'}
        />
      )}

    </div>
  );
}
