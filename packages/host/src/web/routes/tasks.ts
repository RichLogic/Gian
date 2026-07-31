import type {
  ApprovalMode,
  Executor,
  GianActionMethod,
  Role,
  TaskStatus,
} from '@gian/shared';
import type { Hono } from 'hono';
import type { SessionManager } from '../../session/manager.js';
import { deleteTaskCascade } from '../../task/delete-cascade.js';
import type { TaskManager, UpdateTaskInput } from '../../task/manager.js';
import type { WsBroadcaster } from '../ws-broadcast.js';

interface TaskRouteDependencies {
  tasks: TaskManager;
  sessions: SessionManager;
  broadcaster: WsBroadcaster;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerTaskRoutes(
  app: Hono,
  { tasks, sessions, broadcaster }: TaskRouteDependencies,
): void {
  app.get('/api/tasks', c => c.json(tasks.listTasks()));

  app.post('/api/tasks', async c => {
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      executor?: Executor;
    }>();
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json({ error: 'name required' }, 400);
    }
    if (body.executor !== undefined && !['claude', 'codex', 'kimi'].includes(body.executor)) {
      return c.json({ error: 'executor must be claude, codex, or kimi' }, 400);
    }
    try {
      const task = tasks.createTask({
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.executor !== undefined ? { manager_executor: body.executor } : {}),
      });
      broadcaster.broadcast({ type: 'task:created', task });
      return c.json(task);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.patch('/api/tasks/:id', async c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      status?: TaskStatus;
    }>();
    const patch: UpdateTaskInput = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.status !== undefined) patch.status = body.status;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'no updatable fields' }, 400);
    }
    try {
      const task = tasks.updateTask(id, patch);
      broadcaster.broadcast({ type: 'task:updated', task });
      return c.json(task);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.delete('/api/tasks/:id', async c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    try {
      await deleteTaskCascade(tasks, sessions, id);
      broadcaster.broadcast({ type: 'task:deleted', task_id: id });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post('/api/tasks/:id/subtasks', async c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    const body = await c.req.json<{
      workspace_id?: string;
      executor?: Executor;
      name?: string;
      model?: string | null;
      approval_mode?: ApprovalMode;
      mode?: 'regular' | 'worktree';
    }>();
    if (typeof body.workspace_id !== 'string' || body.workspace_id === '') {
      return c.json({ error: 'workspace_id required' }, 400);
    }
    if (body.executor !== 'claude' && body.executor !== 'codex' && body.executor !== 'kimi') {
      return c.json({ error: 'executor must be claude, codex, or kimi' }, 400);
    }
    try {
      const session = await sessions.createSession({
        workspace_id: body.workspace_id,
        executor: body.executor,
        type: 'subtask',
        task_id: id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.approval_mode !== undefined ? { approval_mode: body.approval_mode } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
      });
      broadcaster.broadcast({ type: 'session:created', session });
      return c.json({ session });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post('/api/tasks/:id/loop', async c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    const body = await c.req.json<{
      allowed_methods?: GianActionMethod[];
      allowed_workspaces?: string[];
      allowed_executors?: Executor[];
      max_rounds?: number;
      current_step?: string | null;
      current_step_session_id?: string | null;
      expected_role?: Role | null;
    }>().catch(() => ({}));
    try {
      return c.json({ loop: sessions.startLoop(id, body) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get('/api/tasks/:id/loop', c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    return c.json({ loop: sessions.getTaskLoop(id) });
  });

  app.get('/api/tasks/:id/actions', c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    return c.json({ actions: sessions.listTaskActions(id) });
  });

  app.post('/api/tasks/:id/actions/:actionId/confirm', async c => {
    try {
      const action = await sessions.confirmTaskAction(
        c.req.param('id'),
        c.req.param('actionId'),
      );
      return action
        ? c.json({ action })
        : c.json({ error: 'action not found' }, 404);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post('/api/tasks/:id/actions/:actionId/reject', c => {
    const action = sessions.rejectTaskAction(
      c.req.param('id'),
      c.req.param('actionId'),
    );
    return action
      ? c.json({ action })
      : c.json({ error: 'action not found' }, 404);
  });

  app.post('/api/sessions/:id/complete', c => {
    try {
      sessions.completeSubtask(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        { error: message },
        message.startsWith('session not found') ? 404 : 400,
      );
    }
  });

  app.post('/api/sessions/:id/reopen', c => {
    try {
      sessions.reopenSubtask(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        { error: message },
        message.startsWith('session not found') ? 404 : 400,
      );
    }
  });

  app.post('/api/sessions/:id/abandon', async c => {
    const body: { reason?: string | null } = await c.req
      .json<{ reason?: string | null }>()
      .catch(() => ({}));
    const reason = typeof body.reason === 'string' ? body.reason : null;
    try {
      sessions.abandonSubtask(c.req.param('id'), reason);
      return c.json({ ok: true });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        { error: message },
        message.startsWith('session not found') ? 404 : 400,
      );
    }
  });

  app.post('/api/tasks/:id/manager', async c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    try {
      const existed = sessions.getManagerSession(id) !== null;
      const session = await sessions.ensureManagerSession(id);
      if (!existed) broadcaster.broadcast({ type: 'session:created', session });
      return c.json({ session });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post('/api/tasks/:id/manager/message', async c => {
    const id = c.req.param('id');
    if (!tasks.getTask(id)) return c.json({ error: 'task not found' }, 404);
    const body = await c.req.json<{ text?: string }>();
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return c.json({ error: 'text required' }, 400);
    }
    try {
      const existed = sessions.getManagerSession(id) !== null;
      const sessionId = await sessions.sendManagerMessage(id, body.text);
      if (!existed) {
        broadcaster.broadcast({
          type: 'session:created',
          session: sessions.getSession(sessionId),
        });
      }
      return c.json({ session_id: sessionId });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });
}
