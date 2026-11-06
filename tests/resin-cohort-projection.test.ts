import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectResinCohorts, resinIntakeWeek, resinShareOfBouquets } from '../src/lib/resinCohortProjection.ts';

const horizon = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
const estimates = { '2026-11-09': 30, '2026-11-16': 100, '2026-11-23': 60 };

test('a far-future order does not stop the weeks before it being projected', () => {
  const rows = projectResinCohorts(
    [{ weekOf: '2026-10-26', units: 111 }, { weekOf: '2027-10-04', units: 1 }],
    horizon,
    estimates,
  );
  assert.deepEqual(rows.map(r => r.weekOf), ['2026-10-26', '2026-11-09', '2026-11-16', '2026-11-23', '2027-10-04']);
  assert.deepEqual(rows[4], { weekOf: '2027-10-04', units: 1, estimated: false });
});

test('estimated weeks follow the seasonal forecast instead of a flat number', () => {
  const rows = projectResinCohorts([], horizon, estimates);
  assert.deepEqual(rows.map(r => [r.units, r.estimated]), [[30, true], [100, true], [60, true]]);
});

test('a sparse future week is topped up to its estimate', () => {
  const rows = projectResinCohorts([{ weekOf: '2026-11-16', units: 1 }], horizon, estimates);
  assert.deepEqual(rows.find(r => r.weekOf === '2026-11-16'), { weekOf: '2026-11-16', units: 100, estimated: true });
});

test('a future week booked past its estimate keeps its real count', () => {
  const rows = projectResinCohorts([{ weekOf: '2026-11-16', units: 150 }], horizon, estimates);
  assert.deepEqual(rows.find(r => r.weekOf === '2026-11-16'), { weekOf: '2026-11-16', units: 150, estimated: false });
});

test('the current week stays real even with an estimate above it', () => {
  const rows = projectResinCohorts(
    [{ weekOf: '2026-11-02', units: 46 }],
    horizon,
    { ...estimates, '2026-11-02': 120 },
  );
  assert.deepEqual(rows.find(r => r.weekOf === '2026-11-02'), { weekOf: '2026-11-02', units: 46, estimated: false });
});

test('without a forecast only real cohorts are shown', () => {
  const cohorts = [{ weekOf: '2026-11-02', units: 46 }];
  assert.deepEqual(projectResinCohorts(cohorts, horizon, {}), [{ ...cohorts[0], estimated: false }]);
});

test('share totals the weeks, so a lumpy week does not swing it', () => {
  const share = resinShareOfBouquets(
    { a: 30, b: 189 },
    { a: 100, b: 505 },
    ['a', 'b'],
  );
  assert.equal(share, 219 / 605);
});

test('share skips weeks with no bouquet count and weeks outside the window', () => {
  const share = resinShareOfBouquets(
    { a: 30, missing: 500, zero: 500, older: 999 },
    { a: 100, zero: 0, older: 100 },
    ['a', 'missing', 'zero'],
  );
  assert.equal(share, 0.3);
});

test('share is null when there is nothing to compare', () => {
  assert.equal(resinShareOfBouquets({}, { a: 100 }, ['a']), null);
  assert.equal(resinShareOfBouquets({ a: 5 }, {}, ['a']), null);
});

test('intake week is the Monday of the week containing event date + 4 days', () => {
  // Saturday Oct 3 + 4 days = Wednesday Oct 7, in the week of Monday Oct 5.
  assert.equal(resinIntakeWeek({ event_date: '2026-10-03', order_date: '2026-01-15' }), '2026-10-05');
});

test('intake week falls back to the order date, then to null', () => {
  assert.equal(resinIntakeWeek({ event_date: null, order_date: '2026-10-07' }), '2026-10-05');
  assert.equal(resinIntakeWeek({ event_date: null, order_date: null }), null);
});
