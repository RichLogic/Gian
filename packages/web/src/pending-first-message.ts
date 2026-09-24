import type { ComposerDocument, MessageContextItem, Session } from '@gian/shared';

export interface PendingFirstAttachment {
  id: string;
  name: string;
  /** image/png for screenshots; pasted/picked files carry their own mime. */
  mime: string;
  size: number;
  blob: Blob;
}

export interface PendingFirstMessage {
  scope: { kind: 'workspace' | 'task'; id: string; environmentId?: string };
  text: string;
  attachments: PendingFirstAttachment[];
  contextItems?: MessageContextItem[];
  composerDocument?: ComposerDocument;
}

/** String remains accepted while older isolated tests and callers migrate. */
export type PendingFirstMessageValue = string | PendingFirstMessage | null;

export function pendingFirstMessageForCreatedSession(
  value: PendingFirstMessageValue,
  session: Session,
  origin?: 'interactive-create' | 'native-adopt' | 'task-create' | 'session-fork' | 'tool-create',
): PendingFirstMessage | null {
  if (!value || origin === 'native-adopt' || origin === 'session-fork' || origin === 'tool-create') return null;
  if (typeof value === 'string') {
    if (session.remote_execution) return null;
    const scope = session.task_id
      ? { kind: 'task' as const, id: session.task_id }
      : session.workspace_id
        ? { kind: 'workspace' as const, id: session.workspace_id }
        : null;
    if (!scope) return null;
    return {
      scope,
      text: value,
      attachments: [],
      contextItems: [],
      composerDocument: undefined,
    };
  }
  if (value.scope.environmentId !== session.remote_execution?.environment_id) return null;
  if (value.scope.kind === 'task') {
    if (origin && origin !== 'task-create') return null;
    return session.task_id === value.scope.id ? value : null;
  }
  if (origin === 'task-create') return null;
  return (session.remote_execution?.repository_id ?? session.workspace_id) === value.scope.id && !session.task_id ? value : null;
}
