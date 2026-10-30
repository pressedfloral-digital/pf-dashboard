/** Refresh orchestration; storage must atomically fence owners across processes. */
export interface RefreshStore<T> {
  read(): Promise<{ value: T; completedAt: string } | null>;
  claim(owner: string): Promise<boolean>;
  publish(owner: string, value: T): Promise<boolean>;
  release(owner: string): Promise<void>;
}
export class RefreshDeferredError extends Error {}
export async function completeSnapshot<T>(store: RefreshStore<T>, load: () => Promise<T>, options: {
  owner: string; maxAgeMs: number; now?: () => number;
}): Promise<{ value: T; completedAt: string }> {
  const now = options.now ?? Date.now;
  const fresh = (x: { completedAt: string } | null) => x && now() - Date.parse(x.completedAt) < options.maxAgeMs;
  const prior = await store.read();
  if (prior && fresh(prior)) return prior;
  if (!await store.claim(options.owner)) throw new RefreshDeferredError('Report refresh already running. Last complete report is preserved.');
  try {
    // A previous owner may have published between the read and claim.
    const latest = await store.read();
    if (latest && fresh(latest)) return latest;
    const value = await load();
    if (!await store.publish(options.owner, value)) throw new RefreshDeferredError('Report refresh lease expired. Last complete report is preserved.');
    return { value, completedAt: new Date(now()).toISOString() };
  } finally { await store.release(options.owner); }
}
