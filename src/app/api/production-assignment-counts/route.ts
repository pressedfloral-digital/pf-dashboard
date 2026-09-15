import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { computeDailyAssignmentCounts } from '@/lib/assignment-counts';

export const maxDuration = 120;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await req.json() as { start?: unknown; end?: unknown; names?: unknown };
    const start = typeof body.start === 'string' ? body.start : '';
    const end = typeof body.end === 'string' ? body.end : '';
    const names = Array.isArray(body.names)
      ? body.names.filter((name): name is string => typeof name === 'string').slice(0, 60)
      : [];

    if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || start > end) {
      return NextResponse.json({ error: 'A valid start and end date are required.' }, { status: 400 });
    }
    if (names.length === 0) {
      return NextResponse.json({ error: 'At least one roster name is required.' }, { status: 400 });
    }

    const result = await computeDailyAssignmentCounts(start, end, names);
    return NextResponse.json({ ...result, refreshedAt: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
