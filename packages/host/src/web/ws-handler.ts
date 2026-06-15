import { randomUUID } from 'node:crypto';
import type { ClientToServerMessage, StateSyncMessage, TtySurface } from '@gian/shared';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type { SessionManager } from '../session/manager.js';
import type { WsBroadcaster } from './ws-broadcast.js';
// IMRouter is removed during the IM transplant — ws-handler no longer
// notifies it on web message:send. Takeover state will be revisited when
// the rvc-shaped managers land.
import type { ApprovalManager } from '../approval/index.js';
import type { TtyManager } from '../tty/manager.js';
import type { CodexTtyManager } from '../tty/codex-manager.js';
import type { WorkbenchTerminalManager } from '../term/manager.js';
import type { Db } from '../storage/db.js';
import { getUsernameForToken } from '../auth/tokens.js';
import { AUTH_REQUIRED } from '../auth/middleware.js';
import { loadConfig } from '../storage/config.js';
import { listBots } from '../storage/bots.js';

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
  broadcaster: WsBroadcaster;
  approvals?: ApprovalManager;
  tty?: TtyManager;
  codexTty?: CodexTtyManager;
  term?: WorkbenchTerminalManager;
  db?: Db;
}

interface ClientState {
  authed: boolean;
  clientId: string;
}

