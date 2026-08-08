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
import { toast } from '../feedback.js';
import { maybeNotifyForEnvelope } from '../notifications.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { dispatchMessageSend } from '../operations/message.js';
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
  nextPendingFromEnvelope,
  type PlanLifecycleState,
} from '../transcript/apply.js';
import type { QueueEntry, TranscriptItem } from '../types.js';
import type { GianWs, WsState } from '../ws.js';
import type { AppAuthStatus } from './use-app-auth.js';

type Setter<T> = Dispatch<SetStateAction<T>>;

interface UseAppSocketInput {
  authStatus: AppAuthStatus;
  ws: GianWs;
  sessionsRef: MutableRefObject<Session[]>;
  activeSessionIdRef: MutableRefObject<string | null>;
  pendingFirstMessageRef: MutableRefObject<string | null>;
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
  /** Operation store — canonical session data applied here defensively
   *  absorbs matching overlays (proposal §4.3). */
  operationStore: OperationStore;
  /** Operation dispatcher — the auto first-queued send and the unread
   *  auto-clear dispatch through the operation layer (Phase 2b). */
  ops: OperationDispatcher;
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
          current.setSessions(message.sessions);
          current.setTasks(message.tasks);
          current.setSystemConfig(message.config);
          current.setRunner(message.runner);
          // A reconnect may have missed workspace:git-updated broadcasts.
          // Force a fresh scan whenever the Host sends authoritative state.
          current.refreshWorkingTrees?.();
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
          const pending = current.pendingFirstMessageRef.current;
          current.pendingFirstMessageRef.current = null;
          const firstMessage = planCreatedSessionFirstMessage(pending);
          if (firstMessage.structuredText) {
            // The auto first-queued send shares the Composer's send path:
            // dispatch + synchronous optimistic echo via the echo sink.
            dispatchMessageSend(current.ops.dispatch, {
              sessionId: message.session.id,
              text: firstMessage.structuredText,
              exec: message.session.executor,
            });
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
          const fromTurnEnd = partial.status === 'done' || partial.status === 'error';
          if (partial.unread === 1 && fromTurnEnd
            && partial.id === current.activeSessionIdRef.current) {
            current.ops.dispatch('session.setUnread', { sessionId: partial.id, unread: false });
          }
          if (partial.status === 'running' || partial.status === 'pending') {
            current.setPendingBySession(previous => ({ ...previous, [partial.id]: true }));
          } else if (partial.status === 'done' || partial.status === 'error') {
            current.setPendingBySession(previous => ({ ...previous, [partial.id]: false }));
          }
          current.setSessions(previous => applySessionUpdate(previous, partial));
          current.operationStore.absorbMatchingOverlays(
            sessionEntityKey(partial.id),
            field => (partial as Record<string, unknown>)[field],
          );
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
