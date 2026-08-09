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
import { TurnDiffChip } from '../components/TurnDiffChip.js';
import { UnderbarPanelGroup } from '../components/UnderbarPanelGroup.js';
import { useT } from '../i18n/index.js';
import { Transcript } from '../transcript/Transcript.js';
import {
  TranscriptMinimap,
  TranscriptNavigation,
} from '../transcript/TranscriptMinimap.js';
import type { ApprovalActionContext, QueueEntry, TranscriptItem } from '../types.js';
import { isTurnRunning } from '../session-routing.js';
import type { TranscriptHistoryState } from '../controllers/use-transcript-hydration.js';

export interface SessionMainProps {
  session: Session;
  workspace: Workspace | null;
  items: TranscriptItem[];
  /** False while the session's history is still loading — suppresses the
   *  transcript empty state so switching sessions doesn't flash it. */
  hydrated?: boolean;
  history?: TranscriptHistoryState;
  onLoadOlder?: () => void;
  onRetryHistory?: () => void;
  pending: boolean;
  queue: QueueEntry[];
  planText?: string;
  codexPlanCompleted?: boolean;
  codexPlanStatus?: 'active' | 'paused' | 'completed';
  codexPlanTurn?: number;
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
  onQueueUpdate: (queueId: string, text: string) => void;
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
  /** Opens a selected file in Diffs pinned to the card's Last-turn scope. */
  onShowLastTurnChanges: (turn: number, path: string) => void;
  workingTreeId: string | null;
  branch: string | null;
}

export function SessionMain({
  session,
  workspace,
  items,
  hydrated,
  history,
  onLoadOlder,
  onRetryHistory,
  pending,
  queue,
  planText,
  codexPlanCompleted,
  codexPlanStatus,
  codexPlanTurn,
  onSend,
  onSendSkill,
  onStop,
  onApprove,
  onQueueAdd,
  onQueueRemove,
  onQueueUpdate,
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
  onShowLastTurnChanges,
  workingTreeId,
  branch,
}: SessionMainProps) {
  const t = useT();
  const terminal = session.worktree_outcome !== null;
  // User-set completion flag (spec §B): a completed session is closed for
  // input — the composer blocks and a banner explains how to reopen. The host
  // enforces the same rule in `sendMessage` and the queue drain.
  const sessionCompleted = session.completed_at != null;
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
      <div className="main-head session-chat-head">
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
      {sessionCompleted && (
        <div className="session-banner">
          <span>{t('coding.banner.completed')}</span>
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
          key={session.id}
          items={items}
          hydrated={hydrated}
          hasOlder={history?.hasMore ?? false}
          loadingOlder={history?.loadingOlder ?? false}
          onLoadOlder={onLoadOlder}
          historyError={history?.error}
          onRetryHistory={onRetryHistory}
          pending={pending || session.status === 'running' || session.status === 'pending'}
          onApprove={onApprove}
        />
      </div>
      <TranscriptMinimap items={items} />
      <QueueList
        sessionId={session.id}
        queue={queue}
        onRemove={terminal || sessionCompleted ? undefined : onQueueRemove}
        onUpdate={terminal || sessionCompleted ? undefined : onQueueUpdate}
        onClear={terminal || sessionCompleted ? undefined : onQueueClear}
        onSendNow={session.executor === 'codex' && !terminal && !sessionCompleted
          ? onQueueSendNow
          : undefined}
        readOnly={terminal || sessionCompleted}
      />
      <UnderbarPanelGroup sessionId={session.id}>
        <PlanChip
          items={items}
          planText={planText}
          planCompleted={codexPlanCompleted}
          planStatus={codexPlanStatus}
          planTurn={codexPlanTurn}
          sessionId={session.id}
        />
        <TurnDiffChip
          items={items}
          sessionId={session.id}
          onShowLastTurn={onShowLastTurnChanges}
        />
        <TranscriptNavigation items={items} />
      </UnderbarPanelGroup>
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
        disabled={pending || terminal || sessionCompleted}
        running={isTurnRunning(session.status, pending)}
        disabledSubmitBehavior={terminal || sessionCompleted ? 'block' : 'queue'}
        executor={session.executor}
        workspaceId={workspace?.id}
      />
    </main>
  );
}
