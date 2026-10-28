import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportingFetch } from '../src/lib/pf-budget.ts';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
test('bounds simultaneous upstream requests and includes body consumption', async () => {
  let active = 0, maximum = 0;
  const limited = createReportingFetch(async () => {
    active++; maximum = Math.max(maximum, active);
    return new Response(new ReadableStream({ start(controller) {
      setTimeout(() => { active--; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); }, 5);
    }}));
  }, { concurrency: 2, timeoutMs: 1000 });
  await Promise.all(Array.from({ length: 12 }, () => limited('https://pf.test')));
  assert.equal(maximum, 2); assert.equal(active, 0);
});
test('overload stops queued work and does not retry; resumes after cooldown', async () => {
  let calls = 0;
  const limited = createReportingFetch(async () => { calls++; await wait(5); return new Response('{}', { status: calls === 1 ? 503 : 200 }); }, { concurrency: 1, cooldownMs: 20 });
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => limited('https://pf.test')));
  assert.equal(calls, 1); assert.equal(outcomes.filter(x => x.status === 'rejected').length, 4);
  await wait(30); assert.equal((await limited('https://pf.test')).status, 200);
});
test('request timeout aborts upstream and queued jobs expire without dispatch', async () => {
  let calls = 0;
  const limited = createReportingFetch(async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }, { concurrency: 1, timeoutMs: 15 });
  const keepAlive = setTimeout(() => {}, 100);
  const outcomes = await Promise.allSettled([limited('https://pf.test'), limited('https://pf.test')]);
  clearTimeout(keepAlive);
  assert.equal(calls, 1); assert.ok(outcomes.every(x => x.status === 'rejected'));
});
test('full queue rejects promptly; completed requests release slots', async () => {
  let finish!: () => void;
  const limited = createReportingFetch(async () => { await new Promise<void>(r => { finish = r; }); return new Response('{}'); }, { concurrency: 1, queueLimit: 0 });
  const first = limited('https://pf.test');
  await assert.rejects(limited('https://pf.test'), /queue is full/);
  finish(); await first;
});
test('honors Retry-After and does not retry mutation requests', async () => {
  let calls = 0;
  const limited = createReportingFetch(async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '1' } }); }, { cooldownMs: 1 });
  await limited('https://pf.test', { method: 'POST' }); await wait(5);
  await assert.rejects(limited('https://pf.test'), /paused/); assert.equal(calls, 1);
});
