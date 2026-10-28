import { reportingFetch } from '@/lib/pf-budget';
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

export const maxDuration = 60;

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
  const start = url.searchParams.get('start') ?? '2026-03-09';
  const end   = url.searchParams.get('end')   ?? '2026-03-15';
  const trace: Record<string, unknown> = { start, end };

  const jwt = await getJwt();

  // Step 1: WeeklyReport 18-month lookback, ALL statuses, Utah only
  type WItem = Record<string, unknown>;
  const wStart = new Date(`${start}T00:00:00`);
  wStart.setMonth(wStart.getMonth() - 18);
  const weeklyRes = await pfRaw(jwt, `/OrderProducts/WeeklyReport?startDate=${wStart.toISOString().split('T')[0]}&endDate=${end}`);
  const allItems = (weeklyRes.data as WItem[]) ?? [];
  const utahItems = allItems.filter(i => i.location === 'Utah');
  const orderNums = [...new Set(utahItems.map(i => String(i.orderNumber ?? i.shopifyOrderNumber ?? '')).filter(Boolean))];
  trace['step1'] = { totalItems: allItems.length, utahItems: utahItems.length, uniqueOrders: orderNums.length };

  if (!orderNums.length) return NextResponse.json(trace);

  // Step 2: Search first 100 orders to find ones with designers
  const SRCH_BATCH = 20;
  const toSearch = orderNums.slice(0, 100);
  const orders: Array<{ orderNum: string; orderUuid: string; clientUserUuid: string; designer: string }> = [];
  for (let i = 0; i < toSearch.length; i += SRCH_BATCH) {
    const batch = toSearch.slice(i, i + SRCH_BATCH);
    const results = await Promise.all(
      batch.map(num => pfRaw(jwt, '/OrderProducts/Search', 'POST', { searchTerm: num, pageNumber: 1, pageSize: 1 }))
    );
    results.forEach((r, j) => {
      const item = ((r.data as Record<string, unknown>)?.items as WItem[])?.[0];
      if (!item?.orderUuid || !item?.assignedToUserFirstName) return;
      orders.push({
        orderNum: batch[j],
        orderUuid: String(item.orderUuid),
        clientUserUuid: String(item.clientUserUuid ?? ''),
        designer: `${item.assignedToUserFirstName} ${item.assignedToUserLastName ?? ''}`.trim(),
      });
    });
  }
  trace['step2'] = { searched: toSearch.length, withDesigner: orders.length, sample: orders.slice(0, 5).map(o => ({ orderNum: o.orderNum, designer: o.designer })) };

  if (!orders.length) return NextResponse.json(trace);

  // Step 3: Check conversations — find any with messages and pairs in range
  const filterStart = new Date(`${start}T00:00:00`);
  const filterEnd   = new Date(`${end}T23:59:59`);
  type MsgItem = { userUuid: string; dateCreated: string };

  const convResults = await Promise.all(
    orders.slice(0, 50).map(async o => {
      const r = await pfRaw(jwt, '/OrderConversation/Messages', 'POST', { orderUuid: o.orderUuid, pageNumber: 1, pageSize: 50, offset: 0 });
      const msgs = (((r.data as Record<string, unknown>)?.items) as MsgItem[]) ?? [];
      if (!msgs.length) return null;
      let pending: MsgItem | null = null;
      const pairs: { clientDate: string; replyDate: string; diffHours: string }[] = [];
      const sorted = [...msgs].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime());
      for (const m of sorted) {
        if (m.userUuid === o.clientUserUuid) { pending = m; }
        else if (pending) {
          const replyDate = new Date(m.dateCreated);
          if (replyDate >= filterStart && replyDate <= filterEnd) {
            pairs.push({ clientDate: pending.dateCreated, replyDate: m.dateCreated, diffHours: ((replyDate.getTime() - new Date(pending.dateCreated).getTime()) / 3600000).toFixed(1) });
          }
          pending = null;
        }
      }
      return { orderNum: o.orderNum, designer: o.designer, totalMessages: msgs.length, pairsInRange: pairs.length, pairs };
    })
  );

  const withMessages = convResults.filter(r => r && r.totalMessages > 0);
  const withPairs = convResults.filter(r => r && r.pairsInRange > 0);
  trace['step3'] = {
    checked: Math.min(orders.length, 50),
    withMessages: withMessages.length,
    withPairsInRange: withPairs.length,
    ordersWithMessages: withMessages.map(r => ({ orderNum: r!.orderNum, designer: r!.designer, msgs: r!.totalMessages, pairs: r!.pairsInRange })),
    qualifyingPairs: withPairs.flatMap(r => r!.pairs.map(p => ({ ...p, designer: r!.designer, orderNum: r!.orderNum }))),
  };

  return NextResponse.json(trace);
}
