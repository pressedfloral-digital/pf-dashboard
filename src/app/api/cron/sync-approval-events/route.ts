import { reportingFetch } from '@/lib/pf-budget';
import { NextRequest, NextResponse } from 'next/server';
import { auth }                      from '@clerk/nextjs/server';
import { supabase }                  from '@/lib/supabase';

export const maxDuration = 300;

// ── Auth ──────────────────────────────────────────────────────────────────────
const CRON_SECRET = process.env.CRON_SECRET ?? '';

function isAuthorized(req: NextRequest): boolean {
  const bearer = req.headers.get('authorization') ?? '';
  if (bearer === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

// ── PF API helpers ────────────────────────────────────────────────────────────
const PF_BASE = (() => {
  const u = process.env.PF_API_URL ?? '';
  return u.endsWith('/') ? u : u + '/';
})();

let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getPFToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) return _cachedToken.token;
  const res  = await reportingFetch(`${PF_BASE}Authentication/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.PF_API_EMAIL, password: process.env.PF_API_PASSWORD }),
    cache: 'no-store',
  });
  const json = await res.json() as Record<string, string>;
  const token = json.jwt ?? json.token ?? json.accessToken ?? json.access_token;
  if (!token) throw new Error('PF API login failed');
  _cachedToken = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function pfGet<T>(path: string, token: string): Promise<T> {
  const res = await reportingFetch(`${PF_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PF GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function pfPost<T>(path: string, body: unknown, token: string): Promise<T> {
  const res = await reportingFetch(`${PF_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PF POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Week helper (Monday-anchored, matches HistoricalsSection) ─────────────────
function toMondayWeek(dateStr: string): string {
  const d    = new Date(dateStr);
  const day  = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  const mon  = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diff);
  return mon.toISOString().split('T')[0];
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface HistoryEntry {
  userFirstName:          string | null;
  userLastName:           string | null;
  assignedToUserFirstName: string | null;
  assignedToUserLastName:  string | null;
  status:                 string;
  dateCreated:            string;
}

interface OrderDetail {
  uuid:                    string;
  shopifyOrderNumber:      string;
  status:                  string;
  comment:                 string | null;
  assignedToUserFirstName: string | null;
  assignedToUserLastName:  string | null;
  location:                string | null;
  history:                 HistoryEntry[];
}

interface SearchItem {
  uuid:                    string;
  shopifyOrderNumber:      string;
  status:                  string;
  assignedToUserFirstName: string | null;
  assignedToUserLastName:  string | null;
}

interface SearchResponse {
  items: SearchItem[];
  totalPages: number;
  currentPage: number;
}

interface ApprovalEvent {
  uuid:          string;
  order_num:     string;
  designer_name: string;
  location:      string | null;
  event_type:    'approved' | 'disapproved';
  event_date:    string;
  week_of:       string;
  comment:       string | null;
  synced_at:     string;
}

// ── Main sync ─────────────────────────────────────────────────────────────────
// Strategy:
//   1. Pull all order_nums that have ever been approved or disapproved from
//      order_status_history (our snapshot table).
//   2. For each, fetch OrderProducts/Search to get their UUID(s).
//   3. Fetch OrderProducts/Details/{uuid} for each UUID.
//   4. Walk the history array — every 'approved' or 'disapproved' entry
//      becomes one row in designer_approval_events.
//   5. For orders currently in 'disapproved' status, also capture the
//      top-level comment (it disappears once the order moves to approved).
//   6. Upsert with (uuid, event_type, event_date) as the unique key so
//      re-runs are idempotent.

export async function GET(req: NextRequest) {
  // Allow Clerk session OR cron secret
  const cronAuthed = isAuthorized(req);
  if (!cronAuthed) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun   = req.nextUrl.searchParams.get('dryRun') === 'true';
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit    = limitParam ? parseInt(limitParam) : null; // null = no limit (full sync)

  const now = new Date().toISOString();
  const log: string[] = [];

  try {
    const token = await getPFToken();

    // ── Step 1: Get distinct order_nums from order_status_history that have
    //            ever been approved or disapproved ───────────────────────────
    const { data: histRows, error: histErr } = await supabase
      .from('order_status_history')
      .select('order_num, status')
      .or('status.eq.approved,status.eq.disapproved');

    if (histErr) throw histErr;

    // Unique order_nums, and track which are currently disapproved
    const orderNums         = [...new Set((histRows ?? []).map(r => r.order_num as string))];
    const currentlyDisapproved = new Set(
      (histRows ?? [])
        .filter(r => r.status === 'disapproved')
        .map(r => r.order_num as string)
    );

    const toProcess = limit ? orderNums.slice(0, limit) : orderNums;
    log.push(`Found ${orderNums.length} orders with approval history. Processing ${toProcess.length}.`);

    // ── Step 2 & 3: For each order_num, search → get UUID → fetch details ───
    const events: ApprovalEvent[] = [];
    let fetched = 0;
    let failed  = 0;

    // Also fetch YTD orders from PF API that have approved/disapproved status
    // to catch any orders not yet in order_status_history
    // We'll use a WeeklyReport scan for the current year to supplement
    const ytdStart = `${new Date().getFullYear()}-01-01`;

    for (const orderNum of toProcess) {
      try {
        // Search for this order
        const search = await pfPost<SearchResponse>('OrderProducts/Search', {
          search: orderNum, searchTerm: orderNum, pageSize: 10, pageNumber: 1,
        }, token);

        const items = search.items ?? [];
        if (items.length === 0) { failed++; continue; }

        for (const item of items) {
          if (item.shopifyOrderNumber !== orderNum) continue; // exact match only

          // Fetch full details including history
          const detail = await pfGet<OrderDetail>(
            `OrderProducts/Details/${item.uuid}`, token
          );

          const history = detail.history ?? [];

          // Walk history for approved/disapproved entries
          for (const entry of history) {
            if (entry.status !== 'approved' && entry.status !== 'disapproved') continue;

            // Designer is assignedToUser on that history entry,
            // falling back to current assignedToUser on the detail record
            const firstName = entry.assignedToUserFirstName ?? detail.assignedToUserFirstName;
            const lastName  = entry.assignedToUserLastName  ?? detail.assignedToUserLastName;
            if (!firstName && !lastName) continue; // skip if no designer attribution

            const designerName = `${firstName ?? ''} ${lastName ?? ''}`.trim();
            const weekOf       = toMondayWeek(entry.dateCreated);

            // Capture comment only for disapproval events on currently-disapproved orders
            // (comment is null once order moves to approved)
            const comment =
              entry.status === 'disapproved' && currentlyDisapproved.has(orderNum)
                ? (detail.comment ?? null)
                : null;

            events.push({
              uuid:          detail.uuid,
              order_num:     orderNum,
              designer_name: designerName,
              location:      detail.location ?? null,
              event_type:    entry.status as 'approved' | 'disapproved',
              event_date:    entry.dateCreated,
              week_of:       weekOf,
              comment,
              synced_at:     now,
            });
          }

          fetched++;
        }
      } catch (e) {
        failed++;
        log.push(`  ✗ Failed order ${orderNum}: ${String(e)}`);
      }

      // Small delay to avoid hammering the PF API
      await new Promise(r => setTimeout(r, 50));
    }

    log.push(`Fetched details for ${fetched} order products. Failed: ${failed}.`);
    log.push(`Total events extracted: ${events.length}.`);

    if (dryRun) {
      return NextResponse.json({ dryRun: true, wouldUpsert: events.length, events: events.slice(0, 20), log });
    }

    // ── Step 4: Upsert to designer_approval_events ───────────────────────────
    if (events.length > 0) {
      // Batch upsert in chunks of 500
      const CHUNK = 500;
      let upserted = 0;
      for (let i = 0; i < events.length; i += CHUNK) {
        const chunk = events.slice(i, i + CHUNK);
        const { error } = await supabase
          .from('designer_approval_events')
          .upsert(chunk, { onConflict: 'uuid,event_type,event_date' });
        if (error) throw error;
        upserted += chunk.length;
      }
      log.push(`Upserted ${upserted} events.`);
    }

    return NextResponse.json({
      ok:       true,
      processed: toProcess.length,
      fetched,
      failed,
      events:   events.length,
      log,
    });

  } catch (e) {
    console.error('sync-approval-events error:', e);
    return NextResponse.json({ error: String(e), log }, { status: 500 });
  }
}