export function makeWsHandlers({ sessions, broadcaster, approvals, tty, codexTty, term, db }: WsHandlerDeps) {
  const states = new WeakMap<WSContext, ClientState>();

  function sendStateSync(ws: WSContext): void {
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
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY sort_order, name').all() as StateSyncMessage['workspaces'],
      bots: listBots(db),
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
      const state = states.get(ws);
      if (state) tty?.releaseClient(state.clientId);
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
        sendStateSync(ws);
        return;
      }

      try {
        await dispatch(parsed, sessions, broadcaster, ws, state, tty, codexTty, term);
      } catch (err) {
        console.error('[ws] dispatch error', err);
        // Surface the failure to the client. Without this, errors inside
        // sendMessage / respondApproval / etc. are invisible — the user sees
        // "no reply" with no clue why.
        const sessionIdField = (parsed as { session_id?: unknown }).session_id;
        // Prefer an explicit `code` on the thrown error (e.g.
        // SessionManager.switchRuntime throws { code: 'SWITCH_BLOCKED' }
        // for idle / approval / finalized-worktree refusals). The
        // per-message-type fallback below is only for legacy throws
        // that don't tag a code.
        const explicitCode = (err && typeof err === 'object'
          && typeof (err as { code?: unknown }).code === 'string')
          ? (err as { code: string }).code
          : null;
        broadcaster.send(ws, {
          type: 'error',
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
    case 'approval:resolve':
      return 'APPROVAL_RESOLVE_FAILED';
    case 'session:create':
      return 'SESSION_CREATE_FAILED';
    case 'session:stop':
      return 'SESSION_STOP_FAILED';
    case 'queue:send_now':
      return 'QUEUE_SEND_NOW_FAILED';
    default:
      return 'DISPATCH_FAILED';
  }
}

async function dispatch(
  msg: ClientToServerMessage,
  sessions: SessionManager,
  broadcaster: WsBroadcaster,
  ws: WSContext,
  state: ClientState,
  tty?: TtyManager,
  codexTty?: CodexTtyManager,
  term?: WorkbenchTerminalManager,
): Promise<void> {
  // Resolve TTY routing target for `pty:*` messages by session executor.
  // Centralized so each pty:* case stays terse.
  const ttyManagerFor = (sessionId: string): TtyManager | CodexTtyManager | undefined => {
    let session;
    try { session = sessions.getSession(sessionId); } catch { return undefined; }
    return session.executor === 'codex' ? codexTty : tty;
  };
  const requireClaudeTtyOwner = (sessionId: string): void => {
    const session = sessions.getSession(sessionId);
    if (session.executor !== 'claude') return;
    if (session.runtime_mode !== 'tty') {
      throw Object.assign(new Error('session is not in Claude CLI mode'), { code: 'SWITCH_BLOCKED' });
    }
    if (!tty?.owns(sessionId, state.clientId)) {
      throw Object.assign(new Error('Claude CLI is open in another window'), { code: 'TTY_LOCKED' });
    }
  };
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
      });
      broadcaster.send(ws, { type: 'session:created', session });
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
    case 'session:delete': {
      await sessions.deleteSession(msg.session_id);
      return;
    }
    case 'session:set_unread': {
      sessions.setUnread(msg.session_id, msg.unread);
      return;
    }
    case 'message:send': {
      await sessions.sendMessage(msg.session_id, msg.text, msg.items, msg.oneShotBypass);
      return;
    }
    case 'approval:resolve': {
      await sessions.respondApproval(msg.session_id, msg.approval_id, msg.decision, msg.answers);
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
      sessions.setApprovalMode(msg.session_id, msg.approval_mode, msg.turns);
      return;
    }
    case 'session:set_effort': {
      sessions.setEffort(msg.session_id, msg.effort);
      return;
    }
    case 'session:set_model': {
      sessions.setModel(msg.session_id, msg.model);
      return;
    }
    case 'queue:add': {
      sessions.enqueueMessage(msg.session_id, msg.text);
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
    case 'session:switch-runtime': {
      const session = sessions.getSession(msg.session_id);
      if (session.executor === 'claude' && tty) {
        if (msg.target === 'tty') {
          const claimed = tty.claim(
            msg.session_id,
            state.clientId,
            ws,
            msg.surface === 'beta' ? 'beta' : 'cli',
          );
          if (!claimed) {
            throw Object.assign(new Error('Claude CLI is open in another window'), { code: 'TTY_LOCKED' });
          }
          try {
            await sessions.switchRuntime(msg.session_id, msg.target, {
              remoteControl: msg.remote_control === true,
            });
          } catch (err) {
            tty.release(msg.session_id, state.clientId);
            throw err;
          }
          return;
        }
        if (tty.isLockedByOther(msg.session_id, state.clientId)) {
          throw Object.assign(new Error('Claude CLI is open in another window'), { code: 'TTY_LOCKED' });
        }
        await sessions.switchRuntime(msg.session_id, msg.target, {
          remoteControl: msg.remote_control === true,
        });
        tty.release(msg.session_id, state.clientId);
        return;
      }
      await sessions.switchRuntime(msg.session_id, msg.target, {
        remoteControl: msg.remote_control === true,
      });
      return;
    }
    case 'session:remote-control': {
      // Toggle Claude Remote Control by injecting `/remote-control` into the
      // live PTY. Host-trusted: no TTY-owner check, since the button can be
      // clicked from the composer on any surface. No-op unless the session is
      // a claude session currently in TTY mode.
      const session = sessions.getSession(msg.session_id);
      if (session.executor !== 'claude' || session.runtime_mode !== 'tty' || !tty) return;
      await tty.toggleRemoteControl(msg.session_id);
      return;
    }
    case 'tty:claim': {
      const session = sessions.getSession(msg.session_id);
      if (session.executor !== 'claude') return;
      if (!tty) {
        throw Object.assign(new Error('claude TTY runtime not configured'), { code: 'SWITCH_BLOCKED' });
      }
      if (session.runtime_mode !== 'tty') {
        throw Object.assign(new Error('session is not in Claude CLI mode'), { code: 'SWITCH_BLOCKED' });
      }
      const surface: TtySurface = msg.surface === 'beta' ? 'beta' : 'cli';
      const claimed = tty.claim(msg.session_id, state.clientId, ws, surface, {
        takeover: msg.takeover === true,
      });
      if (!claimed) {
        throw Object.assign(new Error('Claude CLI is open in another window'), { code: 'TTY_LOCKED' });
      }
      return;
    }
    case 'pty:input': {
      const mgr = ttyManagerFor(msg.session_id);
      if (!mgr) return;
      requireClaudeTtyOwner(msg.session_id);
      const payload: { data?: string; text?: string } = {};
      if (typeof msg.data === 'string') payload.data = msg.data;
      if (typeof msg.text === 'string') payload.text = msg.text;
      await mgr.input(msg.session_id, payload);
      return;
    }
    case 'pty:resize': {
      const mgr = ttyManagerFor(msg.session_id);
      if (!mgr) return;
      requireClaudeTtyOwner(msg.session_id);
      await mgr.resize(msg.session_id, msg.cols, msg.rows);
      return;
    }
    case 'pty:replay-request': {
      const mgr = ttyManagerFor(msg.session_id);
      if (!mgr) return;
      requireClaudeTtyOwner(msg.session_id);
      const result = await mgr.replay(msg.session_id);
      broadcaster.send(ws, {
        type: 'pty:replay',
        session_id: msg.session_id,
        chunks: result.chunks,
        alive: result.alive,
      });
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
