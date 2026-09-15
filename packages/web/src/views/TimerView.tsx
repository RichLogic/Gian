/**
 * Timer — the top-level management page for conversation-bound Schedules
 * (Issue #51 / ADR-0053). A quiet, compact, work-oriented surface: the first
 * screen IS the five-column list (name/trigger, status, owning conversation,
 * next run, actions). Creation stays prompt-driven: the 新建定时任务 CTA
 * (list head + empty state, design 04/05/07-B) opens the standard new-session
 * page with a prefilled guidance prompt, and the Schedule itself is still
 * created only by the Gian Tool inside that conversation, behind the
 * Host-enforced confirmation (contract L/M).
 *
 * Data flows: list state lives in useScheduleList (REST + schedule:changed
 * invalidation); every mutation dispatches a schedule.* operation (stable
 * Idempotency-Key, pending policy); a row click opens the detail in panel 2
 * (the shared `.p2` shell, same as the Agents/Custom pages — the list stays
 * mounted beside it, narrow windows swap the list for the panel with a Back
 * affordance).
 */
import { useEffect, useState } from 'react';
import type { Session } from '@gian/shared';
import type { Schedule, ScheduleStatus } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { confirm } from '../feedback.js';
import { useScheduleList } from '../controllers/use-schedules.js';
import { scheduleEntityKey } from '../operations/schedule.js';
import {
  useOperationDispatch,
  useOperationRun,
  usePendingOperations,
} from '../operations/use-operations.js';
import {
  formatNextRun,
  frequencySummary,
  scheduleStatusLabelKey,
  scheduleStatusReasonLabelKey,
} from '../presentation/schedule.js';
import { ScheduleDetail } from '../views/ScheduleDetail.js';
import { Splitter } from '../components/Splitter.js';
import { usePanel2Width } from '../components/RailLayout.js';

/** Media-query hook (same contract as AgentsView): narrow windows (< ~1100px)
 *  swap the list for panel 2. jsdom may lack matchMedia — treat its absence
 *  as "wide". */
function useMediaQuery(queryText: string): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window.matchMedia === 'function'
      && window.matchMedia(queryText).matches
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(queryText);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [queryText]);
  return matches;
}

const I = {
  pause: 'M9 5v14 M15 5v14',
  play: 'M8 5.5v13l11-6.5z',
  archive: 'M4 7h16 M6 7V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2 M6 7l1 13h10l1-13 M10 11v5 M14 11v5',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4',
  plus: 'M12 5v14 M5 12h14',
  alarm: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 9v4l2 2 M5 3 2 6 M22 6l-3-3',
};

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ALL_STATUSES: readonly ScheduleStatus[] = ['active', 'paused', 'completed', 'archived'];
const DEFAULT_STATUSES: readonly ScheduleStatus[] = ['active', 'paused', 'completed'];

