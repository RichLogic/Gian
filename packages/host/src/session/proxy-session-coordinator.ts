import type {
  Executor,
  ExecutorConfigState,
  NativeConfigOption,
  ProxyCapabilities,
  ProxyNotification,
  Session,
  SlashListResult,
} from '@gian/shared';
import { locateNativeJsonl } from '../native/locate-jsonl.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';
import { executorConfigFromOptions, type SessionRepository } from './repository.js';

export interface BringUpProxySessionInput {
  sessionId: string;
  executor: Executor;
  cwd: string;
  model: string | null;
  nativeSessionId?: string | null;
  forkFromClaudeSessionId?: string | null;
  executorConfig?: ExecutorConfigState;
  resumeMode?: 'load' | 'resume';
  displayName?: string | null;
}

export interface BringUpProxySessionResult {
  proxySessionId: string;
  nativeSessionId: string;
  configOptions: NativeConfigOption[];
  replayUpdates: unknown[];
}

interface ProxySessionCallbacks {
  onNotification(sessionId: string, notification: ProxyNotification): void;
  onExit(sessionId: string, code: number | null): void;
  onSessionUpdated(sessionId: string, partial: Partial<Session>): void;
}

export class ProxySessionCoordinator {
  private sessionIds = new Map<string, string>();
  private bringUps = new Map<string, Promise<string>>();
  private capabilitiesByExecutor = new Map<string, ProxyCapabilities>();

  constructor(
    private db: Db,
    private proxy: ProxyManager,
    private sessions: SessionRepository,
    private history: SessionHistoryStore,
    private watcher: NativeJsonlWatcher | null,
    private callbacks: ProxySessionCallbacks,
  ) {}

  get(sessionId: string): string | undefined {
    return this.sessionIds.get(sessionId);
  }

  forget(sessionId: string): void {
    this.sessionIds.delete(sessionId);
    this.bringUps.delete(sessionId);
  }

  async dispose(sessionId: string): Promise<void> {
    await this.proxy.dispose(sessionId).catch(() => undefined);
    this.forget(sessionId);
  }

  async ensure(session: Session): Promise<string> {
    const cached = this.sessionIds.get(session.id);
    if (cached) return cached;
    const existing = this.bringUps.get(session.id);
    if (existing) return existing;

    const pending = this.rehydrate(session);
    this.bringUps.set(session.id, pending);
    try {
      return await pending;
    } catch (error) {
      if (session.executor === 'kimi') await this.dispose(session.id);
      throw error;
    } finally {
      if (this.bringUps.get(session.id) === pending) this.bringUps.delete(session.id);
    }
  }

  private async rehydrate(session: Session): Promise<string> {
    const workspace = this.db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) throw new Error(`workspace missing for session ${session.id}`);

