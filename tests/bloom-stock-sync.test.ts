import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_SYNC_CREATED_BY, bloomStockKeyFromTitle, planBloomStockSync,
  type BloomStockDesignRow, type BloomStockExistingCompletion, type BloomStockShopifyOrder,
} from '../src/lib/bloomStock.ts';

const WEEK = '2026-10-26';
const row = (uuid: string, orderName: string, member = 'Mia Legas Boots', productKey: BloomStockDesignRow['productKey'] = 'recreation'): BloomStockDesignRow =>
  ({ orderProductUuid: uuid, orderName, productKey, member });
const order = (orderName: string, ...lines: [string, number, BloomStockDesignRow['productKey']?][]): BloomStockShopifyOrder => ({
  orderId: `id-${orderName}`, orderName,
  lines: lines.map(([lineItemId, quantity, productKey = 'recreation']) => ({ lineItemId, quantity, productKey })),
});
const prior = (over: Partial<BloomStockExistingCompletion>): BloomStockExistingCompletion => ({
  id: 'c1', line_item_id: 'L1', week_of: WEEK, member_name: 'Mia Legas Boots', units: 1, created_by: AUTO_SYNC_CREATED_BY, ...over,
});
const plan = (rows: BloomStockDesignRow[], orders: BloomStockShopifyOrder[], existing: BloomStockExistingCompletion[] = []) =>
  planBloomStockSync({ weekOf: WEEK, rows, orders, existing, resolvedMembers: ['Mia Legas Boots', 'Jennika Merrill'] });

test('PF titles map to bloom stock products; regular frames do not', () => {
  assert.equal(bloomStockKeyFromTitle('Custom Handprint Frame'), 'handprint');
  assert.equal(bloomStockKeyFromTitle('Custom Paw Print Frame'), 'pawprint');
  assert.equal(bloomStockKeyFromTitle('Custom Footprint Frame'), 'footprint');
  assert.equal(bloomStockKeyFromTitle('Bloom Arrangement Recreation'), 'recreation');
  assert.equal(bloomStockKeyFromTitle('Pressed Frame'), undefined);
  assert.equal(bloomStockKeyFromTitle(null), undefined);
});

test('a designer row becomes a completion on its Shopify line', () => {
  const p = plan([row('a', '#1')], [order('#1', ['L1', 1])]);
  assert.deepEqual(p.writes, [{
    week_of: WEEK, member_name: 'Mia Legas Boots', order_name: '#1', order_id: 'id-#1',
    line_item_id: 'L1', product_key: 'recreation', units: 1,
  }]);
  assert.deepEqual(p.deleteIds, []);
});

test('one unit per PF row, split across lines by quantity', () => {
  const p = plan([row('a', '#1'), row('b', '#1'), row('c', '#1')], [order('#1', ['L1', 2], ['L2', 1])]);
  assert.deepEqual(p.writes.map(w => [w.line_item_id, w.units]), [['L1', 2], ['L2', 1]]);
});

test('only lines for the same product are used', () => {
  const p = plan([row('a', '#1', 'Jennika Merrill', 'footprint')], [order('#1', ['L1', 1, 'recreation'], ['L2', 1, 'footprint'])]);
  assert.deepEqual(p.writes.map(w => w.line_item_id), ['L2']);
});

test('an order logged by hand or on the board is not double counted or overwritten', () => {
  const p = plan([row('a', '#1')], [order('#1', ['L1', 1])], [prior({ created_by: 'user_123', member_name: 'Someone Else' })]);
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.deleteIds, []);
  assert.equal(p.alreadyLogged, 1);
});

test('re-running an unchanged week writes nothing', () => {
  const p = plan([row('a', '#1')], [order('#1', ['L1', 1])], [prior({})]);
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.deleteIds, []);
});

test('a reassignment in the PF app moves the credit', () => {
  const p = plan([row('a', '#1', 'Jennika Merrill')], [order('#1', ['L1', 1])], [prior({})]);
  assert.equal(p.writes[0].member_name, 'Jennika Merrill');
});

test('an auto row PF no longer supports is removed, a manual one is not', () => {
  const p = plan([], [], [prior({ id: 'auto' }), prior({ id: 'manual', line_item_id: 'L2', created_by: 'user_123' })]);
  assert.deepEqual(p.deleteIds, ['auto']);
});

test('nobody loses credit when their lookup did not resolve', () => {
  const p = plan([], [], [prior({ member_name: 'Not Looked Up' })]);
  assert.deepEqual(p.deleteIds, []);
});

test('a line credited in an earlier week stays there', () => {
  const p = plan([row('a', '#1')], [order('#1', ['L1', 1])], [prior({ week_of: '2026-10-19' })]);
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.deleteIds, []);
});

test('a line credited in a later week moves back to this one', () => {
  const p = plan([row('a', '#1')], [order('#1', ['L1', 1])], [prior({ week_of: '2026-11-02' })]);
  assert.deepEqual(p.writes.map(w => [w.line_item_id, w.week_of]), [['L1', WEEK]]);
});

test('rows with no live Shopify line are reported, not written', () => {
  const p = plan([row('a', '#1'), row('b', '#2')], [order('#1', ['L1', 0])]);
  assert.deepEqual(p.writes, []);
  assert.deepEqual(p.unmatched.map(u => u.orderName), ['#1', '#2']);
});
