// Supabase/PostgREST caps an unranged .select() at 1000 rows by default —
// silently, with no error and no truncation flag on the response. A query
// with a date/location filter that looked safely bounded when a table was
// small keeps compiling and keeps returning `data`, it just quietly starts
// missing rows once the table crosses that limit — and since most call
// sites don't have an .order() either, which rows go missing is arbitrary,
// not "the oldest ones" or "the newest ones" you might expect and think to
// check for. This is exactly what made Georgia Design's month-to-date CPO
// silently drop to a third of its real value: weekly_labor_cost passed 1000
// rows and the newest payroll upload landed outside the first page.
//
// Loops .range() until a page comes back short of the page size, so callers
// get every matching row regardless of table size. Pass a factory that
// builds a fresh query (with all your filters already applied, but no
// .range() of your own) for a given [from, to] — a Postgrest query builder
// isn't safe to re-execute, so each page needs its own instance.
export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}
