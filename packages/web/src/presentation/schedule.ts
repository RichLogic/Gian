/**
 * Pure presentation helpers for the Timer surface (Issue #51 / ADR-0053):
 * trigger/status/run formatting shared by the list, the detail Definition
 * form, and the create-confirmation card. All functions are deterministic
 * (no implicit locale or clock access beyond an explicit `now`), so tests
 * can assert exact strings.
 */
import {
  MAX_NAME_CODEPOINTS,
  MAX_PROMPT_BYTES,
  MIN_INTERVAL_MS,
  type Schedule,
  type ScheduleMisfirePolicy,
  type ScheduleRun,
  type ScheduleRunStatus,
  type ScheduleStatus,
  type ScheduleTrigger,
} from '@gian/shared';

type Translate = (key: string) => string;

/** `YYYY-MM-DD HH:mm` in the viewer's local timezone — deterministic across
 *  locales (unlike toLocaleString), matching the compact management UI. */
export function formatScheduleDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Relative future label for next_run_at ("in 5m" style); past/invalid
 *  values fall back to the absolute timestamp. */
export function formatNextRun(iso: string | null, t: Translate, now: number = Date.now()): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const delta = at - now;
  if (delta < 60_000) {
    return delta <= 0 ? formatScheduleDateTime(iso) : t('schedule.time.soon');
  }
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return t('schedule.time.inMinutes').replace('{n}', String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('schedule.time.inHours').replace('{n}', String(hours));
  const days = Math.round(hours / 24);
  return t('schedule.time.inDays').replace('{n}', String(days));
}

/** Compact interval label for the list column and the confirmation card. */
export function formatInterval(everyMs: number): string {
  if (everyMs % 86_400_000 === 0) return `${everyMs / 86_400_000}d`;
  if (everyMs % 3_600_000 === 0) return `${everyMs / 3_600_000}h`;
  if (everyMs % 60_000 === 0) return `${everyMs / 60_000}m`;
  return `${Math.round(everyMs / 60_000)}m`;
}

/** Humanized trigger label for the list row and the confirmation card
 *  (2026-09-15 owner: raw cron expressions never reach the UI — a cron the
 *  structured editor cannot parse falls back to the verbatim expression). */
export function frequencySummary(trigger: ScheduleTrigger, t: Translate): string {
  switch (trigger.kind) {
    case 'once':
      return `${t('schedule.trigger.once')} · ${formatScheduleDateTime(trigger.at)}`;
    case 'interval': {
      const parts = intervalToParts(trigger.every_ms);
      const key = parts.unit === 'minutes' ? 'schedule.frequency.everyMinutes'
        : parts.unit === 'hours' ? 'schedule.frequency.everyHours'
        : 'schedule.frequency.everyDays';
      return t(key).replace('{n}', String(parts.value));
    }
    case 'cron': {
      const spec = parseCronToSpec(trigger.expression);
      if (!spec) return trigger.expression;
      const mm = pad2(spec.minute);
      switch (spec.repeats) {
        case 'hourly':
          return spec.every > 1
            ? t('schedule.frequency.hourlyEvery').replace('{n}', String(spec.every)).replace('{mm}', mm)
            : t('schedule.frequency.hourly').replace('{mm}', mm);
        case 'daily':
          return spec.every > 1
            ? t('schedule.frequency.dailyEvery').replace('{n}', String(spec.every)).replace('{time}', spec.time)
            : t('schedule.frequency.daily').replace('{time}', spec.time);
        case 'weekly': {
          const dows = [...spec.weekdays]
            .sort((a, b) => a - b)
            .map(day => t(`schedule.weekday.short.${day}`))
            .join(t('schedule.frequency.join'));
          return t('schedule.frequency.weekly').replace('{dows}', dows).replace('{time}', spec.time);
        }
        case 'monthly':
          return spec.every > 1
            ? t('schedule.frequency.monthlyEvery')
              .replace('{n}', String(spec.every))
              .replace('{d}', String(spec.monthDay))
              .replace('{time}', spec.time)
            : t('schedule.frequency.monthly')
              .replace('{d}', String(spec.monthDay))
              .replace('{time}', spec.time);
        case 'yearly':
          return t('schedule.frequency.yearly')
            .replace('{month}', String(spec.month))
            .replace('{d}', String(spec.monthDay))
            .replace('{time}', spec.time);
      }
    }
  }
}

