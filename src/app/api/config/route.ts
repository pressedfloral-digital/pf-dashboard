import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAccess, forbidden } from '@/lib/routeAccess';
import { canEditCompanyData } from '@/lib/permissions';

export async function POST(req: NextRequest) {
  const access = await getAccess();
  if (access instanceof NextResponse) return access;
  // dashboard_config holds company-wide values (e.g. the design anchor week).
  if (!canEditCompanyData(access.role)) return forbidden('Only admins and general managers can change dashboard config');

  const { key, value } = await req.json();
  if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });

  const { error } = await supabase
    .from('dashboard_config')
    .upsert({ key, value }, { onConflict: 'key' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
