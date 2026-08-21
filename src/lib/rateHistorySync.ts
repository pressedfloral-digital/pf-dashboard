import type { SupabaseClient } from '@supabase/supabase-js';

// Records a dated entry in employee_rate_history whenever an employee's pay
// changes on file in rippling_employees (populated by the employees upload).
// Append-only — an existing row is never mutated, only a new one added, so
// past weeks that estimate cost from a rate can look up what the rate was
// as of that week instead of whatever it is today. See useActualsWithPayroll's
// resolveRate/getRateForWeek for the read side.
//
// Call this after the rippling_employees upsert, passing the just-upserted
// rows (no need to re-query).

interface EmployeeRecord {
  full_name:     string;
  location:      string;
  department:    string;
  pay_type:      'hourly' | 'salary';
  hourly_rate:   number;
  annual_salary: number;
}

interface RateHistoryRow {
  full_name:      string;
  location:       string;
  department:     string;
  pay_type:       'hourly' | 'salary';
  hourly_rate:    number;
  annual_salary:  number;
  effective_date: string;
  created_at:     string;
}

const GENESIS_DATE = '2000-01-01';

function key(r: { full_name: string; location: string; department: string }): string {
  return `${r.full_name.trim().toLowerCase()}|${r.location}|${r.department}`;
}

export interface RateHistorySyncResult {
  inserted: number;
}

export async function recordRateHistory(supabase: SupabaseClient, employees: EmployeeRecord[]): Promise<RateHistorySyncResult> {
  if (employees.length === 0) return { inserted: 0 };

  const { data: historyRows, error } = await supabase
    .from('employee_rate_history')
    .select('full_name,location,department,pay_type,hourly_rate,annual_salary,effective_date,created_at')
    .order('effective_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;

  // First row seen per key is the latest, since we sorted desc.
  const latest = new Map<string, RateHistoryRow>();
  for (const row of (historyRows ?? []) as RateHistoryRow[]) {
    const k = key(row);
    if (!latest.has(k)) latest.set(k, row);
  }

  const today = new Date().toISOString().split('T')[0];
  const inserts: (RateHistoryRow & { source: string })[] = [];

  for (const emp of employees) {
    const prev = latest.get(key(emp));
    if (!prev) {
      inserts.push({ full_name: emp.full_name, location: emp.location, department: emp.department, pay_type: emp.pay_type, hourly_rate: emp.hourly_rate, annual_salary: emp.annual_salary, effective_date: GENESIS_DATE, created_at: new Date().toISOString(), source: 'backfill' });
    } else if (prev.pay_type !== emp.pay_type || prev.hourly_rate !== emp.hourly_rate || prev.annual_salary !== emp.annual_salary) {
      inserts.push({ full_name: emp.full_name, location: emp.location, department: emp.department, pay_type: emp.pay_type, hourly_rate: emp.hourly_rate, annual_salary: emp.annual_salary, effective_date: today, created_at: new Date().toISOString(), source: 'upload' });
    }
  }

  if (inserts.length === 0) return { inserted: 0 };

  const { error: insErr } = await supabase.from('employee_rate_history').insert(inserts);
  if (insErr) throw insErr;

  return { inserted: inserts.length };
}
