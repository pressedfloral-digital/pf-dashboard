// People who use the production app but aren't production staff — e.g. the
// app/technology team testing workflows. Orders the production app credits
// to them are not real production: the weekly auto-sync never writes them,
// and every view that reads team_member_week_actuals (Historicals, All KPIs,
// Scorecards, Scheduling) ignores any row already stored under their name.
// They're also kept off every roster/schedule view.
//
// Add a name here (as it appears in the production app or on a roster) to
// exclude someone; matching ignores case, punctuation, and extra spaces.
const NON_PRODUCTION_STAFF = [
  'Abi Gregory',
  'Braden Kerr',
  'Emma Soloman',
  'Hailey Hill',
  'Kamden Everett',
  'Lexi McMullin',
  'Maja Neves',
  'Sarah Ebert',
  'Taylor Miller',
];

const normalize = (name: string) => name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();

const EXCLUDED = new Set(NON_PRODUCTION_STAFF.map(normalize));

export function isNonProductionStaff(name: string | null | undefined): boolean {
  return !!name && EXCLUDED.has(normalize(name));
}
