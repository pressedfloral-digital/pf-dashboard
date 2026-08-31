// Parser for Rippling's monthly "Bonus payroll report" export. The current
// report format includes "Work location name"/"Department" columns
// directly; raw (unnormalized) values are passed through here and
// normalized server-side in monthly-bonus-upload/route.ts, mirroring how
// weeklyLaborParser.ts/weekly-labor-upload leave normalization to the
// server. Older exports without those columns are still handled -- the
// upload route falls back to joining `employee` against rippling_employees
// by name when a row's location/department come back blank. See the
// monthly_bonus migration for the full rationale.

const MONTH_NAMES = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];
const MONTH_INDEX: Record<string, number> =
  Object.fromEntries(MONTH_NAMES.map((m, i) => [m.toLowerCase(), i + 1]));

// Returns "YYYY-MM-01" or null if the pay run name isn't a recognizable
// single-month bonus run (e.g. a quarterly true-up like "Q1 Bonus -
// Addition"). Never guesses -- callers must skip + report null results,
// not default them. The trailing "(YYYY)" suffix some pay run names carry
// is stripped without ever being read -- it isn't reliably the earned
// year (e.g. "December 2025 Bonuses (2026)" is earned in 2025).
export function parsePayRunNameToBonusMonth(payRunName: string): string | null {
  const withoutSuffix = payRunName.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const withoutBonusWord = withoutSuffix.replace(/\bbonus(es)?\b/gi, ' ').trim();
  const monthRe = MONTH_NAMES.join('|');
  const m = withoutBonusWord.match(
    new RegExp(`^(?:(${monthRe})\\s+(\\d{4})|(\\d{4})\\s+(${monthRe}))$`, 'i')
  );
  if (!m) return null;
  const monthName = (m[1] ?? m[4]).toLowerCase();
  const year = m[2] ?? m[3];
  const month = MONTH_INDEX[monthName];
  return month && year ? `${year}-${String(month).padStart(2, '0')}-01` : null;
}

export interface MonthlyBonusRow {
  employee:     string;
  location:     string;   // raw, e.g. "Pressed Floral Georgia" -- '' if the file has no such column
  department:   string;   // raw, e.g. "Operations" -- '' if the file has no such column
  payRunName:   string;
  bonusMonth:   string | null;  // null = unparseable Pay run name -- still returned for preview
  grossPay:     number;
  checkDate:    string | null;
  payRunStatus: string;
}

function excelDateToISO(val: unknown): string | null {
  if (val instanceof Date) return val.toISOString().split('T')[0];
  if (typeof val === 'string' && val.trim()) {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  }
  return null;
}

export async function parseMonthlyBonusXLSX(file: File): Promise<MonthlyBonusRow[]> {
  const XLSX = await import('xlsx');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target!.result as ArrayBuffer), { type: 'array', cellDates: true });
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        const parsed = rows
          .filter(r => r['Employee'] && String(r['Pay run status'] ?? '') === 'PAID')
          .map(r => {
            const payRunName = String(r['Pay run name'] ?? '').trim();
            return {
              employee:     String(r['Employee']).trim(),
              location:     String(r['Work location name'] ?? '').trim(),
              department:   String(r['Department'] ?? '').trim(),
              payRunName,
              bonusMonth:   parsePayRunNameToBonusMonth(payRunName),
              grossPay:     parseFloat(String(r['Employee gross pay'] ?? '0')) || 0,
              checkDate:    excelDateToISO(r['Pay run check date']),
              payRunStatus: String(r['Pay run status'] ?? ''),
            };
          })
          .filter(r => r.grossPay > 0);
        resolve(parsed);
      } catch (err) {
        reject(new Error(err instanceof Error ? err.message : String(err)));
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
