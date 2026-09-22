// Historicals is the source of truth for production and hours — management
// makes sure every order is counted there. Any server-side rollup of
// team_member_week_actuals (All KPIs, Scorecards) must count exactly the
// rows Historicals counts, and this is the one place that rule lives.
//
// HistoricalsSection.tsx shows a row when the member is on that department's
// live roster, or — for anyone else (flex workers, renamed/removed people,
// auto-synced credits) — only once they have actual hours logged (its
// `flexNames`). An order-only row for someone off the roster (e.g. a stray
// "Kale" beside "Kale Haug") never appears there, so it must not count
// anywhere else either.

interface ScheduleSettingRow {
  location: string;
  key:      string;
  value:    unknown;
}

interface ActualsRowLike {
  location:     string;
  department:   string;
  member_name:  string;
  actual_hours: number;
}

// Every roster Historicals renders, including Resin.
const ROSTER_DEPT: Record<string, string> = {
  designRoster: 'Design',
  presRoster:   'Preservation',
  ffRoster:     'Fulfillment',
  resinRoster:  'Resin',
};

export const HISTORICALS_ROSTER_KEYS = Object.keys(ROSTER_DEPT);

// Only used to line an actuals row up with its roster — Checks & Unboxing
// rows ('checks_unboxing') show in Preservation's Historicals.
function rosterDept(raw: string): string {
  const l = raw.toLowerCase();
  if (l.includes('design'))                                                  return 'Design';
  if (l.includes('preservation') || l.includes('checks') || l.includes('unboxing')) return 'Preservation';
  if (l.includes('fulfillment'))                                             return 'Fulfillment';
  if (l.includes('resin'))                                                   return 'Resin';
  return raw;
}

const memberKey = (location: string, dept: string, name: string) =>
  `${location}|${dept}|${name.trim().toLowerCase()}`;

// Live (not _removed) roster members, matching the `members` list each
// Historicals tab is given. resinRoster is an array rather than an id-keyed
// object — Object.values() covers both shapes.
export function buildHistoricalsRosterNameSet(rosterRows: ScheduleSettingRow[]): Set<string> {
  const set = new Set<string>();
  for (const row of rosterRows) {
    const dept = ROSTER_DEPT[row.key];
    if (!dept || !row.value) continue;
    for (const member of Object.values(row.value as Record<string, { name?: string; _removed?: boolean }>)) {
      if (member?.name && !member._removed) set.add(memberKey(row.location, dept, member.name));
    }
  }
  return set;
}

export function filterToHistoricalsRows<T extends ActualsRowLike>(rows: T[], rosterRows: ScheduleSettingRow[]): T[] {
  const rosterNames = buildHistoricalsRosterNameSet(rosterRows);
  return rows.filter(row =>
    row.actual_hours > 0 ||
    rosterNames.has(memberKey(row.location, rosterDept(row.department), row.member_name))
  );
}
