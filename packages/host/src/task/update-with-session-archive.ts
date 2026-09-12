import type { Task } from '@gian/shared';
import type { SessionManager } from '../session/manager.js';
import type { TaskManager, UpdateTaskInput } from './manager.js';

/**
 * Keep Task status and its session visibility aligned (T1, 2026-09-06):
 * completing a Task stamps every owned session `completed_at` first (already
 * completed ones keep their own timestamp) and archives them atomically;
 * reopening unarchives without clearing completion.
 */
export function updateTaskWithSessionArchive(
  tasks: TaskManager,
  sessions: SessionManager,
  taskId: string,
  input: UpdateTaskInput,
): Task {
  const previous = tasks.getTask(taskId);
  const task = tasks.updateTask(taskId, input);

  if (input.status !== undefined && input.status !== previous?.status) {
    if (task.status === 'done' || task.status === 'open') {
      sessions.notifyTaskSessionsUpdated(taskId);
    }
  }

  return task;
}
