import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { InputItem, Session, Task, Workspace } from '@gian/shared';
import {
  stripCreateSubtaskBlocks,
  stripGianActionBlocks,
  stripGianRolePrefix,
  stripManagerSystemPrefix,
  wrapManagerContextNote,
} from '@gian/shared';
import { createSubtask, ensureManagerSession } from '../api.js';
import { attachmentInputItem, type ComposerAttachmentPayload } from '../attachments.js';
import { injectComposerDraft } from '../components/Composer.js';
import { toast } from '../feedback.js';
import { createOptimisticEcho } from '../transcript/apply.js';
import type { QueueEntry, TranscriptItem } from '../types.js';
import {
  managerCardContextNote,
  type ManagerComposerHandlers,
  type ManagerSubtaskCard,
  type NewSubtaskDraft,
} from '../views/TasksView.js';
import type { GianWs } from '../ws.js';
import type { SessionCommands } from './use-session-commands.js';

interface UseTaskManagerInput {
  mode: string;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  activeRail: string | null;
  tasks: Task[];
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  workspacesRef: MutableRefObject<Workspace[]>;
  itemsBySession: Record<string, TranscriptItem[]>;
  setItemsBySession: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>;
  pendingBySession: Record<string, boolean>;
  setPendingBySession: Dispatch<SetStateAction<Record<string, boolean>>>;
  queueBySession: Record<string, QueueEntry[]>;
  sessionCommands: SessionCommands;
  hydrateTranscript(sessionId: string, executor: Session['executor']): void;
  setActiveSubtaskId: Dispatch<SetStateAction<string | null>>;
  ws: GianWs;
}

