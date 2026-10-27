/** One refresh at a time. Cancellation stops scheduling, not shared in-flight work. */
export function pollAfterCompletion(load: () => Promise<void>, delayMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function run() {
    try { await load(); }
    finally { if (!stopped) timer = setTimeout(() => { void run(); }, delayMs); }
  }
  void run();
  return () => { stopped = true; clearTimeout(timer); };
}
