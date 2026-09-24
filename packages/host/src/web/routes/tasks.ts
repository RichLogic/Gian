import {
  type ApprovalMode,
  type TaskStatus,
  type ThinkingEffort,
} from '@gian/shared';
import type { Hono } from 'hono';
import type { SessionManager } from '../../session/manager.js';
import { deleteTaskCascade } from '../../task/delete-cascade.js';
import type { TaskManager, UpdateTaskInput } from '../../task/manager.js';
import { updateTaskWithSessionArchive } from '../../task/update-with-session-archive.js';
import type { WsBroadcaster } from '../ws-broadcast.js';
import type { RemoteControllerHub } from '../../remote/controller-hub.js';
import { randomUUID } from 'node:crypto';

interface TaskRouteDependencies {
  remoteController?: RemoteControllerHub;
  tasks: TaskManager;
  sessions: SessionManager;
  broadcaster: WsBroadcaster;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerTaskRoutes(
  app: Hono,
  { tasks, sessions, broadcaster, remoteController }: TaskRouteDependencies,
): void {
  app.get('/api/tasks', c => c.json(tasks.listTasks()));

  app.post('/api/tasks', async c => {
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
    }>();
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return c.json({ error: 'name required' }, 400);
    }
    try {
      const task = tasks.createTask({
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
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
      const task = updateTaskWithSessionArchive(tasks, sessions, id, patch);
      broadcaster.broadcast({ type: 'task:updated', task });
      return c.json(task);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  // Sidebar drag reorder (2026-08-29): the caller passes the scope's full
  // ordered id list; values are rewritten to a dense 1..n sequence. Like
  // /api/workspaces/reorder this does NOT broadcast — the web operation layer
  // converges canonical state itself (see operations/task.ts).
  app.post('/api/tasks/reorder', async c => {
    const body = await c.req.json<{ ids: string[] }>();
    if (!Array.isArray(body.ids)) return c.json({ error: 'ids required' }, 400);
    tasks.reorderTasks(body.ids);
    return c.json({ ok: true });
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
      remote_environment_id?: string;
      remote_session_id?: string;
      session_config?: Record<string, import('@gian/shared').ConfigValue>;
      turn_config?: Record<string, import('@gian/shared').ConfigValue>;
      request_id?: string;
      agent_id?: string;
      name?: string;
      model?: string | null;
      approval_mode?: ApprovalMode;
      thinking_effort?: ThinkingEffort | null;
      service_tier?: 'fast' | null;
    }>();
    if (typeof body.workspace_id !== 'string' || body.workspace_id === '') {
      return c.json({ error: 'workspace_id required' }, 400);
    }
    if (typeof body.agent_id !== 'string' || body.agent_id === '') {
      return c.json({ error: 'agent_id required' }, 400);
    }
    try {
      if (body.remote_environment_id) {
        if (!remoteController) throw new Error('remote execution unavailable');
        const session = body.remote_session_id ? await remoteController.takeOver(body.remote_environment_id, body.remote_session_id, id)
          : await remoteController.create({ environment_id: body.remote_environment_id,
          workspace_id: body.workspace_id, agent_id: body.agent_id, task_id: id, name: body.name,
          model: body.model, thinking_effort: body.thinking_effort, service_tier: body.service_tier,
          approval_mode: body.approval_mode, session_config: body.session_config,
          turn_config: body.turn_config }, body.request_id ?? randomUUID());
        broadcaster.broadcast({ type: 'session:created', session, origin: 'task-create' });
        return c.json({ session });
      }
      const session = await sessions.createSession({
        workspace_id: body.workspace_id,
        agent_id: body.agent_id,
        type: 'subtask',
        task_id: id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.approval_mode !== undefined ? { approval_mode: body.approval_mode } : {}),
        ...(body.thinking_effort !== undefined ? { thinking_effort: body.thinking_effort } : {}),
        ...(body.service_tier !== undefined ? { service_tier: body.service_tier } : {}),
      });
      broadcaster.broadcast({ type: 'session:created', session, origin: 'task-create' });
      return c.json({ session });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        { error: message },
        message.startsWith('agent not found') ? 404 : 400,
      );
    }
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

  app.post('/api/sessions/:id/abandon', c => {
    try {
      sessions.abandonSubtask(c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      const message = errorMessage(error);
      return c.json(
        { error: message },
        message.startsWith('session not found') ? 404 : 400,
      );
    }
  });

}
