/**
 * Schedule detail (Issue #51 / ADR-0053): opened in panel 2 of the Timer
 * page (the shared `.p2` shell, same as the Agents/Custom details — the
 * schedule list stays mounted beside it; narrow windows swap the list for
 * the panel and show a Back button). Two tabs:
 *
 * - Definition: edit name / prompt / trigger (once · interval · cron) /
 *   timezone / misfire policy. The conversation binding (control Session,
 *   Agent, Workspace) is immutable and rendered read-only. Saves dispatch
 *   `schedule.update` with the row's expected_revision; a 409 revision
 *   conflict reloads the canonical state and shows a localized notice.
 * - Runs: the durable, cursor-paginated run log. A bound_session Run opens
 *   its control conversation focused on the Turn; a fork Run opens the
 *   hidden Fork transcript inline inside the same panel (never the session
 *   rail) and Back returns here.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Executor, Session } from '@gian/shared';
import type {
  Schedule,
  ScheduleMisfirePolicy,
  ScheduleRun,
  ScheduleTrigger,
} from '@gian/shared';
import { MIN_INTERVAL_MS } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { confirm } from '../feedback.js';
import { useScheduleDetail } from '../controllers/use-schedules.js';
import {
  SCHEDULE_REVISION_CONFLICT_MESSAGE,
  scheduleEntityKey,
} from '../operations/schedule.js';
import {
  useOperationDispatch,
  useOperationRun,
  usePendingOperations,
} from '../operations/use-operations.js';
import {
  buildCronFromSpec,
  DEFAULT_CUSTOM_FREQUENCY,
  formatScheduleDateTime,
  instantToLocalInput,
  intervalPartsToMs,
  intervalToParts,
  localInputToInstant,
  misfirePolicyLabelKey,
  parseCronToSpec,
  runDurationLabel,
  runErrorLabelKey,
  runStatusLabelKey,
  scheduleStatusLabelKey,
  validateScheduleDraft,
  type CustomFrequencySpec,
  type IntervalUnit,
} from '../presentation/schedule.js';
import { ScheduleForkTranscript } from './ScheduleForkTranscript.js';

type DetailTab = 'definition' | 'runs';

export function ScheduleDetail({
  scheduleId,
  sessions,
  showBack = false,
  onBack,
  onOpenScheduledTurn,
  onOpenConversation,
}: {
  scheduleId: string;
  sessions: Session[];
  /** Narrow layout: the panel replaced the list, so the head shows a Back
   *  chevron (in addition to the always-present Close). */
  showBack?: boolean;
  onBack: () => void;
  onOpenScheduledTurn: (sessionId: string, runId: string) => void;
  /** Definition "Runs in" row: open the control conversation (no Turn
   *  focus). The binding itself stays immutable (ADR-0053). */
  onOpenConversation: (sessionId: string) => void;
}) {
  const t = useT();
  const detail = useScheduleDetail(scheduleId);
  const [tab, setTab] = useState<DetailTab>('definition');
  // Hidden Fork transcript overlay state (Run log → inline read-only view).
  const [forkView, setForkView] = useState<{
    sessionId: string;
    runId: string;
    executor: Executor;
  } | null>(null);

  useEffect(() => {
    setTab('definition');
    setForkView(null);
  }, [scheduleId]);

  const schedule = detail.schedule;
  const controlSession = schedule
    ? sessions.find(session => session.id === schedule.control_session_id) ?? null
    : null;

  if (forkView && schedule) {
    return (
      <ScheduleForkTranscript
        sessionId={forkView.sessionId}
        runId={forkView.runId}
        scheduleId={schedule.id}
        scheduleName={schedule.name}
        executor={forkView.executor}
        onBack={() => setForkView(null)}
      />
    );
  }

  return (
    <>
      <div className="p2-head schedule-detail-head">
        {showBack && (
          <button
            type="button"
            className="btn icon ghost"
            data-testid="schedule-back"
            aria-label={t('timer.back')}
            onClick={onBack}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        {schedule && (
          <>
            <span className="p2-title schedule-detail-name">{schedule.name}</span>
            <span className={`timer-status is-${schedule.status}`}>
              {t(scheduleStatusLabelKey(schedule.status))}
            </span>
            <span className="spacer" />
            <ScheduleDetailActions
              schedule={schedule}
              onChanged={() => {
                void detail.refresh();
                void detail.runs.refresh();
              }}
            />
          </>
        )}
        {!schedule && <span className="spacer" />}
        <button
          type="button"
          className="btn icon ghost"
          data-testid="schedule-close"
          aria-label={t('common.close')}
          onClick={onBack}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      {schedule && (
        <div className="schedule-tabs" role="tablist" aria-label={t('timer.detail.tabs')}>
          {(['definition', 'runs'] as const).map(key => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`schedule-tab${tab === key ? ' active' : ''}`}
              data-testid={`schedule-tab-${key}`}
              onClick={() => setTab(key)}
            >
              {t(`timer.tab.${key}`)}
            </button>
          ))}
        </div>
      )}
      <div className="p2-body">
        {detail.error && !schedule && (
          <div className="spaces-error" role="alert" data-testid="schedule-error">
            <span>{detail.error}</span>
            <button type="button" className="btn xs" onClick={() => void detail.refresh()}>
              {t('timer.retry')}
            </button>
          </div>
        )}
        {detail.loading && !schedule && (
          <div className="timer-state" data-testid="schedule-loading">
            <span className="spinner" />
            <span>{t('timer.loading')}</span>
          </div>
        )}
        {schedule && (
          tab === 'definition' ? (
            <DefinitionForm
              schedule={schedule}
              controlSession={controlSession}
              onOpenConversation={onOpenConversation}
              onSaved={() => void detail.refresh()}
            />
          ) : (
            <RunsList
              runs={detail.runs}
              onOpenRun={run => {
                if (run.execution_mode === 'fork' && run.target_session_id) {
                  const resolvedPluginId = run.resolved_config?.proxy;
                  setForkView({
                    sessionId: run.target_session_id,
                    runId: run.id,
                    executor: typeof resolvedPluginId === 'string' && resolvedPluginId.length > 0
                      ? resolvedPluginId
                      : controlSession?.proxy_plugin_id ?? controlSession?.executor ?? 'claude',
                  });
                } else if (run.execution_mode === 'bound_session' && run.target_session_id) {
                  onOpenScheduledTurn(run.target_session_id, run.id);
                }
              }}
            />
          )
        )}
      </div>
    </>
  );
}

