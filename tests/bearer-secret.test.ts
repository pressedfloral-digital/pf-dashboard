import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBearerSecret, secretMatches } from '../src/lib/bearerSecret.ts';

test('a missing secret never matches', () => {
  assert.equal(hasBearerSecret('Bearer undefined', undefined), false);
  assert.equal(hasBearerSecret('Bearer ', ''), false);
  assert.equal(hasBearerSecret(null, undefined), false);
  assert.equal(secretMatches(null, undefined), false);
  assert.equal(secretMatches('', ''), false);
});

test('a configured secret matches only itself', () => {
  assert.equal(hasBearerSecret('Bearer s3cret', 's3cret'), true);
  assert.equal(hasBearerSecret('Bearer wrong', 's3cret'), false);
  assert.equal(hasBearerSecret('s3cret', 's3cret'), false);
  assert.equal(secretMatches('s3cret', 's3cret'), true);
});
