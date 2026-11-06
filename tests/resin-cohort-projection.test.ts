import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectResinCohorts } from '../src/lib/resinCohortProjection.ts';

const horizon = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
const recentFrom = '2026-09-07';

test('a far-future order does not stop the weeks before it being projected', () => {
  const rows = projectResinCohorts(
    [{ weekOf: '2026-10-26', units: 100 }, { weekOf: '2027-10-04', units: 1 }],
    horizon,
    recentFrom,
  );
  assert.deepEqual(rows.map(r => r.weekOf), ['2026-10-26', '2026-11-09', '2026-11-16', '2026-11-23', '2027-10-04']);
  assert.deepEqual(rows.slice(1, 4).map(r => [r.units, r.estimated]), [[100, true], [100, true], [100, true]]);
  assert.deepEqual(rows[4], { weekOf: '2027-10-04', units: 1, estimated: false });
});

test('a sparse future week inside the horizon is topped up to the average', () => {
  const rows = projectResinCohorts(
    [{ weekOf: '2026-10-26', units: 100 }, { weekOf: '2026-11-16', units: 1 }],
    horizon,
    recentFrom,
  );
  assert.deepEqual(rows.find(r => r.weekOf === '2026-11-16'), { weekOf: '2026-11-16', units: 100, estimated: true });
});

test('a future week already booked past the average keeps its real count', () => {
  const rows = projectResinCohorts(
    [{ weekOf: '2026-10-26', units: 100 }, { weekOf: '2026-11-16', units: 150 }],
    horizon,
    recentFrom,
  );
  assert.deepEqual(rows.find(r => r.weekOf === '2026-11-16'), { weekOf: '2026-11-16', units: 150, estimated: false });
});

test('the average skips the partial current week, future bookings and older weeks', () => {
  const rows = projectResinCohorts(
    [
      { weekOf: '2026-08-31', units: 900 },
      { weekOf: '2026-10-19', units: 110 },
      { weekOf: '2026-10-26', units: 130 },
      { weekOf: '2026-11-02', units: 46 },
      { weekOf: '2027-10-04', units: 1 },
    ],
    horizon,
    recentFrom,
  );
  assert.equal(rows.find(r => r.weekOf === '2026-11-09')?.units, 120);
});

test('the current week stays real even when it is below the average', () => {
  const rows = projectResinCohorts(
    [{ weekOf: '2026-10-26', units: 100 }, { weekOf: '2026-11-02', units: 46 }],
    horizon,
    recentFrom,
  );
  assert.deepEqual(rows.find(r => r.weekOf === '2026-11-02'), { weekOf: '2026-11-02', units: 46, estimated: false });
});

test('nothing is projected without a completed recent week to average', () => {
  const cohorts = [{ weekOf: '2026-11-02', units: 46 }, { weekOf: '2027-10-04', units: 1 }];
  assert.deepEqual(
    projectResinCohorts(cohorts, horizon, recentFrom),
    cohorts.map(c => ({ ...c, estimated: false })),
  );
});
