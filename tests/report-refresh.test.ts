import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeSnapshot, type RefreshStore } from '../src/lib/report-refresh.ts';

function fixture() {
  let value: { value: number[]; completedAt: string } | null = { value: [9], completedAt: new Date(0).toISOString() };
  let owner: string | null = null;
  const storage: RefreshStore<number[]> = {
    async read() { return value; },
    async claim(id) { if (owner) return false; owner = id; return true; },
    async publish(id, next) { if (owner !== id) return false; value = { value: next, completedAt: new Date(10_000).toISOString() }; return true; },
    async release(id) { if (owner === id) owner = null; },
  };
  return { storage, value: () => value, expire: () => { owner = 'new-owner'; } };
}
const options = { owner: 'one', maxAgeMs: 1000, now: () => 10_000 };
test('overlapping processes refresh once and reuse only complete fresh data', async () => {
  const f = fixture(); let finish!: () => void, calls = 0;
  const loader = async () => { calls++; await new Promise<void>(r => { finish = r; }); return [1, 2, 3]; };
  const first = completeSnapshot(f.storage, loader, options);
  await new Promise(r => setImmediate(r));
  await assert.rejects(completeSnapshot(f.storage, loader, { ...options, owner: 'two' }), /already running/);
  assert.deepEqual(f.value()?.value, [9]);
  finish(); await first;
  const second = await completeSnapshot(f.storage, loader, { ...options, owner: 'two' });
  assert.deepEqual(second.value, [1, 2, 3]); assert.equal(calls, 1);
});
test('failed month preserves last complete snapshot and releases lease for next refresh', async () => {
  const f = fixture();
  await assert.rejects(completeSnapshot(f.storage, async () => { throw new Error('month 7 unavailable'); }, options), /month 7/);
  assert.deepEqual(f.value()?.value, [9]);
  await completeSnapshot(f.storage, async () => [1, 2], options);
  assert.deepEqual(f.value()?.value, [1, 2]);
});
test('expired owner cannot publish over a newer owner or release its lease', async () => {
  const f = fixture();
  await assert.rejects(completeSnapshot(f.storage, async () => { f.expire(); return [1]; }, options), /lease expired/);
  assert.deepEqual(f.value()?.value, [9]);
  assert.equal(await f.storage.claim('third'), false);
});
test('coordination unavailable fails closed without calling production API', async () => {
  const f = fixture(); let called = false;
  f.storage.claim = async () => { throw new Error('migration missing'); };
  await assert.rejects(completeSnapshot(f.storage, async () => { called = true; return []; }, options), /migration missing/);
  assert.equal(called, false);
});
