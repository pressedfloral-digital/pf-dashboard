import { reportingFetch } from '@/lib/pf-budget';
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

async function getJwt() {
  const res = await reportingFetch('https://pressedfloralapi.azurewebsites.net/Authentication/Login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.PF_API_EMAIL, password: process.env.PF_API_PASSWORD }),
    cache: 'no-store',
  });
  const { jwt } = await res.json();
  return jwt as string;
}

async function pfRaw(jwt: string, path: string, method = 'GET', body?: unknown) {
  const res = await reportingFetch(`https://pressedfloralapi.azurewebsites.net${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const date = url.searchParams.get('date') ?? '2026-03-10';

  const results: Record<string, unknown> = { date };
  const jwt = await getJwt();

  // Try calendar-related endpoints
  const paths: Array<[string, string, unknown?]> = [
    ['/Calendar', 'GET'],
    ['/Calendar/Events', 'GET'],
    [`/Calendar?date=${date}`, 'GET'],
    [`/Calendar?startDate=${date}&endDate=${date}`, 'GET'],
    ['/OrderProducts/Calendar', 'GET'],
    [`/OrderProducts/Calendar?date=${date}`, 'GET'],
    [`/OrderProducts/Calendar?startDate=${date}&endDate=${date}`, 'GET'],
    ['/Calendar/Bouquets', 'GET'],
    ['/Calendar/Frames', 'GET'],
    [`/Calendar/Bouquets?date=${date}`, 'GET'],
    [`/Calendar/Frames?date=${date}`, 'GET'],
    ['/Calendar', 'POST', { date }],
    ['/Calendar', 'POST', { startDate: date, endDate: date }],
    ['/OrderProducts/CalendarEvents', 'GET'],
    [`/OrderProducts/CalendarEvents?date=${date}`, 'GET'],
  ];

  for (const [path, method, body] of paths) {
    const r = await pfRaw(jwt, path, method, body);
    if (r.status !== 404) {
      // Non-404 means the endpoint exists in some form
      results[`${method} ${path}`] = {
        status: r.status,
        preview: JSON.stringify(r.data)?.slice(0, 200),
      };
    }
  }

  return NextResponse.json(results);
}
