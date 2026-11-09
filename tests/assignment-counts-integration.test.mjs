import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/lib/')) return { url: new URL(`../src/lib/${specifier.slice(6)}.ts`, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });

test('weekly roster makes one batch, sums duplicate accounts, shares overlapping loads and historical totals', async () => {
  process.env.PF_API_URL = 'https://test.invalid';
  process.env.PF_API_EMAIL = 'test@example.com';
  process.env.PF_API_PASSWORD = 'test-only';
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/Authentication/Login') return Response.json({ jwt: 'test-only' });
    if (path === '/User/WithRole') return Response.json({ items: [
      { uuid: 'a', firstName: 'Chloe', lastName: 'Leonard' },
      { uuid: 'b', firstName: 'Chloe', lastName: 'Jensen' },
    ] });
    assert.equal(path, '/OrderProducts/ForUser/Counts/Batch', 'must never fall back to count/list fan-out');
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.userUuids, ['a','b']);
    return Response.json({ refreshedAt: '2026-10-27T20:00:00Z', rows: ['a','b'].flatMap(userUuid =>
      Array.from({ length: 7 }, (_, i) => ({ userUuid, date: `2026-10-${26+i}`.replace('2026-10-32','2026-11-01'),
        design: userUuid === 'a' ? 2 : 3, preservation: 0, fulfillment: 1 }))) });
  };
  try {
    const { computeDailyAssignmentCounts, computeAssignmentCounts } = await import('../src/lib/assignment-counts.ts');
    const results = await Promise.all(Array.from({ length: 20 }, () =>
      computeDailyAssignmentCounts('2026-10-26', '2026-11-01', ['Chloe Jensen', 'Unknown'])));
    assert.equal(paths.filter(p => p === '/User/WithRole').length, 1);
    assert.equal(paths.filter(p => p.endsWith('/Batch')).length, 1);
    assert.deepEqual(results[0].unmatched, ['Unknown']);
    assert.deepEqual(results[0].rows[0].days['2026-10-26'], { design: 5, preservation: 0, fulfillment: 2 });
    const weekly = await computeAssignmentCounts('2026-10-26','2026-11-01',['Chloe Jensen']);
    assert.deepEqual(weekly.rows[0].counts, { design: 35, preservation: 0, fulfillment: 14 });
    assert.equal(paths.filter(p => p.endsWith('/Batch')).length, 1);
    assert.equal(results[0].refreshedAt, '2026-10-27T20:00:00Z');
  } finally { globalThis.fetch = originalFetch; }
});

test('weekly actuals add fulfilled recreations to Fulfillment only', async () => {
  process.env.PF_API_URL = 'https://test.invalid';
  process.env.PF_API_EMAIL = 'test@example.com';
  process.env.PF_API_PASSWORD = 'test-only';
  const originalFetch = globalThis.fetch;
  const recreation = (uuid, stages) => ({ uuid, productTitle: 'Bloom Arrangement Recreation', ...stages });
  const history = { // Multi-stage products: credited only if packaged this week.
    packagedThisWeek: [{ status: 'ReadyToPackage', effectiveAt: '2026-11-04T12:00:00Z', isStatusTransition: true }],
    packagedLastWeek: [{ status: 'ReadyToPackage', effectiveAt: '2026-10-28T12:00:00Z', isStatusTransition: true }],
  };
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === '/Authentication/Login') return Response.json({ jwt: 'test-only' });
    if (path === '/User/WithRole') return Response.json({ items: [
      { uuid: 'a', firstName: 'Chloe', lastName: 'Leonard' },
      { uuid: 'b', firstName: 'Chloe', lastName: 'Jensen' },
    ] });
    if (path.startsWith('/OrderProducts/Details/')) return Response.json({ history: history[path.split('/').pop()] });
    const body = JSON.parse(String(options?.body));
    if (path.endsWith('/Batch')) return Response.json({ refreshedAt: '2026-11-09T20:00:00Z', rows: body.userUuids.flatMap(userUuid =>
      Array.from({ length: 7 }, (_, i) => ({ userUuid, date: `2026-11-0${2 + i}`, design: 1, preservation: 1, fulfillment: 1 }))) });
    assert.equal(path, '/OrderProducts/ForUser');
    const items = body.startDate.startsWith('2026-11-03') || body.startDate.startsWith('2026-11-04') ? [
      recreation('singleStage', { fulfillmentUserUuid: 'a' }), // listed on two days, counted once
      recreation('packagedThisWeek', { fulfillmentUserUuid: 'a', assignedToUserUuid: 'a' }),
      recreation('packagedLastWeek', { fulfillmentUserUuid: 'a', assignedToUserUuid: 'a' }),
      recreation('someoneElseFulfilled', { fulfillmentUserUuid: 'z', assignedToUserUuid: 'a' }),
      { uuid: 'frame', productTitle: 'Pressed Frame', fulfillmentUserUuid: 'a' }, // already in the batch count
    ] : [];
    return Response.json({ items, totalPages: 1 });
  };
  try {
    const { computeWeeklyActualCounts } = await import('../src/lib/assignment-counts.ts');
    const weekly = await computeWeeklyActualCounts('2026-11-02', '2026-11-08');
    const row = weekly.rows.find(r => r.staff === 'Chloe Jensen');
    // Two accounts x 7 days from the batch, plus the two recreations credited here.
    assert.deepEqual(row.counts, { design: 14, preservation: 14, fulfillment: 16 });
  } finally { globalThis.fetch = originalFetch; }
});
