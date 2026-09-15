/**
 * Host-enforced schedule create confirmations (Issue #51 / ADR-0053, contract
 * L). Rendered at the App root so the queue survives view switches; fed by
 * the persistent store (controllers/schedule-confirmations.ts) which is
 * hydrated on every WS auth_ok and upserted by `schedule:confirmation`
 * frames. Deliberately NOT part of the Provider Approval / proxy_interactions
 * surface — the confirmation binds the Schedule definition, not a provider
 * action.
 *
 * Multiple pending confirmations are processed strictly sequentially: only
 * the oldest pending card is shown; resolving it reveals the next.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ScheduleConfirmation } from '@gian/shared';
import { useT } from '../i18n/index.js';
import {
  getScheduleConfirmationsSnapshot,
  hydrateScheduleConfirmations,
  pendingScheduleConfirmations,
  subscribeScheduleConfirmations,
  upsertScheduleConfirmation,
} from '../controllers/schedule-confirmations.js';
import { useOperationDispatch, useOperationRun } from '../operations/use-operations.js';
import {
  formatScheduleDateTime,
  frequencySummary,
  misfirePolicyLabelKey,
} from '../presentation/schedule.js';

export function ScheduleConfirmationHost() {
  const snapshot = useSyncExternalStore(
    subscribeScheduleConfirmations,
    getScheduleConfirmationsSnapshot,
    getScheduleConfirmationsSnapshot,
  );
  const queue = pendingScheduleConfirmations(snapshot);
  const current = queue[0] ?? null;
  if (!current) return null;
  return <ScheduleConfirmationCard key={current.id} confirmation={current} remaining={queue.length - 1} />;
}

function ScheduleConfirmationCard({
  confirmation,
  remaining,
}: {
  confirmation: ScheduleConfirmation;
  remaining: number;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  // The FULL prompt must be reviewable before approval: it renders expanded
  // by default; collapsing swaps in the Host's compact summary.
  const [promptCollapsed, setPromptCollapsed] = useState(false);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const run = useOperationRun(runId);
  const submitting = run?.phase === 'pending';

  useEffect(() => {
    if (!run) return;
    if (run.phase === 'confirmed') {
      // The resolved record replaces the pending one; a non-pending status
      // drops the card from the queue (the next pending card appears).
      upsertScheduleConfirmation(run.result as ScheduleConfirmation);
      setRunId(undefined);
    } else if (run.phase === 'failed' || run.phase === 'timed-out') {
      // Keep the card and allow retry — the Tool call is still blocked
      // host-side until this confirmation resolves or expires.
      setError(run.error ?? t('schedule.confirm.failed'));
      setRunId(undefined);
      // The resolve may have committed even when the client timed out, or the
      // confirmation may have expired while its terminal WS frame was missed.
      // Re-read before the user decides whether a retry is needed.
      void hydrateScheduleConfirmations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.phase]);

  const payload = confirmation.payload;
  const conversation = payload.control_session.title ?? t('timer.conversation.unknown');
  const owner = [payload.control_session.agent_name, payload.control_session.workspace_name]
    .filter(Boolean)
    .join(' · ');
  const occurrences = payload.next_occurrences.slice(0, 3);

  function decide(decision: 'approve' | 'reject') {
    if (submitting) return;
    setError(null);
    setRunId(dispatch('schedule.resolveConfirmation', {
      confirmationId: confirmation.id,
      decision,
    }).id);
  }

  return (
    <div className="schedule-confirm-overlay" data-testid="schedule-confirmation-overlay">
      <div
        className="schedule-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-confirm-title"
        data-testid="schedule-confirmation"
      >
        <div className="schedule-confirm-head">
          <span className="schedule-confirm-title" id="schedule-confirm-title">
            {t('schedule.confirm.title')}
          </span>
          {remaining > 0 && (
            <span className="schedule-confirm-more" data-testid="schedule-confirmation-more">
              {t('schedule.confirm.more').replace('{n}', String(remaining))}
            </span>
          )}
        </div>
        <dl className="schedule-confirm-body">
          <div className="schedule-confirm-row">
            <dt>{t('schedule.confirm.name')}</dt>
            <dd data-testid="schedule-confirmation-name">{payload.name}</dd>
          </div>
          <div className="schedule-confirm-row">
            <dt>{t('schedule.confirm.prompt')}</dt>
            <dd>
              <button
                type="button"
                className="schedule-confirm-prompt-toggle"
                data-testid="schedule-confirmation-prompt-toggle"
                aria-expanded={!promptCollapsed}
                onClick={() => setPromptCollapsed(value => !value)}
              >
                {promptCollapsed ? t('schedule.confirm.expand') : t('schedule.confirm.collapse')}
              </button>
              <pre
                className={`schedule-confirm-prompt${promptCollapsed ? ' collapsed' : ''}`}
                data-testid="schedule-confirmation-prompt"
              >
                {promptCollapsed ? payload.prompt_summary : payload.prompt}
              </pre>
            </dd>
          </div>
          <div className="schedule-confirm-row">
            <dt>{t('schedule.form.trigger')}</dt>
            <dd data-testid="schedule-confirmation-trigger">{frequencySummary(payload.trigger, t)}</dd>
          </div>
          <div className="schedule-confirm-row">
            <dt>{t('schedule.form.timezone')}</dt>
            <dd>{payload.timezone}</dd>
          </div>
          <div className="schedule-confirm-row">
            <dt>{t('schedule.form.misfire')}</dt>
            <dd>{t(misfirePolicyLabelKey(payload.misfire_policy))}</dd>
          </div>
          <div className="schedule-confirm-row">
            <dt>{t('schedule.confirm.nextRuns')}</dt>
            <dd>
              <ul className="schedule-confirm-occurrences" data-testid="schedule-confirmation-occurrences">
                {occurrences.map(occurrence => (
                  <li key={occurrence}>{formatScheduleDateTime(occurrence)}</li>
                ))}
              </ul>
            </dd>
          </div>
          <div className="schedule-confirm-row">
            <dt>{t('schedule.confirm.conversation')}</dt>
            <dd data-testid="schedule-confirmation-conversation">
              {owner ? `${conversation} — ${owner}` : conversation}
            </dd>
          </div>
        </dl>
        <p className="schedule-confirm-risk" data-testid="schedule-confirmation-risk">
          {payload.risk_note}
        </p>
        {error && (
          <div className="schedule-form-error" role="alert" data-testid="schedule-confirmation-error">
            {error}
          </div>
        )}
        <div className="schedule-confirm-actions">
          <button
            type="button"
            className="btn sm danger-ghost"
            data-testid="schedule-confirmation-reject"
            disabled={submitting}
            onClick={() => decide('reject')}
          >
            {t('schedule.confirm.reject')}
          </button>
          <button
            type="button"
            className="btn sm primary"
            data-testid="schedule-confirmation-approve"
            disabled={submitting}
            onClick={() => decide('approve')}
          >
            {submitting ? t('schedule.confirm.submitting') : t('schedule.confirm.approve')}
          </button>
        </div>
      </div>
    </div>
  );
}
