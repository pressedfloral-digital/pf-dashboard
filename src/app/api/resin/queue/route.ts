import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Orders physically arrive for resin work a few days after the customer's
// event (wedding), not at Shopify checkout time — checkout can happen weeks
// before or after the event. Midpoint of the 3–6 day range the resin team
// gave us.
const EVENT_TO_INTAKE_OFFSET_DAYS = 4;

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Intake week — the week the flowers actually arrived for resin work, not
// the week the order was placed on Shopify. When the order carries an
// event-date tag, intake = event date + offset (flowers show up a few days
// after the wedding); otherwise fall back to order_date (photo-inspiration
// orders and anything synced before this field existed have no event-date
// tag). Shared by summary and list modes so "active" means the same thing
// in both.
function intakeDate(r: { event_date: string | null; order_date: string | null }): string | null {
  return r.event_date ? addDays(r.event_date, EVENT_TO_INTAKE_OFFSET_DAYS) : r.order_date;
}

function intakeWeekMonday(r: { event_date: string | null; order_date: string | null }): string | null {
  const iDate = intakeDate(r);
  if (!iDate) return null;
  const d = new Date(iDate + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const page     = parseInt(searchParams.get('page')     ?? '1');
  const pageSize = parseInt(searchParams.get('pageSize') ?? '100');
  const summary  = searchParams.get('summary') === 'true'; // just counts + cohort data
  // ISO Monday — cohorts older than this are the confirmed-already-completed
  // front-of-queue cutoff (see ResinPage's "Currently designing as of").
  // When set, the summary totals below exclude them, matching the turnaround
  // table's own active/completed split instead of counting the whole
  // (uncleared) queue regardless of where the real front is.
  const frontWeek = searchParams.get('frontWeek');

  const from = (page - 1) * pageSize;
  const to   = from + pageSize - 1;

  if (summary) {
    // ── Summary mode: queue counts + cohort breakdown for turnaround tab ──────
    // cleared_at IS NULL = still an active, unfulfilled resin item — see the
    // reconciliation step in resin-queue-sync for how that gets set. Paginated
    // explicitly (not a bare .select()) so this doesn't silently truncate at
    // Supabase's default 1000-row cap once the active queue grows past that.
    const rows: { pf_status: string; pf_status_rank: number; origin_location: string | null; order_date: string | null; event_date: string | null; quantity: number }[] = [];
    {
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('resin_queue')
          .select('pf_status, pf_status_rank, origin_location, order_date, event_date, quantity')
          .is('cleared_at', null)
          .order('pf_status_rank', { ascending: true })
          .order('order_date',     { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        rows.push(...(data ?? []));
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
    }
    let oldestEventDate: string | null = null;
    const cohortMap = new Map<string, number>();
    // Rows with no determinable intake week are kept in the "active" totals
    // below (can't confirm they predate the cutoff, so the safer default is
    // to still count them) — they just don't get a cohort bucket.
    const activeRows: typeof rows = [];
    let excludedUnits = 0;
    for (const r of rows) {
      if (r.event_date && (!oldestEventDate || r.event_date < oldestEventDate)) oldestEventDate = r.event_date;
      const weekKey = intakeWeekMonday(r);
      if (weekKey) cohortMap.set(weekKey, (cohortMap.get(weekKey) ?? 0) + (r.quantity ?? 1));
      if (frontWeek && weekKey && weekKey < frontWeek) {
        excludedUnits += r.quantity ?? 1;
      } else {
        activeRows.push(r);
      }
    }

    const totalUnits     = activeRows.reduce((s, r) => s + (r.quantity ?? 1), 0);
    const utahOrigin     = activeRows.filter(r => r.origin_location === 'Utah').reduce((s, r) => s + (r.quantity ?? 1), 0);
    const georgiaOrigin  = activeRows.filter(r => r.origin_location === 'Georgia').reduce((s, r) => s + (r.quantity ?? 1), 0);
    const unknownOrigin  = activeRows.filter(r => !r.origin_location).reduce((s, r) => s + (r.quantity ?? 1), 0);

    const cohorts = [...cohortMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([weekOf, units]) => ({ weekOf, units }));

    return NextResponse.json({
      totalUnits,
      utahOrigin,
      georgiaOrigin,
      unknownOrigin,
      excludedUnits,
      cohorts,
      oldestEventDate,
      offsetDays: EVENT_TO_INTAKE_OFFSET_DAYS,
    });
  }

  // ── List mode: paginated queue for the order list view ───────────────────────
  // The frontWeek exclusion isn't expressible as a plain SQL filter (it's
  // derived from event_date/order_date at read time, same as the cohorting
  // above), so this fetches every active row and paginates in memory —
  // fine at the current active-queue scale (low hundreds), and keeps this
  // list in sync with the summary cards and turnaround table instead of
  // showing a raw uncleared count nothing else on the page agrees with.
  type QueueRow = { event_date: string | null; order_date: string | null; pf_status_rank: number } & Record<string, unknown>;
  const allRows: QueueRow[] = [];
  {
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('resin_queue')
        .select('*')
        .is('cleared_at', null)
        .order('pf_status_rank', { ascending: true })
        .order('order_date',     { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      allRows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
      offset += PAGE;
    }
  }

  const rows = frontWeek
    ? allRows.filter(r => {
        const wk = intakeWeekMonday(r);
        return !wk || wk >= frontWeek; // no determinable week = keep, same as summary mode
      })
    : allRows;

  return NextResponse.json({
    orders:   rows.slice(from, to + 1),
    total:    rows.length,
    page,
    pageSize,
    hasMore:  rows.length > to + 1,
  });
}