    const pendingFork = this.db.prepare(
      `SELECT parent.native_session_id, parent.worktree_path
       FROM sessions AS child
       JOIN sessions AS parent ON parent.id = child.fork_from_session_id
       WHERE child.id = ?`,
    ).get(session.id) as {
      native_session_id: string | null;
      worktree_path: string | null;
    } | undefined;
    const forkFromClaudeSessionId = pendingFork?.native_session_id ?? null;
    const result = await this.bringUp({
      sessionId: session.id,
      executor: session.executor,
      cwd: pendingFork?.worktree_path ?? session.worktree_path ?? workspace.path,
      model: session.model,
      nativeSessionId: forkFromClaudeSessionId ? null : session.native_session_id,
      forkFromClaudeSessionId,
      executorConfig: session.executor_config,
      displayName: session.name,
    });
    return result.proxySessionId;
  }

  async bringUp(args: BringUpProxySessionInput): Promise<BringUpProxySessionResult> {
    const client = await this.proxy.getOrCreate(args.sessionId, args.executor);
    client.onNotification(notification => this.callbacks.onNotification(args.sessionId, notification));
    client.onExit(code => this.callbacks.onExit(args.sessionId, code));
    await client.initialize();
    const capabilities = await client.capabilities();
    this.capabilitiesByExecutor.set(args.executor, capabilities);

    const adoptParams: {
      claudeSessionId?: string;
      forkFromClaudeSessionId?: string;
      threadId?: string;
      nativeSessionId?: string;
      resumeMode?: 'load' | 'resume';
    } = {};
    if (args.nativeSessionId) {
      if (args.executor === 'claude') adoptParams.claudeSessionId = args.nativeSessionId;
      else if (args.executor === 'codex') adoptParams.threadId = args.nativeSessionId;
      else {
        adoptParams.nativeSessionId = args.nativeSessionId;
        adoptParams.resumeMode = args.resumeMode ?? 'resume';
      }
    }
    if (args.executor === 'claude' && args.forkFromClaudeSessionId) {
      adoptParams.forkFromClaudeSessionId = args.forkFromClaudeSessionId;
    }

    let created: {
      session: import('@gian/shared').ProxySession;
      nativeSessionId: string;
      configOptions?: NativeConfigOption[];
      replayUpdates?: unknown[];
    };
    try {
      created = await client.createSession({
        cwd: args.cwd,
        model: args.model ?? undefined,
        ...adoptParams,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isMissing = args.nativeSessionId && (
        message.includes('THREAD_NOT_FOUND')
        || message.includes('SESSION_NOT_FOUND')
        || message.includes('Could not resume')
      );
      const turnCount = isMissing ? this.history.countTurns(args.sessionId) : -1;
      if (!isMissing || turnCount > 0 || args.executor === 'kimi') throw error;

      created = await client.createSession({ cwd: args.cwd, model: args.model ?? undefined });
      const now = new Date().toISOString();
      this.db.prepare('UPDATE sessions SET native_session_id = ?, updated_at = ? WHERE id = ?')
        .run(created.nativeSessionId, now, args.sessionId);
      this.callbacks.onSessionUpdated(args.sessionId, {
        native_session_id: created.nativeSessionId,
        updated_at: now,
      });
    }

    this.sessionIds.set(args.sessionId, created.session.id);
    let configOptions = created.configOptions ?? created.session.configOptions ?? [];
    if (args.executor === 'kimi' && args.executorConfig && client.setNativeConfig) {
      const current = new Map(configOptions.map(option => [option.id, option.currentValue]));
      const ids = Object.keys(args.executorConfig.values).sort((left, right) => {
        const order = ['model', 'thinking', 'thought_level', 'mode'];
        const leftIndex = order.indexOf(left);
        const rightIndex = order.indexOf(right);
        if (leftIndex !== -1 || rightIndex !== -1) {
          return (leftIndex === -1 ? order.length : leftIndex)
            - (rightIndex === -1 ? order.length : rightIndex);
        }
        return left.localeCompare(right);
      });
      for (const id of ids) {
        const value = args.executorConfig.values[id];
        if (value === undefined || Object.is(current.get(id), value)) continue;
        const updated = await client.setNativeConfig(id, value);
        configOptions = updated.options;
        current.clear();
        for (const option of configOptions) current.set(option.id, option.currentValue);
      }
    }
    this.sessions.setNativeOptions(args.sessionId, configOptions);

    const persisted = this.db.prepare('SELECT id FROM sessions WHERE id = ?')
      .get(args.sessionId) as { id: string } | undefined;
    if (persisted) {
      const state = executorConfigFromOptions(configOptions);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE sessions SET executor_config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(state), now, args.sessionId);
      this.callbacks.onSessionUpdated(args.sessionId, {
        executor_config: state,
        native_config_options: configOptions,
        updated_at: now,
      });
    }

    if (this.watcher && args.executor !== 'kimi') {
      const filePath = locateNativeJsonl(args.executor, created.nativeSessionId, args.cwd);
      if (filePath) this.watcher.start(args.sessionId, filePath, args.executor);
    }
    const displayName = args.displayName?.trim();
    if (args.executor === 'codex' && displayName && client.setName) {
      try {
        await client.setName(displayName);
      } catch (error) {
        console.warn(`[session] codex setName on bring-up failed for ${args.sessionId}: ${String(error)}`);
      }
    }
    return {
      proxySessionId: created.session.id,
      nativeSessionId: created.nativeSessionId,
      configOptions,
      replayUpdates: created.replayUpdates ?? [],
    };
  }

  getCapabilities(executor: string): ProxyCapabilities | null {
    return this.capabilitiesByExecutor.get(executor) ?? null;
  }

  async warmCapabilities(executor: Executor): Promise<ProxyCapabilities> {
    const cached = this.capabilitiesByExecutor.get(executor);
    if (cached && (executor === 'kimi' || cached.models.length > 0)) return cached;
    const tempKey = `__caps__${executor}`;
    if (cached) {
      this.capabilitiesByExecutor.delete(executor);
      await this.proxy.dispose(tempKey).catch(() => undefined);
    }
    const client = await this.proxy.getOrCreate(tempKey, executor);
    await client.initialize();
    const capabilities = await client.capabilities();
    this.capabilitiesByExecutor.set(executor, capabilities);
    return capabilities;
  }

  async listSlashCommands(
    executor: 'codex' | 'claude',
    cwd?: string,
  ): Promise<SlashListResult> {
    const tempKey = `__caps__${executor}`;
    const client = this.proxy.get(tempKey) ?? await this.proxy.getOrCreate(tempKey, executor);
    await client.initialize();
    return client.listSlashCommands(cwd);
  }
}
