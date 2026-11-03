import { NextRequest, NextResponse } from 'next/server';
import { runStatusSnapshot } from '@/lib/status-snapshot';
import { hasBearerSecret } from '@/lib/bearerSecret';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!hasBearerSecret(authHeader, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runStatusSnapshot();
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ scanned: result.scanned, timestamp: new Date().toISOString() });
}
