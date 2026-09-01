/**
 * Shared outer ZCode Proxy with Desktop-equivalent per-workspace inner
 * app-servers (ADR-0052). The existing adapter remains the owner of one
 * ZCode Protocol/1 runtime; this service only routes outer requests and owns
 * runtime lifecycle.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ServiceError,
  ZcodeV2Adapter,
  type DispatchOutcome,
  type WireRequest,
} from './adapter.js';
import {
  ZCodeTransport,
} from './inner/transport.js';
import type { OuterNotification } from './events.js';

interface RuntimeEntry {
  key: string;
  adapter: ZcodeV2Adapter;
  transport: ZCodeTransport;
  sessionIds: Set<string>;
  stopping: boolean;
}

interface SessionRoute {
  runtime: RuntimeEntry;
  nativeSessionId: string | null;
}

export interface ZcodeSharedServiceOptions {
  runtimeBin: string;
  nodeBin?: string;
  dataDir: string | null;
  catalogWorkspace: string;
  interactionEnabled: boolean;
  env: {
    home: string;
    path: string;
    tmpdir: string;
    lang?: string;
    gian?: Readonly<Record<string, string>>;
  };
  onStderr?: (runtimeKey: string, line: unknown) => void;
  onDiagnostic?: (runtimeKey: string, info: unknown) => void;
}

const SESSION_METHODS = new Set([
  'session.get',
  'turn.start',
  'turn.interrupt',
  'interaction.respond',
  'session.close',
  'session.replay',
  'session.rename',
  'session.native.delete',
  'turn.steer',
  'sidechat.create',
  'sidechat.resume',
  'sidechat.close',
  'session.fork',
]);

export class ZcodeSharedService {
  private initializationParams: Record<string, unknown> | null = null;
  private catalogRuntime: RuntimeEntry | null = null;
  private readonly workspaceRuntimes = new Map<string, RuntimeEntry>();
  private readonly sessionRoutes = new Map<string, SessionRoute>();
  private readonly nativeOwners = new Map<string, string>();
  private emitSink: (notification: OuterNotification) => void = () => undefined;

  constructor(private readonly options: ZcodeSharedServiceOptions) {}

  setEmitSink(sink: (notification: OuterNotification) => void): void {
    this.emitSink = sink;
    if (this.catalogRuntime) this.catalogRuntime.adapter.setEmitSink(sink);
    for (const runtime of this.workspaceRuntimes.values()) runtime.adapter.setEmitSink(sink);
  }

  async dispatch(request: WireRequest): Promise<DispatchOutcome> {
    try {
      switch (request.method) {
        case 'initialize':
          return await this.initialize(request);
        case 'catalog.list':
        case 'catalog.resolve':
          return await this.dispatchCatalog(request);
        case 'session.native.list':
          return await this.dispatchCatalog(request);
        case 'session.create':
          return await this.createSession(request);
        case 'shutdown':
          return await this.shutdown(request);
        default:
          if (request.method === 'interaction.respond' && !this.options.interactionEnabled) {
            throw new ServiceError('CAPABILITY_NOT_SUPPORTED', 'interaction capability is not declared.');
          }
          if (SESSION_METHODS.has(request.method)) return await this.dispatchSession(request);
          return await this.dispatchCatalog(request);
      }
    } catch (error) {
      return normalizeServiceError(error);
    }
  }

  private async initialize(request: WireRequest): Promise<DispatchOutcome> {
    if (this.initializationParams !== null) {
      throw new ServiceError('ALREADY_INITIALIZED', 'initialize can only be sent once.');
    }
    const runtime = await this.getOrCreateCatalogRuntime();
    const outcome = await runtime.adapter.dispatch(request);
    if (outcome.ok) this.initializationParams = { ...request.params };
    return outcome;
  }

  private async dispatchCatalog(request: WireRequest): Promise<DispatchOutcome> {
    this.requireInitialized();
    return (await this.getOrCreateCatalogRuntime()).adapter.dispatch(request);
  }

  private async createSession(request: WireRequest): Promise<DispatchOutcome> {
    this.requireInitialized();
    const sessionId = requiredString(request.params, 'sessionId');
    const existing = this.sessionRoutes.get(sessionId);
    const workspace = request.params.workspace as Record<string, unknown> | undefined;
    const cwd = requiredString(workspace ?? {}, 'cwd');
    const runtime = existing?.runtime ?? await this.getOrCreateWorkspaceRuntime(cwd);
    const outcome = await runtime.adapter.dispatch(request);
    if (!outcome.ok) return outcome;

    const session = (outcome.result as { session?: Record<string, unknown> } | undefined)?.session;
    const native = session?.nativeSession as Record<string, unknown> | undefined;
    const nativeSessionId = typeof native?.id === 'string' ? native.id : null;
    runtime.sessionIds.add(sessionId);
    this.sessionRoutes.set(sessionId, { runtime, nativeSessionId });
    if (nativeSessionId) this.nativeOwners.set(nativeSessionId, sessionId);
    return outcome;
  }

  private async dispatchSession(request: WireRequest): Promise<DispatchOutcome> {
    this.requireInitialized();
    const sessionId = requiredString(request.params, 'sessionId');
    const route = this.sessionRoutes.get(sessionId);
    if (!route) throw new ServiceError('SESSION_NOT_FOUND', `Session ${sessionId} is not attached.`);
    const outcome = await route.runtime.adapter.dispatch(request);
    if (request.method === 'session.close' && outcome.ok) {
      this.sessionRoutes.delete(sessionId);
      route.runtime.sessionIds.delete(sessionId);
      if (route.nativeSessionId && this.nativeOwners.get(route.nativeSessionId) === sessionId) {
        this.nativeOwners.delete(route.nativeSessionId);
      }
      if (route.runtime.sessionIds.size === 0) await this.stopWorkspaceRuntime(route.runtime);
    }
    return outcome;
  }

  private async shutdown(request: WireRequest): Promise<DispatchOutcome> {
    const runtimes = [
      ...this.catalogRuntime ? [this.catalogRuntime] : [],
      ...this.workspaceRuntimes.values(),
    ];
    let first: DispatchOutcome | null = null;
    for (const runtime of runtimes) {
      runtime.stopping = true;
      const outcome = await runtime.adapter.dispatch(request);
      first ??= outcome;
    }
    this.catalogRuntime = null;
    this.workspaceRuntimes.clear();
    this.sessionRoutes.clear();
    this.nativeOwners.clear();
    return first ?? { ok: true, result: { ok: true }, notifications: [] };
  }

  private async getOrCreateCatalogRuntime(): Promise<RuntimeEntry> {
    if (this.catalogRuntime) return this.catalogRuntime;
    const workspace = resolve(this.options.catalogWorkspace);
    mkdirSync(workspace, { recursive: true });
    const runtime = this.createRuntime('catalog', workspace);
    this.catalogRuntime = runtime;
    if (this.initializationParams !== null) {
      const initialized = await runtime.adapter.dispatch({
        id: `internal-initialize-${runtimeId('catalog')}`,
        method: 'initialize',
        params: { ...this.initializationParams },
      });
      if (!initialized.ok) {
        runtime.stopping = true;
        if (this.catalogRuntime === runtime) this.catalogRuntime = null;
        await runtime.transport.stop();
        throw new Error(initialized.error?.message ?? 'ZCode catalog runtime initialization failed.');
      }
    }
    return runtime;
  }

  private async getOrCreateWorkspaceRuntime(cwd: string): Promise<RuntimeEntry> {
    const workspace = resolve(cwd);
    const key = `workspace:${workspace}`;
    const existing = this.workspaceRuntimes.get(key);
    if (existing) return existing;
    const runtime = this.createRuntime(key, workspace);
    const initialized = await runtime.adapter.dispatch({
      id: `internal-initialize-${runtimeId(key)}`,
      method: 'initialize',
      params: { ...this.initializationParams },
    });
    if (!initialized.ok) {
      runtime.stopping = true;
      await runtime.transport.stop();
      throw new Error(initialized.error?.message ?? 'ZCode workspace runtime initialization failed.');
    }
    this.workspaceRuntimes.set(key, runtime);
    return runtime;
  }

  private createRuntime(key: string, workspace: string): RuntimeEntry {
    const dataDir = this.options.dataDir
      ? join(this.options.dataDir, key === 'catalog' ? 'catalog' : 'workspaces', runtimeId(key))
      : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const transport = new ZCodeTransport({
      runtimeBin: this.options.runtimeBin,
      ...(this.options.nodeBin ? { nodeBin: this.options.nodeBin } : {}),
      cwd: workspace,
      launchMode: 'desktop-stdio',
      env: this.options.env,
    });
    const adapter = new ZcodeV2Adapter(transport, {
      dataDir,
      catalogWorkspace: workspace,
      interactionEnabled: this.options.interactionEnabled,
      runtimeBin: this.options.runtimeBin,
      isNativeSessionOwned: nativeSessionId => this.nativeOwners.has(nativeSessionId),
    });
    adapter.setEmitSink(notification => this.emitSink(notification));
    const runtime: RuntimeEntry = { key, adapter, transport, sessionIds: new Set(), stopping: false };
    transport.on('stderr', (line: unknown) => this.options.onStderr?.(key, line));
    transport.on('diagnostic', (info: unknown) => this.options.onDiagnostic?.(key, info));
    transport.on('exit', () => {
      if (runtime.stopping) return;
      if (this.catalogRuntime === runtime) this.catalogRuntime = null;
      if (this.workspaceRuntimes.get(key) === runtime) this.workspaceRuntimes.delete(key);
      for (const sessionId of runtime.sessionIds) {
        const route = this.sessionRoutes.get(sessionId);
        if (route?.runtime === runtime) {
          this.sessionRoutes.delete(sessionId);
          if (route.nativeSessionId && this.nativeOwners.get(route.nativeSessionId) === sessionId) {
            this.nativeOwners.delete(route.nativeSessionId);
          }
        }
      }
    });
    transport.start();
    return runtime;
  }

  private async stopWorkspaceRuntime(runtime: RuntimeEntry): Promise<void> {
    runtime.stopping = true;
    if (this.workspaceRuntimes.get(runtime.key) === runtime) this.workspaceRuntimes.delete(runtime.key);
    await runtime.adapter.dispatch({ id: `internal-shutdown-${runtimeId(runtime.key)}`, method: 'shutdown', params: {} });
  }

  private requireInitialized(): void {
    if (this.initializationParams === null) {
      throw new ServiceError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
  }
}

function runtimeId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new ServiceError('INVALID_PARAMS', `params.${key} must be a non-empty string.`);
  }
  return field;
}

function normalizeServiceError(error: unknown): DispatchOutcome {
  if (error instanceof ServiceError) {
    return {
      ok: false,
      error: {
        code: error.domainCode === 'INVALID_PARAMS' ? -32602 : -32000,
        message: error.message,
        data: { domainCode: error.domainCode, retryable: error.retryable, details: {} },
      },
      notifications: [],
    };
  }
  return {
    ok: false,
    error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    notifications: [],
  };
}
