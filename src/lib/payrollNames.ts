// Rippling (hours, payroll, employee directory) sometimes carries a shorter
// name than the schedule roster, which is also the name the production sync
// writes orders under (see STAFF_NAME_ALIASES in assignment-counts.ts). Left
// alone, one person splits into two Historicals rows — hours and cost under
// the Rippling name, orders under the roster name — and neither row's ratio
// or CPO is right. Map the Rippling name to the roster name wherever the two
// are joined. Client-safe: no server imports.
const PAYROLL_NAME_ALIASES: Record<string, string> = {
  'cyd g':       'Cyd Gay',
  'sher taylor': 'Sherilyn Taylor',
};

/** The roster name for a Rippling name; unchanged when there's no alias. */
export function canonicalPayrollName(name: string): string {
  const trimmed = name.trim();
  return PAYROLL_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/** True when a Rippling name and a roster/actuals name are the same person. */
export function samePayrollPerson(payrollName: string, memberName: string): boolean {
  return canonicalPayrollName(payrollName).toLowerCase() === canonicalPayrollName(memberName).toLowerCase();
}
