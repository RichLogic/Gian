import type {
  AgentProxyDefaults,
  Executor,
  ExecutorConfigState,
  NativeConfigOption,
  NativeConfigValue,
  ProxyCapabilities,
  ProxyNotification,
  Session,
  SlashListResult,
} from '@gian/shared';
import { usesNativeExecutorConfig } from '@gian/shared';
import { locateNativeJsonl } from '../native/locate-jsonl.js';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { ProxyClient, ProxyReplayResult } from '../proxy/types.js';
import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';
import { executorConfigFromOptions, type SessionRepository } from './repository.js';

export interface BringUpProxySessionInput {
  sessionId: string;
  executor: Executor;
  cwd: string;
  model: string | null;
  nativeSessionId?: string | null;
  executorConfig?: ExecutorConfigState;
  executorDefaults?: AgentProxyDefaults;
  resumeMode?: 'load' | 'resume';
  displayName?: string | null;
}

export interface BringUpProxySessionResult {
  proxySessionId: string;
  nativeSessionId: string;
  configOptions: NativeConfigOption[];
  replayUpdates: unknown[];
  replayStreamId?: string;
}

interface ProxySessionCallbacks {
  onNotification(sessionId: string, notification: ProxyNotification): void;
  onExit(sessionId: string, code: number | null): void;
  onSessionUpdated(sessionId: string, partial: Partial<Session>): void;
}

interface ProxySessionBindings {
  offNotification: () => void;
  offExit: () => void;
}

type NativeConfigRole = keyof AgentProxyDefaults;

const NATIVE_CONFIG_ROLE_ORDER: readonly NativeConfigRole[] = [
  'model',
  'thinking',
  'mode',
];

