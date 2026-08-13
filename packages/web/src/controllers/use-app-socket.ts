import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type {
  EventEnvelope,
  Executor,
  RunnerInfo,
  ServerToClientMessage,
  Session,
  SystemConfig,
  Task,
  Workspace,
} from '@gian/shared';
import { loadSessions, loadTasks, loadWorkspaces } from '../api.js';
import {
  invalidateSlashCacheForWorkspace,
  SLASH_CACHE_INVALIDATED_EVENT,
} from '../components/composer/capabilities.js';
import { invalidateAllChangesDiffs } from './use-changes-diff.js';
import { toast } from '../feedback.js';
import { maybeNotifyForEnvelope } from '../notifications.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { dispatchAttachmentUpload, dispatchMessageSend } from '../operations/message.js';
import { sessionEntityKey } from '../operations/session.js';
import { taskEntityKey } from '../operations/task.js';
import { workspaceEntityKey } from '../operations/workspace.js';
import type { OperationStore } from '../operations/store.js';
import {
  applySessionUpdate,
  planCreatedSessionFirstMessage,
} from '../session-routing.js';
import {
  applyEnvelope,
  applyErrorEnvelopeToSession,
  applyPlanLifecycle,
  displayTypeForEnvelope,
  ensureLatestTurnEnd,
  nextPendingFromEnvelope,
  type PlanLifecycleState,
} from '../transcript/apply.js';
import type { QueueEntry, TranscriptItem } from '../types.js';
import type { GianWs, WsState } from '../ws.js';
import type { AppAuthStatus } from './use-app-auth.js';
import {
  pendingFirstMessageForCreatedSession,
  type PendingFirstMessage,
  type PendingFirstMessageValue,
} from '../pending-first-message.js';
import { clearNewSessionDraftStorage } from '../screenshot-drafts.js';
import { injectComposerAttachment, injectComposerDraft } from '../components/Composer.js';
import { servedAttachmentUrl } from '../attachments.js';

type Setter<T> = Dispatch<SetStateAction<T>>;

interface UseAppSocketInput {
  authStatus: AppAuthStatus;
  ws: GianWs;
  sessionsRef: MutableRefObject<Session[]>;
  itemsBySessionRef: MutableRefObject<Record<string, TranscriptItem[]>>;
  activeSessionIdRef: MutableRefObject<string | null>;
  pendingFirstMessageRef: MutableRefObject<PendingFirstMessageValue>;
  setWsState: Setter<WsState>;
  setWsAttempt: Setter<number>;
  setAuthed: Setter<boolean>;
  setWorkspaces: Setter<Workspace[]>;
  /** Optional for embedded/test socket consumers that do not render the
   *  worktree selector. The full App always supplies the refresh callback. */
  refreshWorkingTrees?: () => void;
  setSessions: Setter<Session[]>;
  setTasks: Setter<Task[]>;
  setSystemConfig: Setter<SystemConfig | null>;
  setRunner: Setter<RunnerInfo | null>;
  setActiveSessionId: Setter<string | null>;
  setActiveTaskId: Setter<string | null>;
  setActiveSubtaskId: Setter<string | null>;
  setItemsBySession: Setter<Record<string, TranscriptItem[]>>;
  setPendingBySession: Setter<Record<string, boolean>>;
  setQueueBySession: Setter<Record<string, QueueEntry[]>>;
  setPlanStateBySession: Setter<Record<string, PlanLifecycleState>>;
  markSessionHistoryLive: (sessionId: string) => void;
  rebuildSessionHistory: (sessionId: string, executor: Executor) => void;
  /** Operation store — canonical session data applied here defensively
   *  absorbs matching overlays (proposal §4.3). */
  operationStore: OperationStore;
  /** Operation dispatcher — the auto first-queued send and the unread
   *  auto-clear dispatch through the operation layer (Phase 2b). */
  ops: OperationDispatcher;
  translate?: (key: string) => string;
}

