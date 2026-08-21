import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { computeProductionCounts } from '@/lib/production-counts';
import { supabase } from '@/lib/supabase';

export const maxDuration = 300;

// One-time diagnostic: compares the automated production-count logic against
// whatever managers have already entered by hand in team_member_week_actuals,
// for recent completed weeks. Purely read-only — confirms the two sources
// agree before the automated sync (cron/sync-production-actuals) goes live.
// Hit: /api/debug/validate-production-sync?weeks=8

const DEPT_KEYS = ['Preservation', 'Design', 'Fulfillment'] as const;
const ACTUALS_DEPT: Record<(typeof DEPT_KEYS)[number], string> = {
  Preservation: 'preservation',
  Design:       'design',
  Fulfillment:  'fulfillment',
};

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function mondayOf(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

interface RowResult {
  weekOf: string;
  department: string;
  member: string;
  manual: number | null;
  auto: number | null;
  status: 'match' | 'mismatch' | 'auto_only' | 'manual_only';
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const numWeeks = parseInt(req.nextUrl.searchParams.get('weeks') ?? '8', 10);
  const today = new Date();
  const thisMonday = mondayOf(today);

  const weeks: { start: string; end: string }[] = [];
  for (let i = 1; i <= numWeeks; i++) {
    const mon = new Date(thisMonday);
    mon.setDate(mon.getDate() - i * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    weeks.push({ start: isoDate(mon), end: isoDate(sun) });
  }

  try {
    const { data: manualRows, error } = await supabase
      .from('team_member_week_actuals')
      .select('department, week_of, member_name, actual_orders')
      .gte('week_of', weeks[weeks.length - 1].start)
      .lte('week_of', weeks[0].start);
    if (error) throw error;

    const rows: RowResult[] = [];

    for (const { start, end } of weeks) {
      const computed = await computeProductionCounts(start, end);
      const weekOf = start;

      for (const dept of DEPT_KEYS) {
        const actualsDept = ACTUALS_DEPT[dept];
        const manualForWeek = (manualRows ?? []).filter(
          r => r.week_of === weekOf && r.department === actualsDept
        );
        const computedForWeek = computed[dept];

        const names = new Set([
          ...manualForWeek.map(r => r.member_name),
          ...computedForWeek.map(r => r.staff),
        ]);

        for (const name of names) {
          const manual = manualForWeek.find(r => r.member_name === name)?.actual_orders ?? null;
          const auto   = computedForWeek.find(r => r.staff === name)?.count ?? null;

          let status: RowResult['status'];
          if (manual !== null && auto !== null) status = manual === auto ? 'match' : 'mismatch';
          else if (auto !== null) status = 'auto_only';
          else status = 'manual_only';

          rows.push({ weekOf, department: dept, member: name, manual, auto, status });
        }
      }
    }

    const summary = {
      totalRows:  rows.length,
      matches:    rows.filter(r => r.status === 'match').length,
      mismatches: rows.filter(r => r.status === 'mismatch').length,
      autoOnly:   rows.filter(r => r.status === 'auto_only').length,
      manualOnly: rows.filter(r => r.status === 'manual_only').length,
    };

    return NextResponse.json({
      weeksChecked: weeks.map(w => w.start),
      summary,
      mismatches:  rows.filter(r => r.status === 'mismatch'),
      manualOnly:  rows.filter(r => r.status === 'manual_only'),
      autoOnly:    rows.filter(r => r.status === 'auto_only'),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
