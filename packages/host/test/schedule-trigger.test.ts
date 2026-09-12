// SCH-TRG-001: pure trigger contract — validation, normalization, strictly-
// after next occurrences, DST fixtures, and bounded enumeration. No test in
// this file may read the real clock or wait on real time.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  SCHEDULE_ENUMERATION_HARD_CAP,
  type ScheduleTrigger,
} from '@gian/shared';
import {
  enumerateDue,
  nextOccurrence,
  normalizeTimezone,
  normalizeTrigger,
  previewOccurrences,
} from '../src/schedule/trigger.js';
import { ScheduleError } from '../src/schedule/errors.js';

const UTC = 'UTC';

function domainCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ScheduleError, `expected ScheduleError, got ${error}`);
    return error.code;
  }
  throw new Error('expected trigger validation to fail');
}

// ── once ─────────────────────────────────────────────────────────────────────

test('once normalizes an explicit offset to UTC Z', () => {
  const trigger = normalizeTrigger(
    { kind: 'once', at: '2026-09-01T10:30:00+02:00' },
    UTC,
    '2026-08-30T00:00:00Z',
  );
  assert.deepEqual(trigger, { kind: 'once', at: '2026-09-01T08:30:00.000Z' });
});

test('once without offset or malformed instants is rejected', () => {
  assert.equal(domainCode(() => normalizeTrigger({ kind: 'once', at: '2026-09-01T10:30:00' }, UTC, 0)), 'SCHEDULE_TRIGGER_INVALID');
  assert.equal(domainCode(() => normalizeTrigger({ kind: 'once', at: 'not-a-time' }, UTC, 0)), 'SCHEDULE_TRIGGER_INVALID');
  assert.equal(domainCode(() => normalizeTrigger({ kind: 'once' }, UTC, 0)), 'SCHEDULE_TRIGGER_INVALID');
  assert.equal(domainCode(() => normalizeTrigger({ kind: 'once', at: '2026-09-01T10:30:00Z', extra: 1 }, UTC, 0)), 'SCHEDULE_TRIGGER_INVALID');
});

test('once before now yields no future occurrence (resume revalidation shape)', () => {
  const trigger = normalizeTrigger({ kind: 'once', at: '2026-08-29T00:00:00Z' }, UTC, '2026-08-30T00:00:00Z');
  assert.equal(nextOccurrence(trigger, UTC, '2026-08-30T00:00:00Z'), null);
  assert.deepEqual(enumerateDue(trigger, UTC, '2026-08-30T00:00:00Z', '2026-08-31T00:00:00Z', 10), {
    occurrences: [], truncated: false,
  });
});

test('once fires exactly once inside its due window', () => {
  const trigger = normalizeTrigger({ kind: 'once', at: '2026-08-30T12:00:00Z' }, UTC, '2026-08-30T00:00:00Z');
  assert.deepEqual(enumerateDue(trigger, UTC, '2026-08-30T00:00:00Z', '2026-08-31T00:00:00Z', 10), {
    occurrences: ['2026-08-30T12:00:00.000Z'], truncated: false,
  });
});

// ── interval ─────────────────────────────────────────────────────────────────

test('interval normalizes the anchor and enforces the 5 minute bounds', () => {
  const trigger = normalizeTrigger(
    { kind: 'interval', every_ms: 300_000, anchor_at: '2026-08-30T02:00:00+02:00' },
    UTC,
    '2026-08-30T00:00:00Z',
  );
  assert.deepEqual(trigger, { kind: 'interval', every_ms: 300_000, anchor_at: '2026-08-30T00:00:00.000Z' });
  assert.equal(
    domainCode(() => normalizeTrigger({ kind: 'interval', every_ms: 299_999, anchor_at: '2026-08-30T00:00:00Z' }, UTC, 0)),
    'SCHEDULE_TRIGGER_INVALID',
  );
  assert.equal(
    domainCode(() => normalizeTrigger({ kind: 'interval', every_ms: 31_536_000_001, anchor_at: '2026-08-30T00:00:00Z' }, UTC, 0)),
    'SCHEDULE_TRIGGER_INVALID',
  );
  assert.equal(
    domainCode(() => normalizeTrigger({ kind: 'interval', every_ms: 300.5, anchor_at: '2026-08-30T00:00:00Z' }, UTC, 0)),
    'SCHEDULE_TRIGGER_INVALID',
  );
  assert.equal(
    domainCode(() => normalizeTrigger({ kind: 'interval', every_ms: 300_000, anchor_at: '2026-08-30T00:00:00' }, UTC, 0)),
    'SCHEDULE_TRIGGER_INVALID',
  );
});

