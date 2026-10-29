export class ReportingDeferredError extends Error {}

/** Best-effort per-process reporting budget, not a fleet-wide database limit.
 * Hold the slot through body consumption; stop new work after upstream overload.
 */
export function createReportingFetch(fetchImpl: typeof fetch, options: {
  concurrency?: number; queueLimit?: number; timeoutMs?: number; cooldownMs?: number;
} = {}): typeof fetch {
  const limit = options.concurrency ?? 1;
  const queueLimit = options.queueLimit ?? 32;
  const timeoutMs = options.timeoutMs ?? 10000;
  const cooldownMs = options.cooldownMs ?? 60000;
  let active = 0, blockedUntil = 0;
  const waiting: Array<() => void> = [];
  return async (input, init) => {
    if (Date.now() < blockedUntil) throw new ReportingDeferredError('PF reporting paused while the core API recovers.');
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    if (active >= limit) {
      if (waiting.length >= queueLimit) throw new ReportingDeferredError('PF reporting queue is full.');
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { const i = waiting.indexOf(wake); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
        waiting.push(wake);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      // The completing request hands its occupied slot to this waiter.
    } else active++;
    try {
      signal.throwIfAborted();
      if (Date.now() < blockedUntil) throw new ReportingDeferredError('PF reporting paused while the core API recovers.');
      const response = await fetchImpl(input, { ...init, signal });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = Number(retryAfter);
        const retryMs = retryAfter == null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(cooldownMs, Math.min(300000, retryMs || 0)));
      }
      const body = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (error) {
      // Caller cancellation is not evidence of upstream overload.
      if (!init?.signal?.aborted) {
        blockedUntil = Math.max(blockedUntil, Date.now() + cooldownMs);
        throw new ReportingDeferredError('PF reporting request failed or timed out; refresh deferred.');
      }
      throw error;
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}
export const reportingFetch = createReportingFetch((input, init) => fetch(input, init));
