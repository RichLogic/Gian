import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  ApprovalMode,
  ConfigValue,
  ComposerDocument,
  NativeConfigValue,
  MessageContextItem,
  Session,
  ThinkingEffort,
  UserAgentStatus,
  Workspace,
} from '@gian/shared';
import {
  Composer,
  discardComposerDraft,
} from '../components/Composer.js';
import { loadSessionTrace, loadAgents } from '../api.js';
import { GitBadge } from '../components/GitBadge.js';
import { PlanChip } from '../components/PlanChip.js';
import { QueueList } from '../components/QueueList.js';
import { ForkOriginBanner } from '../components/ForkControls.js';
import type { ActionControlState } from '../components/action-gating.js';
import { TurnDiffChip } from '../components/TurnDiffChip.js';
import { UnderbarPanelGroup } from '../components/UnderbarPanelGroup.js';
import { useT } from '../i18n/index.js';
import { toast } from '../feedback.js';
import { ChatPanelOpenContext } from '../presentation/chat-panel.js';
import {
  useOperationDispatchOptional,
  useOperationRun,
} from '../operations/use-operations.js';
import { deriveTraceSnapshot } from '../trace/derive.js';
import { TraceView } from '../trace/TraceView.js';
import type { TraceSnapshot } from '../trace/types.js';
import { Transcript } from '../transcript/Transcript.js';
import {
  TranscriptMinimap,
  TranscriptNavigation,
} from '../transcript/TranscriptMinimap.js';
import type { ApprovalActionContext, QueueEntry, TranscriptItem } from '../types.js';
import { isTurnRunning } from '../session-routing.js';
import type { TranscriptHistoryState } from '../controllers/use-transcript-hydration.js';
import type { TranscriptTextSelection } from '../transcript/selection-context.js';
import {
  addTranscriptSelectionToDraft,
  startTranscriptSelectionSideChat,
} from '../controllers/transcript-selection-actions.js';

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
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    },
  ) => void;
  onSendSkill: (name: string, path: string) => void;
  onStop: () => void;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (
    text: string,
    attachments?: Array<{ path: string; name: string; mime: string; size?: number }>,
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ) => void;
  onQueueRemove: (queueId: string) => void;
  onQueueUpdate: (queueId: string, text: string) => void;
  onQueueClear: () => void;
  onQueueSendNow: () => void;
  onSteer: (
    text: string,
    options?: {
      attachments?: Array<{ path: string; name: string; mime: string; size?: number }>;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    },
  ) => void;
  onSetMode: (mode: ApprovalMode) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: ThinkingEffort | null) => void;
  onSetServiceTier: (tier: 'fast' | null) => void;
  onSetNativeConfig: (configId: string, value: NativeConfigValue) => void;
  onSetTurnConfig?: (optionId: string, value: ConfigValue) => void;
  onDelete: () => void;
  onReopen?: () => void;
  onShowChanges: () => void;
  /** Opens a selected file in Diffs pinned to the card's Last-turn scope. */
  onShowLastTurnChanges: (turn: number, path: string) => void;
  workingTreeId: string | null;
  branch: string | null;
  /** Session Fork standard controls (proposal §10.6): `forkAtTurnControl`
   *  gates the per-turn transcript affordance (`session.fork.atTurn`) —
   *  always rendered when provided, greyed never hidden (§15). The head-fork
   *  entry lives in the session dropdown menu (PathBreadcrumb), not here.
   *  `originParentName` is the caller-resolved parent session name for the
   *  origin banner. */
  forkAtTurnControl?: ActionControlState | null;
  sideChatControl?: ActionControlState | null;
  originParentName?: string;
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
  onSetTurnConfig,
  onDelete,
  onReopen,
  onShowChanges,
  onShowLastTurnChanges,
  workingTreeId,
  branch,
  forkAtTurnControl,
  sideChatControl,
  originParentName,
}: SessionMainProps) {
  const t = useT();
  const dispatch = useOperationDispatchOptional();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const [selectionCreate, setSelectionCreate] = useState<{
    runId: string;
    sidechatId: string;
  }>();
  const selectionCreateRun = useOperationRun(selectionCreate?.runId);
  const signaledSelectionCreateRef = useRef<string | null>(null);
  const terminal = session.worktree_outcome !== null;
  // User-set completion flag (spec §B): a completed session is closed for
  // input — the composer blocks and a banner explains how to reopen. The host
  // enforces the same rule in `sendMessage` and the queue drain.
  const sessionCompleted = session.completed_at != null;
  const [knownAgents, setKnownAgents] = useState<UserAgentStatus[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadAgents()
      .then(list => { if (alive) setKnownAgents(list); })
      .catch(() => { if (alive) setKnownAgents([]); });
    return () => { alive = false; };
  }, []);
  // A deleted Agent's session stays readable from its snapshots but cannot
  // run turns — the composer is disabled and the snapshot name is shown.
  const agentDeleted = !!session.agent_id
    && knownAgents !== null
    && !knownAgents.some(agent => agent.id === session.agent_id);

  useEffect(() => {
    if (!selectionCreate || !selectionCreateRun) return;
    if (signaledSelectionCreateRef.current === selectionCreateRun.id) return;
    if (selectionCreateRun.phase === 'failed') {
      signaledSelectionCreateRef.current = selectionCreateRun.id;
      discardComposerDraft(selectionCreate.sidechatId);
      toast({
        kind: 'error',
        message: selectionCreateRun.error ?? t('sidechat.createFailed'),
      });
    } else if (selectionCreateRun.phase === 'timed-out') {
      signaledSelectionCreateRef.current = selectionCreateRun.id;
      toast({ kind: 'warning', message: t('sidechat.createUnknown') });
    }
  }, [selectionCreate, selectionCreateRun, t]);

  const transcriptReadOnly = terminal || sessionCompleted || agentDeleted;
  const selectionCreatePending = selectionCreateRun?.phase === 'pending'
    || selectionCreateRun?.phase === 'optimistic';
  const askSelectionEnabled = !transcriptReadOnly
    && sideChatControl?.enabled === true
    && dispatch !== null
    && openChatPanel !== null
    && !selectionCreatePending;
  const askSelectionReason = askSelectionEnabled
    ? undefined
    : transcriptReadOnly
      ? t('transcript.selection.readOnly')
      : selectionCreatePending
        ? t('sidechat.creating')
        : (sideChatControl?.reason ?? t('sidechat.unavailable'));

  function addSelectionToChat(selection: TranscriptTextSelection): void {
    if (!addTranscriptSelectionToDraft(session.id, selection)) {
      toast({ kind: 'warning', message: t('composer.context.limitReached') });
    }
  }

  function askSelectionInSideChat(selection: TranscriptTextSelection): void {
    if (!dispatch || !openChatPanel || sideChatControl?.enabled !== true || selectionCreatePending) return;
    try {
      const started = startTranscriptSelectionSideChat({
        parentSessionId: session.id,
        selection,
        dispatch,
        openChatPanel,
      });
      if (!started) return;
      signaledSelectionCreateRef.current = null;
      setSelectionCreate({ runId: started.run.id, sidechatId: started.sidechatId });
    } catch (error) {
      toast({
        kind: 'error',
        message: error instanceof Error ? error.message : t('sidechat.createFailed'),
      });
    }
  }
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const previousPendingRef = useRef(pending);

  // Chat / Trace tab. Core's persisted projection is authoritative because it
  // contains protocol-only step/request evidence that Transcript cannot carry.
  // The local projection keeps older/offline sessions readable while the Host
  // snapshot is loading or temporarily unavailable.
  const [sessionView, setSessionView] = useState<'chat' | 'trace'>('chat');
  const [hostTraceSnapshot, setHostTraceSnapshot] = useState<TraceSnapshot | null>(null);
  const running = pending || session.status === 'running' || session.status === 'pending';
  const derivedTraceSnapshot = useMemo(
    () => deriveTraceSnapshot(items, session.id, {
      partial: running || hydrated === false,
      generatedAt: new Date().toISOString(),
    }),
    [items, session.id, running, hydrated],
  );
  const traceSnapshot = useMemo<TraceSnapshot>(() => {
    if (hostTraceSnapshot?.sessionId !== session.id) return derivedTraceSnapshot;
    return {
      ...hostTraceSnapshot,
      partial: hostTraceSnapshot.partial || running || hydrated === false,
    };
  }, [derivedTraceSnapshot, hostTraceSnapshot, hydrated, running, session.id]);

  useEffect(() => {
    setHostTraceSnapshot(null);
  }, [session.id]);

  useEffect(() => {
    if (sessionView !== 'trace') return;
    const controller = new AbortController();
    let refreshTimer: number | undefined;

    const refresh = async () => {
      try {
        const snapshot = await loadSessionTrace(session.id, controller.signal);
        if (!controller.signal.aborted) setHostTraceSnapshot(snapshot);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(`[trace] failed to load session ${session.id}:`, error);
        }
      }
    };

    void refresh();
    if (running) refreshTimer = window.setInterval(() => { void refresh(); }, 500);
    return () => {
      controller.abort();
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    };
  }, [hydrated, items, running, session.id, sessionView]);

  useEffect(() => {
    if (previousPendingRef.current && !pending) {
      setGitRefreshKey(key => key + 1);
    }
    previousPendingRef.current = pending;
  }, [pending]);

  return (
    <main className="main">
      <div className="main-head session-chat-head">
        <div className="segm session-view-tabs" data-testid="session-view-tabs">
          <button
            className={`segm-item ${sessionView === 'chat' ? 'active' : ''}`}
            onClick={() => setSessionView('chat')}
          >
            {t('trace.tab.chat')}
          </button>
          <button
            className={`segm-item ${sessionView === 'trace' ? 'active' : ''}`}
            onClick={() => setSessionView('trace')}
          >
            {t('trace.tab.trace')}
          </button>
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
      {/* Fork lineage (proposal §10.6): a forked session is a normal
          persistent session — the banner only names its parent and boundary.
          No auto-switch, no source-session side effects. */}
      {session.origin?.kind === 'fork' && (
        <ForkOriginBanner origin={session.origin} parentName={originParentName} />
      )}
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
        {sessionView === 'trace' ? (
          <TraceView snapshot={traceSnapshot} />
        ) : (
          <Transcript
            key={session.id}
            items={items}
            hydrated={hydrated}
            hasOlder={history?.hasMore ?? false}
            loadingOlder={history?.loadingOlder ?? false}
            onLoadOlder={onLoadOlder}
            historyError={history?.error}
            onRetryHistory={onRetryHistory}
            pending={running}
            onApprove={onApprove}
            selectionActions={{
              addToChat: {
                enabled: !transcriptReadOnly,
                ...(!transcriptReadOnly ? {} : { reason: t('transcript.selection.readOnly') }),
                run: addSelectionToChat,
              },
              askInSideChat: {
                enabled: askSelectionEnabled,
                ...(askSelectionReason ? { reason: askSelectionReason } : {}),
                run: askSelectionInSideChat,
              },
            }}
            forkAtTurn={forkAtTurnControl
              ? { sourceSessionId: session.id, state: forkAtTurnControl }
              : null}
          />
        )}
      </div>
      {sessionView === 'chat' && <TranscriptMinimap items={items} />}
      {sessionView === 'chat' && (
        <>
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
          {agentDeleted && (
            <p className="s2-help" role="note" data-testid="agent-deleted-note">
              {t('session.agentDeleted').replace('{name}', session.agent_name ?? '')}
            </p>
          )}
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
            onSetTurnConfig={onSetTurnConfig}
            disabled={pending || terminal || sessionCompleted || agentDeleted}
            running={isTurnRunning(session.status, pending)}
            disabledSubmitBehavior={terminal || sessionCompleted ? 'block' : 'queue'}
            executor={session.executor}
            agentId={session.agent_id ?? null}
            workspaceId={workspace?.id}
          />
        </>
      )}
    </main>
  );
}
