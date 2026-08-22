import type { Session } from '@gian/shared';

export interface PendingFirstAttachment {
  id: string;
  name: string;
  /** image/png for screenshots; pasted/picked files carry their own mime. */
  mime: string;
  size: number;
  blob: Blob;
}

export interface PendingFirstMessage {
  scope: { kind: 'workspace' | 'task'; id: string };
  text: string;
  attachments: PendingFirstAttachment[];
}

/** String remains accepted while older isolated tests and callers migrate. */
export type PendingFirstMessageValue = string | PendingFirstMessage | null;

export function pendingFirstMessageForCreatedSession(
  value: PendingFirstMessageValue,
  session: Session,
  origin?: 'interactive-create' | 'native-adopt' | 'task-create' | 'session-fork',
): PendingFirstMessage | null {
  if (!value || origin === 'native-adopt' || origin === 'session-fork') return null;
  if (typeof value === 'string') {
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
    };
  }
  if (value.scope.kind === 'task') {
    if (origin && origin !== 'task-create') return null;
    return session.task_id === value.scope.id ? value : null;
  }
  if (origin === 'task-create') return null;
  return session.workspace_id === value.scope.id && !session.task_id ? value : null;
}
