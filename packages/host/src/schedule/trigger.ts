import { Cron } from 'croner';
import type { ScheduleTrigger } from '@gian/shared';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  SCHEDULE_ENUMERATION_HARD_CAP,
  SCHEDULE_FREQUENT_GUARD_OCCURRENCES,
} from '@gian/shared';
import { scheduleFailure } from './errors.js';

/**
 * Pure trigger calculation. Nothing here reads the system clock, starts a
 * timer, or touches the database: every function receives `now`/bounds from
 * the caller. Croner is used as a paused, callback-free calendar calculator
 * only — persistence, misfire, overlap, idempotency, and recovery are owned
 * by the schedule module (ADR-0053).
 */

export type NormalizedTrigger = ScheduleTrigger;

/** Strict 5-field Vixie subset: minute hour day-of-month month day-of-week.
 *  Seconds are fixed at 0; `L W # + ?`, nicknames, and names are rejected. */
const CRON_FIELD_LIMITS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const CRON_FIELD = /^(\*|[0-9]{1,2}(?:-[0-9]{1,2})?)(?:\/[0-9]{1,9})?$/;

function isRfc3339Instant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return Number.isFinite(Date.parse(value))
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

export function toUtcZ(instant: string): string {
  return new Date(Date.parse(instant)).toISOString();
}

export function normalizeTimezone(timezone: string): string {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) {
    throw scheduleFailure('SCHEDULE_TIMEZONE_INVALID', 'timezone must be an IANA name');
  }
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    const canonical = format.resolvedOptions().timeZone;
    if (!canonical) throw new Error('unresolved timezone');
    return canonical;
  } catch {
    throw scheduleFailure(
      'SCHEDULE_TIMEZONE_INVALID',
      `timezone is not a supported IANA name: ${timezone}`,
    );
  }
}

function assertCronGrammar(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw scheduleFailure(
      'SCHEDULE_TRIGGER_INVALID',
      'cron must be exactly 5 fields: minute hour day-of-month month day-of-week',
    );
  }
  if (/[A-Za-z?]/.test(expression)) {
    throw scheduleFailure(
      'SCHEDULE_TRIGGER_INVALID',
      'cron names, nicknames, and L/W/#/? modifiers are not supported in v1',
    );
  }
  fields.forEach((field, index) => {
    const [min, max] = CRON_FIELD_LIMITS[index]!;
    for (const part of field.split(',')) {
      const match = part.match(CRON_FIELD);
      if (!match) {
        throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', `invalid cron field: ${part}`);
      }
      const [, start = '*', step] = match;
      if (start !== '*') {
        const [lo, hi] = start.split('-');
        const loValue = Number(lo);
        const hiValue = Number(hi ?? lo);
        if (loValue < min || loValue > max || hiValue < min || hiValue > max || hiValue < loValue) {
          throw scheduleFailure(
            'SCHEDULE_TRIGGER_INVALID',
            `cron field ${index + 1} must be between ${min} and ${max}`,
          );
        }
      }
      if (step !== undefined && Number(step) === 0) {
        throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', 'cron step must be positive');
      }
    }
  });
}

function assertCronPace(expression: string, timezone: string, now: number): void {
  const evaluator = cronEvaluator(expression, timezone);
  const occurrences = upcomingCron(evaluator, now, SCHEDULE_FREQUENT_GUARD_OCCURRENCES + 1);
  if (occurrences.length < 2) return;
  for (let i = 1; i < occurrences.length; i += 1) {
    if (Date.parse(occurrences[i]!) - Date.parse(occurrences[i - 1]!) < MIN_INTERVAL_MS) {
      throw scheduleFailure(
        'SCHEDULE_INTERVAL_TOO_FREQUENT',
        'cron produces an occurrence less than 5 minutes apart within the next 32 occurrences',
      );
    }
  }
}

/** Validates and canonicalizes a trigger definition. Cron definitions get the
 *  32-occurrence 5-minute pace guard here so every create/update/resume path
 *  shares one enforcement point. */
export function normalizeTrigger(
  input: unknown,
  timezone: string,
  now: string | number,
): NormalizedTrigger {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', 'trigger must be an object');
  }
  const canonicalZone = normalizeTimezone(timezone);
  const trigger = input as Record<string, unknown>;
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  switch (trigger.kind) {
    case 'once': {
      if (Object.keys(trigger).length !== 2 || !isRfc3339Instant(trigger.at)) {
        throw scheduleFailure(
          'SCHEDULE_TRIGGER_INVALID',
          'trigger.once requires `at`: an RFC 3339 instant with Z or an explicit offset',
        );
      }
      return { kind: 'once', at: toUtcZ(trigger.at) };
    }
    case 'interval': {
      if (Object.keys(trigger).length !== 3) {
        throw scheduleFailure(
          'SCHEDULE_TRIGGER_INVALID',
          'trigger.interval requires exactly `every_ms` and `anchor_at`',
        );
      }
      const everyMs = trigger.every_ms;
      if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || !Number.isSafeInteger(everyMs)) {
        throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', 'trigger.interval.every_ms must be a safe integer');
      }
      if (everyMs < MIN_INTERVAL_MS || everyMs > MAX_INTERVAL_MS) {
        throw scheduleFailure(
          'SCHEDULE_TRIGGER_INVALID',
          `trigger.interval.every_ms must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms`,
        );
      }
      if (!isRfc3339Instant(trigger.anchor_at)) {
        throw scheduleFailure(
          'SCHEDULE_TRIGGER_INVALID',
          'trigger.interval.anchor_at must be an RFC 3339 instant with Z or an explicit offset',
        );
      }
      return { kind: 'interval', every_ms: everyMs, anchor_at: toUtcZ(trigger.anchor_at) };
    }
    case 'cron': {
      if (Object.keys(trigger).length !== 2 || typeof trigger.expression !== 'string') {
        throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', 'trigger.cron requires `expression`');
      }
      assertCronGrammar(trigger.expression);
      assertCronPace(trigger.expression, canonicalZone, nowMs);
      return { kind: 'cron', expression: trigger.expression.trim().replace(/\s+/g, ' ') };
    }
    default:
      throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', 'trigger.kind must be once, cron, or interval');
  }
}

