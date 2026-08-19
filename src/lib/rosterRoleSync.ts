import type { SupabaseClient } from '@supabase/supabase-js';
import type { RatioTier } from './ratioTargets';

// Keeps each Scheduling roster member's `role` (Master/Senior/Specialist,
// used by /api/kpis to project Expected/Goal ratios), `isManager` (used
// to exclude managers from the Expected/Goal wage-tier lookup — their pay
// reflects management responsibility, not a production tier), and pay
// (hourlyRate/rate, payType, annualSalary — what actually drives CPO) in
// sync with the real job title and pay on file in rippling_employees
// (populated by the employees upload — see employees-upload/route.ts's
// inferRole). Call this after any change to rippling_employees so title/
// manager/pay changes propagate automatically instead of roster fields
// silently going stale.
//
// Pay used to only get filled in when the roster's own value was exactly
// zero — a raise in Rippling would never reach the roster (and therefore
// CPO) since a nonzero-but-stale value always won that check. Pay is now
// synced the same unconditional way role/isManager already are: Rippling
// is the source of truth, so long as it actually has a rate/salary on file
// (an employee's Rippling row with no pay at all is left alone rather than
// zeroing out a roster value that's presumably still correct).
//
// Matching: by name + location. A person can have separate titles/rates per
// department (flex workers), so a same-department entry is preferred;
// otherwise falls back to their most recently uploaded entry from any
// department. Existing roster fields are overwritten — this is the intended
// behavior, not just a one-time backfill.

const DEPT_FOR_ROSTER_KEY: Record<string, string> = {
  designRoster: 'Design',
  presRoster:   'Preservation',
  ffRoster:     'Fulfillment',
  resinRoster:  'Resin',
};

// Which field on the roster member holds their hourly rate — designRoster
// and resinRoster call it hourlyRate, presRoster/ffRoster call it rate.
const RATE_FIELD_FOR_ROSTER_KEY: Record<string, 'hourlyRate' | 'rate'> = {
  designRoster: 'hourlyRate',
  presRoster:   'rate',
  ffRoster:     'rate',
  resinRoster:  'hourlyRate',
};

const MANAGER_TITLE_RE = /manager|head of|director/i;

interface RipplingEmployeeRow {
  full_name:     string;
  location:      string;
  department:    string;
  title:         string;
  role:          RatioTier;
  pay_type:      'hourly' | 'salary';
  hourly_rate:   number;
  annual_salary: number;
  updated_at:    string;
}

interface RosterMemberRow {
  name:         string;
  role?:        RatioTier;
  isManager?:   boolean;
  payType?:     'hourly' | 'salary';
  hourlyRate?:  number;
  rate?:        number;
  annualSalary?: number;
  _removed?:    boolean;
  [key: string]: unknown;
}

export interface RosterFieldUpdate {
  location:   string;
  roster:     string;
  name:       string;
  role?:        { from: RatioTier | null; to: RatioTier };
  isManager?:   { from: boolean; to: boolean };
  payType?:     { from: string | undefined; to: string };
  rate?:        { from: number; to: number };
  annualSalary?: { from: number; to: number };
}

export interface RosterRoleSyncResult {
  updated: RosterFieldUpdate[];
}

export async function syncRosterRoles(supabase: SupabaseClient): Promise<RosterRoleSyncResult> {
  const [{ data: employees, error: empErr }, { data: rosterRows, error: rosterErr }] = await Promise.all([
    supabase.from('rippling_employees').select('full_name,location,department,title,role,pay_type,hourly_rate,annual_salary,updated_at').eq('active', true),
    supabase.from('schedule_settings').select('location,key,value').in('key', Object.keys(DEPT_FOR_ROSTER_KEY)),
  ]);
  if (empErr)    throw empErr;
  if (rosterErr) throw rosterErr;

  const updated: RosterFieldUpdate[] = [];

  for (const row of rosterRows ?? []) {
    const dept   = DEPT_FOR_ROSTER_KEY[row.key];
    // resinRoster is stored as an array (not an id-keyed object like the other
    // three rosters) — Object.values() still yields its elements by reference,
    // so mutating `member` below and re-saving `roster` works for both shapes.
    const roster = row.value as Record<string, RosterMemberRow>;
    let changed  = false;

    for (const member of Object.values(roster)) {
      if (member._removed || !member.name) continue;

      const candidates = ((employees ?? []) as RipplingEmployeeRow[]).filter(e =>
        e.location === row.location && e.full_name.trim().toLowerCase() === member.name.trim().toLowerCase()
      );
      if (candidates.length === 0) continue;

      const best =
        candidates.find(e => e.department === dept) ??
        [...candidates].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

      const isManager = MANAGER_TITLE_RE.test(best.title ?? '');
      const update: RosterFieldUpdate = { location: row.location, roster: row.key, name: member.name };
      let memberChanged = false;

      if (best.role !== member.role) {
        update.role = { from: member.role ?? null, to: best.role };
        member.role = best.role;
        memberChanged = true;
      }
      if (isManager !== !!member.isManager) {
        update.isManager = { from: !!member.isManager, to: isManager };
        member.isManager = isManager;
        memberChanged = true;
      }

      // Pay sync — only when Rippling actually has a rate/salary on file, so
      // a blank/incomplete Rippling row never zeroes out a roster value that
      // presumably still reflects reality.
      const rateField = RATE_FIELD_FOR_ROSTER_KEY[row.key];
      const hasRipplingPay = (best.hourly_rate ?? 0) > 0 || (best.annual_salary ?? 0) > 0;
      if (rateField && hasRipplingPay) {
        if (best.pay_type && best.pay_type !== member.payType) {
          update.payType = { from: member.payType, to: best.pay_type };
          member.payType = best.pay_type;
          memberChanged = true;
        }

        const currentRate = rateField === 'hourlyRate' ? (member.hourlyRate ?? 0) : (member.rate ?? 0);
        const nextRate = best.pay_type === 'hourly' ? (best.hourly_rate ?? 0) : 0;
        if (Math.abs(nextRate - currentRate) > 0.001) {
          update.rate = { from: currentRate, to: nextRate };
          if (rateField === 'hourlyRate') member.hourlyRate = nextRate; else member.rate = nextRate;
          memberChanged = true;
        }

        const currentSalary = member.annualSalary ?? 0;
        const nextSalary = best.pay_type === 'salary' ? (best.annual_salary ?? 0) : 0;
        if (Math.abs(nextSalary - currentSalary) > 0.5) {
          update.annualSalary = { from: currentSalary, to: nextSalary };
          member.annualSalary = nextSalary;
          memberChanged = true;
        }
      }

      if (memberChanged) {
        updated.push(update);
        changed = true;
      }
    }

    if (changed) {
      const { error } = await supabase
        .from('schedule_settings')
        .upsert(
          { location: row.location, key: row.key, value: roster, updated_by: 'role-sync', updated_at: new Date().toISOString() },
          { onConflict: 'location,key' }
        );
      if (error) throw error;
    }
  }

  return { updated };
}
