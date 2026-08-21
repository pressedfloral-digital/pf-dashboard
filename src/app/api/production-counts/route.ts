import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { computeProductionCounts } from '@/lib/production-counts';

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const start = req.nextUrl.searchParams.get('start');
  const end   = req.nextUrl.searchParams.get('end');
  if (!start || !end) return NextResponse.json({ error: 'start and end required' }, { status: 400 });

  try {
    const counts = await computeProductionCounts(start, end);
    return NextResponse.json(counts);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
