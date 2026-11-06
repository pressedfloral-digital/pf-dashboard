import { supabase } from '@/lib/supabase';
import { DEFAULT_BLOOM_STOCK_ROSTER, type BloomStockMember, type BloomStockType } from '@/lib/bloomStock';

// Server-only. Who Bloom Stock orders are auto-assigned to — Mia for
// recreations, Jen for everything else. Matched by first name against the
// Utah Bloom Stock roster so the assignee is the exact roster name the
// Orders board dropdown uses.
export async function bloomStockAutoAssignee(): Promise<(type: BloomStockType) => string> {
  const { data } = await supabase.from('schedule_settings').select('value')
    .eq('location', 'Utah').eq('key', 'bloomStockRoster').maybeSingle();
  const roster: BloomStockMember[] = Array.isArray(data?.value) ? data.value as BloomStockMember[] : DEFAULT_BLOOM_STOCK_ROSTER;
  const find = (first: RegExp, fallback: string) =>
    roster.map(m => m.name?.trim()).find(n => n && first.test(n)) ?? fallback;
  const mia = find(/^mia\b/i, 'Mia Legas Boots');
  const jen = find(/^jen/i, 'Jennika Merrill');
  return type => (type === 'recreation' ? mia : jen);
}
