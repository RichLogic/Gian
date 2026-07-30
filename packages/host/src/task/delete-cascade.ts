import type { SessionManager } from '../session/manager.js';
import type { TaskManager } from './manager.js';

/**
 * Delete a Task and every Gian session owned by it (PM manager + subtasks).
 *
 * Session deletion goes through SessionManager so proxy/CLI-PTY/worktree/
 * approval teardown and `session:deleted` broadcasts stay identical to
 * deleting the sessions one by one. The final task delete still uses
 * TaskManager's guard, so a failed session deletion leaves the task row in
 * place instead of silently orphaning sessions.
 */
export async function deleteTaskCascade(
  tasks: TaskManager,
  sessions: SessionManager,
  taskId: string,
): Promise<void> {
  for (const id of sessions.listSessionIdsForTask(taskId)) {
    try {
      await sessions.deleteSession(id);
    } catch (err) {
      console.warn(`[task:delete] cascade delete of session ${id} failed: ${String(err)}`);
    }
  }
  tasks.deleteTask(taskId);
}
