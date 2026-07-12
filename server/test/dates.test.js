import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, diffDays, computeDoDate, nextOccurrence, isValidISODate } from '../src/dates.js';
import { scoreTask } from '../src/scoring.js';

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-07-30', 3), '2026-08-02');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('diffDays', () => {
  assert.equal(diffDays('2026-07-12', '2026-07-15'), 3);
  assert.equal(diffDays('2026-07-12', '2026-07-10'), -2);
});

test('computeDoDate: due minus estimated TTC in workdays', () => {
  // 2h task, 8h workday -> start one day before due
  assert.equal(computeDoDate('2026-07-20', 120, 480), '2026-07-19');
  // 2-day task -> start two days before due
  assert.equal(computeDoDate('2026-07-20', 960, 480), '2026-07-18');
  // no estimate -> do date = due date
  assert.equal(computeDoDate('2026-07-20', null, 480), '2026-07-20');
  // no due date -> no default
  assert.equal(computeDoDate(null, 120, 480), null);
});

test('nextOccurrence clamps month ends', () => {
  assert.equal(nextOccurrence('2026-01-31', { freq: 'monthly', interval: 1 }), '2026-02-28');
  assert.equal(nextOccurrence('2026-07-12', { freq: 'weekly', interval: 2 }), '2026-07-26');
  assert.equal(nextOccurrence('2026-07-12', { freq: 'daily', interval: 1 }), '2026-07-13');
});

test('isValidISODate', () => {
  assert.ok(isValidISODate('2026-07-12'));
  assert.ok(!isValidISODate('12/07/2026'));
  assert.ok(!isValidISODate('2026-13-99'));
});

test('scoring: overdue urgent beats future low', () => {
  const today = '2026-07-12';
  const overdue = scoreTask({ due_date: '2026-07-10', priority: 'urgent', status: 'todo', tags: [] }, today);
  const future = scoreTask({ due_date: '2026-08-01', priority: 'low', status: 'todo', tags: [] }, today);
  assert.ok(overdue.score > future.score);
  assert.ok(overdue.reasons.some((r) => r.includes('overdue')));
});

test('scoring: blocked tasks sink', () => {
  const today = '2026-07-12';
  const blocked = scoreTask({ due_date: today, priority: 'urgent', status: 'todo', blocked: true, tags: [] }, today);
  const free = scoreTask({ priority: 'low', status: 'todo', tags: [] }, today);
  assert.ok(blocked.score < free.score);
});
