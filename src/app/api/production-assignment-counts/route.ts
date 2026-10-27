import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { computeDailyAssignmentCounts } from '@/lib/assignment-counts';

import { assignmentDates } from '@/lib/assignment-batch';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await req.json() as { start?: unknown; end?: unknown; names?: unknown };
    const start = typeof body.start === 'string' ? body.start : '';
    const end = typeof body.end === 'string' ? body.end : '';
    if (!Array.isArray(body.names) || body.names.length < 1 || body.names.length > 60
        || body.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 200)) {
      return NextResponse.json({ error: 'Provide between 1 and 60 valid roster names.' }, { status: 400 });
    }
    const names = body.names as string[];
    try { assignmentDates(start, end); }
    catch { return NextResponse.json({ error: 'Provide a valid range of one to seven days.' }, { status: 400 }); }

    const result = await computeDailyAssignmentCounts(start, end, names);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