export function TimerView({
  sessions,
  selectedScheduleId,
  onSelectSchedule,
  onOpenScheduledTurn,
  onOpenConversation,
  onCreateSchedule,
  offline = false,
}: {
  /** Canonical session list — the detail uses it to resolve the control
   *  conversation (executor for the hidden Fork transcript projection).
   *  Hidden Fork Sessions are never in this list and are never added. */
  sessions: Session[];
  selectedScheduleId: string | null;
  onSelectSchedule: (scheduleId: string | null) => void;
  /** Open a bound-session Run's control conversation, focused on its Turn. */
  onOpenScheduledTurn: (sessionId: string, runId: string) => void;
  /** Open the Schedule's control conversation (no Turn focus). */
  onOpenConversation: (sessionId: string) => void;
  /** 新建定时任务 CTA: App opens the standard new-session page with the
   *  passed guidance prompt prefilled in the composer (design 05). */
  onCreateSchedule: (prompt: string) => void;
  /** WS disconnected — the list shows its last data behind an offline note. */
  offline?: boolean;
}) {
  const t = useT();
  const [statuses, setStatuses] = useState<readonly ScheduleStatus[]>(DEFAULT_STATUSES);
  const list = useScheduleList([...statuses]);
  const narrow = useMediaQuery('(max-width: 1100px)');
  const p2Width = usePanel2Width();

  const detail = selectedScheduleId !== null;

  return (
    <div className="timer-view" data-testid="timer-view">
      {(!narrow || !detail) && (
        <main className="main timer-main">
          <div className="main-head timer-head">
            <span className="timer-title">{t('timer.title')}</span>
            <span className="timer-head-spacer" />
            <button
              type="button"
              className="btn sm ghost timer-refresh"
              data-testid="timer-refresh"
              aria-label={t('timer.refresh')}
              title={t('timer.refresh')}
              disabled={list.loading}
              onClick={() => void list.refresh()}
            >
              <Icon d={I.refresh} />
            </button>
            <button
              type="button"
              className="btn sm primary timer-create"
              data-testid="timer-create"
              onClick={() => onCreateSchedule(t('timer.create.prefill'))}
            >
              <Icon d={I.plus} size={14} />
              {t('timer.create')}
            </button>
          </div>
          <div className="timer-filters" role="group" aria-label={t('timer.filter.label')}>
            {ALL_STATUSES.map(status => {
              const on = statuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  className={`timer-filter${on ? ' on' : ''}`}
                  data-testid={`timer-filter-${status}`}
                  aria-pressed={on}
                  onClick={() => {
                    setStatuses(previous => {
                      const next = on
                        ? previous.filter(entry => entry !== status)
                        : [...previous, status];
                      return next.length === 0 ? [...DEFAULT_STATUSES] : next;
                    });
                  }}
                >
                  {t(scheduleStatusLabelKey(status))}
                </button>
              );
            })}
          </div>
          {offline && (
            <div className="timer-offline" role="status" data-testid="timer-offline">
              {t('timer.offline')}
            </div>
          )}
          <div className="main-scroll timer-scroll">
            {list.loading && list.schedules.length === 0 && (
              <div className="timer-state" data-testid="timer-loading">
                <span className="spinner" />
                <span>{t('timer.loading')}</span>
              </div>
            )}
            {!list.loading && list.error && list.schedules.length === 0 && (
              <div className="spaces-error" role="alert" data-testid="timer-error">
                <span>{list.error}</span>
                <button type="button" className="btn xs" onClick={() => void list.refresh()}>
                  {t('timer.retry')}
                </button>
              </div>
            )}
            {!list.loading && !list.error && list.schedules.length === 0 && (
              <div className="empty timer-empty" data-testid="timer-empty">
                <span className="e-ico"><Icon d={I.alarm} size={26} /></span>
                <span className="e-t">{t('timer.empty.title')}</span>
                <span className="e-d">{t('timer.empty.desc')}</span>
                <button
                  type="button"
                  className="btn primary"
                  data-testid="timer-create-empty"
                  onClick={() => onCreateSchedule(t('timer.create.prefill'))}
                >
                  <Icon d={I.plus} size={14} />
                  {t('timer.create')}
                </button>
              </div>
            )}
            {list.schedules.length > 0 && (
              <ScheduleTable
                schedules={list.schedules}
                onOpen={onSelectSchedule}
                onChanged={() => { void list.refresh(); }}
              />
            )}
            {list.nextCursor && (
              <div className="timer-more">
                <button
                  type="button"
                  className="btn sm ghost"
                  data-testid="timer-load-more"
                  disabled={list.loadingMore}
                  onClick={() => void list.loadMore()}
                >
                  {list.loadingMore ? t('timer.loading') : t('timer.loadMore')}
                </button>
              </div>
            )}
          </div>
        </main>
      )}
      {detail && !narrow && (
        <Splitter
          seam="main-panel2"
          className="p2-splitter"
          onMouseDown={p2Width.onMouseDown}
          ariaLabel={t('common.resize.panel')}
        />
      )}
      {detail && (
        <aside
          className={`p2 schedule-detail-panel${narrow ? ' replacing' : ''}`}
          style={!narrow && p2Width.customized
            // Once the user drags the seam, the inline geometry must win over
            // the `.p2` 50/50 flex + min-width clamp or the drag does nothing.
            ? { width: p2Width.width, minWidth: 340, flex: '0 0 auto' }
            : undefined}
          data-testid="schedule-detail-panel"
        >
          <ScheduleDetail
            scheduleId={selectedScheduleId}
            sessions={sessions}
            showBack={narrow}
            onBack={() => onSelectSchedule(null)}
            onOpenScheduledTurn={onOpenScheduledTurn}
            onOpenConversation={onOpenConversation}
          />
        </aside>
      )}
    </div>
  );
}

/** Four quiet columns (2026-09-15 owner): name + a humanized frequency line,
 *  status, next run, actions. The raw cron expression and the owning
 *  conversation live in the detail, not the list. Stable widths; narrow
 *  windows scroll horizontally instead of overlapping text. */