export function scheduleStatusLabelKey(status: ScheduleStatus): string {
  return `schedule.status.${status}`;
}

export function scheduleStatusReasonLabelKey(reason: Schedule['status_reason']): string | null {
  return reason ? `schedule.statusReason.${reason}` : null;
}

export function runStatusLabelKey(status: ScheduleRunStatus): string {
  return `schedule.run.status.${status}`;
}

/** i18n key for a durable run error code; unknown codes render verbatim. */
export function runErrorLabelKey(code: string): string {
  return `schedule.runError.${code}`;
}

export function misfirePolicyLabelKey(policy: ScheduleMisfirePolicy): string {
  return `schedule.misfire.${policy}`;
}

/** Elapsed run duration ("8s" / "1m 03s" — same style as turn elapsed). */
export function runDurationLabel(run: ScheduleRun): string | null {
  if (!run.started_at) return null;
  const start = Date.parse(run.started_at);
  const end = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
    : `${seconds}s`;
}

/** Runs that still own the Schedule's single active-execution slot. */
export function isLiveRunStatus(status: ScheduleRunStatus): boolean {
  return status === 'scheduled'
    || status === 'starting'
    || status === 'running'
    || status === 'waiting_interaction';
}

// ── Definition form helpers ────────────────────────────────────────────────

export type IntervalUnit = 'minutes' | 'hours' | 'days';

export const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** Split every_ms into the largest exact unit for the interval editor. */
export function intervalToParts(everyMs: number): { value: number; unit: IntervalUnit } {
  if (everyMs % INTERVAL_UNIT_MS.days === 0) return { value: everyMs / INTERVAL_UNIT_MS.days, unit: 'days' };
  if (everyMs % INTERVAL_UNIT_MS.hours === 0) return { value: everyMs / INTERVAL_UNIT_MS.hours, unit: 'hours' };
  return { value: Math.max(1, Math.round(everyMs / INTERVAL_UNIT_MS.minutes)), unit: 'minutes' };
}

export function intervalPartsToMs(value: number, unit: IntervalUnit): number {
  return Math.round(value * INTERVAL_UNIT_MS[unit]);
}

/** The Definition form's client-side validation; the Host remains
 *  authoritative (closed error codes surface through the operation run).
 *  Timezone is no longer a draft field (2026-09-15 owner): saves always use
 *  the viewer's system timezone. */
export function validateScheduleDraft(draft: {
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
}): string | null {
  if (draft.name.trim().length === 0) return 'schedule.form.error.nameRequired';
  if ([...draft.name.trim()].length > MAX_NAME_CODEPOINTS) return 'schedule.form.error.nameTooLong';
  if (draft.prompt.trim().length === 0) return 'schedule.form.error.promptRequired';
  if (new TextEncoder().encode(draft.prompt).length > MAX_PROMPT_BYTES) return 'schedule.form.error.promptTooLong';
  switch (draft.trigger.kind) {
    case 'once':
      if (!Number.isFinite(Date.parse(draft.trigger.at))) return 'schedule.form.error.onceInvalid';
      return null;
    case 'interval':
      if (draft.trigger.every_ms < MIN_INTERVAL_MS) return 'schedule.form.error.intervalTooShort';
      return null;
    case 'cron':
      if (draft.trigger.expression.trim().length === 0) return 'schedule.form.error.cronRequired';
      return null;
  }
}

