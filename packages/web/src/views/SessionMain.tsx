import { useEffect, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  ApprovalMode,
  NativeConfigValue,
  Session,
  ThinkingEffort,
  Workspace,
} from '@gian/shared';
import { Composer } from '../components/Composer.js';
import { GitBadge } from '../components/GitBadge.js';
import { PlanChip } from '../components/PlanChip.js';
import { QueueList } from '../components/QueueList.js';
import { useT } from '../i18n/index.js';
import { Transcript } from '../transcript/Transcript.js';
import { TranscriptMinimap } from '../transcript/TranscriptMinimap.js';
import type { ApprovalActionContext, QueueEntry, TranscriptItem } from '../types.js';
import { isTurnRunning } from '../session-routing.js';

export interface SessionMainProps {
  session: Session;
  workspace: Workspace | null;
  items: TranscriptItem[];
  /** False while the session's history is still loading — suppresses the
   *  transcript empty state so switching sessions doesn't flash it. */
  hydrated?: boolean;
  pending: boolean;
  queue: QueueEntry[];
  planText?: string;
  codexPlanCompleted?: boolean;
  onSend: (
    text: string,
    options?: {
      oneShotBypass?: boolean;
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
    },
  ) => void;
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (
    text: string,
    attachments?: Array<{ path: string; name: string; mime: string; size?: number }>,
  ) => void;
  onQueueRemove: (queueId: string) => void;
  onQueueReorder: (order: string[]) => void;
  onQueueClear: () => void;
  onQueueSendNow: () => void;
  onSteer: (
    text: string,
    options?: {
      attachments?: Array<{ path: string; name: string; mime: string; size?: number }>;
    },
  ) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  onSetServiceTier: (tier: 'fast' | null) => void;
  onSetNativeConfig: (configId: string, value: NativeConfigValue) => void;
  onDelete: () => void;
  onReopen?: () => void;
  onShowChanges: () => void;
  workingTreeId: string | null;
  branch: string | null;
}

export function SessionMain({
  session,
  workspace,
  items,
  hydrated,
  pending,
  queue,
  planText,
  codexPlanCompleted,
  onSend,
  onSendSkill,
  onStop,
  onApprove,
  onQueueAdd,
  onQueueRemove,
  onQueueReorder,
  onQueueClear,
  onQueueSendNow,
  onSteer,
  onSetMode,
  onSetModel,
  onSetEffort,
  onSetServiceTier,
  onSetNativeConfig,
  onDelete,
  onReopen,
  onShowChanges,
  workingTreeId,
  branch,
}: SessionMainProps) {
  const t = useT();
  const terminal = session.worktree_outcome !== null;
  const subtaskCompleted = session.type === 'subtask' && session.completed_at != null;
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const previousPendingRef = useRef(pending);

  useEffect(() => {
    if (previousPendingRef.current && !pending) {
      setGitRefreshKey(key => key + 1);
    }
    previousPendingRef.current = pending;
  }, [pending]);

  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          {session.type === 'subtask' && (
            <span className="manager-eyebrow">{t('tasks.subtask.title')}</span>
          )}
        </div>
        <div className="main-head-r">
          <GitBadge
            workingTreeId={workingTreeId}
            branch={branch}
            refreshKey={gitRefreshKey}
            onClick={onShowChanges}
          />
        </div>
      </div>
      {terminal && (
        <div className={`session-banner ${session.worktree_outcome}`}>
          <span>
            {session.worktree_outcome === 'merged'
              ? `${t('coding.banner.merged')} ${session.base_branch}. ${t('coding.banner.readonly')}`
              : t('coding.banner.discarded')}
          </span>
          <span className="session-banner-spacer" />
          <button className="btn xs danger-ghost" onClick={onDelete}>
            {t('common.delete')}
          </button>
        </div>
      )}
      {subtaskCompleted && (
        <div className="session-banner">
          <span>{t('coding.banner.subtaskCompleted')}</span>
          <span className="session-banner-spacer" />
          {onReopen && (
            <button className="btn xs secondary" onClick={onReopen}>
              {t('tasks.subtask.reopen')}
            </button>
          )}
        </div>
      )}
      <div className="main-scroll">
        <Transcript
          items={items}
          hydrated={hydrated}
          pending={pending || session.status === 'running' || session.status === 'pending'}
          onApprove={onApprove}
        />
      </div>
      <QueueList
        queue={queue}
        onRemove={onQueueRemove}
        onReorder={onQueueReorder}
        onClear={onQueueClear}
        onSendNow={session.executor === 'codex' ? onQueueSendNow : undefined}
      />
      <div className="main-underbar">
        <PlanChip
          items={items}
          planText={planText}
          planCompleted={codexPlanCompleted}
          sessionId={session.id}
        />
        <TranscriptMinimap items={items} />
      </div>
      <Composer
        session={session}
        onSend={onSend}
        onSendSkill={onSendSkill}
        onStop={onStop}
        onQueueAdd={onQueueAdd}
        onSteer={onSteer}
        onSetMode={onSetMode}
        onSetModel={onSetModel}
        onSetEffort={onSetEffort}
        onSetServiceTier={onSetServiceTier}
        onSetNativeConfig={onSetNativeConfig}
        disabled={pending || terminal || subtaskCompleted}
        running={isTurnRunning(session.status, pending)}
        disabledSubmitBehavior={subtaskCompleted ? 'block' : 'queue'}
        executor={session.executor}
        workspaceId={workspace?.id}
      />
    </main>
  );
}
