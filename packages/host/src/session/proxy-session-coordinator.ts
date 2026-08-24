import type {
  AgentProxyDefaults,
  ConfigOption,
  ConfigValue,
  Executor,
  ExecutorConfigState,
  NativeConfigOption,
  ProxyCatalog,
  ProxyNotification,
  ResolvedProxyCatalog,
  Session,
  SessionAvailableActions,
  SlashListResult,
} from '@gian/shared';
import type { NativeJsonlWatcher } from '../native/watcher.js';
import type { ProxyManager } from '../proxy/manager.js';
import type { ProxyClient, ProxyReplayResult } from '../proxy/types.js';
import { ensureSessionAttachmentDir } from '../storage/attachments.js';
import type { Db } from '../storage/db.js';
import type { SessionHistoryStore } from './history-store.js';
import { requestViolation } from '@gian/proxy-protocol';
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
  sessionConfig?: Record<string, string | boolean | number | null>;
}

export interface BringUpProxySessionResult {
  proxySessionId: string;
  nativeSessionId: string;
  configOptions: NativeConfigOption[];
  replayUpdates: unknown[];
  replayStreamId?: string;
  turnConfigOptions?: ConfigOption[];
  turnConfigRevision?: string;
  availableActions?: SessionAvailableActions;
}

interface ProxySessionCallbacks {
  onNotification(sessionId: string, notification: ProxyNotification): void;
  onExit(sessionId: string, code: number | null): void;
  onSessionFault(sessionId: string, error: Error): void;
  onSessionUpdated(sessionId: string, partial: Partial<Session>): void;
  onAttached?(sessionId: string): void;
}

interface ProxySessionBindings {
  offNotification: () => void;
  offExit: () => void;
  offFault: () => void;
}

function catalogHasModelChoices(catalog: ProxyCatalog): boolean {
  return catalog.configOptions.some((option) => (
    option.role === 'model' && (option.choices?.length ?? 0) > 0
  ));
}

function nativeOptionsFromCatalog(
  catalog: ProxyCatalog,
  values: Record<string, string | boolean | number | null>,
): NativeConfigOption[] {
  return catalog.configOptions.map((option: ConfigOption) => ({
    id: option.id,
    name: option.displayName,
    type: option.control,
    currentValue: values[option.id] ?? option.defaultValue,
    scope: option.binding,
    ...(option.role ? { category: option.role } : {}),
    ...(option.choices ? {
      choices: option.choices.map((choice) => ({
        value: choice.value,
        label: choice.displayName,
      })),
    } : {}),
  }));
}

export class ProxySessionCoordinator {
  private sessionIds = new Map<string, string>();
  private bringUps = new Map<string, Promise<string>>();
  private bindings = new Map<string, ProxySessionBindings>();
  private catalogByExecutor = new Map<string, ProxyCatalog>();
  private protocolCapabilitiesByExecutor = new Map<string, Record<string, unknown>>();
  private emptyCatalogKeys = new Set<string>();
  private sessionStore: SessionRepository;

  constructor(
    private db: Db,
    private proxy: ProxyManager,
    sessions: SessionRepository,
    private history: SessionHistoryStore,
    watcher: NativeJsonlWatcher | null,
    private callbacks: ProxySessionCallbacks,
    private dataDir?: string,
  ) {
    this.sessionStore = sessions;
    void watcher;
  }

  get(sessionId: string): string | undefined {
    return this.sessionIds.get(sessionId);
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

  quarantine(sessionId: string, error: Error): void {
    console.error(`[proxy] quarantined session ${sessionId}: ${error.message}`);
    const client = this.proxy.get(sessionId);
    this.callbacks.onSessionFault(sessionId, error);
    void client?.closeSession?.().catch(() => undefined);
  }

  async refreshCatalog(sessionId: string): Promise<void> {
    const client = this.proxy.get(sessionId);
    if (!client) return;
    const catalog = await client.catalog();
    this.catalogByExecutor.set(client.executor, catalog);
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
      await this.dispose(session.id);
      throw error;
    } finally {
      if (this.bringUps.get(session.id) === pending) this.bringUps.delete(session.id);
    }
  }

