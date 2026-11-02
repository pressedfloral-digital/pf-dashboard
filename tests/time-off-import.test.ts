import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeOffRows, matchPerson, rowToDays, toIsoDate } from '../src/lib/timeOffImport.ts';

test('finds Rippling columns by name and reads status', () => {
  const sheet = parseTimeOffRows([
    { 'Employee': 'Jane Doe', 'Policy': 'PTO', 'Start date': '11/10/2026', 'End date': '11/12/2026', 'Duration (hours)': '24', 'Status': 'Approved', 'Approver': 'Lauren Boyd' },
    { 'Employee': 'Sam Lee',  'Policy': 'PTO', 'Start date': '2026-11-13', 'End date': '',           'Duration (hours)': '4',  'Status': 'Pending',  'Approver': '' },
    { 'Employee': 'Ana Ruiz', 'Policy': 'Sick', 'Start date': '11/16/26',  'End date': '11/16/26',   'Duration (hours)': '8',  'Status': 'Declined', 'Approver': '' },
    { 'Employee': '',         'Policy': '',    'Start date': '',           'End date': '',           'Duration (hours)': '',   'Status': '',         'Approver': '' },
  ]);
  assert.equal(sheet.columns.status, 'Status');
  assert.equal(sheet.columns.hours, 'Duration (hours)');
  assert.equal(sheet.skipped, 1);
  assert.deepEqual(sheet.rows.map(r => [r.start, r.end, r.status]), [
    ['2026-11-10', '2026-11-12', 'approved'],
    ['2026-11-13', '2026-11-13', 'pending'],
    ['2026-11-16', '2026-11-16', 'denied'],
  ]);
});

test('duration with a Unit of days converts to hours', () => {
  const sheet = parseTimeOffRows([{ 'Employee': 'Jane Doe', 'Start date': '2026-11-10', 'Duration': '2', 'Unit': 'Days', 'Request status': 'APPROVED' }]);
  assert.equal(sheet.rows[0].hours, 16);
  assert.equal(sheet.rows[0].status, 'approved');
});

test('full days vs. partial hours per weekday', () => {
  assert.deepEqual(rowToDays({ start: '2026-11-13', end: '2026-11-13', hours: 4 }), [{ date: '2026-11-13', hoursOff: 4 }]);
  // 16h over Thanksgiving Wed–Fri stays whole days, not 5.33h/day
  const thanksgiving = rowToDays({ start: '2026-11-25', end: '2026-11-27', hours: 16 });
  assert.equal(thanksgiving.length, 3);
  assert.equal(thanksgiving.every(d => d.hoursOff == null), true);
  assert.equal(rowToDays({ start: '2026-11-10', end: '2026-11-10', hours: null })[0].hoursOff, null);
});

test('name matching handles Last, First and middle names', () => {
  const people = [{ id: '1', name: 'Jane Doe' }, { id: '2', name: 'Sam Lee' }];
  assert.equal(matchPerson('Doe, Jane', people)?.id, '1');
  assert.equal(matchPerson('Jane Q. Doe', people)?.id, '1');
  assert.equal(matchPerson('Someone Else', people), null);
});

test('dates from Excel serials and Date objects', () => {
  assert.equal(toIsoDate(46336), '2026-11-10');
  assert.equal(toIsoDate(new Date(2026, 10, 10)), '2026-11-10');
  assert.equal(toIsoDate(new Date(2026, 10, 9, 23)), '2026-11-10');
});

test('reads the Rippling Upcoming Time Off report layout', () => {
  const sheet = parseTimeOffRows([{
    'Employee': 'Jane Doe', 'Department': 'Preservation', 'Work location name': 'Pressed Floral Utah',
    'Leave request duration in hours': 16, 'Start Date': new Date(2026, 10, 25), 'Leave end date': new Date(2026, 10, 27),
    'Leave request status': 'APPROVED', 'Processed at': new Date(2026, 9, 19), 'Leave type name': 'Unpaid Time Off', 'Requested by': 'Jane Doe',
  }]);
  assert.deepEqual(sheet.columns, {
    name: 'Employee', start: 'Start Date', end: 'Leave end date', hours: 'Leave request duration in hours',
    status: 'Leave request status', policy: 'Leave type name',
  });
  assert.deepEqual(sheet.rows[0], {
    rowNumber: 2, name: 'Jane Doe', start: '2026-11-25', end: '2026-11-27', hours: 16,
    status: 'approved', rawStatus: 'APPROVED', policy: 'Unpaid Time Off',
  });
});
