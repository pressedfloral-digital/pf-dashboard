import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/lib/')) return { url: new URL(`../src/lib/${specifier.slice(6)}.ts`, import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });

// Resin counts only in Resin: credits the batch gives for resin pieces are
// subtracted from Preservation, Design and Fulfillment.
test('resin pieces are taken back out of department counts', async () => {
  process.env.PF_API_URL = 'https://test.invalid';
  process.env.PF_API_EMAIL = 'test@example.com';
  process.env.PF_API_PASSWORD = 'test-only';
  const originalFetch = globalThis.fetch;
  const resinPieces = [
    { uuid: 'r1', workflowProfile: 'resinSendMyOwn', assignedToUserUuid: 'a' },                         // design only
    { uuid: 'r2', workflowProfile: 'resinRecreation', assignedToUserUuid: 'a', fulfillmentUserUuid: 'a' }, // designed and packed
    { uuid: 'r3', workflowProfile: 'resinSendMyOwn', preservationUserUuid: 'z' },                         // someone not asked about
  ];
  const lists = {
    '2026-11-03': [resinPieces[0], { uuid: 'frame', workflowProfile: 'standardPreservation', assignedToUserUuid: 'a' }],
    '2026-11-04': [resinPieces[1]],
    '2026-11-06': [resinPieces[1]],
  };
  // r2's history: design handed to a on the 4th, packing on the 6th.
  const r2History = [
    { dateCreated: '2026-11-03T21:00:00Z', assignedToUserUuid: null, fulfillmentUserUuid: null },
    { dateCreated: '2026-11-04T23:37:26Z', assignedToUserUuid: 'a', fulfillmentUserUuid: null },
    { dateCreated: '2026-11-06T18:00:00Z', assignedToUserUuid: 'a', fulfillmentUserUuid: 'a' },
  ];
  const searched = [];
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path === '/Authentication/Login') return Response.json({ jwt: 'test-only' });
    if (path === '/User/WithRole') return Response.json({ items: [
      { uuid: 'a', firstName: 'Chloe', lastName: 'Leonard' },
      { uuid: 'b', firstName: 'Chloe', lastName: 'Jensen' },
    ] });
    if (path === '/OrderProducts/Details/r2') return Response.json({ history: r2History });
    const body = JSON.parse(String(options?.body));
    if (path === '/OrderProducts/Search') {
      searched.push(body.workflowFamily);
      return Response.json({ items: resinPieces, totalPages: 1 });
    }
    if (path.endsWith('/Batch')) return Response.json({ refreshedAt: '2026-11-09T20:00:00Z', rows: body.userUuids.flatMap(userUuid =>
      Array.from({ length: 7 }, (_, i) => ({ userUuid, date: `2026-11-0${2 + i}`,
        design: userUuid === 'a' ? 2 : 0, preservation: userUuid === 'a' ? 1 : 0, fulfillment: userUuid === 'a' ? 1 : 0 }))) });
    assert.equal(path, '/OrderProducts/ForUser');
    return Response.json({ items: lists[body.startDate.slice(0, 10)] ?? [], totalPages: 1 });
  };
  try {
    const { computeDailyAssignmentCounts, computeWeeklyActualCounts } = await import('../src/lib/assignment-counts.ts');
    const daily = await computeDailyAssignmentCounts('2026-11-02', '2026-11-08', ['Chloe Jensen']);
    const days = daily.rows[0].days;
    assert.deepEqual(searched, ['resin']);
    assert.deepEqual(days['2026-11-03'], { design: 1, preservation: 1, fulfillment: 1 }); // r1 out, the frame stays
    assert.deepEqual(days['2026-11-04'], { design: 1, preservation: 1, fulfillment: 1 }); // r2's design
    assert.deepEqual(days['2026-11-06'], { design: 2, preservation: 1, fulfillment: 0 }); // r2's packing
    assert.deepEqual(days['2026-11-05'], { design: 2, preservation: 1, fulfillment: 1 }); // untouched

    const weekly = await computeWeeklyActualCounts('2026-11-02', '2026-11-08');
    const row = weekly.rows.find(r => r.staff === 'Chloe Jensen');
    assert.deepEqual(row.counts, { design: 12, preservation: 7, fulfillment: 6 });
  } finally { globalThis.fetch = originalFetch; }
});