  private async rehydrate(session: Session): Promise<string> {
    if (session.origin?.kind === 'fork' && !session.native_session_id) {
      throw requestViolation('RUNTIME_ERROR', 'Fork Session has no durable nativeSession');
    }
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
    const remapped = executorConfigFromOptions(result.configOptions);
    const now = new Date().toISOString();
    this.sessionStore.setNativeOptions(session.id, result.configOptions);
    this.db.prepare(
      result.availableActions
        ? 'UPDATE sessions SET executor_config_json = ?, available_actions_json = ?, updated_at = ? WHERE id = ?'
        : 'UPDATE sessions SET executor_config_json = ?, updated_at = ? WHERE id = ?',
    ).run(
      ...(result.availableActions
        ? [JSON.stringify(remapped), JSON.stringify(result.availableActions), now, session.id]
        : [JSON.stringify(remapped), now, session.id]),
    );
    this.callbacks.onSessionUpdated(session.id, {
      executor_config: remapped,
      native_config_options: result.configOptions,
      ...(result.availableActions ? { available_actions: result.availableActions } : {}),
      updated_at: now,
    });
    return result.proxySessionId;
  }

  async bringUp(args: BringUpProxySessionInput): Promise<BringUpProxySessionResult> {
    const client = await this.proxy.getOrCreate(args.sessionId, args.executor);
    // Replace any stale callbacks before the new facade starts initialization.
    // Native create/adopt may emit notifications or exit before createSession
    // resolves, so binding only at the end of bring-up would lose that state.
    this.bind(args.sessionId, client);
    const initialized = await client.initialize();
    this.rememberProtocolCapabilities(args.executor, initialized);
    const catalog = await client.catalog();
    this.catalogByExecutor.set(args.executor, catalog);

    const adoptParams: {
      nativeSessionId?: string;
      history?: 'none' | 'replay';
      resumeMode?: 'load' | 'resume';
    } = {};
    if (args.nativeSessionId) {
      adoptParams.nativeSessionId = args.nativeSessionId;
      adoptParams.history = args.resumeMode === 'load' ? 'replay' : 'none';
      adoptParams.resumeMode = args.resumeMode ?? 'resume';
    }
    const sessionConfig: Record<string, string | boolean | number | null> = {};
    for (const option of catalog.configOptions) {
      if (option.binding !== 'session') continue;
      const persisted = args.executorConfig?.values[option.id]
        ?? (option.role === 'effort'
          ? args.executorConfig?.values.thought_level
          : undefined);
      const byRole = option.role === 'model'
        ? args.model
        : option.role === 'effort'
          ? args.executorDefaults?.thinking
          : option.role === 'approval_mode'
            ? args.executorDefaults?.mode
            : undefined;
      const supportedRoleValue = byRole === undefined || byRole === null
        || !option.choices || option.choices.some(choice => Object.is(choice.value, byRole))
        ? byRole
        : undefined;
      const value = args.sessionConfig?.[option.id]
        ?? persisted
        ?? supportedRoleValue
        ?? option.defaultValue;
      if (value !== undefined && value !== '') sessionConfig[option.id] = value;
    }
    const attachmentDir = await ensureSessionAttachmentDir(args.sessionId, this.dataDir);
    const workspaceRoots = [args.cwd, attachmentDir];
    let created;
    try {
      created = await client.createSession({
        cwd: args.cwd,
        workspaceRoots,
        sessionConfig,
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
      if (!isMissing || turnCount > 0) throw error;

      created = await client.createSession({
        cwd: args.cwd,
        workspaceRoots,
        sessionConfig,
      });
      const now = new Date().toISOString();
      this.db.prepare('UPDATE sessions SET native_session_id = ?, updated_at = ? WHERE id = ?')
        .run(created.nativeSessionId, now, args.sessionId);
      this.callbacks.onSessionUpdated(args.sessionId, {
        native_session_id: created.nativeSessionId,
        updated_at: now,
      });
    }

    this.sessionIds.set(args.sessionId, created.session.id);
    const persistedName = this.db.prepare('SELECT name FROM sessions WHERE id = ?')
      .get(args.sessionId) as { name: string | null } | undefined;
    const displayName = (persistedName ? persistedName.name : args.displayName)?.trim();
    if (displayName && client.setName) {
      try {
        await client.setName(displayName);
      } catch (error) {
        console.warn(`[session] ${args.executor} setName on bring-up failed for ${args.sessionId}: ${String(error)}`);
      }
    }
    this.callbacks.onAttached?.(args.sessionId);
    return {
      proxySessionId: created.session.id,
      nativeSessionId: created.nativeSessionId ?? args.nativeSessionId ?? '',
      configOptions: nativeOptionsFromCatalog(catalog, sessionConfig),
      replayUpdates: created.replayEvents ?? [],
      ...(created.replayStreamId ? { replayStreamId: created.replayStreamId } : {}),
      ...(created.turnConfigOptions !== undefined
        ? {
            turnConfigOptions: created.turnConfigOptions,
            turnConfigRevision: created.turnConfigRevision,
          }
        : {}),
      ...(created.availableActions ? { availableActions: created.availableActions } : {}),
    };
  }

  attachAdopted(sessionId: string, proxySessionId: string): void {
    const client = this.proxy.get(sessionId);
    if (!client) throw new Error(`no adopted proxy for session: ${sessionId}`);
    this.bind(sessionId, client);
    this.sessionIds.set(sessionId, proxySessionId);
    this.callbacks.onAttached?.(sessionId);
  }

  private bind(sessionId: string, client: ProxyClient): void {
    this.unbind(sessionId);
    this.bindings.set(sessionId, {
      offNotification: client.onNotification((notification) => (
        this.callbacks.onNotification(sessionId, notification as ProxyNotification)
      )),
      offExit: client.onExit((code) => this.callbacks.onExit(sessionId, code)),
      offFault: client.onSessionFault
        ? client.onSessionFault((error) => this.quarantine(sessionId, error))
        : () => undefined,
    });
  }

  private unbind(sessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (!binding) return;
    this.bindings.delete(sessionId);
    binding.offNotification();
    binding.offExit();
    binding.offFault();
  }

  getCapabilities(executor: string): ProxyCatalog | null {
    return this.catalogByExecutor.get(executor) ?? null;
  }

  getProtocolCapabilities(executor: string): Record<string, unknown> | null {
    return this.protocolCapabilitiesByExecutor.get(executor) ?? null;
  }

  async warmCapabilities(executor: Executor): Promise<ProxyCatalog> {
    const cached = this.catalogByExecutor.get(executor);
    if (cached) return cached;
    const tempKey = `__caps__${executor}`;
    if (this.emptyCatalogKeys.has(tempKey)) {
      this.emptyCatalogKeys.delete(tempKey);
      await this.proxy.dispose(tempKey).catch(() => undefined);
    }
    const client = await this.proxy.getOrCreate(tempKey, executor);
    const initialized = await client.initialize();
    this.rememberProtocolCapabilities(executor, initialized);
    const catalog = await client.catalog();
    if (catalogHasModelChoices(catalog)) {
      this.catalogByExecutor.set(executor, catalog);
    } else {
      this.emptyCatalogKeys.add(tempKey);
    }
    return catalog;
  }

  async resolveCatalog(
    executor: Executor,
    params: {
      catalogRevision: string;
      sessionConfig: Record<string, ConfigValue>;
      turnConfig: Record<string, ConfigValue>;
    },
    sessionId?: string,
  ): Promise<ResolvedProxyCatalog> {
    let client = sessionId ? this.proxy.get(sessionId) : undefined;
    if (!client) {
      const tempKey = `__caps__${executor}`;
      client = await this.proxy.getOrCreate(tempKey, executor);
      await client.initialize();
    }
    if (!client.resolveCatalog) {
      throw new Error('catalog.resolve is not available');
    }
    return client.resolveCatalog(params);
  }

  async listSlashCommands(
    executor: 'codex' | 'claude',
    _cwd?: string,
  ): Promise<SlashListResult> {
    const catalog = this.catalogByExecutor.get(executor) ?? await this.warmCapabilities(executor);
    return { commands: catalog.slashCommands };
  }

  private rememberProtocolCapabilities(
    executor: string,
    initialized: { capabilities?: Record<string, unknown> },
  ): void {
    if (initialized.capabilities) {
      this.protocolCapabilitiesByExecutor.set(executor, initialized.capabilities);
    }
  }
}