async function deliverCreatedSessionFirstMessage(
  pending: PendingFirstMessage,
  session: Session,
  current: Pick<UseAppSocketInput, 'ops' | 'translate'>,
): Promise<void> {
  if (pending.attachments.length === 0) {
    const firstMessage = planCreatedSessionFirstMessage(pending.text);
    if (firstMessage.structuredText) {
      dispatchMessageSend(current.ops.dispatch, {
        sessionId: session.id,
        text: firstMessage.structuredText,
        exec: session.executor,
      });
    }
    clearNewSessionDraftStorage(pending.scope);
    return;
  }

  const settled = await Promise.allSettled(pending.attachments.map(attachment =>
    dispatchAttachmentUpload(current.ops.dispatch, {
      sessionId: session.id,
      blob: attachment.blob,
      filename: attachment.name,
    })));
  const uploaded = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const failed = settled.length - uploaded.length;

  if (failed > 0) {
    // Keep the original Workspace/Task draft (including its raw Blobs) for a
    // safe retry. Anything that did upload is also recoverable in the created
    // Session's Composer, and is deliberately not auto-sent on partial error.
    if (pending.text.trim()) injectComposerDraft(session.id, pending.text.trim());
    for (const attachment of uploaded) injectComposerAttachment(session.id, attachment);
    toast({
      kind: 'error',
      message: current.translate?.('screenshot.firstMessageUploadFailed')
        ?? 'Some screenshots could not be uploaded. The original new-session draft was kept.',
    });
    return;
  }

  dispatchMessageSend(current.ops.dispatch, {
    sessionId: session.id,
    text: pending.text.trim(),
    exec: session.executor,
    attachments: uploaded.map(attachment => ({
      ...attachment,
      previewUrl: servedAttachmentUrl(session.id, attachment.path),
    })),
  });
  clearNewSessionDraftStorage(pending.scope);
}