/** Header actions mirror the list row: pause/resume · run now · archive
 *  (confirmed). All are pending schedule.* operations keyed to the entity;
 *  a confirmed run refreshes the canonical definition (the Host's
 *  `schedule:changed` broadcast does the same for every other client). */
function ScheduleDetailActions({
  schedule,
  onChanged,
}: {
  schedule: Schedule;
  onChanged: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const pending = usePendingOperations(scheduleEntityKey(schedule.id));
  const busy = pending.length > 0;
  const archived = schedule.status === 'archived';
  const completed = schedule.status === 'completed';
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const run = useOperationRun(runId);

  useEffect(() => {
    if (run?.phase === 'confirmed' || run?.phase === 'failed' || run?.phase === 'timed-out') {
      setRunId(undefined);
      onChanged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.phase]);

  return (
    <span className="schedule-detail-actions">
      {!archived && !completed && (
        <button
          type="button"
          className="btn sm ghost"
          data-testid="schedule-action-toggle"
          disabled={busy}
          onClick={() => {
            const dispatched = dispatch(schedule.status === 'paused' ? 'schedule.resume' : 'schedule.pause', {
              scheduleId: schedule.id,
              expectedRevision: schedule.revision,
            });
            setRunId(dispatched.id);
          }}
        >
          {schedule.status === 'paused' ? t('timer.action.resume') : t('timer.action.pause')}
        </button>
      )}
      {!archived && (
        <button
          type="button"
          className="btn sm ghost"
          data-testid="schedule-action-run"
          disabled={busy}
          onClick={() => setRunId(dispatch('schedule.runNow', { scheduleId: schedule.id }).id)}
        >
          {t('timer.action.runNow')}
        </button>
      )}
      {!archived && (
        <button
          type="button"
          className="btn sm danger-ghost"
          data-testid="schedule-action-archive"
          disabled={busy}
          onClick={() => {
            void confirm({
              title: t('timer.archive.title'),
              message: t('timer.archive.message').replace('{name}', schedule.name),
              confirmLabel: t('timer.archive.confirm'),
              danger: true,
            }).then(accepted => {
              if (accepted) {
                setRunId(dispatch('schedule.archive', {
                  scheduleId: schedule.id,
                  expectedRevision: schedule.revision,
                }).id);
              }
            });
          }}
        >
          {t('timer.action.archive')}
        </button>
      )}
    </span>
  );
}

// ── Definition tab ─────────────────────────────────────────────────────────

interface Draft {
  name: string;
  prompt: string;
  misfirePolicy: ScheduleMisfirePolicy;
  /** The Codex-style "Repeat" row (2026-09-15 owner): users never type a
   *  cron expression — a Custom repeat edits structured rows that compile
   *  to the stored 5-field cron. */
  repeat: 'once' | 'interval' | 'custom';
  onceLocal: string;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  intervalAnchorAt: string | null;
  custom: CustomFrequencySpec;
  /** An existing cron the structured editor cannot express: shown read-only
   *  until the user converts it (picks structured editing). */
  rawCron: string | null;
}

function draftFromSchedule(schedule: Schedule): Draft {
  const trigger = schedule.trigger;
  let custom = DEFAULT_CUSTOM_FREQUENCY;
  let rawCron: string | null = null;
  if (trigger.kind === 'cron') {
    const spec = parseCronToSpec(trigger.expression);
    if (spec) custom = spec;
    else rawCron = trigger.expression;
  }
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    misfirePolicy: schedule.misfire_policy,
    repeat: trigger.kind === 'once' ? 'once' : trigger.kind === 'interval' ? 'interval' : 'custom',
    onceLocal: trigger.kind === 'once' ? instantToLocalInput(trigger.at) : '',
    intervalValue: trigger.kind === 'interval'
      ? intervalToParts(trigger.every_ms).value
      : 30,
    intervalUnit: trigger.kind === 'interval'
      ? intervalToParts(trigger.every_ms).unit
      : 'minutes',
    intervalAnchorAt: trigger.kind === 'interval'
      ? trigger.anchor_at
      : null,
    custom,
    rawCron,
  };
}

function draftTrigger(draft: Draft): ScheduleTrigger | null {
  switch (draft.repeat) {
    case 'once': {
      const at = localInputToInstant(draft.onceLocal);
      return at ? { kind: 'once', at } : null;
    }
    case 'interval':
      return {
        kind: 'interval',
        every_ms: intervalPartsToMs(draft.intervalValue, draft.intervalUnit),
        anchor_at: draft.intervalAnchorAt ?? new Date().toISOString(),
      };
    case 'custom':
      return draft.rawCron !== null
        ? { kind: 'cron', expression: draft.rawCron }
        : { kind: 'cron', expression: buildCronFromSpec(draft.custom) };
  }
}

/** Timezone is not a draft field (2026-09-15 owner): saves always pin the
 *  viewer's system timezone. */
function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function DefinitionForm({
  schedule,
  controlSession,
  onOpenConversation,
  onSaved,
}: {
  schedule: Schedule;
  controlSession: Session | null;
  onOpenConversation: (sessionId: string) => void;
  onSaved: () => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const readOnly = schedule.status === 'archived' || schedule.status === 'completed';
  const [draft, setDraft] = useState<Draft>(() => draftFromSchedule(schedule));
  const [dirty, setDirty] = useState(false);
  const [saveRunId, setSaveRunId] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const saveRun = useOperationRun(saveRunId);
  const saving = saveRun?.phase === 'pending';

  // Re-seed the draft when a different schedule opens, or when canonical
  // state changes underneath an untouched form. Never clobber local edits.
  useEffect(() => {
    if (!dirty) setDraft(draftFromSchedule(schedule));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule.id, schedule.revision, dirty]);

  useEffect(() => {
    if (!saveRun) return;
    if (saveRun.phase === 'confirmed') {
      setSaveRunId(undefined);
      setDirty(false);
      setFormError(null);
      setConflict(false);
      onSaved();
    } else if (saveRun.phase === 'failed' || saveRun.phase === 'timed-out') {
      const message = saveRun.error ?? '';
      if (message === SCHEDULE_REVISION_CONFLICT_MESSAGE) {
        // 409: reload canonical state and surface the conflict notice; the
        // user's draft stays intact so they can re-apply deliberately.
        setConflict(true);
        setFormError(null);
        onSaved();
      } else {
        setFormError(message || t('schedule.form.error.saveFailed'));
        if (saveRun.phase === 'timed-out') onSaved();
      }
      setSaveRunId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveRun?.phase]);

  const patch = (partial: Partial<Draft>) => {
    setDraft(previous => ({ ...previous, ...partial }));
    setDirty(true);
    setConflict(false);
  };

  function save() {
    const trigger = draftTrigger(draft);
    if (!trigger) {
      setFormError(t('schedule.form.error.onceInvalid'));
      return;
    }
    const invalidKey = validateScheduleDraft({
      name: draft.name,
      prompt: draft.prompt,
      trigger,
    });
    if (invalidKey) {
      setFormError(t(invalidKey));
      return;
    }
    setFormError(null);
    const run = dispatch('schedule.update', {
      scheduleId: schedule.id,
      expectedRevision: schedule.revision,
      name: draft.name.trim(),
      prompt: draft.prompt,
      trigger,
      timezone: systemTimezone(),
      misfirePolicy: draft.misfirePolicy,
    });
    setSaveRunId(run.id);
  }

  const ownerLine = [
    schedule.control_session_title ?? t('timer.conversation.unknown'),
    [schedule.agent_name, schedule.workspace_name].filter(Boolean).join(' · ') || null,
  ].filter(Boolean);

  return (
    <div className="schedule-form" data-testid="schedule-definition">
      {conflict && (
        <div className="schedule-conflict" role="alert" data-testid="schedule-conflict">
          {t('schedule.form.conflict')}
        </div>
      )}
      <div className="schedule-field">
        <span className="schedule-label">{t('schedule.form.runsIn')}</span>
        <div className="schedule-runsin">
          <span className="schedule-static ellip" data-testid="schedule-conversation">
            {ownerLine.join(' — ')}
          </span>
          <button
            type="button"
            className="btn sm ghost schedule-openchat"
            data-testid="schedule-open-chat"
            disabled={!controlSession}
            title={t('schedule.form.openChat')}
            onClick={() => {
              if (controlSession) onOpenConversation(controlSession.id);
            }}
          >
            {t('schedule.form.openChat')}
          </button>
        </div>
      </div>
      <label className="schedule-field">
        <span className="schedule-label">{t('schedule.form.name')}</span>
        <input
          type="text"
          className="schedule-input"
          data-testid="schedule-field-name"
          value={draft.name}
          disabled={readOnly}
          onChange={event => patch({ name: event.target.value })}
        />
      </label>
      <label className="schedule-field">
        <span className="schedule-label">{t('schedule.form.prompt')}</span>
        <textarea
          className="schedule-input schedule-prompt"
          data-testid="schedule-field-prompt"
          value={draft.prompt}
          disabled={readOnly}
          rows={5}
          onChange={event => patch({ prompt: event.target.value })}
        />
      </label>
      <FrequencyEditor draft={draft} readOnly={readOnly} onChange={patch} />
      <label className="schedule-field">
        <span className="schedule-label">{t('schedule.form.misfire')}</span>
        <select
          className="schedule-input"
          data-testid="schedule-field-misfire"
          value={draft.misfirePolicy}
          disabled={readOnly}
          onChange={event => patch({ misfirePolicy: event.target.value as ScheduleMisfirePolicy })}
        >
          <option value="skip">{t(misfirePolicyLabelKey('skip'))}</option>
          <option value="run_once">{t(misfirePolicyLabelKey('run_once'))}</option>
        </select>
      </label>
      {formError && (
        <div className="schedule-form-error" role="alert" data-testid="schedule-form-error">
          {formError}
        </div>
      )}
      {!readOnly && (
        <div className="schedule-form-actions">
          <button
            type="button"
            className="btn sm primary"
            data-testid="schedule-save"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? t('schedule.form.saving') : t('schedule.form.save')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Codex-style frequency card (2026-09-15 owner): label left, control
 *  right, hairline between rows. Compiles to the stored trigger model —
 *  users never type a cron expression. */
function FrequencyEditor({
  draft,
  readOnly,
  onChange,
}: {
  draft: Draft;
  readOnly: boolean;
  onChange: (partial: Partial<Draft>) => void;
}) {
  const t = useT();
  const custom = draft.custom;
  const patchCustom = (partial: Partial<CustomFrequencySpec>) => {
    onChange({ custom: { ...custom, ...partial }, ...(draft.rawCron !== null ? { rawCron: null } : {}) });
  };
  const unitKey = custom.repeats === 'hourly'
    ? 'schedule.interval.hours'
    : custom.repeats === 'monthly'
      ? 'schedule.freq.unit.months'
      : 'schedule.interval.days';
  const showEvery = custom.repeats === 'hourly' || custom.repeats === 'daily' || custom.repeats === 'monthly';

  return (
    <div className="schedule-field">
      <span className="schedule-label">{t('schedule.form.trigger')}</span>
      <div className="schedule-freq" data-testid="schedule-frequency">
        <div className="schedule-freq-row">
          <span className="schedule-freq-label">{t('schedule.freq.repeat')}</span>
          <select
            className="schedule-input schedule-freq-select"
            data-testid="schedule-repeat"
            value={draft.repeat}
            disabled={readOnly}
            onChange={event => onChange({ repeat: event.target.value as Draft['repeat'] })}
          >
            <option value="once">{t('schedule.repeat.once')}</option>
            <option value="interval">{t('schedule.repeat.interval')}</option>
            <option value="custom">{t('schedule.repeat.custom')}</option>
          </select>
        </div>

        {draft.repeat === 'once' && (
          <div className="schedule-freq-row">
            <span className="schedule-freq-label">{t('schedule.freq.at')}</span>
            <input
              type="datetime-local"
              className="schedule-input"
              data-testid="schedule-trigger-once-at"
              value={draft.onceLocal}
              disabled={readOnly}
              onChange={event => onChange({ onceLocal: event.target.value })}
            />
          </div>
        )}

        {draft.repeat === 'interval' && (
          <div className="schedule-freq-row">
            <span className="schedule-freq-label">{t('schedule.freq.every')}</span>
            <span className="schedule-freq-controls">
              <input
                type="number"
                min={1}
                className="schedule-input schedule-freq-number"
                data-testid="schedule-trigger-interval-value"
                value={draft.intervalValue}
                disabled={readOnly}
                onChange={event => onChange({ intervalValue: Number(event.target.value) })}
              />
              <select
                className="schedule-input schedule-freq-select"
                data-testid="schedule-trigger-interval-unit"
                value={draft.intervalUnit}
                disabled={readOnly}
                onChange={event => onChange({ intervalUnit: event.target.value as IntervalUnit })}
              >
                <option value="minutes">{t('schedule.interval.minutes')}</option>
                <option value="hours">{t('schedule.interval.hours')}</option>
                <option value="days">{t('schedule.interval.days')}</option>
              </select>
            </span>
          </div>
        )}

        {draft.repeat === 'custom' && draft.rawCron !== null && (
          <div className="schedule-freq-row">
            <span className="schedule-freq-label">{t('schedule.form.cronRaw')}</span>
            <span className="schedule-freq-controls">
              <code className="schedule-freq-raw" data-testid="schedule-cron-raw">{draft.rawCron}</code>
              {!readOnly && (
                <button
                  type="button"
                  className="btn xs ghost"
                  data-testid="schedule-cron-convert"
                  onClick={() => onChange({ rawCron: null })}
                >
                  {t('schedule.form.cronConvert')}
                </button>
              )}
            </span>
          </div>
        )}

        {draft.repeat === 'custom' && draft.rawCron === null && (
          <>
            <div className="schedule-freq-row">
              <span className="schedule-freq-label">{t('schedule.freq.repeats')}</span>
              <select
                className="schedule-input schedule-freq-select"
                data-testid="schedule-repeats"
                value={custom.repeats}
                disabled={readOnly}
                onChange={event => patchCustom({ repeats: event.target.value as CustomFrequencySpec['repeats'] })}
              >
                <option value="hourly">{t('schedule.repeats.hourly')}</option>
                <option value="daily">{t('schedule.repeats.daily')}</option>
                <option value="weekly">{t('schedule.repeats.weekly')}</option>
                <option value="monthly">{t('schedule.repeats.monthly')}</option>
                <option value="yearly">{t('schedule.repeats.yearly')}</option>
              </select>
            </div>
            {showEvery && (
              <div className="schedule-freq-row">
                <span className="schedule-freq-label">{t('schedule.freq.every')}</span>
                <span className="schedule-freq-controls">
                  <input
                    type="number"
                    min={1}
                    className="schedule-input schedule-freq-number"
                    data-testid="schedule-custom-every"
                    value={custom.every}
                    disabled={readOnly}
                    onChange={event => patchCustom({ every: Math.max(1, Number(event.target.value)) })}
                  />
                  <span className="schedule-freq-unit">{t(unitKey)}</span>
                </span>
              </div>
            )}
            {custom.repeats === 'hourly' && (
              <div className="schedule-freq-row">
                <span className="schedule-freq-label">{t('schedule.freq.atMinute')}</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  className="schedule-input schedule-freq-number"
                  data-testid="schedule-custom-minute"
                  value={custom.minute}
                  disabled={readOnly}
                  onChange={event => patchCustom({
                    minute: Math.min(59, Math.max(0, Number(event.target.value))),
                  })}
                />
              </div>
            )}
            {custom.repeats === 'weekly' && (
              <div className="schedule-freq-row">
                <span className="schedule-freq-label">{t('schedule.freq.on')}</span>
                <span className="schedule-freq-weekdays" role="group" aria-label={t('schedule.freq.on')}>
                  {[0, 1, 2, 3, 4, 5, 6].map(day => {
                    const on = custom.weekdays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`timer-filter${on ? ' on' : ''}`}
                        data-testid={`schedule-weekday-${day}`}
                        aria-pressed={on}
                        disabled={readOnly}
                        onClick={() => {
                          const next = on
                            ? custom.weekdays.filter(entry => entry !== day)
                            : [...custom.weekdays, day];
                          // Keep at least one weekday — an empty set is not a
                          // valid weekly schedule.
                          if (next.length > 0) patchCustom({ weekdays: next });
                        }}
                      >
                        {t(`schedule.weekday.short.${day}`)}
                      </button>
                    );
                  })}
                </span>
              </div>
            )}
            {(custom.repeats === 'monthly' || custom.repeats === 'yearly') && (
              <div className="schedule-freq-row">
                <span className="schedule-freq-label">{t('schedule.freq.onDays')}</span>
                <span className="schedule-freq-controls">
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className="schedule-input schedule-freq-number"
                    data-testid="schedule-custom-monthday"
                    value={custom.monthDay}
                    disabled={readOnly}
                    onChange={event => patchCustom({
                      monthDay: Math.min(31, Math.max(1, Number(event.target.value))),
                    })}
                  />
                  {custom.monthDay > 28 && (
                    <span className="schedule-hint" data-testid="schedule-monthday-hint">
                      {t('schedule.freq.monthDayHint')}
                    </span>
                  )}
                </span>
              </div>
            )}
            {custom.repeats === 'yearly' && (
              <div className="schedule-freq-row">
                <span className="schedule-freq-label">{t('schedule.freq.in')}</span>
                <select
                  className="schedule-input schedule-freq-select"
                  data-testid="schedule-custom-month"
                  value={custom.month}
                  disabled={readOnly}
                  onChange={event => patchCustom({ month: Number(event.target.value) })}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(month => (
                    <option key={month} value={month}>{t(`schedule.month.short.${month}`)}</option>
                  ))}
                </select>
              </div>
            )}
            {custom.repeats !== 'hourly' && (
              <div className="schedule-freq-row">
                <span className="schedule-freq-label">{t('schedule.freq.at')}</span>
                <input
                  type="time"
                  className="schedule-input"
                  data-testid="schedule-custom-time"
                  value={custom.time}
                  disabled={readOnly}
                  onChange={event => {
                    if (/^\d{2}:\d{2}$/.test(event.target.value)) {
                      patchCustom({ time: event.target.value });
                    }
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
      {draft.repeat === 'interval'
        && intervalPartsToMs(draft.intervalValue, draft.intervalUnit) < MIN_INTERVAL_MS && (
        <span className="schedule-hint" data-testid="schedule-interval-hint">
          {t('schedule.form.error.intervalTooShort')}
        </span>
      )}
    </div>
  );
}

// ── Runs tab ───────────────────────────────────────────────────────────────

function RunsList({
  runs,
  onOpenRun,
}: {
  runs: ReturnType<typeof useScheduleDetail>['runs'];
  onOpenRun: (run: ScheduleRun) => void;
}) {
  const t = useT();
  const rows = useMemo(() => runs.runs, [runs.runs]);

  if (runs.loading && rows.length === 0) {
    return (
      <div className="timer-state" data-testid="schedule-runs-loading">
        <span className="spinner" />
        <span>{t('timer.loading')}</span>
      </div>
    );
  }
  if (runs.error && rows.length === 0) {
    return (
      <div className="spaces-error" role="alert" data-testid="schedule-runs-error">
        <span>{runs.error}</span>
        <button type="button" className="btn xs" onClick={() => void runs.refresh()}>
          {t('timer.retry')}
        </button>
      </div>
    );
  }
  if (rows.length === 0) {
    return <div className="timer-state" data-testid="schedule-runs-empty">{t('timer.runs.empty')}</div>;
  }

  return (
    <div className="timer-table-wrap" data-testid="schedule-runs">
      <table className="timer-table schedule-runs-table">
        <thead>
          <tr>
            <th scope="col">{t('timer.runs.col.scheduledFor')}</th>
            <th scope="col">{t('timer.runs.col.status')}</th>
            <th scope="col">{t('timer.runs.col.started')}</th>
            <th scope="col">{t('timer.runs.col.finished')}</th>
            <th scope="col">{t('timer.runs.col.duration')}</th>
            <th scope="col">{t('timer.runs.col.mode')}</th>
            <th scope="col">{t('timer.runs.col.result')}</th>
            <th scope="col" aria-label={t('timer.col.actions')} />
          </tr>
        </thead>
        <tbody>
          {rows.map(run => (
            <RunRow key={run.id} run={run} onOpenRun={onOpenRun} />
          ))}
        </tbody>
      </table>
      {runs.nextCursor && (
        <div className="timer-more">
          <button
            type="button"
            className="btn sm ghost"
            data-testid="schedule-runs-load-more"
            disabled={runs.loadingMore}
            onClick={() => void runs.loadMore()}
          >
            {runs.loadingMore ? t('timer.loading') : t('timer.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  onOpenRun,
}: {
  run: ScheduleRun;
  onOpenRun: (run: ScheduleRun) => void;
}) {
  const t = useT();
  const duration = runDurationLabel(run);
  const canOpen = (run.execution_mode === 'bound_session' || run.execution_mode === 'fork')
    && run.target_session_id !== null;
  return (
    <tr className="timer-row schedule-run-row" data-testid={`schedule-run-${run.id}`}>
      <td>{formatScheduleDateTime(run.scheduled_for)}</td>
      <td>
        <span className={`timer-status run-${run.status}`}>{t(runStatusLabelKey(run.status))}</span>
      </td>
      <td>{run.started_at ? formatScheduleDateTime(run.started_at) : '—'}</td>
      <td>{run.finished_at ? formatScheduleDateTime(run.finished_at) : '—'}</td>
      <td>{duration ?? '—'}</td>
      <td>{run.execution_mode ? t(`schedule.mode.${run.execution_mode}`) : '—'}</td>
      <td className="schedule-run-result">
        {run.error_code
          ? `${t(runErrorLabelKey(run.error_code))}${run.error_message ? `: ${run.error_message}` : ''}`
          : (run.summary ?? '—')}
      </td>
      <td>
        {canOpen && (
          <button
            type="button"
            className="btn xs ghost"
            data-testid={`schedule-run-open-${run.id}`}
            onClick={() => onOpenRun(run)}
          >
            {run.execution_mode === 'fork'
              ? t('timer.runs.openTranscript')
              : t('timer.runs.openTurn')}
          </button>
        )}
      </td>
    </tr>
  );
}