function ScheduleTable({
  schedules,
  onOpen,
  onChanged,
}: {
  schedules: Schedule[];
  onOpen: (scheduleId: string) => void;
  onChanged: () => void;
}) {
  const t = useT();
  return (
    <div className="timer-table-wrap" data-testid="timer-list">
      <table className="timer-table">
        <colgroup>
          <col className="timer-col-name" />
          <col className="timer-col-status" />
          <col className="timer-col-next" />
          <col className="timer-col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t('timer.col.name')}</th>
            <th scope="col">{t('timer.col.status')}</th>
            <th scope="col">{t('timer.col.nextRun')}</th>
            <th scope="col" aria-label={t('timer.col.actions')} />
          </tr>
        </thead>
        <tbody>
          {schedules.map(schedule => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              onOpen={onOpen}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleRow({
  schedule,
  onOpen,
  onChanged,
}: {
  schedule: Schedule;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const reasonKey = scheduleStatusReasonLabelKey(schedule.status_reason);
  return (
    <tr
      className="timer-row"
      data-testid={`timer-row-${schedule.id}`}
      tabIndex={0}
      onClick={() => onOpen(schedule.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(schedule.id);
        }
      }}
    >
      <td className="timer-cell-name">
        <span className="timer-name">{schedule.name}</span>
        <span className="timer-trigger">{frequencySummary(schedule.trigger, t)}</span>
      </td>
      <td className="timer-cell-status">
        <span className={`timer-status is-${schedule.status}`}>
          {t(scheduleStatusLabelKey(schedule.status))}
        </span>
        {reasonKey && (
          <span className="timer-status-reason" title={t(reasonKey)}>{t(reasonKey)}</span>
        )}
      </td>
      <td className="timer-cell-next" title={schedule.next_run_at ?? undefined}>
        {formatNextRun(schedule.next_run_at, t)}
      </td>
      <td className="timer-cell-actions">
        <ScheduleRowActions schedule={schedule} onChanged={onChanged} />
      </td>
    </tr>
  );
}

/** Row actions: pause/resume · run now · archive (with confirmation). Icon +
 *  tooltip (title + aria-label); every dispatch is a pending schedule.*
 *  operation, so rapid re-clicks dedupe on the entity key. */
function ScheduleRowActions({
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
  const [runId, setRunId] = useState<string | undefined>();
  const run = useOperationRun(runId);

  useEffect(() => {
    if (run?.phase !== 'confirmed' && run?.phase !== 'failed' && run?.phase !== 'timed-out') return;
    setRunId(undefined);
    onChanged();
  }, [onChanged, run?.phase]);

  return (
    <span className="ri-acts timer-actions" onClick={event => event.stopPropagation()}>
      {!archived && !completed && (
        schedule.status === 'paused' ? (
          <button
            type="button"
            className="ri-act"
            data-testid={`timer-action-resume-${schedule.id}`}
            aria-label={t('timer.action.resume')}
            title={t('timer.action.resume')}
            disabled={busy}
            onClick={() => setRunId(dispatch('schedule.resume', {
              scheduleId: schedule.id,
              expectedRevision: schedule.revision,
            }).id)}
          >
            <Icon d={I.play} />
          </button>
        ) : (
          <button
            type="button"
            className="ri-act"
            data-testid={`timer-action-pause-${schedule.id}`}
            aria-label={t('timer.action.pause')}
            title={t('timer.action.pause')}
            disabled={busy}
            onClick={() => setRunId(dispatch('schedule.pause', {
              scheduleId: schedule.id,
              expectedRevision: schedule.revision,
            }).id)}
          >
            <Icon d={I.pause} />
          </button>
        )
      )}
      {!archived && (
        <button
          type="button"
          className="ri-act"
          data-testid={`timer-action-run-${schedule.id}`}
          aria-label={t('timer.action.runNow')}
          title={t('timer.action.runNow')}
          disabled={busy}
          onClick={() => setRunId(dispatch('schedule.runNow', { scheduleId: schedule.id }).id)}
        >
          <Icon d={I.play} size={14} />
        </button>
      )}
      {!archived && (
        <button
          type="button"
          className="ri-act danger"
          data-testid={`timer-action-archive-${schedule.id}`}
          aria-label={t('timer.action.archive')}
          title={t('timer.action.archive')}
          disabled={busy}
          onClick={() => {
            void confirm({
              title: t('timer.archive.title'),
              message: t('timer.archive.message').replace('{name}', schedule.name),
              confirmLabel: t('timer.archive.confirm'),
              danger: true,
            }).then(accepted => {
              if (!accepted) return;
              setRunId(dispatch('schedule.archive', {
                scheduleId: schedule.id,
                expectedRevision: schedule.revision,
              }).id);
            });
          }}
        >
          <Icon d={I.archive} />
        </button>
      )}
    </span>
  );
}