function cronEvaluator(expression: string, timezone: string): Cron {
  try {
    // No callback and paused: Croner owns no timer and never fires anything;
    // it only answers nextRun() calendar questions in the target zone.
    return new Cron(expression, { timezone, paused: true });
  } catch {
    throw scheduleFailure('SCHEDULE_TRIGGER_INVALID', `cron expression is invalid: ${expression}`);
  }
}

function upcomingCron(evaluator: Cron, afterMs: number, limit: number): string[] {
  const out: string[] = [];
  let cursor = new Date(afterMs);
  for (let i = 0; i < limit; i += 1) {
    const next = evaluator.nextRun(cursor);
    if (!next) break;
    out.push(next.toISOString());
    cursor = next;
  }
  return out;
}

/** Next occurrence strictly after `afterExclusive`, or null when none exists. */
export function nextOccurrence(
  trigger: NormalizedTrigger,
  timezone: string,
  afterExclusive: string | number,
): string | null {
  const afterMs = typeof afterExclusive === 'number' ? afterExclusive : Date.parse(afterExclusive);
  if (!Number.isFinite(afterMs)) {
    throw scheduleFailure('INVALID_ARGUMENT', 'afterExclusive must be an instant');
  }
  switch (trigger.kind) {
    case 'once': {
      const atMs = Date.parse(trigger.at);
      return atMs > afterMs ? new Date(atMs).toISOString() : null;
    }
    case 'interval': {
      const anchorMs = Date.parse(trigger.anchor_at);
      const every = trigger.every_ms;
      if (afterMs < anchorMs) return new Date(anchorMs).toISOString();
      const elapsed = afterMs - anchorMs;
      const steps = Math.ceil(elapsed / every);
      const candidate = anchorMs + steps * every;
      const nextMs = candidate > afterMs ? candidate : afterMs + every;
      if (!Number.isSafeInteger(nextMs)) return null;
      return new Date(nextMs).toISOString();
    }
    case 'cron': {
      const evaluator = cronEvaluator(trigger.expression, timezone);
      const next = evaluator.nextRun(new Date(afterMs));
      return next ? next.toISOString() : null;
    }
  }
}

/** Future occurrences strictly after `afterExclusive`, capped by `limit`
 *  (clamped to the Host hard cap of 1,000). */
export function previewOccurrences(
  trigger: NormalizedTrigger,
  timezone: string,
  afterExclusive: string | number,
  limit: number,
): string[] {
  const capped = Math.max(0, Math.min(Math.floor(limit), SCHEDULE_ENUMERATION_HARD_CAP));
  if (capped === 0) return [];
  const afterMs = typeof afterExclusive === 'number' ? afterExclusive : Date.parse(afterExclusive);
  if (!Number.isFinite(afterMs)) {
    throw scheduleFailure('INVALID_ARGUMENT', 'afterExclusive must be an instant');
  }
  if (trigger.kind === 'cron') {
    return upcomingCron(cronEvaluator(trigger.expression, timezone), afterMs, capped);
  }
  const out: string[] = [];
  let cursor: string | null = nextOccurrence(trigger, timezone, afterMs);
  while (cursor !== null && out.length < capped) {
    out.push(cursor);
    cursor = nextOccurrence(trigger, timezone, Date.parse(cursor));
  }
  return out;
}

/** Occurrences inside [fromInclusive, throughInclusive]. When the window
 *  holds more than `limit`, the list stops at `limit` and `truncated` is
 *  true — misfire accounting stays bounded instead of replaying history. */
export function enumerateDue(
  trigger: NormalizedTrigger,
  timezone: string,
  fromInclusive: string | number,
  throughInclusive: string | number,
  limit: number,
): { occurrences: string[]; truncated: boolean } {
  const capped = Math.max(0, Math.min(Math.floor(limit), SCHEDULE_ENUMERATION_HARD_CAP));
  const fromMs = typeof fromInclusive === 'number' ? fromInclusive : Date.parse(fromInclusive);
  const throughMs = typeof throughInclusive === 'number' ? throughInclusive : Date.parse(throughInclusive);
  if (!Number.isFinite(fromMs) || !Number.isFinite(throughMs)) {
    throw scheduleFailure('INVALID_ARGUMENT', 'enumeration bounds must be instants');
  }
  if (throughMs < fromMs) return { occurrences: [], truncated: false };
  if (trigger.kind === 'once') {
    const atMs = Date.parse(trigger.at);
    return atMs >= fromMs && atMs <= throughMs
      ? { occurrences: [new Date(atMs).toISOString()], truncated: false }
      : { occurrences: [], truncated: false };
  }
  const occurrences: string[] = [];
  let cursor = nextOccurrence(trigger, timezone, fromMs - 1);
  let truncated = false;
  while (cursor !== null) {
    const atMs = Date.parse(cursor);
    if (atMs > throughMs) break;
    if (occurrences.length === capped) {
      truncated = true;
      break;
    }
    occurrences.push(cursor);
    cursor = nextOccurrence(trigger, timezone, atMs);
  }
  return { occurrences, truncated };
}
