import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUBRIC, RUBRIC_KEYS, RUBRIC_MAX, piecesForHours, pieceTotal } from '../src/lib/designQualityRubric.ts';
import { aggregate, byDesigner, forLocation, missedLines, periodsFor, type ReportPiece } from '../src/lib/designQualityReport.ts';

const full = Object.fromEntries(RUBRIC_KEYS.map(k => [k, 1]));

function piece(over: Partial<ReportPiece>): ReportPiece {
  return {
    id: 1, weekOf: '2026-11-09', designer: 'A', location: 'Utah', orderNum: '1', variantTitle: null,
    scores: full, criterionNotes: {}, notes: null, seconds: 0, gradedBy: null, ...over,
  };
}

test('rubric is the 23-point version', () => {
  assert.equal(RUBRIC_MAX, 23);
  assert.deepEqual(RUBRIC.map(s => s.criteria.length), [7, 6, 4, 6]);
  assert.equal(new Set(RUBRIC_KEYS).size, 23);
});

test('frames to grade by hours: <20 → 1, 20–30 → 2, 30+ → 3', () => {
  assert.equal(piecesForHours(0), 1);
  assert.equal(piecesForHours(19.99), 1);
  assert.equal(piecesForHours(20), 2);
  assert.equal(piecesForHours(29.99), 2);
  assert.equal(piecesForHours(30), 3);
  assert.equal(piecesForHours(47), 3);
});

test('half points sum and ignore unknown values', () => {
  assert.equal(pieceTotal({ ...full, bloom_tilt: 0.5, quality_in_focus: 0 }), 21.5);
  assert.equal(pieceTotal({ bloom_tilt: 0.7 as number }), 0);
});

test('aggregate pools points across frames and by section', () => {
  const a = piece({ id: 1, scores: { ...full, bloom_tilt: 0 }, seconds: 300 });
  const b = piece({ id: 2, designer: 'B', scores: { ...full, quality_in_focus: 0.5 }, seconds: 0 });
  const agg = aggregate([a, b]);
  assert.equal(agg.frames, 2);
  assert.equal(agg.designers, 2);
  assert.equal(agg.overall.earned, 44.5);
  assert.equal(agg.overall.possible, 46);
  assert.equal(agg.sections['Bloom Rules'].earned, 13);
  assert.equal(agg.sections['Bloom Rules'].possible, 14);
  assert.equal(agg.sections['Quality'].earned, 11.5);
  assert.equal(agg.avgSeconds, 300); // frames with no time recorded are left out
  assert.equal(aggregate([]).overall.pct, null);
});

test('byDesigner sorts best first; forLocation filters unless Combined', () => {
  const ps = [
    piece({ id: 1, designer: 'Low', scores: { bloom_tilt: 1 } }),
    piece({ id: 2, designer: 'High', location: 'Georgia' }),
  ];
  assert.deepEqual(byDesigner(ps).map(r => r.designer), ['High', 'Low']);
  assert.equal(forLocation(ps, 'Utah').length, 1);
  assert.equal(forLocation(ps, 'Combined').length, 2);
});

test('missedLines lists lines under full marks with notes', () => {
  const m = missedLines(piece({ scores: { ...full, balance_centered: 0.5 }, criterionNotes: { balance_centered: 'Shifted left' } }));
  assert.deepEqual(m, [{ section: 'Overall Balance', text: 'The design is centered within the frame', score: 0.5, note: 'Shifted left' }]);
});

test('period windows', () => {
  assert.deepEqual(periodsFor('mtd', '2026-11-24', null), [{ label: 'Nov 2026 MTD', start: '2026-11-01', end: '2026-11-24' }]);
  assert.equal(periodsFor('qtd', '2026-11-24', null)[0].start, '2026-10-01');
  assert.equal(periodsFor('ytd', '2026-11-24', null)[0].start, '2026-01-01');
  assert.deepEqual(periodsFor('weekly', '2026-11-24', null), []);

  const weeks = periodsFor('weekly', '2026-11-24', '2026-11-09');
  // The week in progress (W/C Nov 23) isn't listed until it ends.
  assert.deepEqual(weeks.map(w => w.start), ['2026-11-09', '2026-11-16']);
  assert.equal(periodsFor('weekly', '2026-11-23', '2026-11-09').length, 2);
  assert.equal(weeks[0].label, 'W/C Nov 9, 2026');

  const months = periodsFor('monthly', '2027-01-05', '2026-11-09');
  assert.deepEqual(months.map(m => m.label), ['Nov 2026', 'Dec 2026', 'Jan 2027']);
  assert.equal(months[0].end, '2026-11-30');

  const quarters = periodsFor('quarterly', '2027-01-05', '2026-08-03');
  assert.deepEqual(quarters.map(q => q.label), ['Q3 2026', 'Q4 2026', 'Q1 2027']);
  assert.equal(quarters[1].end, '2026-12-31');
});