/** datetime-local input value (local wall time) → RFC3339 instant. */
export function localInputToInstant(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** RFC3339 instant → datetime-local input value (local wall time). */
export function instantToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── Structured frequency editor (Codex-style, 2026-09-15 owner) ────────────
// The Definition form never exposes a raw cron input: a "Custom" repeat is
// edited as structured rows and compiled to the 5-field cron the Host model
// stores. Only the patterns below round-trip; anything else an agent created
// falls back to a read-only row until the user converts it.

export type FrequencyRepeats = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CustomFrequencySpec {
  repeats: FrequencyRepeats;
  /** Every N units — only where a 5-field cron can express it
   *  (hourly/daily/monthly). Weekly and yearly are always 1. */
  every: number;
  /** Hourly: minute of the hour (0–59). */
  minute: number;
  /** Daily and longer: local wall time "HH:MM" (24h, zero-padded). */
  time: string;
  /** Weekly: cron weekday numbers (0 = Sunday … 6 = Saturday), at least one. */
  weekdays: number[];
  /** Monthly/Yearly: day of month (1–31). */
  monthDay: number;
  /** Yearly: month (1–12). */
  month: number;
}

export const DEFAULT_CUSTOM_FREQUENCY: CustomFrequencySpec = {
  repeats: 'daily',
  every: 1,
  minute: 0,
  time: '09:00',
  weekdays: [1],
  monthDay: 1,
  month: 1,
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function buildCronFromSpec(spec: CustomFrequencySpec): string {
  const [hourText, minuteText] = spec.time.split(':');
  const hour = Number(hourText);
  const minute = spec.repeats === 'hourly' ? spec.minute : Number(minuteText);
  switch (spec.repeats) {
    case 'hourly':
      return `${minute} ${spec.every > 1 ? `*/${spec.every}` : '*'} * * *`;
    case 'daily':
      return `${minute} ${hour} ${spec.every > 1 ? `*/${spec.every}` : '*'} * *`;
    case 'weekly': {
      const dows = [...new Set(spec.weekdays)].sort((a, b) => a - b).join(',');
      return `${minute} ${hour} * * ${dows.length > 0 ? dows : '*'}`;
    }
    case 'monthly':
      return `${minute} ${hour} ${spec.monthDay} ${spec.every > 1 ? `*/${spec.every}` : '*'} *`;
    case 'yearly':
      return `${minute} ${hour} ${spec.monthDay} ${spec.month} *`;
  }
}

function isNumericField(field: string): boolean {
  return /^\d+$/.test(field);
}

/** Parse a cron step field: bare star → every (1), star-slash-N → every N;
 *  anything else is not a step field (null). */
function parseStepField(field: string): number | null {
  if (field === '*') return 1;
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;
  const step = Number(match[1]);
  return step >= 1 ? step : null;
}

/** Exact inverse of buildCronFromSpec for the generated patterns (plus plain
 *  numeric variants of the same shapes). Returns null for everything else —
 *  the form shows those as a read-only raw row. */
export function parseCronToSpec(expression: string): CustomFrequencySpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  if (!isNumericField(minuteF)) return null;
  const minute = Number(minuteF);
  if (minute > 59) return null;

  // Hourly: "M * * * *" / "M */N * * *"
  const hourStep = parseStepField(hourF);
  if (hourStep !== null && domF === '*' && monthF === '*' && dowF === '*') {
    return { ...DEFAULT_CUSTOM_FREQUENCY, repeats: 'hourly', every: hourStep, minute };
  }

  if (!isNumericField(hourF)) return null;
  const hour = Number(hourF);
  if (hour > 23) return null;
  const time = `${pad2(hour)}:${pad2(minute)}`;

  // Daily: "m h * * *" / "m h */N * *"
  const domStep = parseStepField(domF);
  if (domStep !== null && monthF === '*' && dowF === '*') {
    return { ...DEFAULT_CUSTOM_FREQUENCY, repeats: 'daily', every: domStep, time };
  }

  // Weekly: "m h * * d1,d2"
  if (domF === '*' && monthF === '*' && /^\d+(,\d+)*$/.test(dowF)) {
    const weekdays = dowF.split(',').map(Number);
    if (weekdays.length === 0 || weekdays.some(day => day < 0 || day > 7)) return null;
    return {
      ...DEFAULT_CUSTOM_FREQUENCY,
      repeats: 'weekly',
      weekdays: [...new Set(weekdays.map(day => day % 7))],
      time,
    };
  }

  // Monthly: "m h D * *" / "m h D */N *"
  const monthStep = parseStepField(monthF);
  if (isNumericField(domF) && monthStep !== null && dowF === '*') {
    const monthDay = Number(domF);
    if (monthDay < 1 || monthDay > 31) return null;
    return { ...DEFAULT_CUSTOM_FREQUENCY, repeats: 'monthly', every: monthStep, monthDay, time };
  }

  // Yearly: "m h D MO *"
  if (isNumericField(domF) && isNumericField(monthF) && dowF === '*') {
    const monthDay = Number(domF);
    const month = Number(monthF);
    if (monthDay < 1 || monthDay > 31 || month < 1 || month > 12) return null;
    return { ...DEFAULT_CUSTOM_FREQUENCY, repeats: 'yearly', monthDay, month, time };
  }

  return null;
}
