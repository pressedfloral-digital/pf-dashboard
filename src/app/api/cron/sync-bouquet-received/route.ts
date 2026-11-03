import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { syncBouquetReceived } from '@/lib/preservationTurnaround';

export const maxDuration = 300;

// No new Changes page starts after the budget; a backfill resumes next run.
const BUDGET_MS = 240_000;

// ── GET /api/cron/sync-bouquet-received ──────────────────────────────────────
// Copies Bouquet Received entries from the PF API's /OrderProducts/Changes
// feed into pf_bouquet_received for Preservation's turnaround KPI. Runs every
// 15 minutes; a signed-in user can also call it to seed the table.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronOk = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await syncBouquetReceived(BUDGET_MS));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
