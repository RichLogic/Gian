/**
 * Pure presentation helpers for the Timer surface (Issue #51): trigger
 * summaries, relative next-run labels, interval editor conversion, draft
 * validation, and run duration. Deterministic — every clock input is
 * injected.
 */
import { describe, expect, it } from 'vitest';
import { EN } from '../src/i18n/en.js';
import {
  buildCronFromSpec,
  DEFAULT_CUSTOM_FREQUENCY,
  formatInterval,
  formatNextRun,
  formatScheduleDateTime,
  frequencySummary,
  instantToLocalInput,
  intervalPartsToMs,
  intervalToParts,
  localInputToInstant,
  parseCronToSpec,
  runDurationLabel,
  validateScheduleDraft,
} from '../src/presentation/schedule.js';
import type { ScheduleRun } from '@gian/shared';

const t = (key: string) => EN[key] ?? key;

describe('frequencySummary', () => {
  it('renders once with an absolute timestamp', () => {
    const summary = frequencySummary({ kind: 'once', at: '2026-09-05T01:00:00.000Z' }, t);
    expect(summary).toMatch(/^Once · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('renders intervals humanized per unit', () => {
    expect(frequencySummary({ kind: 'interval', every_ms: 1_800_000, anchor_at: '2026-09-01T00:00:00.000Z' }, t))
      .toBe('Every 30 min');
    expect(frequencySummary({ kind: 'interval', every_ms: 3_600_000 * 2, anchor_at: '2026-09-01T00:00:00.000Z' }, t))
      .toBe('Every 2 h');
    expect(frequencySummary({ kind: 'interval', every_ms: 86_400_000, anchor_at: '2026-09-01T00:00:00.000Z' }, t))
      .toBe('Every 1 d');
  });

  it('renders structured cron shapes without the raw expression', () => {
    expect(frequencySummary({ kind: 'cron', expression: '0 9 * * *' }, t)).toBe('Daily at 09:00');
    expect(frequencySummary({ kind: 'cron', expression: '30 23 * * *' }, t)).toBe('Daily at 23:30');
    expect(frequencySummary({ kind: 'cron', expression: '5 */2 * * *' }, t)).toBe('Every 2 hours at :05');
    expect(frequencySummary({ kind: 'cron', expression: '15 * * * *' }, t)).toBe('Hourly at :15');
    expect(frequencySummary({ kind: 'cron', expression: '0 10 * * 1' }, t)).toBe('Weekly Mo at 10:00');
    expect(frequencySummary({ kind: 'cron', expression: '0 10 * * 1,3' }, t)).toBe('Weekly Mo, We at 10:00');
    expect(frequencySummary({ kind: 'cron', expression: '0 9 1 * *' }, t)).toBe('Monthly on day 1 at 09:00');
    expect(frequencySummary({ kind: 'cron', expression: '0 9 1 */3 *' }, t))
      .toBe('Every 3 months on day 1 at 09:00');
    expect(frequencySummary({ kind: 'cron', expression: '0 9 15 6 *' }, t)).toBe('Yearly on 6/15 at 09:00');
    expect(frequencySummary({ kind: 'cron', expression: '0 9 */2 * *' }, t)).toBe('Every 2 days at 09:00');
  });

  it('falls back to the verbatim expression for unparseable cron', () => {
    expect(frequencySummary({ kind: 'cron', expression: '0 9 * * 1-5' }, t)).toBe('0 9 * * 1-5');
    expect(frequencySummary({ kind: 'cron', expression: '@daily' }, t)).toBe('@daily');
  });
});

describe('buildCronFromSpec / parseCronToSpec', () => {
  const spec = (partial: Partial<typeof DEFAULT_CUSTOM_FREQUENCY>) => ({
    ...DEFAULT_CUSTOM_FREQUENCY,
    ...partial,
  });

  it('round-trips every structured shape', () => {
    const cases: Array<[ReturnType<typeof spec>, string]> = [
      [spec({ repeats: 'hourly', every: 1, minute: 15 }), '15 * * * *'],
      [spec({ repeats: 'hourly', every: 2, minute: 5 }), '5 */2 * * *'],
      [spec({ repeats: 'daily', every: 1, time: '09:00' }), '0 9 * * *'],
      [spec({ repeats: 'daily', every: 2, time: '23:30' }), '30 23 */2 * *'],
      [spec({ repeats: 'weekly', weekdays: [1], time: '10:00' }), '0 10 * * 1'],
      [spec({ repeats: 'weekly', weekdays: [3, 1], time: '10:00' }), '0 10 * * 1,3'],
      [spec({ repeats: 'monthly', every: 1, monthDay: 1, time: '09:00' }), '0 9 1 * *'],
      [spec({ repeats: 'monthly', every: 3, monthDay: 15, time: '09:00' }), '0 9 15 */3 *'],
      [spec({ repeats: 'yearly', month: 6, monthDay: 15, time: '09:00' }), '0 9 15 6 *'],
    ];
    for (const [input, expression] of cases) {
      expect(buildCronFromSpec(input)).toBe(expression);
      expect(parseCronToSpec(expression)).toEqual(
        input.repeats === 'weekly'
          ? { ...input, weekdays: [...input.weekdays].sort((a, b) => a - b) }
          : input,
      );
    }
  });

  it('treats cron Sunday 0 and 7 as the same weekday', () => {
    expect(parseCronToSpec('0 9 * * 0')?.weekdays).toEqual([0]);
    expect(parseCronToSpec('0 9 * * 7')?.weekdays).toEqual([0]);
  });

  it('rejects expressions outside the structured shapes', () => {
    expect(parseCronToSpec('0 9 * * 1-5')).toBeNull();
    expect(parseCronToSpec('@daily')).toBeNull();
    expect(parseCronToSpec('0 9 * *')).toBeNull();
    expect(parseCronToSpec('61 * * * *')).toBeNull();
    expect(parseCronToSpec('0 25 * * *')).toBeNull();
    expect(parseCronToSpec('0 9 32 * *')).toBeNull();
    expect(parseCronToSpec('0 9 1 13 *')).toBeNull();
  });
});

describe('formatNextRun', () => {
  const now = Date.parse('2026-09-03T04:00:00.000Z');

  it('renders relative labels for future runs', () => {
    expect(formatNextRun(null, t, now)).toBe('—');
    expect(formatNextRun('2026-09-03T04:00:30.000Z', t, now)).toBe('under a minute');
    expect(formatNextRun('2026-09-03T04:30:00.000Z', t, now)).toBe('in 30m');
    expect(formatNextRun('2026-09-03T09:00:00.000Z', t, now)).toBe('in 5h');
    expect(formatNextRun('2026-09-06T04:00:00.000Z', t, now)).toBe('in 3d');
  });

  it('falls back to the absolute timestamp for past/invalid values', () => {
    expect(formatNextRun('2026-09-01T04:00:00.000Z', t, now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatNextRun('not-a-date', t, now)).toBe('not-a-date');
  });
});

describe('formatScheduleDateTime', () => {
  it('formats a deterministic local YYYY-MM-DD HH:mm', () => {
    expect(formatScheduleDateTime('2026-09-03T04:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatScheduleDateTime('garbage')).toBe('garbage');
  });
});

describe('formatInterval', () => {
  it('picks the largest exact unit', () => {
    expect(formatInterval(86_400_000 * 2)).toBe('2d');
    expect(formatInterval(3_600_000 * 6)).toBe('6h');
    expect(formatInterval(300_000)).toBe('5m');
    expect(formatInterval(390_000)).toBe('7m');
  });
});

describe('interval editor conversion', () => {
  it('splits and rebuilds exact values', () => {
    expect(intervalToParts(3_600_000 * 12)).toEqual({ value: 12, unit: 'hours' });
    expect(intervalToParts(86_400_000)).toEqual({ value: 1, unit: 'days' });
    expect(intervalToParts(900_000)).toEqual({ value: 15, unit: 'minutes' });
    expect(intervalPartsToMs(12, 'hours')).toBe(3_600_000 * 12);
    expect(intervalPartsToMs(2, 'days')).toBe(86_400_000 * 2);
  });
});

describe('local datetime conversion', () => {
  it('round-trips datetime-local values', () => {
    const iso = localInputToInstant('2026-09-05T09:30');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(instantToLocalInput(iso!)).toBe('2026-09-05T09:30');
    expect(localInputToInstant('')).toBeNull();
  });
});

describe('validateScheduleDraft', () => {
  const base = {
    name: 'Nightly',
    prompt: 'do the thing',
    trigger: { kind: 'cron', expression: '0 9 * * *' } as const,
  };

  it('accepts a complete draft and rejects the broken shapes', () => {
    expect(validateScheduleDraft(base)).toBeNull();
    expect(validateScheduleDraft({ ...base, name: '  ' })).toBe('schedule.form.error.nameRequired');
    expect(validateScheduleDraft({ ...base, prompt: '' })).toBe('schedule.form.error.promptRequired');
    expect(validateScheduleDraft({ ...base, trigger: { kind: 'cron', expression: ' ' } }))
      .toBe('schedule.form.error.cronRequired');
    expect(validateScheduleDraft({ ...base, trigger: { kind: 'once', at: 'nope' } }))
      .toBe('schedule.form.error.onceInvalid');
    expect(validateScheduleDraft({
      ...base,
      trigger: { kind: 'interval', every_ms: 60_000, anchor_at: '2026-09-01T00:00:00.000Z' },
    })).toBe('schedule.form.error.intervalTooShort');
    expect(validateScheduleDraft({
      ...base,
      trigger: { kind: 'interval', every_ms: 300_000, anchor_at: '2026-09-01T00:00:00.000Z' },
    })).toBeNull();
  });
});

describe('runDurationLabel', () => {
  const run = (overrides: Partial<ScheduleRun>): ScheduleRun => overrides as ScheduleRun;

  it('formats start→finish durations', () => {
    expect(runDurationLabel(run({
      started_at: '2026-09-03T04:00:00.000Z',
      finished_at: '2026-09-03T04:00:08.000Z',
    }))).toBe('8s');
    expect(runDurationLabel(run({
      started_at: '2026-09-03T04:00:00.000Z',
      finished_at: '2026-09-03T04:01:03.000Z',
    }))).toBe('1m 03s');
    expect(runDurationLabel(run({ started_at: null, finished_at: null }))).toBeNull();
    expect(runDurationLabel(run({ started_at: '2026-09-03T04:00:00.000Z', finished_at: null }))).toBeNull();
  });
});
