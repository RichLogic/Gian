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
import { toast } from '../feedback.js';
import { maybeNotifyForEnvelope } from '../notifications.js';
import {
  applySessionUpdate,
  isSessionCreateDispatchError,
  planCreatedSessionFirstMessage,
} from '../session-routing.js';
import {
  applyEnvelope,
  applyErrorEnvelopeToSession,
  applyPlanLifecycle,
  createOptimisticEcho,
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
  setCreatingSession: Setter<boolean>;
  setForkingSession: Setter<boolean>;
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
      if (displayType === 'plan' || displayType === 'state.turn-completed') {
        current.setPlanStateBySession(previous => {
          const existing = previous[envelope.session_id] ?? { completed: false };
          const next = applyPlanLifecycle(existing, envelope);
          return next === existing ? previous : { ...previous, [envelope.session_id]: next };
        });
      }
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
          return;
        case 'state_sync':
          current.setWorkspaces(message.workspaces);
          current.setSessions(message.sessions);
          current.setTasks(message.tasks);
          current.setSystemConfig(message.config);
          current.setRunner(message.runner);
          return;
        case 'session:created': {
          current.setSessions(previous => [
            message.session,
            ...previous.filter(session => session.id !== message.session.id),
          ]);
          current.setActiveSessionId(message.session.id);
          current.setCreatingSession(false);
          current.setForkingSession(false);
          const pending = current.pendingFirstMessageRef.current;
          current.pendingFirstMessageRef.current = null;
          const firstMessage = planCreatedSessionFirstMessage(pending);
          if (firstMessage.structuredText) {
            const optimistic = createOptimisticEcho({
              sessionId: message.session.id,
              text: firstMessage.structuredText,
              exec: message.session.executor,
            });
            current.setItemsBySession(previous => ({
              ...previous,
              [message.session.id]: [optimistic],
            }));
            current.setPendingBySession(previous => ({
              ...previous,
              [message.session.id]: true,
            }));
            input.ws.send({
              type: 'message:send',
              session_id: message.session.id,
              text: firstMessage.structuredText,
            });
          } else {
            current.setItemsBySession(previous => ({ ...previous, [message.session.id]: [] }));
          }
          return;
        }
        case 'session:updated': {
          const partial = message.session;
          const fromTurnEnd = partial.status === 'done' || partial.status === 'error';
          if (partial.unread === 1 && fromTurnEnd
            && partial.id === current.activeSessionIdRef.current) {
            input.ws.send({ type: 'session:set_unread', session_id: partial.id, unread: false });
          }
          if (partial.status === 'running' || partial.status === 'pending') {
            current.setPendingBySession(previous => ({ ...previous, [partial.id]: true }));
          } else if (partial.status === 'done' || partial.status === 'error') {
            current.setPendingBySession(previous => ({ ...previous, [partial.id]: false }));
          }
          current.setSessions(previous => applySessionUpdate(previous, partial));
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
          if (message.session_id && message.code === 'MESSAGE_SEND_FAILED') {
            const sessionId = message.session_id;
            current.setItemsBySession(previous => {
              const delta = applyErrorEnvelopeToSession(previous[sessionId], sessionId);
              if (!delta || delta.items === previous[sessionId]) return previous;
              return { ...previous, [sessionId]: delta.items };
            });
            current.setPendingBySession(previous => ({ ...previous, [sessionId]: false }));
          }
          if (isSessionCreateDispatchError(message)) {
            current.setCreatingSession(false);
            current.setForkingSession(false);
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
