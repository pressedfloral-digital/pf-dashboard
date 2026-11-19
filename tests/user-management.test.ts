import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignableRoles, inviteDenied, manageDenied, editDenied } from '../src/lib/userManagement.ts';

const admin   = { userId: 'a', role: 'admin',           location: null };
const utahGM  = { userId: 'g', role: 'general_manager', location: 'Utah' };
const utahMgr = { userId: 'm', role: 'manager',         location: 'Utah' };
const user    = { userId: 'u', role: 'user',            location: 'Utah' };
const t = (id: string, role: string, location: string | null) => ({ clerk_user_id: id, role, location });

test('assignable roles by role', () => {
  assert.deepEqual(assignableRoles('admin'), ['admin', 'general_manager', 'manager', 'user', 'viewer']);
  assert.deepEqual(assignableRoles('general_manager'), ['manager', 'user', 'viewer']);
  assert.deepEqual(assignableRoles('manager'), ['user']);
  assert.deepEqual(assignableRoles('user'), []);
  assert.deepEqual(assignableRoles('viewer'), []);
});

test('invites: GMs and managers invite into their own location only, at allowed roles', () => {
  assert.equal(inviteDenied(admin, { role: 'admin', location: null }), null);
  assert.equal(inviteDenied(utahGM, { role: 'manager', location: 'Utah' }), null);
  assert.equal(inviteDenied(utahMgr, { role: 'user', location: 'Utah' }), null);
  assert.ok(inviteDenied(utahGM, { role: 'general_manager', location: 'Utah' }));
  assert.ok(inviteDenied(utahGM, { role: 'admin', location: 'Utah' }));
  assert.ok(inviteDenied(utahGM, { role: 'manager', location: 'Georgia' }));
  assert.ok(inviteDenied(utahGM, { role: 'manager', location: null }));
  assert.ok(inviteDenied(utahMgr, { role: 'manager', location: 'Utah' }));
  assert.ok(inviteDenied(user, { role: 'user', location: 'Utah' }));
  assert.ok(inviteDenied({ ...utahMgr, location: null }, { role: 'user', location: null }));
});

test('managing: own location, lower roles, never yourself', () => {
  assert.equal(manageDenied(admin, t('x', 'admin', null)), null);
  assert.equal(manageDenied(utahGM, t('x', 'manager', 'Utah')), null);
  assert.equal(manageDenied(utahMgr, t('x', 'user', 'Utah')), null);
  assert.ok(manageDenied(utahGM, t('x', 'general_manager', 'Utah')));
  assert.ok(manageDenied(utahGM, t('x', 'manager', 'Georgia')));
  assert.ok(manageDenied(utahGM, t('g', 'manager', 'Utah')), 'self');
  assert.ok(manageDenied(utahMgr, t('x', 'manager', 'Utah')));
  assert.ok(manageDenied(user, t('x', 'user', 'Utah')));
});

test('edits cannot promote past allowed roles or move people out of the location', () => {
  const mgr = t('x', 'manager', 'Utah');
  assert.equal(editDenied(utahGM, mgr, { role: 'user' }), null);
  assert.equal(editDenied(utahGM, mgr, { location: 'Utah' }), null);
  assert.ok(editDenied(utahGM, mgr, { role: 'admin' }));
  assert.ok(editDenied(utahGM, mgr, { role: 'general_manager' }));
  assert.ok(editDenied(utahGM, mgr, { location: 'Georgia' }));
  assert.ok(editDenied(utahMgr, t('x', 'user', 'Utah'), { role: 'manager' }));
  assert.equal(editDenied(admin, mgr, { role: 'admin', location: 'Georgia' }), null);
});
