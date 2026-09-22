'use client';

import { useEffect, useState } from 'react';

// Tier + Flex badges shown next to a team member's name on Historicals,
// This Week, Weekly Schedule, the roster editors, and Scorecard > Individual
// Ratios.
//
// Tier and home department come from rippling_employees (one active row per
// person per location) — the same source rosterRoleSync.ts copies role/
// isManager onto the rosters from, so a title change shows up here without
// waiting for a roster re-save. A member is "flexing" when the table they're
// shown in belongs to a department other than their Rippling home department.
//
// Someone missing from Rippling (name mismatch, not uploaded yet) falls back
// to the roster entry's own role/isManager; with no home department on file
// we can't tell whether they're flexing, so callers pass `notOnRoster` to
// flag the one case we can still infer (they have actuals in a department
// whose roster they aren't on).

export type MemberTier = 'specialist' | 'senior' | 'master' | 'manager';

interface DirectoryEntry {
  tier:     MemberTier;
  homeDept: string;
  title:    string;
}

interface EmployeeRow {
  full_name:  string;
  department: string;
  title:      string;
  role:       string | null;
}

// Same test rosterRoleSync.ts uses to set a roster member's isManager.
const MANAGER_TITLE_RE = /manager|head of|director/i;

const TIER_STYLE: Record<MemberTier, { label: string; className: string }> = {
  specialist: { label: 'Specialist', className: 'bg-slate-100 text-slate-600' },
  senior:     { label: 'Senior',     className: 'bg-amber-100 text-amber-700' },
  master:     { label: 'Master',     className: 'bg-emerald-100 text-emerald-700' },
  manager:    { label: 'Manager',    className: 'bg-violet-100 text-violet-700' },
};

// Accepts any of the department spellings the views use ('preservation',
// 'Resin', 'checks_unboxing', ...) and returns Rippling's Title Case.
function normalizeDept(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes('design'))                          return 'Design';
  if (l.includes('preservation') || l.includes('checks') || l.includes('unboxing')) return 'Preservation';
  if (l.includes('fulfillment'))                     return 'Fulfillment';
  if (l.includes('resin'))                           return 'Resin';
  return raw;
}

const nameKey = (name: string) => name.trim().toLowerCase();

// One fetch per location for the life of the page, shared by every badge.
const directoryCache = new Map<string, Promise<Map<string, DirectoryEntry>>>();

function loadDirectory(location: string): Promise<Map<string, DirectoryEntry>> {
  let pending = directoryCache.get(location);
  if (!pending) {
    pending = fetch(`/api/admin/employees-upload?location=${encodeURIComponent(location)}`)
      .then(res => res.json() as Promise<{ employees?: EmployeeRow[] }>)
      .then(({ employees }) => {
        const map = new Map<string, DirectoryEntry>();
        for (const e of employees ?? []) {
          if (!e.full_name) continue;
          const role = e.role === 'senior' || e.role === 'master' ? e.role : 'specialist';
          map.set(nameKey(e.full_name), {
            tier:     MANAGER_TITLE_RE.test(e.title ?? '') ? 'manager' : role,
            homeDept: normalizeDept(e.department ?? ''),
            title:    e.title ?? '',
          });
        }
        return map;
      })
      .catch(() => {
        // Let the next mount retry instead of caching the failure.
        directoryCache.delete(location);
        return new Map<string, DirectoryEntry>();
      });
    directoryCache.set(location, pending);
  }
  return pending;
}

function useMemberDirectory(location: string): Map<string, DirectoryEntry> | null {
  const [directory, setDirectory] = useState<Map<string, DirectoryEntry> | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadDirectory(location).then(d => { if (!cancelled) setDirectory(d); });
    return () => { cancelled = true; };
  }, [location]);
  return directory;
}

export function MemberTierBadges({ name, location, dept, fallbackRole, fallbackIsManager, notOnRoster, className = 'flex mt-0.5' }: {
  name:     string;
  location: string;
  /** The department whose table this row is in. */
  dept:     string;
  /** Roster entry's role/isManager, used only when Rippling has no match. */
  fallbackRole?:      string | null;
  fallbackIsManager?: boolean;
  notOnRoster?:       boolean;
  /** Layout for the wrapper — defaults to its own line under the name. */
  className?:         string;
}) {
  const directory = useMemberDirectory(location);
  if (!name) return null;

  const entry = directory?.get(nameKey(name));
  const viewDept = normalizeDept(dept);

  let tier: MemberTier | null = null;
  if (entry) tier = entry.tier;
  else if (fallbackIsManager) tier = 'manager';
  else if (fallbackRole === 'specialist' || fallbackRole === 'senior' || fallbackRole === 'master') tier = fallbackRole;

  const homeDept = entry?.homeDept;
  const flexing = homeDept ? homeDept !== viewDept : !!notOnRoster;

  if (!tier && !flexing) return null;
  const style = tier ? TIER_STYLE[tier] : null;

  return (
    <span className={`flex-wrap items-center gap-1 ${className}`}>
      {style && (
        <span
          className={`text-[9px] rounded px-1 py-px font-semibold whitespace-nowrap ${style.className}`}
          title={entry?.title || style.label}
        >
          {style.label}
        </span>
      )}
      {flexing && (
        <span
          className="text-[9px] rounded px-1 py-px font-semibold whitespace-nowrap bg-indigo-50 text-indigo-600 border border-dashed border-indigo-300"
          title={homeDept ? `Flexing into ${viewDept} — home department is ${homeDept}` : `Flexing into ${viewDept} — not on the ${viewDept} roster`}
        >
          ⇄ Flex{homeDept ? ` · ${homeDept}` : ''}
        </span>
      )}
    </span>
  );
}
