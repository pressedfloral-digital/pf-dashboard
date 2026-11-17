import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePermissions } from '../src/lib/permissions.ts';

const p = (role: string, location: string | null = 'Utah') => derivePermissions({ role, location });

test('user: Department Dashboard only — no Scheduling/Inventory/Growth, Scorecards/KPIs or CPO', () => {
  const u = p('user');
  assert.equal(u.canViewScheduling, false);
  assert.equal(u.canViewScorecards, false);
  assert.equal(u.canViewCPO, false);
  assert.equal(u.canEditUtah, false);
  assert.equal(u.canManageUsers, false);
  assert.equal(u.canViewUtah, true);
  assert.equal(u.canViewGeorgia, false);
});

test('viewer: read-only everywhere, Scheduling yes, Scorecards/KPIs and CPO no', () => {
  const v = p('viewer', null);
  assert.equal(v.canViewScheduling, true);
  assert.equal(v.canViewScorecards, false);
  assert.equal(v.canViewCPO, false);
  assert.equal(v.canViewUtah && v.canViewGeorgia && v.canViewAllLocations, true);
  assert.equal(v.canEditUtah || v.canEditGeorgia || v.canEditSchedule || v.canManageUsers, false);
});

test('admin, GM, manager keep full tabs and CPO; editing follows location', () => {
  for (const role of ['admin', 'general_manager', 'manager']) {
    const x = p(role, 'Georgia');
    assert.equal(x.canViewScheduling && x.canViewScorecards && x.canViewCPO && x.canManageUsers, true, role);
    assert.equal(x.canEditGeorgia, true, role);
    assert.equal(x.canEditUtah, role === 'admin', role);
  }
  assert.equal(p('general_manager', 'Georgia').canViewUtah, true);
  assert.equal(p('manager', 'Georgia').canViewUtah, false);
});

test('unknown role gets nothing', () => {
  const x = p('something-else');
  assert.equal(Object.values(x).some(Boolean), false);
});
