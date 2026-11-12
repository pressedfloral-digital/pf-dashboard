import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../src/lib/errorMessage.ts';

test('Error instances use their message', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
});

test('Supabase-style plain error objects are readable, not [object Object]', () => {
  const pg = { message: 'TypeError: fetch failed', details: 'socket hang up', hint: '', code: '' };
  assert.equal(errorMessage(pg), 'TypeError: fetch failed (socket hang up)');
  assert.equal(errorMessage({ message: 'relation missing', code: '42P01' }), 'relation missing (42P01)');
});

test('other values fall back to JSON or String', () => {
  assert.equal(errorMessage({ foo: 1 }), '{"foo":1}');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(undefined), 'undefined');
});