export function useAppSocket(input: UseAppSocketInput): void {
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const state = latest.current;
    if (input.authStatus !== 'authenticated') {
      input.ws.disconnect();
      state.setAuthed(false);
      return;
    }
    input.ws.connect();

    const handleEnvelope = (envelope: EventEnvelope, executor: Executor) => {
      const current = latest.current;
      const notifyingSession = current.sessionsRef.current
        .find(session => session.id === envelope.session_id) ?? null;
      maybeNotifyForEnvelope(envelope, {
        session: notifyingSession,
        onClick: () => current.setActiveSessionId(envelope.session_id),
      });
      const nextPending = nextPendingFromEnvelope(envelope);
      if (nextPending !== null) {
        current.setPendingBySession(previous => ({
          ...previous,
          [envelope.session_id]: nextPending,
        }));
      }
      const displayType = displayTypeForEnvelope(envelope);
      if (displayType === 'plan'
          || displayType === 'state.turn-completed'
          || displayType === 'state.error') {
        current.setPlanStateBySession(previous => {
          const existing = previous[envelope.session_id] ?? { completed: false };
          const next = applyPlanLifecycle(existing, envelope);
          return next === existing ? previous : { ...previous, [envelope.session_id]: next };
        });
      }
      current.markSessionHistoryLive(envelope.session_id);
      current.setItemsBySession(previous => {
        const list = previous[envelope.session_id] ?? [];
        const next = applyEnvelope(list, envelope, executor);
        return next === list ? previous : { ...previous, [envelope.session_id]: next };
      });
    };

    const offState = input.ws.onState((wsState, attempt) => {
      const current = latest.current;
      current.setWsState(wsState);
      current.setWsAttempt(attempt);
      if (wsState !== 'open') current.setAuthed(false);
    });

    const offMessage = input.ws.onMessage((message: ServerToClientMessage) => {
      const current = latest.current;
      switch (message.type) {
        case 'auth_ok':
          current.setAuthed(true);
          input.ws.send({
            type: 'events:subscribe',
            session_id: current.activeSessionIdRef.current,
          });
          return;
        case 'state_sync':
          current.setWorkspaces(message.workspaces);
          // Message handling can continue in the same task before React runs
          // an effect. Keep lifecycle guards on the authoritative sync state,
          // not the previous render's ref snapshot.
          current.sessionsRef.current = message.sessions;
          current.setSessions(message.sessions);
          // `state_sync` is the reconnect authority for session lifecycle.
          // Reconcile transient pending state too, otherwise a missed terminal
          // frame can leave Composer saying "Turn running" indefinitely. Keep
          // a genuine optimistic send pending until its canonical echo lands.
          current.setPendingBySession(previous => {
            let next = previous;
            for (const session of message.sessions) {
              const hasPendingEcho = (current.itemsBySessionRef.current[session.id] ?? [])
                .some(item => item.kind === 'user' && item.pending === true && !item.failed);
              const pending = session.status === 'running'
                || session.status === 'pending'
                || hasPendingEcho;
              if (previous[session.id] === pending) continue;
              if (next === previous) next = { ...previous };
              next[session.id] = pending;
            }
            return next;
          });
          current.setTasks(message.tasks);
          current.setSystemConfig(message.config);
          current.setRunner(message.runner);
          // A reconnect may have missed workspace:git-updated broadcasts.
          // Force a fresh scan whenever the Host sends authoritative state.
          current.refreshWorkingTrees?.();
          invalidateAllChangesDiffs();
          // Defensive absorption: any overlay whose value the sync already
          // reflects is dropped immediately (§4.3).
          for (const session of message.sessions) {
            current.operationStore.absorbMatchingOverlays(
              sessionEntityKey(session.id),
              field => session[field as keyof Session],
            );
          }
          for (const task of message.tasks) {
            current.operationStore.absorbMatchingOverlays(
              taskEntityKey(task.id),
              field => task[field as keyof Task],
            );
          }
          for (const workspace of message.workspaces) {
            current.operationStore.absorbMatchingOverlays(
              workspaceEntityKey(workspace.id),
              field => workspace[field as keyof Workspace],
            );
          }
          return;
        case 'workspace:git-updated':
          invalidateSlashCacheForWorkspace(message.workspace_id);
          window.dispatchEvent(new CustomEvent(SLASH_CACHE_INVALIDATED_EVENT, {
            detail: { workspaceId: message.workspace_id },
          }));
          current.refreshWorkingTrees?.();
          // The Diffs rail's Changes multi-diff store is tree-scoped and
          // doesn't track workspace membership — refresh every loaded tree
          // (in practice only the viewed one holds state).
          invalidateAllChangesDiffs();
          return;
        case 'session:created': {
          // Native adoption has an independent HTTP result and WS broadcast.
          // The Host-originated cause makes both delivery orders safe: this
          // frame only converges canonical state, while ordinary create
          // frames still own selection and pendingFirstMessage even if a
          // reconnect state_sync already exposed their session id.
          const nativeAdopt = message.origin === 'native-adopt';
          current.sessionsRef.current = [
            message.session,
            ...current.sessionsRef.current.filter(session => session.id !== message.session.id),
          ];
          current.setSessions(previous => [
            message.session,
            ...previous.filter(session => session.id !== message.session.id),
          ]);
          if (nativeAdopt) return;
          current.setActiveSessionId(message.session.id);
          // The creating/forking busy state is driven by the pending
          // operation run in App and ends on operation:result — nothing to
          // clear here.
          const pending = pendingFirstMessageForCreatedSession(
            current.pendingFirstMessageRef.current,
            message.session,
            message.origin,
          );
          if (pending) {
            current.pendingFirstMessageRef.current = null;
            // Screenshot Blobs can only be uploaded after the Session exists.
            // The operation path is async; selection already happened above.
            void deliverCreatedSessionFirstMessage(pending, message.session, current);
          } else {
            // Native adoption broadcasts session:created around the same time
            // its HTTP response selects the session and hydrates replayed
            // history. The WS and HTTP connections may arrive in either
            // order, so never erase a transcript that hydration already
            // populated; initialize only a genuinely unseen session.
            current.setItemsBySession(previous => (
              previous[message.session.id] === undefined
                ? { ...previous, [message.session.id]: [] }
                : previous
            ));
          }
          return;
        }
        case 'session:updated': {
          const partial = message.session;
          const priorStatus = current.sessionsRef.current
            .find(session => session.id === partial.id)?.status;
          const fromTurnEnd = partial.status === 'done' || partial.status === 'error';
          if (partial.unread === 1 && fromTurnEnd
            && partial.id === current.activeSessionIdRef.current) {
            current.ops.dispatch('session.setUnread', { sessionId: partial.id, unread: false });
          }
          if (partial.status === 'running' || partial.status === 'pending') {
            current.setPendingBySession(previous => ({ ...previous, [partial.id]: true }));
          } else if (fromTurnEnd) {
            current.setPendingBySession(previous => ({ ...previous, [partial.id]: false }));
            // The session lifecycle broadcast is authoritative even when the
            // subscribed event frame was lost during a switch/reconnect. Fold
            // the newest turn already in memory now; a later real completion
            // event is idempotent with this synthetic boundary.
            const updatedAt = typeof partial.updated_at === 'string'
              ? Date.parse(partial.updated_at)
              : Number.NaN;
            // Only a live/pending → terminal transition is a turn boundary.
            // Later rename/archive updates can include status=done too; they
            // must not timestamp a legacy turn with the mutation time.
            if (priorStatus == null || priorStatus === 'running' || priorStatus === 'pending') {
              const terminalTs = Number.isFinite(updatedAt) ? updatedAt : 0;
              current.setItemsBySession(previous => {
                const list = previous[partial.id];
                if (!list) return previous;
                const next = ensureLatestTurnEnd(list, partial.id, terminalTs);
                return next === list ? previous : { ...previous, [partial.id]: next };
              });
              // An inactive session is not subscribed to event frames, so its
              // plan may otherwise remain "active" forever even though the
              // authoritative session lifecycle already reached terminal.
              current.setPlanStateBySession(previous => {
                const existing = previous[partial.id];
                if (!existing?.text) return previous;
                const transcript = current.itemsBySessionRef.current[partial.id] ?? [];
                let latestTurn = existing.turn ?? 0;
                for (const item of transcript) latestTurn = Math.max(latestTurn, item.turn);
                const terminal: EventEnvelope = {
                  session_id: partial.id,
                  turn: latestTurn,
                  call_id: `session-terminal:${partial.id}:${latestTurn}`,
                  event: partial.status === 'error' ? 'turn.failed' : 'turn.completed',
                  ts: terminalTs,
                  data: partial.status === 'error'
                    ? { message: 'Session ended with an error', retryable: true }
                    : { turnId: String(latestTurn) },
                  display: partial.status === 'error'
                    ? {
                        type: 'state.error',
                        data: { message: 'Session ended with an error', retryable: true },
                      }
                    : {
                        type: 'state.turn-completed',
                        data: { turnId: String(latestTurn) },
                      },
                };
                const next = applyPlanLifecycle(existing, terminal);
                return next === existing ? previous : { ...previous, [partial.id]: next };
              });
            }
          }
          current.sessionsRef.current = applySessionUpdate(current.sessionsRef.current, partial);
          current.setSessions(previous => applySessionUpdate(previous, partial));
          current.operationStore.absorbMatchingOverlays(
            sessionEntityKey(partial.id),
            field => (partial as Record<string, unknown>)[field],
          );
          return;
        }
        case 'session:history-rebuilt': {
          const executor = current.sessionsRef.current
            .find(session => session.id === message.session_id)?.executor ?? 'claude';
          current.rebuildSessionHistory(message.session_id, executor);
          return;
        }
        case 'session:native-config':
          current.setSessions(previous => previous.map(session => session.id === message.session_id
            ? {
                ...session,
                executor_config: message.state,
                native_config_options: message.options,
              }
            : session));
          return;
        case 'session:slash-commands':
          window.dispatchEvent(new CustomEvent('gian:session-slash-commands', {
            detail: { sessionId: message.session_id, commands: message.commands },
          }));
          return;
        case 'session:deleted':
          current.setSessions(previous => previous.filter(session => session.id !== message.session_id));
          current.setActiveSessionId(previous => previous === message.session_id ? null : previous);
          return;
        case 'task:created':
          current.setTasks(previous => [
            message.task,
            ...previous.filter(task => task.id !== message.task.id),
          ]);
          current.setActiveTaskId(message.task.id);
          current.setActiveSubtaskId(null);
          return;
        case 'task:updated':
          current.setTasks(previous => previous.map(task =>
            task.id === message.task.id ? { ...task, ...message.task } : task));
          // Defensive absorption for task overlays (rename/done/pin), same
          // contract as session:updated above.
          current.operationStore.absorbMatchingOverlays(
            taskEntityKey(message.task.id),
            field => (message.task as Record<string, unknown>)[field],
          );
          return;
        case 'task:deleted':
          current.setTasks(previous => previous.filter(task => task.id !== message.task_id));
          current.setActiveTaskId(previous => previous === message.task_id ? null : previous);
          current.setActiveSubtaskId(null);
          return;
        case 'queue:updated':
          current.setQueueBySession(previous => ({
            ...previous,
            [message.session_id]: message.queue,
          }));
          return;
        case 'approval:created':
        case 'approval:updated':
          return;
        case 'event': {
          const session = current.sessionsRef.current
            .find(candidate => candidate.id === message.session_id);
          handleEnvelope(message, session?.executor ?? 'claude');
          return;
        }
        case 'runner:updated':
          current.setRunner(previous => previous
            ? { ...previous, ...message.runner }
            : message.runner as RunnerInfo);
          return;
        case 'error': {
          if (message.session_id
            && (message.request_type === 'message:send' || message.code === 'MESSAGE_SEND_FAILED')) {
            const sessionId = message.session_id;
            if (!message.request_id) {
              // UNCORRELATED legacy fallback only: correlated send failures
              // (every send now carries a request_id) mark THEIR echo failed
              // precisely by run id via the operation rollback (proposal §9);
              // this imprecise latest-pending marking must not run for them.
              current.setItemsBySession(previous => {
                const delta = applyErrorEnvelopeToSession(previous[sessionId], sessionId);
                if (!delta || delta.items === previous[sessionId]) return previous;
                return { ...previous, [sessionId]: delta.items };
              });
            }
            // Clear the spinner for both paths (the operation rollback only
            // marks the echo; the session-level pending flag is cleared here).
            current.setPendingBySession(previous => ({ ...previous, [sessionId]: false }));
          }
          toast({ kind: 'error', title: message.code, message: message.message });
        }
      }
    });

    void Promise.all([loadWorkspaces(), loadSessions(), loadTasks()]).then(([workspaces, sessions, tasks]) => {
      const current = latest.current;
      current.setWorkspaces(previous => previous.length > 0 ? previous : workspaces);
      current.setSessions(previous => previous.length > 0 ? previous : sessions);
      current.setTasks(previous => previous.length > 0 ? previous : tasks);
    });
    return () => {
      offMessage();
      offState();
      input.ws.disconnect();
    };
  }, [input.authStatus, input.ws]);
}
