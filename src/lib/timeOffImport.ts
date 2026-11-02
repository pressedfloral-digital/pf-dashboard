// Rippling time-off export → roster daysOff / hoursOff.
//
// Rippling report columns vary with how the report was built, so columns are
// found by name pattern rather than exact header, and the detected column for
// each field is returned so the upload screen can show what it read.
// Only Approved requests are applied by default; anything else is flagged.

export const FULL_DAY_HOURS = 8;

export type TimeOffStatus = 'approved' | 'pending' | 'denied' | 'unknown';

export interface TimeOffSheetRow {
  rowNumber: number;          // spreadsheet row (header = 1)
  name:      string;
  start:     string;          // ISO date
  end:       string;          // ISO date, ≥ start
  hours:     number | null;   // total hours requested, when the sheet has them
  status:    TimeOffStatus;
  rawStatus: string;
  policy:    string;
}

export interface TimeOffSheet {
  rows:    TimeOffSheetRow[];
  columns: Partial<Record<'name' | 'start' | 'end' | 'hours' | 'days' | 'unit' | 'status' | 'policy', string>>;
  skipped: number;            // rows missing a name or a readable start date
}

const COLUMN_PATTERNS: [keyof TimeOffSheet['columns'], RegExp][] = [
  ['name',   /^(employee( name)?|full name|name|employee full name)$/i],
  ['start',  /^(start( date)?|from|first day)$|start date/i],
  ['end',    /^(end( date)?|to|through|last day)$|end date/i],
  ['hours',  /hours|^(duration|amount|total)( \(hours\))?$/i],
  ['days',   /^(duration|amount|total)? ?\(?days\)?$/i],
  ['unit',   /^(unit|units|duration unit|time unit)$/i],
  ['status', /status/i],
  ['status', /approv(?!er)/i],   // "Approved?" — never the approver's name
  ['policy', /policy|type|reason|category/i],
];

function findColumns(headers: string[]): TimeOffSheet['columns'] {
  const cols: TimeOffSheet['columns'] = {};
  for (const [field, re] of COLUMN_PATTERNS) {
    if (cols[field]) continue;
    const h = headers.find(h => re.test(h.trim()) && !Object.values(cols).includes(h));
    if (h) cols[field] = h;
  }
  return cols;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toIsoDate(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // SheetJS dates land on (or a few hours either side of) local midnight;
    // round to the nearest one so a timezone offset can't shift the day
    const near = v.getHours() >= 12 ? new Date(v.getTime() + 12 * 3600000) : v;
    return `${near.getFullYear()}-${pad(near.getMonth() + 1)}-${pad(near.getDate())}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date (days since 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${pad(+m[1])}-${pad(+m[2])}`;
  const d = new Date(s);
  return s && !isNaN(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
}

export function toStatus(raw: string): TimeOffStatus {
  if (/approv/i.test(raw)) return 'approved';
  if (/den(y|ied)|declin|reject|cancel|withdr/i.test(raw)) return 'denied';
  if (/pend|request|submit|await|review|open/i.test(raw)) return 'pending';
  return 'unknown';
}

export function parseTimeOffRows(rows: Record<string, unknown>[]): TimeOffSheet {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const columns = findColumns(headers);
  const out: TimeOffSheetRow[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const name  = columns.name ? String(r[columns.name] ?? '').trim() : '';
    const start = columns.start ? toIsoDate(r[columns.start]) : '';
    if (!name || !start) { skipped++; return; }
    const endRaw = columns.end ? toIsoDate(r[columns.end]) : '';
    const end    = endRaw && endRaw >= start ? endRaw : start;
    const hoursRaw = columns.hours ? parseFloat(String(r[columns.hours] ?? '')) : NaN;
    const daysRaw  = columns.days ? parseFloat(String(r[columns.days] ?? '')) : NaN;
    // A plain "Duration" column with a Unit of days is days, not hours
    const inDays = columns.unit ? /day/i.test(String(r[columns.unit] ?? '')) : false;
    const hours = hoursRaw > 0 ? (inDays ? hoursRaw * FULL_DAY_HOURS : hoursRaw) : daysRaw > 0 ? daysRaw * FULL_DAY_HOURS : null;
    const rawStatus = columns.status ? String(r[columns.status] ?? '').trim() : '';
    out.push({
      rowNumber: i + 2, name, start, end, hours,
      status: columns.status ? toStatus(rawStatus) : 'unknown', rawStatus,
      policy: columns.policy ? String(r[columns.policy] ?? '').trim() : '',
    });
  });
  return { rows: out, columns, skipped };
}

// ── Name matching against the roster ────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Exact name, then "Last, First" flipped, then first + last word (drops
// middle names / initials).
export function matchPerson<P extends { id: string; name: string }>(name: string, people: P[]): P | null {
  const flipped = name.includes(',') ? name.split(',').reverse().join(' ') : name;
  const target = norm(flipped);
  const exact = people.find(p => norm(p.name) === target);
  if (exact) return exact;
  const ends = (s: string) => { const w = norm(s).split(' '); return w.length > 1 ? `${w[0]} ${w[w.length - 1]}` : w[0]; };
  const hits = people.filter(p => ends(p.name) === ends(flipped));
  return hits.length === 1 ? hits[0] : null;
}

// ── Row → days off ──────────────────────────────────────────────────────────

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A multi-day request is whole days off for every date in it — Rippling only
// charges hours for days the person normally works (a 16h request over
// Thanksgiving week spans 3 weekdays), so dividing hours across the range
// would invent partial days. A single day under a full day's hours is a
// partial day off.
export function rowToDays(row: Pick<TimeOffSheetRow, 'start' | 'end' | 'hours'>): { date: string; hoursOff: number | null }[] {
  if (row.start === row.end && row.hours != null && row.hours < FULL_DAY_HOURS)
    return [{ date: row.start, hoursOff: row.hours }];
  const dates: string[] = [];
  for (let d = row.start; d <= row.end && dates.length < 366; d = addDays(d, 1)) dates.push(d);
  return dates.map(date => ({ date, hoursOff: null }));
}
