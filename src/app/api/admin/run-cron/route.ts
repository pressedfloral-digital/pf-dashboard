import { NextResponse } from 'next/server';
import { getAccess, forbidden } from '@/lib/routeAccess';

export const maxDuration = 300;

export async function GET() {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  // Manual admin tool — no dashboard button calls this.
  if (access.role !== 'admin') return forbidden('Admin only');

  const secret = process.env.CRON_SECRET;
  const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'https://project-yx1nc.vercel.app'}/api/cron/status-snapshot`, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: 'no-store',
  });
  const data = await res.json();
  return NextResponse.json(data);
}
