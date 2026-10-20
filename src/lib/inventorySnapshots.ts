/**
 * The last successful /api/design-inventory response per location, saved in
 * Supabase (pf_inventory_snapshots). The Inventory tab shows it immediately
 * while a fresh one builds, and keeps showing it if that refresh fails.
 * Only successful builds are saved, so a failure never replaces it.
 */
import { supabase } from '@/lib/supabase';

const TABLE = 'pf_inventory_snapshots';

export async function saveSnapshot(location: string, payload: { generatedAt: string }): Promise<void> {
  const { error } = await supabase
    .from(TABLE)
    .upsert({ location, payload, generated_at: payload.generatedAt }, { onConflict: 'location' });
  if (error) console.warn(`${TABLE} save failed:`, error.message);
}

export async function loadSnapshot<T>(location: string): Promise<T | null> {
  const { data, error } = await supabase.from(TABLE).select('payload').eq('location', location).maybeSingle();
  if (error) { console.warn(`${TABLE} unavailable:`, error.message); return null; }
  return (data?.payload as T) ?? null;
}
