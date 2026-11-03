import { withReportingRefreshLease } from '@/lib/report-refresh-store';
import { RefreshDeferredError } from '@/lib/report-refresh';
import { ReportingDeferredError } from '@/lib/pf-budget';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES } from '@/lib/designInventory';
import { loadPipelineLines } from '@/lib/designPipeline';
import { resolveOrderUuids } from '@/lib/orderUuids';
import { listSavedAddOnTimes, fetchAddOns, ADDONS_REFRESH_HOURS } from '@/lib/orderAddOns';

export const maxDuration = 300;

// Gentle on the PF API: a few requests at a time, steadily, instead of the
// Inventory tab's old burst of ~1,000. No new request starts after the budget.
const CONCURRENCY = 1;
const BUDGET_MS = 230_000;

// ── GET /api/cron/refresh-order-addons ───────────────────────────────────────
// Keeps pf_order_addons current for every order in Preservation or Design
// (both locations): orders never saved first, then any not checked in
// ADDONS_REFRESH_HOURS, oldest first. Runs every 30 minutes; a signed-in user
// can also call it to seed the table.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronOk = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const startedAt = Date.now();

  try {
    return await withReportingRefreshLease('order-addons-v1', async () => {
      const pipeline = await loadPipelineLines();
      const nums = [...new Set(pipeline.lines.map(l => l.num))];
      const orderUuids = await resolveOrderUuids(nums, [...DESIGN_QUEUE_STATUSES, ...PRESERVATION_STATUSES]);

      const savedAt = new Map((await listSavedAddOnTimes()).map(r => [r.num, r.fetchedAt]));
      const staleBefore = new Date(Date.now() - ADDONS_REFRESH_HOURS * 3600_000).toISOString();
      const withUuid = nums.filter(n => orderUuids[n]);
      const neverSaved = withUuid.filter(n => !savedAt.has(n));
      const stale = withUuid
        .filter(n => savedAt.has(n) && savedAt.get(n)! < staleBefore)
        .sort((a, b) => savedAt.get(a)!.localeCompare(savedAt.get(b)!));
      const queue = [...neverSaved, ...stale];

      const { fetched, failed, notTried } = await fetchAddOns(queue.map(num => ({ num, uuid: orderUuids[num] })), {
        concurrency: CONCURRENCY, deadline: startedAt + BUDGET_MS, save: true,
      });

      return NextResponse.json({
        ok: failed.length === 0 && notTried.length === 0 && nums.length === withUuid.length,
        deferred: failed.length > 0 || notTried.length > 0 || nums.length !== withUuid.length,
        pipelineRefreshedAt: pipeline.refreshedAt,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        // Pipeline is complete; failures never shrink the scan silently.
        failedMonths: pipeline.failedMonths,
        orders: nums.length,
        noUuid: nums.length - withUuid.length,
        neverSaved: neverSaved.length,
        stale: stale.length,
        refreshed: Object.keys(fetched).length,
        failed: failed.length,
        leftForNextRun: notTried.length,
      });
    });
  } catch (e) {
    if (e instanceof RefreshDeferredError || e instanceof ReportingDeferredError)
      return NextResponse.json({ ok: false, deferred: true, error: e.message }, { status: 503, headers: { 'Retry-After': '60' } });
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
