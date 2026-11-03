import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { syncBouquetReceived, computeTurnaround, type PreservationTurnaround } from '@/lib/preservationTurnaround';

export const maxDuration = 60;

// Preservation turnaround (Bouquet Received → first bouquet photo) for the
// Preservation tab's KPI row. Catches up the last few minutes of the Changes
// feed first (the cron does the heavy lifting), then averages today / this
// week / this month. Cached per location for a few minutes.
const CACHE_MS = 3 * 60 * 1000;
const SYNC_BUDGET_MS = 15_000;
const cache = new Map<string, { at: number; data: PreservationTurnaround }>();
const pending = new Map<string, Promise<PreservationTurnaround>>();

async function load(location: string): Promise<PreservationTurnaround> {
  const { cursor } = await syncBouquetReceived(SYNC_BUDGET_MS);
  return computeTurnaround(location, cursor);
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location') ?? 'Utah';
  try {
    const hit = cache.get(location);
    if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json(hit.data);
    let run = pending.get(location);
    if (!run) {
      run = load(location).finally(() => pending.delete(location));
      pending.set(location, run);
    }
    const data = await run;
    cache.set(location, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
