// Shared, dependency-free count contract. Missing data is an error, never zero.
export type Counts = { preservation: number; design: number; fulfillment: number };
export type BatchRow = Counts & { userUuid: string; date: string };
export type BatchResponse = { rows: BatchRow[]; refreshedAt: string };
export const departments = ['preservation', 'design', 'fulfillment'] as const;
export const zeroCounts = (): Counts => ({ preservation: 0, design: 0, fulfillment: 0 });

export function assignmentDates(start: string, end: string): string[] {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (!valid(start) || !valid(end) || start > end) throw new Error('Invalid assignment date range.');
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (days > 7) throw new Error('Assignment counts are limited to seven days.');
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
}

export function validateBatch(data: BatchResponse, users: string[], dates: string[]): Map<string, Counts> {
  if (!data || !Array.isArray(data.rows) || !Number.isFinite(Date.parse(data.refreshedAt)))
    throw new Error('Invalid assignment count response.');
  const expected = new Set(users.flatMap(user => dates.map(day => `${user.toLowerCase()}/${day}`)));
  const counts = new Map<string, Counts>();
  for (const row of data.rows) {
    const key = `${row.userUuid?.toLowerCase()}/${row.date}`;
    if (!expected.delete(key) || departments.some(d => !Number.isSafeInteger(row[d]) || row[d] < 0))
      throw new Error('Invalid or duplicate assignment count row.');
    counts.set(key, { preservation: row.preservation, design: row.design, fulfillment: row.fulfillment });
  }
  if (expected.size) throw new Error('Incomplete assignment count response.');
  return counts;
}

export function sumCounts(values: Counts[]): Counts {
  return values.reduce((sum, value) => {
    for (const department of departments) sum[department] += value[department];
    return sum;
  }, zeroCounts());
}

/** Bounded process-local cache. Identical callers share work; failures never cache. */
export function createSingleFlight<T>(ttlMs: number, maxEntries = 64) {
  const entries = new Map<string, { promise: Promise<T>; expiresAt: number; pending: boolean }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const existing = entries.get(key);
    if (existing && (existing.pending || existing.expiresAt > Date.now())) return existing.promise;
    entries.delete(key);
    if (entries.size >= maxEntries) {
      const evict = [...entries].find(([, entry]) => !entry.pending);
      if (evict) entries.delete(evict[0]);
      else return Promise.reject(new Error('Production counts are busy. Please try the next refresh.'));
    }
    const entry = { promise: Promise.resolve().then(load), expiresAt: 0, pending: true };
    entries.set(key, entry);
    entry.promise = entry.promise.then(value => {
      entry.pending = false;
      entry.expiresAt = Date.now() + ttlMs;
      return value;
    }, error => { entries.delete(key); throw error; });
    return entry.promise;
  };
}
