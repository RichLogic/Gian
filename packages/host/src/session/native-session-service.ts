import { randomUUID } from 'node:crypto';
import type { ApprovalMode, Executor, NativeSession, Session } from '@gian/shared';
import type { ProxyManager } from '../proxy/manager.js';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { ProxySessionCoordinator } from './proxy-session-coordinator.js';
import { executorConfigFromOptions, type SessionRepository } from './repository.js';

function capabilityAdvertised(
  capabilities: Record<string, unknown> | undefined,
  name: string,
): boolean {
  if (capabilities == null || Object.keys(capabilities).length === 0) return true;
  return capabilities[name] !== undefined;
}

interface NativeSessionCallbacks {
  persistKimiReplay: (
    sessionId: string,
    updates: unknown[],
    timestamp: string,
    replayStreamId?: string,
  ) => { turns: number; events: number };
}

export class NativeSessionService {
  constructor(
    private db: Db,
    private proxy: ProxyManager,
    private proxySessions: ProxySessionCoordinator,
    private sessions: SessionRepository,
    private broadcaster: WsBroadcaster,
    private callbacks: NativeSessionCallbacks,
  ) {}

  async listKimi(cwd: string): Promise<NativeSession[]> {
    return (await this.listFromProxy('kimi', cwd, false)) ?? [];
  }

  async listPlugin(executor: Executor, cwd: string): Promise<NativeSession[] | null> {
    return this.listFromProxy(executor, cwd, true);
  }

  private async listFromProxy(
    executor: Executor,
    cwd: string,
    requireNativeList: boolean,
  ): Promise<NativeSession[] | null> {
    const cacheKey = `__native_sessions_${executor}__`;
    let client;
    try {
      client = await this.proxy.getOrCreate(cacheKey, executor);
      const initialized = await client.initialize();
      if (!client.listNativeSessions || !capabilityAdvertised(initialized.capabilities, 'session.native.list')) {
        return requireNativeList ? null : [];
      }
    } catch {
      await this.proxy.dispose(cacheKey).catch(() => undefined);
      return null;
    }
    try {
      const rows: unknown[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const result = await client.listNativeSessions({
          cwd,
          ...(cursor ? { cursor } : {}),
        });
        if (!result || typeof result !== 'object') break;
        const page = result as { sessions?: unknown; nextCursor?: unknown };
        if (Array.isArray(page.sessions)) rows.push(...page.sessions);
        const nextCursor = typeof page.nextCursor === 'string' && page.nextCursor
          ? page.nextCursor
          : undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return rows.flatMap(row => {
        if (!row || typeof row !== 'object') return [];
        const item = row as Record<string, unknown>;
        const nativeId = typeof item.id === 'string' && item.id
          ? item.id
          : typeof item.sessionId === 'string' ? item.sessionId : '';
        if (!nativeId) return [];
        const title = typeof item.displayName === 'string'
          ? item.displayName
          : typeof item.title === 'string' ? item.title : '';
        return [{
          id: nativeId,
          executor,
          filePath: '',
          cwd: typeof item.cwd === 'string' ? item.cwd : cwd,
          updatedAt: typeof item.updatedAt === 'string'
            ? item.updatedAt
            : new Date(0).toISOString(),
          fileSize: 0,
          turnCount: 0,
          firstUserMessage: title,
        }];
      });
    } catch (error) {
      await this.proxy.dispose(cacheKey).catch(() => undefined);
      throw error;
    }
  }

  async deletePluginNativeSession(
    executor: Executor,
    nativeSessionId: string,
    _cwd: string,
  ): Promise<void> {
    const cacheKey = `__native_sessions_${executor}__`;
    try {
      const client = await this.proxy.getOrCreate(cacheKey, executor);
      const initialized = await client.initialize();
      if (!client.deleteNativeSession || !capabilityAdvertised(initialized.capabilities, 'session.native.delete')) {
        throw new Error(`${executor} does not expose native-session deletion.`);
      }
      await client.deleteNativeSession(nativeSessionId);
    } finally {
      await this.proxy.dispose(cacheKey).catch(() => undefined);
    }
  }

  async adoptKimi(input: {
    workspaceId: string;
    cwd: string;
    nativeSessionId: string;
    name?: string;
  }): Promise<{ session: Session; replay: { turns: number; events: number } }> {
    return this.adopt({ ...input, executor: 'kimi' });
  }

  async adopt(input: {
    workspaceId: string;
    cwd: string;
    executor: Executor;
    nativeSessionId: string;
    name?: string;
    approvalMode?: ApprovalMode;
  }): Promise<{ session: Session; replay: { turns: number; events: number } }> {
    const duplicate = this.db
      .prepare('SELECT id FROM sessions WHERE executor = ? AND native_session_id = ?')
      .get(input.executor, input.nativeSessionId) as { id: string } | undefined;
    if (duplicate) {
      throw Object.assign(
        new Error(`${input.executor} session is already adopted as ${duplicate.id}`),
        { code: 'SESSION_ALREADY_EXISTS', sessionId: duplicate.id },
      );
    }

    const sessionId = randomUUID();
    let broughtUp: Awaited<ReturnType<ProxySessionCoordinator['bringUp']>>;
    try {
      broughtUp = await this.proxySessions.bringUp({
        sessionId,
        executor: input.executor,
        cwd: input.cwd,
        model: null,
        nativeSessionId: input.nativeSessionId,
        resumeMode: 'load',
      });
    } catch (error) {
      await this.proxy.dispose(sessionId).catch(() => undefined);
      this.proxySessions.forget(sessionId);
      throw error;
    }

    const now = new Date().toISOString();
    const name = input.name?.trim() || `adopted ${input.nativeSessionId.slice(0, 8)}`;
    let replay = { turns: 0, events: 0 };
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO sessions
              (id, name, type, workspace_id, executor, model, approval_mode,
               executor_config_json, active_channel, status, archived,
               worktree_path, branch, base_branch, worktree_outcome,
               native_session_id, created_at, updated_at)
             VALUES
              (?, ?, 'coding', ?, ?, NULL, ?, ?, 'web', 'new', 0,
               NULL, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(
            sessionId,
            name,
            input.workspaceId,
            input.executor,
            input.executor === 'kimi' || input.executor === 'grok' ? null : input.approvalMode ?? 'ask',
            JSON.stringify(executorConfigFromOptions(broughtUp.configOptions)),
            input.nativeSessionId,
            now,
            now,
          );
        replay = this.callbacks.persistKimiReplay(
          sessionId,
          broughtUp.replayUpdates,
          now,
          broughtUp.replayStreamId,
        );
      })();
    } catch (error) {
      await this.proxy.dispose(sessionId).catch(() => undefined);
      this.proxySessions.forget(sessionId);
      this.sessions.forget(sessionId);
      throw error;
    }

    const session = this.sessions.get(sessionId);
    this.broadcaster.broadcast({ type: 'session:created', session, origin: 'native-adopt' });
    return { session, replay };
  }
}
