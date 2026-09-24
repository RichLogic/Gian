import { useEffect, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, ComposerDocument, ConfigValue, Executor, MessageContextItem, NativeConfigValue, Session, Workspace } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { Mode } from '../components/Topbar.js';
import { LeftRail } from '../components/SidebarChrome.js';
import { SessionsSidebar } from '../components/SessionsSidebar.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import type { RailLayoutController } from '../components/RailLayout.js';
import type { ActionControlState } from '../components/action-gating.js';
import type { OperationRun } from '../operations/types.js';
import type { PlanLifecycleState } from '../transcript/apply.js';
import type { TranscriptHistoryState } from '../controllers/use-transcript-hydration.js';
import type { ApprovalActionContext, QueueEntry, TranscriptItem } from '../types.js';
import { SessionMain } from './SessionMain.js';
import { clearNewSessionDraft, NewSessionView } from './new-session-view.js';
import type { CreateSessionInput } from './new-session-view.js';
export { buildSessionCreatePayload } from './new-session-view.js';
export type { CreateSessionInput, SessionCreateFormState } from './new-session-view.js';


export interface CodingViewProps {
  /** Top-level app mode — the persistent sidebar navigation reads/drives this. */
  mode: Mode;
  onSetAppMode: (mode: Mode) => void;
  workspaces: Workspace[];
  sessions: Session[];
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  activeSessionId: string | null;
  itemsBySession: Record<string, TranscriptItem[]>;
  pendingBySession: Record<string, boolean>;
  queueBySession: Record<string, QueueEntry[]>;
  /** Streamed plan text and whether a successful turn finalized it. */
  planStateBySession: Record<string, PlanLifecycleState>;
  historyBySession: Record<string, TranscriptHistoryState>;
  onLoadOlder: (sessionId: string, executor: Executor) => void;
  onRetryHistory: (sessionId: string, executor: Executor) => void;
  onSelectSession: (id: string) => void;
  /** Open the New Repo dialog (new-session page's workspace drop "+ New Repo"
   *  row, Repos section "+"). */
  onNewWorkspace: () => void;
  /** Open the Edit Repo dialog (Repos rail group ⋯ menu, name-only). */
  onEditWorkspace: (workspace: Workspace) => void;
  /** App-driven request to open the new-session page with this workspace
   *  preselected (auto-return after creating one from the New Repo dialog).
   *  Consumed once via onConsumeOpenNewForWorkspace. */
  openNewForWorkspace?: string | null;
  onConsumeOpenNewForWorkspace?: () => void;
  /** App-driven request to open the new-session page with a prefilled
   *  composer message (the Timer 新建定时任务 CTA's guidance prompt).
   *  Consumed once via onConsumeOpenNewWithMessage. */
  openNewWithMessage?: string | null;
  onConsumeOpenNewWithMessage?: () => void;
  onCreateSession: (input: CreateSessionInput) => OperationRun;
  /** Latest create run, owned by App so timed-out attempts survive this
   * view unmounting during mode switches. */
  sessionCreateRun?: OperationRun;
  /** Global session.create pending state survives view/mode unmounts, so
   * reopening the form cannot accidentally submit a duplicate create. */
  creatingSession: boolean;
  onClearSessionCreateRun: () => void;
  /** Reload canonical sessions after an unknown create outcome. Only a
   * successful reload releases the retry interlock. */
  onVerifySessionCreate: () => Promise<void>;
  onSend: (
    sessionId: string,
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      translationId?: string;
      attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    },
  ) => void;
  onSendSkill: (sessionId: string, name: string, path: string) => void;
  onStop: (sessionId: string) => void;
  onApprove: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (
    sessionId: string,
    text: string,
    attachments?: Array<{ path: string; name: string; mime: string; size?: number }>,
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ) => void;
  onQueueRemove: (sessionId: string, queueId: string) => void;
  onQueueUpdate: (sessionId: string, queueId: string, text: string) => void;
  onQueueClear: (sessionId: string) => void;
  onQueueSendNow: (sessionId: string) => void;
  /** Codex-only mid-turn injection (`turn/steer`) — the composer's Ctrl+Enter
   *  path while a turn is running. Other executors never call it. */
  onSteer: (
    sessionId: string,
    text: string,
    attachments?: Array<{ path: string; name: string; mime: string; size?: number }>,
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ) => void;
  onSetMode: (sessionId: string, approvalMode: ApprovalMode) => void;
  onSetModel: (sessionId: string, model: string) => void;
  onSetEffort: (sessionId: string, effort: import('@gian/shared').ThinkingEffort | null) => void;
  onSetServiceTier: (sessionId: string, tier: 'fast' | null) => void;
  onSetNativeConfig: (
    sessionId: string,
    configId: string,
    value: NativeConfigValue,
  ) => void;
  onSetTurnConfig?: (
    sessionId: string,
    optionId: string,
    value: ConfigValue,
  ) => void;
  onReopenSession: (sessionId: string) => void;
  /** Toggle a session's pinned marker (sidebar ordering). */
  onPinSession: (sessionId: string, pinned: boolean) => void;
  /** Archive a session from the sidebar row. */
  onArchiveSession: (sessionId: string) => void;
  /** Open a selected file in Diffs pinned to the card's Last-turn scope. */
  onShowLastTurnChanges: (session: Session, turn: number, path: string) => void;
  /** Session Fork standard control (proposal §10.6): two-layer gating for
   *  the per-turn transcript affordance (`session.fork.atTurn`) of the
   *  ACTIVE session. The head-fork entry lives in the session dropdown menu;
   *  the Side Chat surface lives on the Dock rail + panel 2. */
  forkAtTurnControl: ActionControlState | null;
  /** `sidechat.create` gating used by transcript selection actions. */
  sideChatControl?: ActionControlState | null;
  /** Timer "open the Run's Turn" request (Issue #51): sessionId + schedule
   *  Run id; forwarded to the Transcript of the matching active session. */
  scheduleFocus?: { sessionId: string; runId: string } | null;
  onConsumeScheduleFocus?: () => void;
  /** App-owned four-panel layout. Optional for isolated component renders. */
  railLayout?: RailLayoutController;
}