function nativeConfigRole(
  option: Pick<NativeConfigOption, 'id' | 'category'>,
): NativeConfigRole | null {
  const category = option.category?.trim().toLowerCase() ?? '';
  const id = option.id.trim().toLowerCase();
  if (category === 'model' || id === 'model') return 'model';
  if (
    category === 'thought_level'
    || category === 'thought'
    || category === 'thinking'
    || category === 'effort'
    || category === 'reasoning_effort'
    || id === 'thought_level'
    || id === 'thought'
    || id === 'thinking'
    || id === 'effort'
    || id === 'reasoning_effort'
  ) return 'thinking';
  if (category === 'mode' || id === 'mode' || id === 'permission_mode') return 'mode';
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProxySessionCoordinator {
  private sessionIds = new Map<string, string>();
  private bringUps = new Map<string, Promise<string>>();
  private bindings = new Map<string, ProxySessionBindings>();
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

  usesProtocolV1(sessionId: string): boolean {
    return this.proxy.get(sessionId)?.protocolV1 === true;
  }

  async replay(sessionId: string): Promise<ProxyReplayResult> {
    const client = this.proxy.get(sessionId);
    if (!client?.replaySession) return { events: [] };
    const result = await client.replaySession();
    return Array.isArray(result) ? { events: result } : result;
  }

  abort(sessionId: string): void {
    this.proxy.get(sessionId)?.forceKill();
  }

  forget(sessionId: string): void {
    this.sessionIds.delete(sessionId);
    this.bringUps.delete(sessionId);
    this.unbind(sessionId);
  }

  async dispose(sessionId: string): Promise<void> {
    this.forget(sessionId);
    await this.proxy.dispose(sessionId).catch(() => undefined);
  }

  async ensure(session: Session): Promise<string> {
    const cached = this.sessionIds.get(session.id);
    if (cached && this.proxy.get(session.id)) return cached;
    if (cached) this.forget(session.id);
    const existing = this.bringUps.get(session.id);
    if (existing) return existing;

    const pending = this.rehydrate(session);
    this.bringUps.set(session.id, pending);
    try {
      return await pending;
    } catch (error) {
      if (usesNativeExecutorConfig(session.executor)) await this.dispose(session.id);
      throw error;
    } finally {
      if (this.bringUps.get(session.id) === pending) this.bringUps.delete(session.id);
    }
  }

  private async rehydrate(session: Session): Promise<string> {
    const workspace = this.db.prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { path: string } | undefined;
    if (!workspace) throw new Error(`workspace missing for session ${session.id}`);

    const result = await this.bringUp({
      sessionId: session.id,
      executor: session.executor,
      cwd: session.worktree_path ?? workspace.path,
      model: session.model,
      nativeSessionId: session.native_session_id,
      executorConfig: session.executor_config,
      displayName: session.name,
    });
    return result.proxySessionId;
  }

  async bringUp(args: BringUpProxySessionInput): Promise<BringUpProxySessionResult> {
    const client = await this.proxy.getOrCreate(args.sessionId, args.executor);
    // Replace any stale callbacks before the new facade starts initialization.
    // Native create/adopt may emit notifications or exit before createSession
    // resolves, so binding only at the end of bring-up would lose that state.
    this.bind(args.sessionId, client);
    await client.initialize();
    const capabilities = await client.capabilities();
    this.capabilitiesByExecutor.set(args.executor, capabilities);

    const adoptParams: {
      claudeSessionId?: string;
      threadId?: string;
      nativeSessionId?: string;
      resumeMode?: 'load' | 'resume';
    } = {};
    if (args.nativeSessionId) {
      adoptParams.resumeMode = args.resumeMode ?? 'resume';
      if (args.executor === 'claude') adoptParams.claudeSessionId = args.nativeSessionId;
      else if (args.executor === 'codex') adoptParams.threadId = args.nativeSessionId;
      else {
        adoptParams.nativeSessionId = args.nativeSessionId;
      }
    }
    let created: {
      session: import('@gian/shared').ProxySession;
      nativeSessionId: string;
      configOptions?: NativeConfigOption[];
      replayUpdates?: unknown[];
      replayStreamId?: string;
    };
    try {
      const persistedMode = args.executorConfig?.values.permission_mode
        ?? args.executorConfig?.values.mode;
      const createMode = typeof persistedMode === 'string' && persistedMode
        ? persistedMode
        : args.executorDefaults?.mode;
      created = await client.createSession({
        cwd: args.cwd,
        model: args.model ?? undefined,
        ...(args.executor === 'grok' && createMode ? { mode: createMode } : {}),
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
      if (!isMissing || turnCount > 0 || usesNativeExecutorConfig(args.executor)) throw error;

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
    if (
      usesNativeExecutorConfig(args.executor)
      && client.setNativeConfig
      && (args.executorConfig || args.executorDefaults)
    ) {
      const setNativeConfig = client.setNativeConfig.bind(client);
      const optionForRole = (role: NativeConfigRole) =>
        configOptions.find(option => nativeConfigRole(option) === role);
      const applyValue = async (
        option: NativeConfigOption,
        value: NativeConfigValue,
        label: string,
      ) => {
        if (Object.is(option.currentValue, value)) return;
        try {
          const updated = await setNativeConfig(option.id, value);
          configOptions = updated.options;
        } catch (error) {
          const executorName = `${args.executor[0]!.toUpperCase()}${args.executor.slice(1)}`;
          throw new Error(
            `Failed to apply ${executorName} ${label} using config id "${option.id}": ${errorMessage(error)}`,
          );
        }
      };

      // Settings defaults name semantic roles. Resolve them only after
      // session/new or session/load returns the authoritative ACP options;
      // option.category may stay stable while option.id changes between Kimi
      // versions (for example thought_level -> thinking).
      for (const role of NATIVE_CONFIG_ROLE_ORDER) {
        const value = args.executorDefaults?.[role];
        if (!value) continue;
        const option = optionForRole(role);
        if (option) await applyValue(option, value, `${role} default`);
      }

      // Persisted state normally contains exact native ids. If an upgrade
      // renames one, remap known semantic aliases to the id advertised by the
      // current session. Unknown, no-longer-advertised ids are never sent.
      const persistedEntries = Object.entries(args.executorConfig?.values ?? {})
        .sort(([left], [right]) => {
          const leftRole = nativeConfigRole({ id: left });
          const rightRole = nativeConfigRole({ id: right });
          const leftIndex = leftRole ? NATIVE_CONFIG_ROLE_ORDER.indexOf(leftRole) : -1;
          const rightIndex = rightRole ? NATIVE_CONFIG_ROLE_ORDER.indexOf(rightRole) : -1;
          if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? NATIVE_CONFIG_ROLE_ORDER.length : leftIndex)
              - (rightIndex === -1 ? NATIVE_CONFIG_ROLE_ORDER.length : rightIndex);
          }
          return left.localeCompare(right);
        });
      for (const [storedId, value] of persistedEntries) {
        const exact = configOptions.find(option => option.id === storedId);
        const role = nativeConfigRole({ id: storedId });
        const option = exact ?? (role ? optionForRole(role) : undefined);
        if (option) await applyValue(option, value, `session setting "${option.name}"`);
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

    if (
      this.watcher
      && !usesNativeExecutorConfig(args.executor)
      && !client.protocolV1
    ) {
      const filePath = locateNativeJsonl(args.executor, created.nativeSessionId, args.cwd);
      if (filePath) this.watcher.start(args.sessionId, filePath, args.executor);
    }
    // Re-read the authoritative name after the potentially slow native
    // create/adopt. A rename can land while createSession is in flight, when
    // the facade exists but has not bound a native thread yet. Row absence is
    // intentional during first creation, so only then fall back to args.
    const persistedName = this.db.prepare('SELECT name FROM sessions WHERE id = ?')
      .get(args.sessionId) as { name: string | null } | undefined;
    const displayName = (persistedName ? persistedName.name : args.displayName)?.trim();
    const shouldSyncName = args.executor === 'codex'
      || args.executor === 'grok'
      || (args.executor === 'claude' && client.protocolV1);
    if (shouldSyncName && displayName && client.setName) {
      try {
        await client.setName(displayName);
      } catch (error) {
        console.warn(`[session] ${args.executor} setName on bring-up failed for ${args.sessionId}: ${String(error)}`);
      }
    }
    return {
      proxySessionId: created.session.id,
      nativeSessionId: created.nativeSessionId,
      configOptions,
      replayUpdates: created.replayUpdates ?? [],
      ...(created.replayStreamId ? { replayStreamId: created.replayStreamId } : {}),
    };
  }

  private bind(sessionId: string, client: ProxyClient): void {
    this.unbind(sessionId);
    this.bindings.set(sessionId, {
      offNotification: client.onNotification(notification => (
        this.callbacks.onNotification(sessionId, notification)
      )),
      offExit: client.onExit(code => this.callbacks.onExit(sessionId, code)),
    });
  }

  private unbind(sessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (!binding) return;
    this.bindings.delete(sessionId);
    binding.offNotification();
    binding.offExit();
  }

  getCapabilities(executor: string): ProxyCapabilities | null {
    return this.capabilitiesByExecutor.get(executor) ?? null;
  }

  async warmCapabilities(executor: Executor): Promise<ProxyCapabilities> {
    const cached = this.capabilitiesByExecutor.get(executor);
    if (cached && (usesNativeExecutorConfig(executor) || cached.models.length > 0)) return cached;
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
