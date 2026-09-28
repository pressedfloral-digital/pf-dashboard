import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { fetchAssignedOrderProducts, type AssignmentDepartment } from '@/lib/assignment-counts';

export const maxDuration = 60;

// Drill-down for Historicals' auto-synced order counts: the order products a
// person was attributed for one department during a week or a single day.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEPARTMENTS: AssignmentDepartment[] = ['preservation', 'design', 'fulfillment'];

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const name = params.get('name')?.trim() ?? '';
  const department = params.get('department') as AssignmentDepartment;
  // Either a Mon–Sun week (weekOf) or an explicit start/end of up to 7 days
  // (This Week's per-day Actual counts pass a single day).
  const weekOf = params.get('weekOf');
  const start = weekOf ?? params.get('start') ?? '';
  let end = params.get('end') ?? start;
  if (weekOf) {
    const d = new Date(`${weekOf}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    end = d.toISOString().slice(0, 10);
  }

  if (!name) return NextResponse.json({ error: 'name is required.' }, { status: 400 });
  if (!DEPARTMENTS.includes(department)) {
    return NextResponse.json({ error: 'department must be preservation, design, or fulfillment.' }, { status: 400 });
  }
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || start > end) {
    return NextResponse.json({ error: 'Provide weekOf, or start/end, as YYYY-MM-DD.' }, { status: 400 });
  }
  if (Date.parse(end) - Date.parse(start) > 6 * 86_400_000) {
    return NextResponse.json({ error: 'Range is limited to seven days.' }, { status: 400 });
  }

  try {
    const result = await fetchAssignedOrderProducts(name, department, start, end);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
