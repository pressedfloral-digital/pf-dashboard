import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationHours } from '../src/lib/durationHours.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('reads clock-time durations', () => {
  close(parseDurationHours('8:39'), 8 + 39 / 60);
  close(parseDurationHours('0:45'), 0.75);
  close(parseDurationHours('8:30:00'), 8.5);
  close(parseDurationHours(' 10:05 '), 10 + 5 / 60);
});

test('still reads decimals', () => {
  close(parseDurationHours('8.65'), 8.65);
  close(parseDurationHours(7.25), 7.25);
});

test('reads time-formatted cells parsed as dates', () => {
  close(parseDurationHours(new Date(1899, 11, 30, 8, 39, 0)), 8 + 39 / 60);
});

test('returns 0 for blanks and junk', () => {
  assert.equal(parseDurationHours(''), 0);
  assert.equal(parseDurationHours(null), 0);
  assert.equal(parseDurationHours('n/a'), 0);
});
