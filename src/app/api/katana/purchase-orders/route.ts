import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { auth, currentUser } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';
import { loadKatana, nextPurchaseOrderNumber, createPurchaseOrder, KATANA_STOCK_TAG, type NewPurchaseOrderRow } from '@/lib/katana';

interface Body {
  location:   string;
  supplierId: number;
  needBy:     string;                                 // YYYY-MM-DD, Monday the stock is needed
  rows:       { variantId: number; quantity: number }[]; // quantity in the item's purchase unit
}

// ── POST /api/katana/purchase-orders ─────────────────────────────────────────
// Creates a Not Received purchase order in Katana for one supplier and one
// location from the Inventory tab's order list. Katana doesn't send anything
// to the supplier until someone does that from Katana.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const location = body.location === 'Georgia' ? 'Georgia' : body.location === 'Utah' ? 'Utah' : null;
  if (!location) return NextResponse.json({ error: 'location must be Utah or Georgia' }, { status: 400 });
  if (!Number.isInteger(body.supplierId)) return NextResponse.json({ error: 'supplierId is required' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.needBy ?? '')) return NextResponse.json({ error: 'needBy must be YYYY-MM-DD' }, { status: 400 });
  const rows = (body.rows ?? []).filter(r => Number.isInteger(r.variantId) && Number(r.quantity) > 0);
  if (!rows.length) return NextResponse.json({ error: 'Add at least one item with a quantity' }, { status: 400 });

  // Same rule as editing a location elsewhere on the dashboard.
  const { data: profile } = await supabase.from('user_profiles').select('role, location').eq('clerk_user_id', userId).single();
  const canEdit = profile?.role === 'admin'
    || ((profile?.role === 'general_manager' || profile?.role === 'manager') && profile?.location === location);
  if (!canEdit) return NextResponse.json({ error: `You don't have permission to order for ${location}` }, { status: 403 });

  try {
    const k = await loadKatana(location);
    const supplier = k.suppliers.find(s => s.id === body.supplierId);
    if (!supplier) return NextResponse.json({ error: 'Unknown Katana supplier' }, { status: 400 });

    const byVariant = new Map<number, { item: (typeof k.materials)[number]; price: number }>();
    for (const item of [...k.materials, ...k.products]) {
      for (const v of item.variants) byVariant.set(v.id, { item, price: Number(v.purchase_price ?? 0) });
    }

    const arrival = `${body.needBy}T12:00:00.000Z`;
    const poRows: NewPurchaseOrderRow[] = [];
    for (const r of rows) {
      const found = byVariant.get(r.variantId);
      if (!found) return NextResponse.json({ error: `Unknown Katana variant ${r.variantId}` }, { status: 400 });
      const conversion = Number(found.item.purchase_uom_conversion_rate);
      const usesPurchaseUnit = !!found.item.purchase_uom && conversion > 0;
      poRows.push({
        variant_id: r.variantId,
        quantity: Math.ceil(Number(r.quantity)),
        // Katana's variant price is per stock unit; the PO row is priced per purchase unit.
        price_per_unit: Math.round(found.price * (usesPurchaseUnit ? conversion : 1) * 10000) / 10000,
        purchase_uom: usesPurchaseUnit ? found.item.purchase_uom! : found.item.uom,
        ...(usesPurchaseUnit ? { purchase_uom_conversion_rate: conversion } : {}),
        arrival_date: arrival,
      });
    }

    const user = await currentUser();
    const who = user?.fullName || user?.primaryEmailAddress?.emailAddress || 'dashboard user';
    const n = await nextPurchaseOrderNumber();
    const po = await createPurchaseOrder({
      order_no: `PO-${n} ${supplier.name} ${location}`,
      supplier_id: supplier.id,
      location_id: k.locationId,
      expected_arrival_date: arrival,
      additional_info: `Created from the Department Dashboard Inventory tab by ${who} on ${new Date().toISOString().slice(0, 10)}. Needed by the week of ${body.needBy}.`,
      purchase_order_rows: poRows,
    });

    // New "on order" quantities should drop these items off the order list now.
    revalidateTag(KATANA_STOCK_TAG, { expire: 0 });
    return NextResponse.json({ id: po.id, orderNo: po.order_no, total: po.total });
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 502 });
  }
}
