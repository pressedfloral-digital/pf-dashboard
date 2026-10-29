import { randomUUID } from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { completeSnapshot, RefreshDeferredError, type RefreshStore } from '@/lib/report-refresh';

function store<T>(key: string, leaseSeconds: number): RefreshStore<T> {
  return {
    async read() {
      const { data, error } = await supabase.from('pf_reporting_refreshes').select('payload,completed_at').eq('key', key).maybeSingle();
      if (error) throw new RefreshDeferredError('Reporting refresh storage unavailable; refresh deferred.');
      return data?.completed_at && data.payload !== null ? { value: data.payload as T, completedAt: data.completed_at as string } : null;
    },
    async claim(owner) {
      const { data, error } = await supabase.rpc('claim_pf_reporting_refresh', { p_key: key, p_owner: owner, p_seconds: leaseSeconds });
      if (error) throw new RefreshDeferredError('Reporting refresh lock unavailable; refresh deferred.');
      return data === true;
    },
    async publish(owner, value) {
      const { data, error } = await supabase.rpc('publish_pf_reporting_refresh', { p_key: key, p_owner: owner, p_payload: value });
      if (error) throw new RefreshDeferredError('Reporting snapshot could not be saved.');
      return data === true;
    },
    async release(owner) {
      const { error } = await supabase.rpc('release_pf_reporting_refresh', { p_key: key, p_owner: owner });
      // Expiring lease is the fallback; do not mask a successful publish.
      if (error) console.warn('Reporting lease release failed; lease will expire.');
    },
  };
}
export function sharedReportSnapshot<T>(key: string, load: () => Promise<T>) {
  return completeSnapshot(store<T>(key, 180), load, { owner: randomUUID(), maxAgeMs: 30 * 60_000 });
}
export async function withReportingRefreshLease<T>(key: string, work: () => Promise<T>): Promise<T> {
  const lease = store<never>(key, 300), owner = randomUUID();
  if (!await lease.claim(owner)) throw new RefreshDeferredError('This refresh is already running; work deferred.');
  try { return await work(); } finally { await lease.release(owner); }
}
