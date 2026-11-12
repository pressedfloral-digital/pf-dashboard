// Supabase/Postgrest errors are plain {message, details, hint, code} objects,
// not Error instances, so String(err) on one gives "[object Object]". This
// pulls a readable message off whichever shape was thrown.
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof e.message === 'string' && e.message) {
      const extra = [e.code, e.details, e.hint].filter(v => typeof v === 'string' && v).join(' | ');
      return extra ? `${e.message} (${extra})` : e.message;
    }
    try { return JSON.stringify(err); } catch { /* fall through */ }
  }
  return String(err);
}
