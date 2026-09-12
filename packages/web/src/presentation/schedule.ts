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

export function triggerSummary(trigger: ScheduleTrigger, t: Translate): string {
  switch (trigger.kind) {
    case 'once':
      return `${t('schedule.trigger.once')} · ${formatScheduleDateTime(trigger.at)}`;
    case 'interval':
      return `${t('schedule.trigger.interval')} · ${formatInterval(trigger.every_ms)}`;
    case 'cron':
      return `${t('schedule.trigger.cron')} · ${trigger.expression}`;
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
 *  authoritative (closed error codes surface through the operation run). */
export function validateScheduleDraft(draft: {
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
  timezone: string;
}): string | null {
  if (draft.name.trim().length === 0) return 'schedule.form.error.nameRequired';
  if ([...draft.name.trim()].length > MAX_NAME_CODEPOINTS) return 'schedule.form.error.nameTooLong';
  if (draft.prompt.trim().length === 0) return 'schedule.form.error.promptRequired';
  if (new TextEncoder().encode(draft.prompt).length > MAX_PROMPT_BYTES) return 'schedule.form.error.promptTooLong';
  if (draft.timezone.trim().length === 0) return 'schedule.form.error.timezoneRequired';
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