export function useTaskManager(input: UseTaskManagerInput) {
  const [cardsByTask, setCardsByTask] = useState<Record<string, ManagerSubtaskCard[]>>({});
  const cardsRef = useRef(cardsByTask);
  cardsRef.current = cardsByTask;
  const [showRaw, setShowRaw] = useState(() => {
    try { return localStorage.getItem('gian.manager.debugRaw') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('gian.manager.debugRaw', showRaw ? '1' : '0'); } catch { /* ignore */ }
  }, [showRaw]);

  const activeSession = useMemo(() => input.activeTaskId
    ? input.sessions.find(session =>
        session.type === 'manager' && session.task_id === input.activeTaskId) ?? null
    : null, [input.activeTaskId, input.sessions]);
  const activeTask = useMemo(() => input.activeTaskId
    ? input.tasks.find(task => task.id === input.activeTaskId) ?? null
    : null, [input.activeTaskId, input.tasks]);
  const rawItems = activeSession ? input.itemsBySession[activeSession.id] ?? [] : [];
  const items = showRaw ? rawItems : rawItems.map(item => {
    if (item.kind === 'user') {
      return { ...item, text: stripGianRolePrefix(stripManagerSystemPrefix(item.text)) };
    }
    if (item.kind === 'assistant') {
      return { ...item, text: stripGianActionBlocks(stripCreateSubtaskBlocks(item.text)) };
    }
    return item;
  });
  const pending = activeSession
    ? input.pendingBySession[activeSession.id] ?? activeSession.status === 'running'
    : false;
  const sessionId = activeSession?.id ?? null;
  const queue = sessionId ? input.queueBySession[sessionId] ?? [] : [];
  const handlers = useMemo<ManagerComposerHandlers | null>(() => {
    if (!sessionId) return null;
    const commands = input.sessionCommands;
    return {
      onSetModel: model => commands.onSetModel(sessionId, model),
      onSetMode: mode => commands.onSetMode(sessionId, mode),
      onSetEffort: effort => commands.onSetEffort(sessionId, effort),
      onSetServiceTier: tier => commands.onSetServiceTier(sessionId, tier),
      onSetNativeConfig: (configId, value) => commands.onSetNativeConfig(sessionId, configId, value),
      onSendSkill: (name, path) => commands.onSendSkill(sessionId, name, path),
      onQueueAdd: (text, attachments) => commands.onQueueAdd(sessionId, text, attachments),
      onQueueRemove: queueId => commands.onQueueRemove(sessionId, queueId),
      onQueueReorder: order => commands.onQueueReorder(sessionId, order),
      onQueueClear: () => commands.onQueueClear(sessionId),
      onQueueSendNow: () => commands.onQueueSendNow(sessionId),
      onApprove: (approvalId, decision, answers, context) =>
        commands.onApprove(sessionId, approvalId, decision, answers, context),
    };
  }, [input.sessionCommands, sessionId]);

  const visible = input.mode === 'tasks' && (
    (!input.activeSubtaskId && !!input.activeTaskId)
    || (!!input.activeSubtaskId && input.activeRail === 'manager')
  );
  const clearedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !activeSession) {
      clearedRef.current = null;
      return;
    }
    if (clearedRef.current === activeSession.id) return;
    clearedRef.current = activeSession.id;
    if (activeSession.unread === 1) {
      input.ws.send({ type: 'session:set_unread', session_id: activeSession.id, unread: false });
    }
  }, [activeSession, input.ws, visible]);

  const onMount = useCallback((taskId: string) => {
    const existing = input.sessionsRef.current.find(session =>
      session.type === 'manager' && session.task_id === taskId);
    if (existing) {
      input.hydrateTranscript(existing.id, existing.executor);
      return;
    }
    void ensureManagerSession(taskId).then(session => {
      if (!session) return;
      input.setItemsBySession(previous => previous[session.id] !== undefined
        ? previous
        : { ...previous, [session.id]: [] });
    });
  }, [input.hydrateTranscript, input.sessionsRef, input.setItemsBySession]);

  const onSend = useCallback((
    taskId: string,
    text: string,
    options?: { attachments?: Array<ComposerAttachmentPayload & { previewUrl: string }> },
  ) => {
    const unacked = (cardsRef.current[taskId] ?? []).filter(card => !card.acked);
    const sentText = wrapManagerContextNote(unacked.map(managerCardContextNote), text);
    const manager = input.sessionsRef.current.find(session =>
      session.type === 'manager' && session.task_id === taskId);
    if (!manager) return;
    const attachments = options?.attachments ?? [];
    const optimistic = createOptimisticEcho({
      sessionId: manager.id,
      text,
      exec: manager.executor,
      attachments: attachments.length > 0
        ? attachments.map(attachment => ({
            name: attachment.name,
            mime: attachment.mime,
            url: attachment.previewUrl,
            ...(attachment.size !== undefined ? { size: attachment.size } : {}),
          }))
        : undefined,
    });
    input.setItemsBySession(previous => ({
      ...previous,
      [manager.id]: [...(previous[manager.id] ?? []), optimistic],
    }));
    input.setPendingBySession(previous => ({ ...previous, [manager.id]: true }));
    const messageItems: InputItem[] = [];
    if (sentText.trim()) messageItems.push({ type: 'text', text: sentText });
    for (const attachment of attachments) messageItems.push(attachmentInputItem(attachment));
    input.ws.send({
      type: 'message:send',
      session_id: manager.id,
      text: sentText,
      ...(messageItems.length > 0 ? { items: messageItems } : {}),
    });
    if (unacked.length > 0) {
      const ids = new Set(unacked.map(card => card.id));
      setCardsByTask(previous => ({
        ...previous,
        [taskId]: (previous[taskId] ?? []).map(card => ids.has(card.id)
          ? { ...card, acked: true }
          : card),
      }));
    }
  }, [input.sessionsRef, input.setItemsBySession, input.setPendingBySession, input.ws]);

  const onStop = useCallback((taskId: string) => {
    const manager = input.sessionsRef.current.find(session =>
      session.type === 'manager' && session.task_id === taskId);
    if (manager) input.ws.send({ type: 'session:stop', session_id: manager.id });
  }, [input.sessionsRef, input.ws]);

  const onCreateSubtask = useCallback((taskId: string, draft: NewSubtaskDraft) => {
    void createSubtask(taskId, {
      workspace_id: draft.workspace_id,
      executor: draft.executor,
      ...(draft.name ? { name: draft.name } : {}),
    }).then(session => {
      if (!session) {
        toast({ kind: 'error', message: 'create subtask failed' });
        return;
      }
      const prompt = draft.prompt?.trim() ?? '';
      if (prompt) injectComposerDraft(session.id, prompt);
      const workspaceLabel = input.workspacesRef.current
        .find(workspace => workspace.id === draft.workspace_id)?.name;
      setCardsByTask(previous => ({
        ...previous,
        [taskId]: [...(previous[taskId] ?? []), {
          id: session.id,
          status: 'created',
          executor: draft.executor,
          prompt,
          ...(draft.name ? { name: draft.name } : {}),
          ...(workspaceLabel ? { workspaceLabel } : {}),
          ts: Date.now(),
          acked: false,
        }],
      }));
      input.setActiveSubtaskId(session.id);
    });
  }, [input.setActiveSubtaskId, input.workspacesRef]);

  return {
    activeManagerSession: activeSession,
    activeManagerTask: activeTask,
    managerItems: items,
    managerPending: pending,
    managerQueue: queue,
    managerHandlers: handlers,
    managerCardsByTask: cardsByTask,
    showManagerRaw: showRaw,
    setShowManagerRaw: setShowRaw,
    onManagerMount: onMount,
    onManagerSend: onSend,
    onManagerStop: onStop,
    onCreateSubtask,
  };
}
