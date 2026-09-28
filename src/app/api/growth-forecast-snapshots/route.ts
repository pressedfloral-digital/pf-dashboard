import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

// GET /api/growth-forecast-snapshots
// Returns { snapshots: { [week_of]: { ut_pct, multiplier, captured_at } } }
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('growth_forecast_snapshots')
    .select('week_of, ut_pct, multiplier, captured_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const snapshots: Record<string, { ut_pct: number; multiplier: number; captured_at: string }> = {};
  (data ?? []).forEach(row => {
    snapshots[row.week_of] = { ut_pct: Number(row.ut_pct), multiplier: Number(row.multiplier), captured_at: row.captured_at };
  });
  return NextResponse.json({ snapshots });
}

// POST /api/growth-forecast-snapshots
// Body: { week_of, ut_pct, multiplier }
// Insert-once — an existing week is left untouched (see the migration).
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { week_of, ut_pct, multiplier } = await req.json() as { week_of?: string; ut_pct?: number; multiplier?: number };
  if (!week_of || !/^\d{4}-\d{2}-\d{2}$/.test(week_of) || typeof ut_pct !== 'number' || typeof multiplier !== 'number'
      || !Number.isFinite(ut_pct) || !Number.isFinite(multiplier)) {
    return NextResponse.json({ error: 'week_of, ut_pct and multiplier required' }, { status: 400 });
  }

  const { error } = await supabase
    .from('growth_forecast_snapshots')
    .upsert({ week_of, ut_pct, multiplier, captured_by: userId }, { onConflict: 'week_of', ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
