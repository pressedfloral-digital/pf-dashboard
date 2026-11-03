import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSalaryMgrCostSplitForWeeks, getSalaryMgrCostForWeeks, ptoAdjustedHomeCost, MANAGER_PTO, type SalaryMgr } from '../src/lib/managers.ts';

// $41,600/yr → $800/wk. Home: Fulfillment.
const mgr: SalaryMgr = { name: 'Test Manager', location: 'Utah', departments: ['Fulfillment'], annualSalary: 41600 };
const norm = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
const row = (week_of: string, actual_orders: number, member_name = 'Hourly') =>
  ({ week_of, member_name, department: 'fulfillment', location: 'Utah', actual_hours: 10, actual_orders });

// Two normal weeks of 100 orders → $8/order normally; then a full PTO week
// with 20 orders and a busy week with one day off.
const rows = [row('2026-09-07', 100), row('2026-09-14', 100), row('2026-09-21', 20), row('2026-09-28', 300)];
MANAGER_PTO.push(
  { name: 'Test Manager', location: 'Utah', weekOf: '2026-09-21', hours: 40 },
  { name: 'Test Manager', location: 'Utah', weekOf: '2026-09-28', hours: 8 },
);

test('weeks without PTO keep full salary', () => {
  assert.equal(ptoAdjustedHomeCost(mgr, 'Utah', '2026-09-14', 800, rows, norm), 800);
  assert.equal(getSalaryMgrCostSplitForWeeks([mgr], 'Utah', ['2026-09-14'], rows, norm).Fulfillment, 800);
});

test('a full PTO week costs the normal cost per order × its orders', () => {
  assert.equal(getSalaryMgrCostSplitForWeeks([mgr], 'Utah', ['2026-09-21'], rows, norm).Fulfillment, 20 * 8);
  assert.equal(getSalaryMgrCostForWeeks([mgr], 'Utah', 'Fulfillment', ['2026-09-21'], rows, norm), 20 * 8);
});

test('PTO never raises a busy week above full salary', () => {
  assert.equal(getSalaryMgrCostSplitForWeeks([mgr], 'Utah', ['2026-09-28'], rows, norm).Fulfillment, 800);
});

test('flat cost without actuals ignores PTO', () => {
  assert.equal(getSalaryMgrCostForWeeks([mgr], 'Utah', 'Fulfillment', ['2026-09-21']), 800);
});
