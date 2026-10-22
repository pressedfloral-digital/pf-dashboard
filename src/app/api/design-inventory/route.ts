import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { isoMonday } from '@/lib/weekDates';
import {
  DESIGN_QUEUE_STATUSES, PRESERVATION_STATUSES,
  addWeeks, scheduleLines, matchMaterials,
} from '@/lib/designInventory';
import { loadKatana } from '@/lib/katana';
import { buildOrderPlan, ORDER_EDITS_KEY, type OrderPlan, type OrderEdits } from '@/lib/katanaPlan';
import { MAX_LEAD_WEEKS } from '@/lib/supplierLeadTimes';
import { resolveOrderUuids } from '@/lib/orderUuids';
import { loadLocationQueueLines, loadDesignCapacityWeeks } from '@/lib/designPipeline';
import { readSavedAddOns, fetchAddOns, ADDONS_REFRESH_HOURS, type SavedAddOns } from '@/lib/orderAddOns';
import { saveSnapshot, loadSnapshot } from '@/lib/inventorySnapshots';

export const maxDuration = 300;

// Orders whose add-ons have never been saved are fetched live, 8 at a time,
// starting no new request after this long into the request; any left over
// show as couldn't-load until the refresh cron reaches them.
const LIVE_ADDON_BUDGET_MS = 150_000;
const LIVE_ADDON_CONCURRENCY = 8;

// ── GET /api/design-inventory?location=Utah&through=2026-12-31 ───────────────
// Every order line Design is scheduled to work on each week from this week
// through `through` (default: Dec 31 of this year, or the longest supplier
// lead time from now if that's later, so it reaches into next year from about
// November on), filled oldest-intake-first
// against the saved Design schedule's capacity.
//
// With &saved=1, returns the last successful build for the location instead
// (404 if there isn't one), with current hand edits.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const startedAt = Date.now();

  const location = req.nextUrl.searchParams.get('location') === 'Georgia' ? 'Georgia' : 'Utah';

  if (req.nextUrl.searchParams.get('saved') === '1') {
    const snapshot = await loadSnapshot<Record<string, unknown>>(location);
    if (!snapshot) return NextResponse.json({ error: 'No saved copy yet' }, { status: 404 });
    const { data: editsRow } = await supabase
      .from('schedule_settings').select('value').eq('location', location).eq('key', ORDER_EDITS_KEY).maybeSingle();
    return NextResponse.json({ ...snapshot, orderEdits: (editsRow?.value ?? {}) as OrderEdits, savedCopy: true });
  }
  const thisWeek = isoMonday(0);
  const leadHorizon = addWeeks(thisWeek, MAX_LEAD_WEEKS);
  const yearEnd = `${thisWeek.slice(0, 4)}-12-31`;
  const through  = req.nextUrl.searchParams.get('through') ?? (leadHorizon > yearEnd ? leadHorizon : yearEnd);

  try {
    // ── 1. Order lines in Preservation or Design ───────────────────────────
    // Katana recipes + stock load alongside; a Katana failure only drops the
    // order list, not the schedule.
    const katanaPromise = loadKatana(location);
    katanaPromise.catch(() => {}); // awaited in step 5
    const pipeline = await loadLocationQueueLines(location, thisWeek);
    // A missing month silently drops its orders from the schedule and the
    // order list, so fail instead of showing a confident partial answer.
    if (pipeline.failedMonths > 0) {
      return NextResponse.json({
        error: `the production app didn't return ${pipeline.failedMonths} of ${pipeline.totalMonths} months of orders, so the schedule would be incomplete. Try again in a minute.`,
      }, { status: 503 });
    }
    // ── 2. Bouquet-received dates (intake week) — see loadLocationQueueLines
    const { lines, missingLocation } = pipeline;

    // ── 3. Design capacity per week (same projection as /api/kpis) ─────────
    const { capacityWeeks, designedThisWeek, settings } = await loadDesignCapacityWeeks(location, thisWeek, through);
    const get = (key: string) => settings.find(r => r.location === location && r.key === key)?.value ?? {};

    const { weeks, unscheduled } = scheduleLines(lines, capacityWeeks);

    // ── 4. Backing & glass for every scheduled order ───────────────────────
    const scheduledNums = [...new Set(weeks.flatMap(w => w.lines.map(l => l.orderNumber)))];
    // WeeklyReport has order numbers but not the order UUIDs /Orders/{uuid}
    // (the only endpoint returning backing/glass add-ons) needs.
    const orderUuids = await resolveOrderUuids(scheduledNums, [...DESIGN_QUEUE_STATUSES, ...PRESERVATION_STATUSES]);
    // Saved add-ons (kept current by /api/cron/refresh-order-addons); orders
    // never saved are fetched now, within the time budget.
    const { saved, tableOk } = await readSavedAddOns(scheduledNums);
    const neverSaved = scheduledNums.filter(n => !saved[n] && orderUuids[n]);
    const live = await fetchAddOns(neverSaved.map(num => ({ num, uuid: orderUuids[num] })), {
      concurrency: LIVE_ADDON_CONCURRENCY, deadline: startedAt + LIVE_ADDON_BUDGET_MS, save: tableOk,
    });
    const addOnsByOrder: Record<string, SavedAddOns> = { ...saved, ...live.fetched };

    const usedAddOns = new Set<string>();
    let unknownLines = 0;
    for (const w of weeks) {
      for (const line of w.lines) {
        line.materials = matchMaterials(line, addOnsByOrder[line.orderNumber]?.addOns ?? null, usedAddOns);
        if (line.materials.addOnsUnknown) unknownLines++;
      }
    }
    const fetchedTimes = scheduledNums.map(n => addOnsByOrder[n]?.fetchedAt).filter((t): t is string => !!t).sort();

    // ── 5. What to order: recipes × schedule vs Katana stock ───────────────
    let orderPlan: OrderPlan | null = null;
    let katanaError: string | null = null;
    try {
      orderPlan = buildOrderPlan(await katanaPromise, location, weeks, thisWeek);
    } catch (e) {
      katanaError = String(e);
    }

    const payload = {
      location,
      orderPlan,
      katanaError,
      // Hand edits are applied in the browser on top of orderPlan, so they can
      // change without rebuilding the schedule.
      orderEdits: (get(ORDER_EDITS_KEY) ?? {}) as OrderEdits,
      generatedAt: new Date().toISOString(),
      designedThisWeek,
      weeks: weeks.map((w, i) => ({ ...w, scheduled: Math.round(capacityWeeks[i].scheduled) })),
      unscheduledCount: unscheduled.length,
      totals: {
        lines: lines.length,
        inDesignQueue: lines.filter(l => DESIGN_QUEUE_STATUSES.has(l.status)).length,
        inPreservation: lines.filter(l => PRESERVATION_STATUSES.has(l.status)).length,
        intakeFromEventDate: lines.filter(l => l.intakeSource === 'eventDate').length,
        missingLocation,
      },
      addOns: {
        orders:        scheduledNums.length,
        unknownOrders: scheduledNums.filter(n => !addOnsByOrder[n]).length,
        unknownLines,
        oldestFetchedAt: fetchedTimes[0] ?? null,
        newestFetchedAt: fetchedTimes[fetchedTimes.length - 1] ?? null,
        refreshHours:  ADDONS_REFRESH_HOURS,
      },
    };
    await saveSnapshot(location, payload);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