test('interval math is exact before, at, and after the anchor with no float drift', () => {
  const anchor = '2026-08-30T00:00:00.000Z';
  const trigger = normalizeTrigger({ kind: 'interval', every_ms: 600_000, anchor_at: anchor }, UTC, 0);
  assert.equal(nextOccurrence(trigger, UTC, '2026-08-29T23:59:59Z'), anchor);
  assert.equal(nextOccurrence(trigger, UTC, anchor), '2026-08-30T00:10:00.000Z');
  assert.equal(nextOccurrence(trigger, UTC, '2026-08-30T00:00:01Z'), '2026-08-30T00:10:00.000Z');
  // Exactly on a step boundary: strictly after wins.
  assert.equal(nextOccurrence(trigger, UTC, '2026-08-30T00:20:00.000Z'), '2026-08-30T00:30:00.000Z');
  // Large elapsed durations stay integer-exact (30 days = exactly 4320 steps,
  // so the boundary itself is excluded and the next step wins).
  assert.equal(
    nextOccurrence(trigger, UTC, '2026-09-29T00:00:00Z'),
    '2026-09-29T00:10:00.000Z',
  );
});

test('interval occurrences are DST-independent absolute durations', () => {
  const trigger = normalizeTrigger(
    { kind: 'interval', every_ms: 3_600_000, anchor_at: '2026-03-07T20:00:00-05:00' },
    'America/New_York',
    0,
  );
  // Crossing the US spring transition: elapsed UTC hours stay exact.
  assert.equal(
    nextOccurrence(trigger, 'America/New_York', '2026-03-08T06:30:00Z'),
    '2026-03-08T07:00:00.000Z',
  );
});

// ── cron ─────────────────────────────────────────────────────────────────────

test('cron accepts the standard 5-field subset and normalizes whitespace', () => {
  const trigger = normalizeTrigger(
    { kind: 'cron', expression: '  30  2 * * 1-5  ' },
    UTC,
    '2026-08-30T00:00:00Z',
  );
  assert.deepEqual(trigger, { kind: 'cron', expression: '30 2 * * 1-5' });
});

test('cron rejects 6/7 fields, nicknames, names, and special modifiers', () => {
  const rejects = [
    '* * * * * *',
    '0 0 0 * * * *',
    '@daily',
    '30 2 L * *',
    '30 2 * * 1#1',
    '0 12 ? * 1',
    '30 2 * * MON',
    '30 2 1W * *',
    '30/0 2 * * *',
    '60 2 * * *',
    '30 25 * * *',
    '30 2 32 * *',
    '30 2 * 13 *',
    '30 2 * * 8',
    '30 2 0 * *',
    '30-1 2 * * *',
  ];
  for (const expression of rejects) {
    assert.equal(
      domainCode(() => normalizeTrigger({ kind: 'cron', expression }, UTC, 0)),
      'SCHEDULE_TRIGGER_INVALID',
      `expected rejection: ${expression}`,
    );
  }
});

test('cron requires a valid IANA timezone', () => {
  assert.equal(domainCode(() => normalizeTrigger({ kind: 'cron', expression: '* * * * *' }, 'Mars/Olympus', 0)), 'SCHEDULE_TIMEZONE_INVALID');
  assert.equal(domainCode(() => normalizeTimezone('Not/AZone')), 'SCHEDULE_TIMEZONE_INVALID');
  assert.equal(normalizeTimezone('America/New_York'), 'America/New_York');
  assert.equal(normalizeTimezone('UTC'), 'UTC');
});

