import test from 'node:test';
import assert from 'node:assert/strict';
import { isProgramDue, localScheduleParts, normalizeProgram, scheduleRunKey } from './scheduler-utils.js';

test('timezone schedule parts use Argentina timezone', () => {
  const parts = localScheduleParts(new Date('2026-10-16T09:00:00.000Z'));
  assert.deepEqual(parts, { day: 5, time: '06:00', date: '2026-10-16' });
});

test('program due requires enabled, matching weekday and exact minute', () => {
  const now = { day: 1, time: '06:00', date: '2026-10-19' };
  const p = { id: 1, time: '06:00', days: [1, 2, 3, 4, 5], enabled: true };
  assert.equal(isProgramDue(p, now, Date.parse('2026-10-19T09:00:00Z')), true);
  assert.equal(isProgramDue({ ...p, enabled: false }, now), false);
  assert.equal(isProgramDue({ ...p, time: '06:01' }, now), false);
  assert.equal(isProgramDue({ ...p, days: [2] }, now), false);
});

test('active climate delay suppresses due program', () => {
  const now = { day: 1, time: '06:00', date: '2026-10-19' };
  const p = { id: 1, time: '06:00', days: [1], enabled: true, delayUntil: '2026-10-19T12:00:00.000Z' };
  assert.equal(isProgramDue(p, now, Date.parse('2026-10-19T09:00:00.000Z')), false);
  assert.equal(isProgramDue(p, now, Date.parse('2026-10-19T13:00:00.000Z')), true);
});

test('run key is unique by date, program and minute', () => {
  assert.equal(scheduleRunKey({ id: 7, time: '06:00' }, { date: '2026-10-19' }), '2026-10-19 7 06:00');
});

test('program normalization deduplicates weekdays and rejects invalid durations', () => {
  const p = normalizeProgram({ time: '07:15', days: [1, 1, 8, 2], durations: { 1: 10.8, 2: 0 }, enabled: true }, 0);
  assert.deepEqual(p.days, [1, 2]);
  assert.equal(p.durations[1], 10);
  assert.throws(() => normalizeProgram({ time: '07:15', durations: { 1: 241 } }, 0), /Duración inválida/);
});
