import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabase } from '@/lib/supabase';

// GET /api/admin/rate-history?location=Utah
// Returns every dated pay-rate entry for a location (all departments) so
// clients can look up what someone's rate was as of a given week, rather
// than only ever seeing the current value. See src/lib/rateHistorySync.ts
// for how rows get written.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const location = req.nextUrl.searchParams.get('location');
  if (!location) return NextResponse.json({ error: 'location is required' }, { status: 400 });

  try {
    const { data, error } = await supabase
      .from('employee_rate_history')
      .select('full_name,location,department,pay_type,hourly_rate,annual_salary,effective_date')
      .eq('location', location)
      .order('effective_date', { ascending: true });
    if (error) throw error;
    return NextResponse.json({ ok: true, history: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