export function CodingView(p: CodingViewProps) {
  const [showNew, setShowNew] = useState(false);
  const submittedDraftScopeRef = useRef<{
    scope: { kind: 'workspace'; id: string };
    preserveDraftUntilUpload: boolean;
  } | null>(null);
  const [verifyingCreate, setVerifyingCreate] = useState(false);
  const [verifyCreateError, setVerifyCreateError] = useState<string | null>(null);
  const createRun = p.sessionCreateRun;
  const createUnknown = createRun?.phase === 'timed-out';
  const preserveCreateRun = createUnknown
    || createRun?.phase === 'pending'
    || createRun?.phase === 'optimistic';
  const creatingSession = p.creatingSession
    || createRun?.phase === 'pending'
    || createRun?.phase === 'optimistic';
  const createError = createRun?.phase === 'failed'
    ? (createRun.error ?? 'Session creation failed. You can adjust the form and retry.')
    : createRun?.phase === 'timed-out'
      ? 'Session creation status is unknown. Refresh sessions before retrying.'
      : null;
  /** Workspace preselected in NewSessionView when opened via a workspace
   *  row's "+" action. Undefined when opened from the header "+" button. */
  const [newForWs, setNewForWs] = useState<string | undefined>(undefined);
  /** One-shot composer prefill handed to the next NewSessionView mount. */
  const [newPrefill, setNewPrefill] = useState<string | undefined>(undefined);
  const fallbackRail = useResizableWidth('rail.w', 272, 200, 480, 'left');
  const rail = p.railLayout ?? fallbackRail;

  // The Host broadcasts session:created before the correlated result. Close
  // only on a confirmed run; failures remain visible and retryable in-place.
  useEffect(() => {
    if (createRun?.phase === 'confirmed') {
      if (submittedDraftScopeRef.current) {
        if (!submittedDraftScopeRef.current.preserveDraftUntilUpload) {
          clearNewSessionDraft(submittedDraftScopeRef.current.scope);
        }
        submittedDraftScopeRef.current = null;
      }
      setShowNew(false);
      p.onClearSessionCreateRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRun?.phase]);

  // Auto-return from the New Workspace sheet: App re-opens the new-session
  // page with the just-created workspace preselected.
  useEffect(() => {
    if (p.openNewForWorkspace == null) return;
    setNewForWs(p.openNewForWorkspace);
    if (!preserveCreateRun) p.onClearSessionCreateRun();
    setShowNew(true);
    p.onConsumeOpenNewForWorkspace?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.openNewForWorkspace]);

  // Timer's 新建定时任务 CTA: open the new-session page with the guidance
  // prompt prefilled in the composer (the draft store keeps it if edited).
  useEffect(() => {
    if (p.openNewWithMessage == null) return;
    setNewForWs(undefined);
    setNewPrefill(p.openNewWithMessage);
    if (!preserveCreateRun) p.onClearSessionCreateRun();
    setShowNew(true);
    p.onConsumeOpenNewWithMessage?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.openNewWithMessage]);

  async function verifyUnknownCreate() {
    if (!createUnknown || verifyingCreate) return;
    setVerifyingCreate(true);
    setVerifyCreateError(null);
    try {
      await p.onVerifySessionCreate();
    } catch (thrown) {
      setVerifyCreateError(
        thrown instanceof Error ? thrown.message : 'Failed to refresh sessions',
      );
    } finally {
      setVerifyingCreate(false);
    }
  }

  const resetNewSession = () => {
    // Explicit failures are safe to forget. In-flight and unknown outcomes
    // remain globally interlocked even if the form closes.
    if (!preserveCreateRun) p.onClearSessionCreateRun();
    setNewPrefill(undefined);
    setShowNew(false);
  };

  // Topbar's brand burger emits this event — primary discoverable affordance
  // for hiding/showing the rail. The in-sidebar collapse button is the
  // secondary path. Listening at the window level keeps Topbar decoupled.
  useEffect(() => {
    if (p.railLayout) return;
    const onToggle = () => rail.setCollapsed(!rail.collapsed);
    window.addEventListener('gian.toggle-rail', onToggle);
    return () => window.removeEventListener('gian.toggle-rail', onToggle);
  }, [p.railLayout, rail.collapsed, rail.setCollapsed]);

  useEffect(() => {
    const open = () => {
      setNewForWs(undefined);
      setNewPrefill(undefined);
      if (!preserveCreateRun) p.onClearSessionCreateRun();
      setShowNew(true);
    };
    window.addEventListener('gian:new-session', open);
    return () => window.removeEventListener('gian:new-session', open);
  }, [p.onClearSessionCreateRun, preserveCreateRun]);

  return (
    <div
      className={`view${rail.collapsed ? ' rail-collapsed' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      {/* Collapsed (2026-08-31 redesign): the full sidebar swaps for the 38px
          icon rail (Agents / Timer / Custom / 消息). Group-collapse state is
          persisted in localStorage, so unmounting the rail loses nothing. */}
      {rail.collapsed ? (
        <LeftRail
          mode={p.mode}
          listMode="sessions"
          onSetMode={p.onSetAppMode}
          onExpand={() => rail.setCollapsed(false)}
        />
      ) : (
        <SessionsSidebar
          mode={p.mode}
          onSetMode={p.onSetAppMode}
          listMode="sessions"
          onSetListMode={p.onSetAppMode}
          workspaces={p.workspaces}
          sessions={p.sessions}
          activeSessionId={p.activeSessionId}
          onNewWorkspace={p.onNewWorkspace}
          onEditWorkspace={p.onEditWorkspace}
          onNewForWorkspace={id => {
            setNewForWs(id);
            setNewPrefill(undefined);
            if (!preserveCreateRun) p.onClearSessionCreateRun();
            setShowNew(true);
          }}
          onPinSession={p.onPinSession}
          onArchiveSession={p.onArchiveSession}
          onSelect={id => { resetNewSession(); p.onSelectSession(id); }}
        />
      )}
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize sidebar" />
      {showNew ? (
        <NewSessionView
          key={`workspace:${newForWs ?? 'active'}`}
          workspaces={p.workspaces}
          initialWorkspaceId={newForWs}
          initialMessage={newPrefill}
          onCancel={resetNewSession}
          onNewWorkspace={p.onNewWorkspace}
          creating={creatingSession}
          createError={verifyCreateError ?? createError}
          createUnknown={createUnknown}
          verifyingCreate={verifyingCreate}
          onVerifyCreate={() => void verifyUnknownCreate()}
          onCreate={input => {
            setVerifyCreateError(null);
            submittedDraftScopeRef.current = {
              scope: { kind: 'workspace', id: input.workspaceId },
              preserveDraftUntilUpload: (input.firstAttachments?.length ?? 0) > 0,
            };
            p.onCreateSession(input);
          }}
        />
      ) : p.activeSession ? (
        <SessionMain
          key={p.activeSession.id}
          session={p.activeSession}
          workspace={p.activeWorkspace}
          items={p.itemsBySession[p.activeSession.id] ?? []}
          hydrated={p.historyBySession[p.activeSession.id]?.phase === 'page'
            || p.historyBySession[p.activeSession.id]?.phase === 'complete'}
          history={p.historyBySession[p.activeSession.id]}
          onLoadOlder={() => p.onLoadOlder(p.activeSession!.id, p.activeSession!.executor)}
          onRetryHistory={() => p.onRetryHistory(p.activeSession!.id, p.activeSession!.executor)}
          pending={p.pendingBySession[p.activeSession.id] ?? false}
          queue={p.queueBySession[p.activeSession.id] ?? []}
          planText={p.planStateBySession[p.activeSession.id]?.text}
          codexPlanCompleted={p.planStateBySession[p.activeSession.id]?.completed}
          codexPlanStatus={p.planStateBySession[p.activeSession.id]?.status}
          codexPlanTurn={p.planStateBySession[p.activeSession.id]?.turn}
          onSend={(text, opts) => p.onSend(p.activeSession!.id, text, opts)}
          onSendSkill={(name, path) => p.onSendSkill(p.activeSession!.id, name, path)}
          onStop={() => p.onStop(p.activeSession!.id)}
          onApprove={(approvalId, decision, answers, context) => p.onApprove(p.activeSession!.id, approvalId, decision, answers, context)}
          onQueueAdd={(text, items, contextItems, composerDocument) =>
            p.onQueueAdd(p.activeSession!.id, text, items, contextItems, composerDocument)}
          onQueueRemove={queueId => p.onQueueRemove(p.activeSession!.id, queueId)}
          onQueueUpdate={(queueId, text) => p.onQueueUpdate(p.activeSession!.id, queueId, text)}
          onQueueClear={() => p.onQueueClear(p.activeSession!.id)}
          onQueueSendNow={() => p.onQueueSendNow(p.activeSession!.id)}
          onSteer={(text, opts) =>
            p.onSteer(
              p.activeSession!.id,
              text,
              opts?.attachments,
              opts?.contextItems,
              opts?.composerDocument,
            )}
          onSetMode={mode => p.onSetMode(p.activeSession!.id, mode)}
          onSetModel={model => p.onSetModel(p.activeSession!.id, model)}
          onSetEffort={effort => p.onSetEffort(p.activeSession!.id, effort)}
          onSetServiceTier={tier => p.onSetServiceTier(p.activeSession!.id, tier)}
          onSetNativeConfig={(configId, value) =>
            p.onSetNativeConfig(p.activeSession!.id, configId, value)}
          onSetTurnConfig={p.onSetTurnConfig
            ? (optionId, value) => p.onSetTurnConfig!(p.activeSession!.id, optionId, value)
            : undefined}
          onReopen={() => p.onReopenSession(p.activeSession!.id)}
          onOpenAgents={() => p.onSetAppMode('agents')}
          onShowLastTurnChanges={(turn, path) =>
            p.onShowLastTurnChanges(p.activeSession!, turn, path)}
          forkAtTurnControl={p.forkAtTurnControl}
          scheduleFocus={p.scheduleFocus && p.scheduleFocus.sessionId === p.activeSession.id
            ? { runId: p.scheduleFocus.runId }
            : null}
          onConsumeScheduleFocus={p.onConsumeScheduleFocus}
          sideChatControl={p.sideChatControl}
        />
      ) : (
        <CodingViewEmpty />
      )}
    </div>
  );
}

function CodingViewEmpty() {
  const t = useT();
  return (
    <main className="main">
      <div className="files-preview-empty">
        <svg className="fpe-icon" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M10 14a4 4 0 014-4h28a4 4 0 014 4v22a4 4 0 01-4 4H22l-12 10V14z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M20 22h16M20 28h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
        </svg>
        <p className="fpe-title">{t('coding.session.empty')}</p>
        <p className="fpe-hint">
          <kbd>⌘K</kbd> {t('coding.empty.hint')}
        </p>
      </div>
    </main>
  );
}
