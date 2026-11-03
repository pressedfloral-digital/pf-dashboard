import { reportingFetch } from '@/lib/pf-budget';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

const PF_API = 'https://pressedfloralapi.azurewebsites.net';

async function getJwt() {
  const res = await reportingFetch(`${PF_API}/Authentication/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.PF_API_EMAIL, password: process.env.PF_API_PASSWORD }),
    cache: 'no-store',
  });
  const { jwt } = await res.json();
  return jwt as string;
}

async function pfTry(jwt: string, method: string, path: string, body?: unknown) {
  const res = await reportingFetch(`${PF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, preview: JSON.stringify(data)?.slice(0, 400) };
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // order #44314 orderUuid and orderProductUuid (from previous debug)
  const orderUuid   = req.nextUrl.searchParams.get('orderUuid')   ?? '7b2bfb94-ee0a-4325-95f1-0f99b57fb3a5';
  const productUuid = req.nextUrl.searchParams.get('productUuid') ?? '0494c248-c877-4475-a9ca-5b56088fa158';

  const jwt = await getJwt();

  const paths: [string, string, unknown?][] = [
    // Retry 405s as POST with various body shapes
    ['POST', `/OrderProducts/${productUuid}/Activity`,      {}],
    ['POST', `/OrderProducts/${productUuid}/Activity`,      { orderProductUuid: productUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderProducts/${productUuid}/History`,       {}],
    ['POST', `/OrderProducts/${productUuid}/History`,       { orderProductUuid: productUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderProducts/${productUuid}/StatusHistory`, {}],
    ['POST', `/OrderProducts/${productUuid}/StatusHistory`, { pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderProducts/${productUuid}/Uploads`,       {}],
    ['POST', `/OrderProducts/${productUuid}/Uploads`,       { pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderProducts/${productUuid}/BouquetPhoto`,  {}],
    ['POST', `/OrderProducts/${productUuid}/Photos`,        {}],
    ['POST', `/OrderProducts/${productUuid}/Photos`,        { pageNumber: 1, pageSize: 10 }],
    // Try direct product fetch
    ['GET',  `/OrderProducts/${productUuid}`,               undefined],
    // Try order-level endpoints
    ['GET',  `/Orders/${orderUuid}/Activity`,               undefined],
    ['POST', `/Orders/${orderUuid}/Activity`,               {}],
    ['POST', `/Orders/${orderUuid}/History`,                {}],
    ['POST', `/Orders/${orderUuid}/StatusHistory`,          {}],
    // Other patterns
    ['POST', `/OrderProducts/Activity`,        { orderProductUuid: productUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderProducts/StatusHistory`,   { orderProductUuid: productUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderProducts/StatusHistory`,   { orderUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderActivity/Search`,          { orderUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/OrderActivity/Search`,          { orderProductUuid: productUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/Preservation/Search`,           { orderProductUuid: productUuid }],
    ['POST', `/Preservation/Search`,           { orderUuid, pageNumber: 1, pageSize: 10 }],
    ['POST', `/BouquetPhoto/Search`,           { orderProductUuid: productUuid }],
    ['POST', `/OrderProducts/BouquetPhotos`,   { orderProductUuid: productUuid }],
  ];

  const results: Record<string, unknown> = {};
  for (const [method, path, body] of paths) {
    const r = await pfTry(jwt, method, path, body);
    if (r.status !== 404) {
      results[`${method} ${path}`] = r;
    }
  }

  return NextResponse.json({ orderUuid, productUuid, results });
}
