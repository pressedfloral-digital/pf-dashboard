import { NextRequest, NextResponse } from 'next/server';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { pfPost } from '@/lib/pf-api';

export async function GET(req: NextRequest) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  // Manual admin tool — no dashboard button calls this.
  if (access.role !== 'admin') return forbidden('Admin only');

  const orderNum = req.nextUrl.searchParams.get('order') ?? '40279';
  const data = await pfPost<any>('/OrderProducts/Search', {
    searchTerm: orderNum,
    pageNumber: 1,
    pageSize: 10,
  });

  return NextResponse.json(data);
}
