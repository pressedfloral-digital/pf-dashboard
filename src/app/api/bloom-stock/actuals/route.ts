import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { shopifyGraphql } from '@/lib/shopifyGraphql';
import { productByShopifyId } from '@/lib/bloomStock';
import { canonicalPayrollName } from '@/lib/payrollNames';

// Bloom-stock Historicals: weekly hours per person plus the Shopify order
// numbers they finished, which together give bloom-stock CPO. Utah only.
//
// GET  ?weeks=12                                   → { hours, completions, payroll? }
//      payroll = Recreation-department gross pay per person/week from the
//      Rippling earnings upload (weekly_labor_cost, read only), sent only to
//      roles that can see CPO.
// POST { kind: 'hours', weekOf, memberName, hours } → set that week's hours
// POST { kind: 'order', weekOf, memberName, orderNumber } → log an order's
//      bloom-stock line items as completed
// DELETE ?id=<completion id>

const LOCATION = 'Utah';

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const weeks = Math.min(104, parseInt(req.nextUrl.searchParams.get('weeks') ?? '12') || 12);
  const since = new Date();
  since.setDate(since.getDate() - weeks * 7);
  const sinceIso = since.toISOString().split('T')[0];

  const [hoursRes, compRes] = await Promise.all([
    supabase.from('bloom_stock_week_actuals')
      .select('week_of, member_name, hours')
      .eq('location', LOCATION).gte('week_of', sinceIso),
    supabase.from('bloom_stock_completions')
      .select('id, week_of, member_name, order_name, order_id, line_item_id, product_key, units, created_at')
      .eq('location', LOCATION).gte('week_of', sinceIso)
      .order('created_at', { ascending: true }),
  ]);
  if (hoursRes.error) return NextResponse.json({ error: hoursRes.error.message }, { status: 500 });
  if (compRes.error)  return NextResponse.json({ error: compRes.error.message }, { status: 500 });

  // Same rule as /api/auth/me's canViewCPO: everyone except the 'user' role.
  const { data: profile } = await supabase.from('user_profiles').select('role').eq('clerk_user_id', userId).maybeSingle();
  let payroll: { week_of: string; member_name: string; cost: number }[] | undefined;
  if (profile && profile.role !== 'user') {
    const { data: pay, error: payErr } = await supabase
      .from('weekly_labor_cost')
      .select('employee, week_of, gross_pay, department')
      .eq('location', LOCATION).ilike('department', '%recreation%').gte('week_of', sinceIso);
    if (payErr) return NextResponse.json({ error: payErr.message }, { status: 500 });
    const by = new Map<string, { week_of: string; member_name: string; cost: number }>();
    for (const r of pay ?? []) {
      const name = canonicalPayrollName(r.employee);
      const k = `${r.week_of}|${name}`;
      const row = by.get(k) ?? { week_of: r.week_of, member_name: name, cost: 0 };
      row.cost += Number(r.gross_pay);
      by.set(k, row);
    }
    payroll = [...by.values()];
  }

  return NextResponse.json({
    hours:       (hoursRes.data ?? []).map(r => ({ ...r, hours: Number(r.hours) })),
    completions: (compRes.data ?? []).map(r => ({ ...r, units: Number(r.units) })),
    payroll,
  });
}

const ORDER_BY_NAME = `
query BloomStockOrderByName($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      legacyResourceId
      name
      lineItems(first: 100) {
        nodes { id currentQuantity product { legacyResourceId } }
      }
    }
  }
}`;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as {
    kind: 'hours' | 'order'; weekOf: string; memberName: string; hours?: number; orderNumber?: string;
  };
  const { kind, weekOf, memberName } = body;
  if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf) || !memberName?.trim()) {
    return NextResponse.json({ error: 'weekOf and memberName required' }, { status: 400 });
  }

  try {
    if (kind === 'hours') {
      const hours = Math.max(0, Number(body.hours) || 0);
      const { error } = await supabase
        .from('bloom_stock_week_actuals')
        .upsert({
          location: LOCATION, week_of: weekOf, member_name: memberName, hours,
          entered_by: userId, updated_at: new Date().toISOString(),
        }, { onConflict: 'location,week_of,member_name' });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (kind === 'order') {
      const raw = (body.orderNumber ?? '').trim().replace(/^#/, '');
      if (!/^\d+$/.test(raw)) return NextResponse.json({ error: 'Enter an order number like 41234' }, { status: 400 });
      const orderName = `#${raw}`;

      const data = await shopifyGraphql<{ orders: { nodes: {
        legacyResourceId: string; name: string;
        lineItems: { nodes: { id: string; currentQuantity: number; product: { legacyResourceId: string } | null }[] };
      }[] } }>(ORDER_BY_NAME, { q: `name:${orderName}` });
      const order = data.orders.nodes.find(o => o.name === orderName);
      if (!order) return NextResponse.json({ error: `Order ${orderName} not found in Shopify` }, { status: 404 });

      const lines = order.lineItems.nodes
        .map(li => ({ li, product: li.product ? productByShopifyId.get(li.product.legacyResourceId) : undefined }))
        .filter(x => x.product && x.li.currentQuantity > 0);
      if (lines.length === 0) {
        return NextResponse.json({ error: `Order ${orderName} has no Handprint, Paw Print, Footprint or Bloom Arrangement Recreation items` }, { status: 400 });
      }

      const lineIds = lines.map(x => x.li.id.split('/').pop()!);
      const { data: already, error: dupErr } = await supabase
        .from('bloom_stock_completions')
        .select('line_item_id, member_name, week_of')
        .in('line_item_id', lineIds);
      if (dupErr) throw dupErr;
      const taken = new Set((already ?? []).map(r => r.line_item_id));
      const rows = lines
        .filter(x => !taken.has(x.li.id.split('/').pop()!))
        .map(x => ({
          location: LOCATION, week_of: weekOf, member_name: memberName,
          order_name: order.name, order_id: order.legacyResourceId,
          line_item_id: x.li.id.split('/').pop()!,
          product_key: x.product!.key, units: x.li.currentQuantity,
          created_by: userId,
        }));
      if (rows.length === 0) {
        const first = already![0];
        return NextResponse.json({ error: `Order ${orderName} is already logged by ${first.member_name} (week of ${first.week_of})` }, { status: 409 });
      }
      const { error } = await supabase.from('bloom_stock_completions').insert(rows);
      if (error) throw error;
      return NextResponse.json({ ok: true, logged: rows.length });
    }

    return NextResponse.json({ error: 'Unknown kind' }, { status: 400 });
  } catch (e) {
    console.error('[bloom-stock/actuals] Error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await supabase.from('bloom_stock_completions').delete().eq('id', id).eq('location', LOCATION);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
