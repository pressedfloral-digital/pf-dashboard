import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/lib/')) return { url: new URL(`../src/lib/${specifier.slice(6)}.ts`, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
test('15-month bulk scans finish serially; overload stops scan and never reconciles partial snapshot', async () => {
  Object.assign(process.env, { PF_API_URL: 'https://pf.test', PF_API_EMAIL: 'fixture@example.test', PF_API_PASSWORD: 'fixture', NEXT_PUBLIC_SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture' });
  const previous = globalThis.fetch;
  let calls = 0, active = 0, maximum = 0, failAt = Infinity, dbCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'db.test') { dbCalls++; throw new Error('must not write partial data'); }
    if (url.pathname === '/Authentication/Login') return Response.json({ jwt: 'fixture' });
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(r => setTimeout(r, 2)); active--;
    return calls === failAt ? new Response('{}', { status: 503, headers: { 'Retry-After': '10' } }) : Response.json([{ status: 'fixture', orderNumber: 'fixture', uuid: 'fixture' }]);
  };
  try {
    const { pfGetAll } = await import('../src/lib/pf-api.ts');
    const paths = Array.from({ length: 15 }, (_, m) => `/OrderProducts/WeeklyReport?month=${m}`);
    const [a, b] = await Promise.all([pfGetAll(paths), pfGetAll(paths)]);
    assert.equal(a.length, 15); assert.deepEqual(a, b);
    assert.equal(maximum, 1); assert.equal(calls, 15, 'identical overlapping requests share a flight');
    failAt = calls + 3;
    await assert.rejects(pfGetAll(paths), /deferred/);
    assert.equal(calls, 18, 'no later months and no retries after overload');
    const { runStatusSnapshot } = await import('../src/lib/status-snapshot.ts');
    await assert.rejects(runStatusSnapshot(), /paused/);
    assert.equal(dbCalls, 0, 'incomplete scan cannot delete or upsert snapshot rows');
  } finally { globalThis.fetch = previous; }
});
