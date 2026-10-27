import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignmentDates, validateBatch, sumCounts, createSingleFlight } from '../src/lib/assignment-batch.ts';
import { pollAfterCompletion } from '../src/lib/poll-after-completion.ts';

const day = '2026-10-26';
const refreshedAt = '2026-10-27T20:00:00Z';
test('calendar validation rejects normalized, reversed and oversized dates', () => {
  assert.equal(assignmentDates(day, '2026-11-01').length, 7);
  for (const [start, end] of [['2026-02-30','2026-03-01'], [day,'2026-10-25'],[day,'2026-11-02'],['bad', day]])
    assert.throws(() => assignmentDates(start, end));
});
test('complete matrix sums duplicate accounts and preserves explicit zero', () => {
  const rows = [
    { userUuid: 'A', date: day, preservation: 2, design: 0, fulfillment: 3 },
    { userUuid: 'b', date: day, preservation: 4, design: 1, fulfillment: 0 },
  ];
  const counts = validateBatch({ rows, refreshedAt }, ['a','b'], [day]);
  assert.deepEqual(sumCounts([...counts.values()]), { preservation: 6, design: 1, fulfillment: 3 });
  assert.equal(counts.get(`a/${day}`)?.design, 0);
  assert.throws(() => validateBatch({ rows: rows.slice(0,1), refreshedAt }, ['a','b'], [day]));
  assert.throws(() => validateBatch({ rows: [rows[0], rows[0]], refreshedAt }, ['a','b'], [day]));
  assert.throws(() => validateBatch({ rows: [{ ...rows[0], design: -1 }], refreshedAt }, ['a'], [day]));
});
test('concurrent refreshes share a single request and original freshness', async () => {
  const flight = createSingleFlight<{ refreshedAt: string }>(1000);
  let calls = 0;
  const load = async () => { calls++; return { refreshedAt }; };
  const results = await Promise.all(Array.from({ length: 40 }, () => flight('roster/week', load)));
  assert.equal(calls, 1);
  assert.ok(results.every(value => value.refreshedAt === refreshedAt));
  await flight('roster/week', load);
  assert.equal(calls, 1);
});
test('failed responses do not poison cache or return fabricated zeros', async () => {
  const flight = createSingleFlight<number>(1000);
  await assert.rejects(flight('key', async () => { throw new Error('offline'); }));
  assert.equal(await flight('key', async () => 7), 7);
});
test('different scopes are independent and pending cache capacity is bounded', async () => {
  const flight = createSingleFlight<number>(1000, 1);
  let finish!: (value: number) => void;
  const pending = flight('week1', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(flight('week2', async () => 2));
  finish(1);
  await pending;
  assert.equal(await flight('week2', async () => 2), 2);
});
test('poll never starts a second refresh while first is pending and cleanup stops it', async () => {
  let calls = 0;
  let finish!: () => void;
  const stop = pollAfterCompletion(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, 5);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 1);
  finish();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 2);
  stop();
  finish();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(calls, 2);
});
