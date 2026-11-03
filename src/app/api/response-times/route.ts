import { reportingFetch } from '@/lib/pf-budget';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

export const maxDuration = 60;

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

async function pfFetch<T>(jwt: string, path: string, body?: unknown): Promise<T | null> {
  const isGet = body === undefined;
  const res = await reportingFetch(`${PF_API}${path}`, {
    method: isGet ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: isGet ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json() as Promise<T>;
}

interface SearchItem {
  shopifyOrderNumber?: string | number;
  orderNumber?: string | number;
  location?: string;
  assignedToUserFirstName?: string;
  assignedToUserLastName?: string;
  orderUuid?: string;
  clientUserUuid?: string | null;
}
interface SearchResponse { items: SearchItem[]; totalPages?: number; }

interface MessageItem { userUuid: string; dateCreated: string; }
interface MessagesResponse { items?: MessageItem[]; }

function calcResponseMinutes(messages: MessageItem[], clientUuid: string, filterStart: Date, filterEnd: Date): number[] {
  const sorted = [...messages].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime());
  const times: number[] = [];
  let pending: MessageItem | null = null;
  for (const msg of sorted) {
    if (msg.userUuid === clientUuid) {
      pending = msg;
    } else if (pending) {
      const replyDate = new Date(msg.dateCreated);
      if (replyDate >= filterStart && replyDate <= filterEnd) {
        times.push((replyDate.getTime() - new Date(pending.dateCreated).getTime()) / 60000);
      }
      pending = null;
    }
  }
  return times;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    start?: string;
    end?: string;
    location?: string;
    orders?: Array<{ orderUuid: string; orderNum: string; designerName: string; clientUserUuid?: string }>;
  };

  let orders: Array<{ orderUuid: string; orderNum: string; designerName: string; clientUserUuid: string }> = [];

  const jwt = await getJwt();

  if (body.start && body.end) {
    // WeeklyReport 18-month lookback, all statuses, Utah only
    const wStart = new Date(`${body.start}T00:00:00`);
    wStart.setMonth(wStart.getMonth() - 18);
    const weekly = await pfFetch<SearchItem[]>(jwt, `/OrderProducts/WeeklyReport?startDate=${wStart.toISOString().split('T')[0]}&endDate=${body.end}`, undefined);
    const orderNums = [...new Set(
      (weekly ?? [])
        .filter(i => body.location === 'All' || !body.location || i.location === (body.location ?? 'Utah'))
        .map(i => String(i.orderNumber ?? i.shopifyOrderNumber ?? ''))
        .filter(Boolean)
    )];

    // Search in batches to get orderUuid + designer
    const SRCH = 20;
    for (let i = 0; i < orderNums.length && orders.length < 150; i += SRCH) {
      const batch = orderNums.slice(i, i + SRCH);
      const results = await Promise.all(
        batch.map(num => pfFetch<SearchResponse>(jwt, '/OrderProducts/Search', { searchTerm: num, pageNumber: 1, pageSize: 1 }))
      );
      results.forEach((data, j) => {
        const item = data?.items?.[0];
        if (!item?.orderUuid || !item?.assignedToUserFirstName) return;
        orders.push({ orderUuid: item.orderUuid, orderNum: batch[j], designerName: `${item.assignedToUserFirstName} ${item.assignedToUserLastName ?? ''}`.trim(), clientUserUuid: String(item.clientUserUuid ?? '') });
      });
    }
  } else if (body.orders?.length) {
    orders = body.orders.map(o => ({ ...o, clientUserUuid: o.clientUserUuid ?? '' }));
  }

  if (!orders.length) {
    return NextResponse.json({ byDesigner: {}, overall: { avgMinutes: 0, sampleSize: 0 }, _debug: 'no orders found' });
  }

  // Cap at 150 orders to stay within maxDuration
  orders = orders.slice(0, 150);

  const filterStart = new Date(`${body.start ?? '2000-01-01'}T00:00:00`);
  const filterEnd   = new Date(`${body.end   ?? '2999-12-31'}T23:59:59`);

  const BATCH = 10;
  const byDesigner: Record<string, number[]> = {};
  const allTimes: number[] = [];

  for (let i = 0; i < orders.length; i += BATCH) {
    const batch = orders.slice(i, i + BATCH);
    const messagesResults = await Promise.all(
      batch.map(o => pfFetch<MessagesResponse>(jwt, '/OrderConversation/Messages', { orderUuid: o.orderUuid, pageNumber: 1, pageSize: 50, offset: 0 }))
    );

    messagesResults.forEach((data, j) => {
      const order = batch[j];
      const messages = data?.items ?? [];
      if (!messages.length || !order.clientUserUuid) return;
      const times = calcResponseMinutes(messages, order.clientUserUuid, filterStart, filterEnd);
      if (!times.length) return;
      if (!byDesigner[order.designerName]) byDesigner[order.designerName] = [];
      byDesigner[order.designerName].push(...times);
      allTimes.push(...times);
    });
  }

  const result: Record<string, { avgMinutes: number; sampleSize: number }> = {};
  for (const [name, times] of Object.entries(byDesigner)) {
    result[name] = { avgMinutes: avg(times), sampleSize: times.length };
  }

  return NextResponse.json({
    byDesigner: result,
    overall: { avgMinutes: avg(allTimes), sampleSize: allTimes.length },
    _debug: { ordersProcessed: orders.length, totalTimes: allTimes.length },
  });
}
