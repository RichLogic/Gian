import { randomUUID } from 'node:crypto';
import type { ClientToServerMessage, StateSyncMessage } from '@gian/shared';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type { SessionManager } from '../session/manager.js';
import type { TaskManager } from '../task/manager.js';
import type { WsBroadcaster } from './ws-broadcast.js';
// Platform managers subscribe to SessionManager events directly; web sends
// need no separate IM router callback.
import type { ApprovalManager } from '../approval/index.js';
import type { WorkbenchTerminalManager } from '../term/manager.js';
import type { Db } from '../storage/db.js';
import { getUsernameForToken } from '../auth/tokens.js';
import { AUTH_REQUIRED } from '../auth/middleware.js';
import { loadConfig } from '../storage/config.js';
import { listAllBots } from '../im/bots-api.js';
import { deleteTaskCascade } from '../task/delete-cascade.js';

interface WsMessageEvent {
  data: WSMessageReceive;
}

interface WsCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface WsHandlerDeps {
  sessions: SessionManager;
  tasks?: TaskManager;
  broadcaster: WsBroadcaster;
  approvals?: ApprovalManager;
  term?: WorkbenchTerminalManager;
  db?: Db;
}

interface ClientState {
  authed: boolean;
  clientId: string;
}

export function makeWsHandlers({ sessions, tasks, broadcaster, approvals, term, db }: WsHandlerDeps) {
  const states = new WeakMap<WSContext, ClientState>();

  async function sendStateSync(ws: WSContext): Promise<void> {
    if (!db) return;
    const config = loadConfig(db);
    const sync: StateSyncMessage = {
      type: 'state_sync',
      runner: {
        host: config.host || '127.0.0.1',
        latency: 0,
        started_ago: '0s',
        agents: 0,
        disk: '?',
        codex_version: '?',
        cc_version: '?',
        ws_root: config.workspace_root,
      },
      sessions: sessions.listSessions(),
      tasks: tasks?.listTasks() ?? [],
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY sort_order, name').all() as StateSyncMessage['workspaces'],
      bots: await listAllBots(db),
      approvals: (approvals?.listPending() ?? []).map(r => ({
        id: r.id,
        session_id: r.sessionId,
        turn_id: r.turnId,
        category: r.category,
        title: r.description,
        command: typeof r.subject === 'string' ? r.subject : '',
        reason: null,
        status: r.status,
        resolved_by: r.resolvedBy ?? null,
        resolved_at: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
        created_at: new Date(r.createdAt).toISOString(),
        ...(r.nativeOptions ? { native_options: r.nativeOptions } : {}),
      })),
      config,
    };
    broadcaster.send(ws, sync);
  }

  return {
    onOpen(_evt: Event, ws: WSContext) {
      states.set(ws, { authed: false, clientId: randomUUID() });
      broadcaster.add(ws);
    },

    onClose(_evt: WsCloseEvent, ws: WSContext) {
      broadcaster.remove(ws);
      states.delete(ws);
    },

    async onMessage(evt: WsMessageEvent, ws: WSContext) {
      const state = states.get(ws);
      if (!state) return;

      let parsed: ClientToServerMessage;
      try {
        const raw = typeof evt.data === 'string' ? evt.data : evt.data.toString();
        parsed = JSON.parse(raw) as ClientToServerMessage;
      } catch {
        ws.close(4002, 'invalid_json');
        return;
      }

      if (!state.authed) {
        if (parsed.type !== 'auth') {
          ws.close(4001, 'auth_required');
          return;
        }
        if (!parsed.token || parsed.token.length === 0) {
          ws.close(4001, 'auth_failed');
          return;
        }
        if (AUTH_REQUIRED) {
          const username = getUsernameForToken(parsed.token);
          if (!username) {
            ws.close(4001, 'auth_failed');
            return;
          }
          state.authed = true;
          broadcaster.send(ws, { type: 'auth_ok', user: username });
        } else {
          state.authed = true;
          broadcaster.send(ws, { type: 'auth_ok', user: 'dev' });
        }
        // Send authoritative state immediately after auth so the client can
        // skip REST fetches and re-sync after reconnect.
        await sendStateSync(ws);
        return;
      }

      try {
        await dispatch(parsed, sessions, tasks, broadcaster, ws, term);
      } catch (err) {
        console.error('[ws] dispatch error', err);
        // Surface the failure to the client. Without this, errors inside
        // sendMessage / respondApproval / etc. are invisible — the user sees
        // "no reply" with no clue why.
        const sessionIdField = (parsed as { session_id?: unknown }).session_id;
        // Prefer an explicit error code when the domain layer provides one.
        const explicitCode = (err && typeof err === 'object'
          && typeof (err as { code?: unknown }).code === 'string')
          ? (err as { code: string }).code
          : null;
        broadcaster.send(ws, {
          type: 'error',
          request_type: parsed.type,
          ...(typeof sessionIdField === 'string' ? { session_id: sessionIdField } : {}),
          code: explicitCode ?? dispatchErrorCode(parsed.type),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

function dispatchErrorCode(messageType: string): string {
  switch (messageType) {
    case 'message:send':
      return 'MESSAGE_SEND_FAILED';
    case 'message:steer':
      return 'MESSAGE_STEER_FAILED';
    case 'approval:resolve':
      return 'APPROVAL_RESOLVE_FAILED';
    case 'session:create':
      return 'SESSION_CREATE_FAILED';
    case 'session:stop':
      return 'SESSION_STOP_FAILED';
    case 'queue:send_now':
      return 'QUEUE_SEND_NOW_FAILED';
    case 'task:delete':
      return 'TASK_DELETE_FAILED';
    default:
      return 'DISPATCH_FAILED';
  }
}

async function dispatch(
  msg: ClientToServerMessage,
  sessions: SessionManager,
  tasks: TaskManager | undefined,
  broadcaster: WsBroadcaster,
  ws: WSContext,
  term?: WorkbenchTerminalManager,
): Promise<void> {
  switch (msg.type) {
    case 'session:create': {
      const session = await sessions.createSession({
        workspace_id: msg.workspace_id,
        executor: msg.executor,
        model: msg.model,
        approval_mode: msg.approval_mode,
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        ...(msg.mode !== undefined ? { mode: msg.mode } : {}),
        ...(msg.base_branch !== undefined ? { base_branch: msg.base_branch } : {}),
        ...(msg.branch !== undefined ? { branch: msg.branch } : {}),
        ...(msg.fork_from !== undefined ? { fork_from: msg.fork_from } : {}),
      });
      broadcaster.send(ws, {
        type: 'session:created',
        session,
        ...(msg.client_tag !== undefined ? { client_tag: msg.client_tag } : {}),
      });
      return;
    }
    case 'session:rename': {
      sessions.renameSession(msg.session_id, msg.name);
      return;
    }
    case 'session:archive': {
      sessions.archiveSession(msg.session_id, msg.archived);
      return;
    }
    case 'session:pin': {
      sessions.setPinned(msg.session_id, msg.pinned);
      return;
    }
    case 'session:delete': {
      await sessions.deleteSession(msg.session_id);
      return;
    }
    case 'session:set_unread': {
      sessions.setUnread(msg.session_id, msg.unread);
      return;
    }
    case 'task:create': {
      if (!tasks) return;
      const task = tasks.createTask({
        name: msg.name,
        ...(msg.description !== undefined ? { description: msg.description } : {}),
        ...(msg.executor !== undefined ? { manager_executor: msg.executor } : {}),
      });
      broadcaster.broadcast({ type: 'task:created', task });
      return;
    }
    case 'task:update': {
      if (!tasks) return;
      const patch: import('../task/manager.js').UpdateTaskInput = {};
      if (msg.name !== undefined) patch.name = msg.name;
      if (msg.description !== undefined) patch.description = msg.description;
      if (msg.status !== undefined) patch.status = msg.status;
      // Pin is a separate, updated_at-neutral path (setTaskPinned); a content
      // patch (if any) runs first, then the pin, and the final row is broadcast.
      let task = Object.keys(patch).length > 0 ? tasks.updateTask(msg.task_id, patch) : undefined;
      if (msg.pinned !== undefined) task = tasks.setTaskPinned(msg.task_id, msg.pinned);
      if (task) broadcaster.broadcast({ type: 'task:updated', task });
      return;
    }
    case 'task:delete': {
      if (!tasks) return;
      await deleteTaskCascade(tasks, sessions, msg.task_id);
      broadcaster.broadcast({ type: 'task:deleted', task_id: msg.task_id });
      return;
    }
    case 'message:send': {
      await sessions.sendMessage(msg.session_id, msg.text, msg.items, msg.oneShotBypass);
      return;
    }
    case 'message:steer': {
      await sessions.steerMessage(msg.session_id, msg.text, msg.items);
      return;
    }
    case 'approval:resolve': {
      await sessions.respondApproval(
        msg.session_id,
        msg.approval_id,
        msg.decision,
        msg.answers,
        msg.native_option_id,
      );
      return;
    }
    case 'session:stop': {
      await sessions.stopTurn(msg.session_id);
      return;
    }
    case 'session:recover': {
      await sessions.forceRecover(msg.session_id);
      return;
    }
    case 'session:set_mode': {
      sessions.setApprovalMode(msg.session_id, msg.approval_mode);
      return;
    }
    case 'session:set_effort': {
      sessions.setEffort(msg.session_id, msg.effort);
      return;
    }
    case 'session:set_service_tier': {
      sessions.setServiceTier(msg.session_id, msg.service_tier);
      return;
    }
    case 'session:set_model': {
      sessions.setModel(msg.session_id, msg.model);
      return;
    }
    case 'session:set_native_config': {
      await sessions.setNativeConfig(msg.session_id, msg.config_id, msg.value);
      return;
    }
    case 'queue:add': {
      sessions.enqueueMessage(msg.session_id, msg.text, msg.items);
      return;
    }
    case 'queue:remove': {
      sessions.removeFromQueue(msg.session_id, msg.queue_id);
      return;
    }
    case 'queue:reorder': {
      sessions.reorderQueue(msg.session_id, msg.order);
      return;
    }
    case 'queue:clear': {
      sessions.clearQueue(msg.session_id);
      return;
    }
    case 'queue:send_now': {
      await sessions.sendQueuedNow(msg.session_id);
      return;
    }
    case 'term:spawn': {
      if (!term) return;
      const spawnOpts: import('../term/manager.js').SpawnOptions = {
        termId: msg.term_id,
        cols: msg.cols,
        rows: msg.rows,
      };
      if (msg.cwd !== undefined) spawnOpts.cwd = msg.cwd;
      if (msg.shell !== undefined) spawnOpts.shell = msg.shell;
      const result = await term.spawn(spawnOpts);
      broadcaster.send(ws, {
        type: 'term:replay',
        term_id: msg.term_id,
        chunks: result.replay,
        alive: result.alive,
      });
      return;
    }
    case 'term:input': {
      if (!term) return;
      term.input(msg.term_id, msg.data);
      return;
    }
    case 'term:resize': {
      if (!term) return;
      term.resize(msg.term_id, msg.cols, msg.rows);
      return;
    }
    case 'term:replay-request': {
      if (!term) return;
      const result = term.replay(msg.term_id);
      broadcaster.send(ws, {
        type: 'term:replay',
        term_id: msg.term_id,
        chunks: result.chunks,
        alive: result.alive,
      });
      return;
    }
    case 'term:close': {
      if (!term) return;
      await term.kill(msg.term_id);
      return;
    }
    case 'auth':
      // already handled
      return;
    default:
      console.log('[ws] ignoring message type', (msg as { type: string }).type);
  }
}
// Note: session:reset/takeover, slash:execute, transcript:load_more are
// intentionally not yet handled — added by M2 (slash + load_more).
//
// `_broadcaster` parameter and `_ws` retained on dispatch for future use by
// per-client responses; treat as the WS sender for ack/error replies.
