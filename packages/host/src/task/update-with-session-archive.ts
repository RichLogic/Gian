import type { Task } from '@gian/shared';
import type { SessionManager } from '../session/manager.js';
import type { TaskManager, UpdateTaskInput } from './manager.js';

/**
 * Keep Task status and its session visibility aligned. Session completion is
 * intentionally independent: this changes `archived`, never `completed_at`.
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