test('cron strictly-after semantics and DOM/DOW OR', () => {
  const trigger = normalizeTrigger({ kind: 'cron', expression: '0 12 * * *' }, UTC, 0);
  // Exclusive boundary: 12:00 itself is not returned when `after` is 12:00.
  assert.equal(
    nextOccurrence(trigger, UTC, '2026-08-30T12:00:00Z'),
    '2026-08-31T12:00:00.000Z',
  );
  // Vixie OR: day-of-month 1 OR Sunday.
  const orTrigger = normalizeTrigger({ kind: 'cron', expression: '0 0 1 * 0' }, UTC, 0);
  assert.equal(
    nextOccurrence(orTrigger, UTC, '2026-08-30T00:00:00Z'),
    '2026-09-01T00:00:00.000Z',
  );
  const sunday = normalizeTrigger({ kind: 'cron', expression: '0 0 * * 0' }, UTC, 0);
  assert.equal(
    nextOccurrence(sunday, UTC, '2026-08-30T00:00:00Z'),
    '2026-09-06T00:00:00.000Z',
  );
});

test('cron leap day and month-end calendar math', () => {
  const leap = normalizeTrigger({ kind: 'cron', expression: '0 0 29 2 *' }, UTC, 0);
  assert.equal(nextOccurrence(leap, UTC, '2026-01-01T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  const monthEnd = normalizeTrigger({ kind: 'cron', expression: '0 0 31 * *' }, UTC, 0);
  // Months without a 31st contribute no occurrence.
  assert.equal(nextOccurrence(monthEnd, UTC, '2026-01-31T00:00:00Z'), '2026-03-31T00:00:00.000Z');
});

// Locked croner@10.0.1 DST semantics (ADR-0051 / design §5.3): a gap wall
// time produces exactly one shifted occurrence that day; a repeated fall
// wall time produces exactly the first instant. Upgrading croner must diff
// these fixtures.
test('DST spring gap produces one shifted occurrence (America/New_York)', () => {
  const trigger = normalizeTrigger({ kind: 'cron', expression: '30 2 * * *' }, 'America/New_York', 0);
  assert.equal(
    nextOccurrence(trigger, 'America/New_York', '2026-03-07T12:00:00Z'),
    '2026-03-08T07:30:00.000Z', // nonexistent 02:30 EST maps to 03:30 EDT.
  );
  assert.deepEqual(
    enumerateDue(trigger, 'America/New_York', '2026-03-08T00:00:00Z', '2026-03-09T00:00:00Z', 10),
    { occurrences: ['2026-03-08T07:30:00.000Z'], truncated: false },
  );
});

test('DST fall overlap runs only the first instant (America/New_York, Europe/Berlin)', () => {
  const ny = normalizeTrigger({ kind: 'cron', expression: '30 1 * * *' }, 'America/New_York', 0);
  assert.deepEqual(
    enumerateDue(ny, 'America/New_York', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', 10),
    { occurrences: ['2026-11-01T05:30:00.000Z'], truncated: false },
  );
  const berlin = normalizeTrigger({ kind: 'cron', expression: '30 2 * * *' }, 'Europe/Berlin', 0);
  assert.deepEqual(
    enumerateDue(berlin, 'Europe/Berlin', '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z', 10),
    { occurrences: ['2026-10-25T00:30:00.000Z'], truncated: false },
  );
  assert.equal(
    nextOccurrence(berlin, 'Europe/Berlin', '2026-03-28T12:00:00Z'),
    '2026-03-29T01:30:00.000Z', // gap day: single shifted occurrence.
  );
});

test('high-frequency cron is rejected by the 32-occurrence 5-minute guard', () => {
  assert.equal(
    domainCode(() => normalizeTrigger({ kind: 'cron', expression: '* * * * *' }, UTC, '2026-08-30T00:00:00Z')),
    'SCHEDULE_INTERVAL_TOO_FREQUENT',
  );
  assert.equal(
    domainCode(() => normalizeTrigger({ kind: 'cron', expression: '*/2 * * * *' }, UTC, '2026-08-30T00:00:00Z')),
    'SCHEDULE_INTERVAL_TOO_FREQUENT',
  );
  // Exactly 5 minutes apart is acceptable.
  const ok = normalizeTrigger({ kind: 'cron', expression: '*/5 * * * *' }, UTC, '2026-08-30T00:00:00Z');
  assert.equal(ok.kind, 'cron');
  // DST can compress real gaps below 5 minutes; the guard must still pass a
  // normal schedule that is calendar-legal.
  assert.equal(normalizeTrigger({ kind: 'cron', expression: '*/5 * * * *' }, 'America/New_York', '2026-11-01T00:00:00Z').kind, 'cron');
});

// ── preview / enumeration caps ───────────────────────────────────────────────

test('preview returns strictly-after occurrences up to the limit', () => {
  const trigger = normalizeTrigger({ kind: 'cron', expression: '0 12 * * *' }, UTC, 0);
  const occurrences = previewOccurrences(trigger, UTC, '2026-08-30T00:00:00Z', 3);
  assert.deepEqual(occurrences, [
    '2026-08-30T12:00:00.000Z',
    '2026-08-31T12:00:00.000Z',
    '2026-09-01T12:00:00.000Z',
  ]);
  assert.deepEqual(previewOccurrences(trigger, UTC, '2026-08-30T00:00:00Z', 0), []);
});

test('preview clamps the request to the enumeration hard cap', () => {
  const trigger = normalizeTrigger({ kind: 'cron', expression: '0 12 * * *' }, UTC, 0);
  const occurrences = previewOccurrences(trigger, UTC, '2026-08-30T00:00:00Z', SCHEDULE_ENUMERATION_HARD_CAP + 5_000);
  assert.equal(occurrences.length, SCHEDULE_ENUMERATION_HARD_CAP);
});

test('enumerateDue truncates bounded windows instead of replaying history', () => {
  const trigger = normalizeTrigger({ kind: 'cron', expression: '*/5 * * * *' }, UTC, 0);
  const from = '2026-08-01T00:00:00Z';
  const through = '2026-09-01T00:00:00Z'; // 31 days at 5 minutes ≫ 1000.
  const result = enumerateDue(trigger, UTC, from, through, 50);
  assert.equal(result.occurrences.length, 50);
  assert.equal(result.truncated, true);
  // First occurrence is still the window start, not a mid-window slice.
  assert.equal(result.occurrences[0], '2026-08-01T00:00:00.000Z');
  // Small windows are exact and untruncated.
  const small = enumerateDue(trigger, UTC, '2026-08-01T00:00:00Z', '2026-08-01T00:20:00Z', 10);
  assert.deepEqual(small, {
    occurrences: [
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:05:00.000Z',
      '2026-08-01T00:10:00.000Z',
      '2026-08-01T00:15:00.000Z',
      '2026-08-01T00:20:00.000Z',
    ],
    truncated: false,
  });
});

test('interval and once enumeration stay inside the requested window', () => {
  const interval = normalizeTrigger(
    { kind: 'interval', every_ms: 600_000, anchor_at: '2026-08-01T00:03:00Z' },
    UTC,
    0,
  );
  assert.deepEqual(enumerateDue(interval, UTC, '2026-08-01T00:00:00Z', '2026-08-01T00:25:00Z', 10), {
    occurrences: [
      '2026-08-01T00:03:00.000Z',
      '2026-08-01T00:13:00.000Z',
      '2026-08-01T00:23:00.000Z',
    ],
    truncated: false,
  });
});

test('normalized triggers round-trip through the shared guard', () => {
  const triggers: ScheduleTrigger[] = [
    { kind: 'once', at: '2026-09-01T08:30:00.000Z' },
    { kind: 'cron', expression: '30 2 * * 1-5' },
    { kind: 'interval', every_ms: 300_000, anchor_at: '2026-08-30T00:00:00.000Z' },
  ];
  for (const trigger of triggers) {
    assert.deepEqual(normalizeTrigger(trigger, UTC, '2026-08-30T00:00:00Z'), trigger);
  }
});
