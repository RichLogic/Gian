import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  CollaborationMode,
  ConfiguredPermissions,
  InputItem,
  SandboxMode,
  SandboxPolicy,
  ThinkingLevel,
} from '../core/types.js';
import type { CodexNativeThreadSummary, CodexRuntime } from './types.js';

function toError(value: unknown, fallback: string) {
  return value instanceof Error ? value : new Error(value ? String(value) : fallback);
}

function abortReason(signal: AbortSignal, fallback: string) {
  return toError(signal.reason, fallback);
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal, 'Codex app-server startup was cancelled.'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, 'Codex app-server startup was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function findFreePort(signal: AbortSignal) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finish = (error: unknown, port?: number) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      server.removeListener('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve(port!);
      }
    };
    const onAbort = () => {
      if (server.listening) server.close();
      finish(abortReason(signal, 'Codex app-server startup was cancelled.'));
    };
    const onError = (error: Error) => finish(error);

    if (signal.aborted) {
      finish(abortReason(signal, 'Codex app-server startup was cancelled.'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      if (settled) {
        server.close();
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        finish(new Error('Failed to allocate a free port.'));
        return;
      }

      const port = address.port;
      server.close((error) => finish(error, port));
    });
  });
}

async function waitForReady(url: string, timeoutMs: number, startupSignal: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => new Error(
    `Timed out waiting for Codex app-server readiness at ${url} after ${timeoutMs}ms.`,
  );

  while (true) {
    if (startupSignal.aborted) {
      throw abortReason(startupSignal, 'Codex app-server startup was cancelled.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();

    const attemptController = new AbortController();
    const onStartupAbort = () => attemptController.abort(startupSignal.reason);
    startupSignal.addEventListener('abort', onStartupAbort, { once: true });
    const attemptTimer = setTimeout(
      () => attemptController.abort(timeoutError()),
      remaining,
    );
    try {
      const response = await fetch(url, { signal: attemptController.signal });
      if (response.ok) return;
    } catch {
      if (startupSignal.aborted) {
        throw abortReason(startupSignal, 'Codex app-server startup was cancelled.');
      }
      if (Date.now() >= deadline || attemptController.signal.aborted) {
        throw timeoutError();
      }
      // The listener may not be accepting connections yet.
    } finally {
      clearTimeout(attemptTimer);
      startupSignal.removeEventListener('abort', onStartupAbort);
    }

    await delay(Math.min(100, Math.max(1, deadline - Date.now())), startupSignal);
  }
}

/** Translate our simple SandboxMode enum to codex's `SandboxPolicy` tagged
 *  union (which is what `turn/start.sandboxPolicy` expects in v2 protocol). */
function toSandboxPolicy(sandbox: SandboxMode) {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly' as const };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' as const };
    default:
      return { type: 'workspaceWrite' as const };
  }
}

interface ThreadBootstrapResponse {
  thread?: { id?: unknown };
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandbox?: unknown;
  activePermissionProfile?: { id?: unknown } | null;
}

function normalizeApprovalPolicy(value: unknown): ApprovalPolicy | null {
  if (
    value === 'untrusted'
    || value === 'on-request'
    || value === 'never'
    // Explicit rolling-upgrade compatibility: current app-server v2 no
    // longer advertises on-failure, but its semantics are known and older
    // managed Codex builds can still return it.
    || value === 'on-failure'
  ) return value;
  if (!value || typeof value !== 'object') return null;
  const outer = value as Record<string, unknown>;
  if (Object.keys(outer).length !== 1 || !Object.hasOwn(outer, 'granular')) return null;
  const granular = outer.granular;
  if (!granular || typeof granular !== 'object') return null;
  const record = granular as Record<string, unknown>;
  const allowedFields = [
    'sandbox_approval',
    'rules',
    'skill_approval',
    'request_permissions',
    'mcp_elicitations',
  ];
  if (Object.keys(record).some(field => !allowedFields.includes(field))) return null;
  if (
    typeof record.sandbox_approval !== 'boolean'
    || typeof record.rules !== 'boolean'
    || typeof record.mcp_elicitations !== 'boolean'
    || (record.skill_approval !== undefined && typeof record.skill_approval !== 'boolean')
    || (record.request_permissions !== undefined
      && typeof record.request_permissions !== 'boolean')
  ) return null;
  // The v2 JSON wire schema default-elides these two fields even though the
  // generated TS binding makes them required. Canonicalize both forms so the
  // rest of Gian always handles the complete policy.
  return {
    granular: {
      sandbox_approval: record.sandbox_approval,
      rules: record.rules,
      skill_approval: record.skill_approval ?? false,
      request_permissions: record.request_permissions ?? false,
      mcp_elicitations: record.mcp_elicitations,
    },
  };
}

function normalizeSandboxPolicy(value: unknown): SandboxPolicy | null {
  if (!value || typeof value !== 'object') return null;
  // Sandbox variants intentionally preserve extra metadata: app-server v2
  // does not set additionalProperties:false. Known fields are still typed,
  // and default-elided fields are canonicalized to their v2 wire defaults.
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'dangerFullAccess':
      return record as SandboxPolicy;
    case 'readOnly': {
      if (record.networkAccess !== undefined && typeof record.networkAccess !== 'boolean') {
        return null;
      }
      return { ...record, type: 'readOnly', networkAccess: record.networkAccess ?? false };
    }
    case 'workspaceWrite': {
      if (
        (record.writableRoots !== undefined
          && (!Array.isArray(record.writableRoots)
            || !record.writableRoots.every(root => typeof root === 'string')))
        || (record.networkAccess !== undefined && typeof record.networkAccess !== 'boolean')
        || (record.excludeTmpdirEnvVar !== undefined
          && typeof record.excludeTmpdirEnvVar !== 'boolean')
        || (record.excludeSlashTmp !== undefined && typeof record.excludeSlashTmp !== 'boolean')
      ) return null;
      return {
        ...record,
        type: 'workspaceWrite',
        writableRoots: record.writableRoots ?? [],
        networkAccess: record.networkAccess ?? false,
        excludeTmpdirEnvVar: record.excludeTmpdirEnvVar ?? false,
        excludeSlashTmp: record.excludeSlashTmp ?? false,
      };
    }
    case 'externalSandbox': {
      if (
        record.networkAccess !== undefined
        && record.networkAccess !== 'restricted'
        && record.networkAccess !== 'enabled'
      ) return null;
      return {
        ...record,
        type: 'externalSandbox',
        networkAccess: record.networkAccess ?? 'restricted',
      };
    }
    default:
      return null;
  }
}

function normalizeConfiguredPermissions(response: ThreadBootstrapResponse): ConfiguredPermissions {
  const approvalPolicy = response.approvalPolicy;
  const approvalsReviewer = response.approvalsReviewer;
  const sandboxPolicy = response.sandbox;
  const permissions = response.activePermissionProfile?.id;
  const normalizedApprovalPolicy = normalizeApprovalPolicy(approvalPolicy);
  if (!normalizedApprovalPolicy) {
    throw new Error('Codex thread response omitted its effective approval policy.');
  }
  if (
    approvalsReviewer !== 'user'
    && approvalsReviewer !== 'auto_review'
    && approvalsReviewer !== 'guardian_subagent'
  ) {
    throw new Error('Codex thread response omitted its effective approvals reviewer.');
  }
  if (typeof permissions === 'string' && permissions) {
    return { approvalPolicy: normalizedApprovalPolicy, approvalsReviewer, permissions };
  }
  const normalizedSandboxPolicy = normalizeSandboxPolicy(sandboxPolicy);
  if (!normalizedSandboxPolicy) {
    throw new Error('Codex thread response omitted its effective sandbox policy.');
  }
  return {
    approvalPolicy: normalizedApprovalPolicy,
    approvalsReviewer,
    sandboxPolicy: normalizedSandboxPolicy,
  };
}

function normalizeThreadBootstrap(response: unknown) {
  const record = response && typeof response === 'object'
    ? response as ThreadBootstrapResponse
    : {};
  const threadId = record.thread?.id;
  if (typeof threadId !== 'string' || !threadId) {
    throw new Error('Codex thread response omitted its thread id.');
  }
  return {
    thread: { id: threadId },
    configuredPermissions: normalizeConfiguredPermissions(record),
  };
}

function normalizedLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.replace(/\s+/g, ' ').trim();
  return label || null;
}

function previewLabel(value: unknown): string | null {
  const label = normalizedLabel(value);
  if (!label) return null;
  return label.length <= 120 ? label : `${label.slice(0, 117)}...`;
}

function normalizedUpdatedAt(value: unknown): string | null {
  const timestamp = typeof value === 'number'
    ? value * 1_000
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeNativeThread(
  value: unknown,
  cwdFilter: string | undefined,
): CodexNativeThreadSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const thread = value as Record<string, unknown>;
  if (typeof thread.id !== 'string' || !thread.id.trim()) return null;
  const cwd = typeof thread.cwd === 'string' && thread.cwd ? thread.cwd : null;
  // Keep an exact client-side filter as rolling-upgrade protection for older
  // app-server builds that accepted but did not consistently apply `cwd`.
  if (cwdFilter && cwd !== cwdFilter) return null;
  const displayName = normalizedLabel(thread.name) ?? previewLabel(thread.preview);
  const updatedAt = normalizedUpdatedAt(thread.updatedAt);
  return {
    id: thread.id.trim(),
    ...(displayName ? { displayName } : {}),
    ...(cwd ? { cwd } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export interface CodexAppServerDeadlines {
  /** Entire allocation → initialized handshake. */
  startupMs: number;
  /** HTTP `/readyz` polling. */
  readyMs: number;
  /** WebSocket open handshake. */
  socketConnectMs: number;
  /** Every JSON-RPC request, including `initialize`. */
  rpcMs: number;
  /** Grace after SIGTERM before a still-live child receives SIGKILL. */
  terminateGraceMs: number;
}

const DEFAULT_DEADLINES: CodexAppServerDeadlines = {
  startupMs: 30_000,
  readyMs: 10_000,
  socketConnectMs: 10_000,
  rpcMs: 60_000,
  terminateGraceMs: 2_000,
};

function normalizeDeadlines(overrides: Partial<CodexAppServerDeadlines> | undefined) {
  const deadlines = { ...DEFAULT_DEADLINES, ...overrides };
  for (const [name, value] of Object.entries(deadlines)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`Codex app-server deadline ${name} must be a positive finite number.`);
    }
  }
  return deadlines;
}

export function buildInitializeParams() {
  return {
    clientInfo: { name: 'codex-proxy', version: '0.1.0' },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
}

export function buildAppServerArgs(listenUrl: string): string[] {
  return [
    '-c', 'check_for_update_on_startup=false',
    'app-server', '--listen', listenUrl,
  ];
}

export class CodexAppServerClient extends EventEmitter implements CodexRuntime {
  private readonly codexBin: string;
  private readonly deadlines: CodexAppServerDeadlines;
  private process: ReturnType<typeof spawn> | null = null;
  private socket: WebSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private listenUrl: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private nextGeneration = 1;
  private activeGeneration: number | null = null;
  private startupAbort: { generation: number; controller: AbortController } | null = null;

  constructor(options: {
    codexBin?: string;
    deadlines?: Partial<CodexAppServerDeadlines>;
  } = {}) {
    super();
    this.codexBin = options.codexBin || (process.platform === 'darwin' ? '/opt/homebrew/bin/codex' : 'codex');
    this.deadlines = normalizeDeadlines(options.deadlines);
  }

  ensureStarted() {
    if (!this.startPromise) {
      const generation = this.nextGeneration++;
      this.activeGeneration = generation;
      const startPromise = this.start(generation);
      this.startPromise = startPromise;
      void startPromise.catch(() => {
        if (this.startPromise === startPromise) this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async start(generation: number) {
    const startupController = new AbortController();
    this.startupAbort = { generation, controller: startupController };
    const startupTimeout = setTimeout(() => {
      startupController.abort(new Error(
        `Timed out starting Codex app-server after ${this.deadlines.startupMs}ms.`,
      ));
    }, this.deadlines.startupMs);

    try {
      const port = await findFreePort(startupController.signal);
      this.assertCurrentGeneration(generation, startupController.signal);
      const listenUrl = `ws://127.0.0.1:${port}`;
      this.listenUrl = listenUrl;
      // Gian owns runtime activation. Prevent Codex's own startup updater from
      // racing the HOME-scoped updater or mutating a leased binary in place.
      const child = spawn(this.codexBin, buildAppServerArgs(listenUrl), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      this.process = child;
      this.attachProcess(child, generation);

      await waitForReady(
        `http://127.0.0.1:${port}/readyz`,
        this.deadlines.readyMs,
        startupController.signal,
      );
      this.assertCurrentGeneration(generation, startupController.signal);
      await this.connectSocket(listenUrl, generation, startupController.signal);
      this.assertCurrentGeneration(generation, startupController.signal);
      await this.requestInternal('initialize', buildInitializeParams(), {
        generation,
        signal: startupController.signal,
      });
      this.assertCurrentGeneration(generation, startupController.signal);
      this.send({ jsonrpc: '2.0', method: 'initialized' });
    } catch (cause) {
      const error = startupController.signal.aborted
        ? abortReason(startupController.signal, 'Codex app-server startup was cancelled.')
        : toError(cause, 'Failed to start Codex app-server.');
      this.handleRuntimeFailure(generation, error);
      throw error;
    } finally {
      clearTimeout(startupTimeout);
      if (this.startupAbort?.generation === generation) this.startupAbort = null;
    }
  }

  private assertCurrentGeneration(generation: number, startupSignal?: AbortSignal) {
    if (this.activeGeneration === generation && !startupSignal?.aborted) return;
    if (startupSignal?.aborted) {
      throw abortReason(startupSignal, 'Codex app-server startup was cancelled.');
    }
    throw new Error('Codex app-server startup was superseded by a newer runtime.');
  }

  private attachProcess(child: ReturnType<typeof spawn>, generation: number) {
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit('debug', text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit('debug', text);
    });
    child.on('error', (cause) => {
      this.handleRuntimeFailure(
        generation,
        toError(cause, 'Codex app-server process failed.'),
      );
    });
    child.once('exit', () => {
      this.handleRuntimeFailure(generation, new Error('Codex app-server stopped.'));
    });
  }

  private async connectSocket(
    listenUrl: string,
    generation: number,
    startupSignal: AbortSignal,
  ) {
    this.assertCurrentGeneration(generation, startupSignal);
    const socket = new WebSocket(listenUrl);
    await this.attachSocket(socket, generation, startupSignal);
  }

  private attachSocket(
    socket: WebSocket,
    generation: number,
    startupSignal: AbortSignal,
  ) {
    this.assertCurrentGeneration(generation, startupSignal);
    // Keep the CONNECTING socket reachable so process/startup failure can
    // close it. send() still refuses anything other than OPEN.
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let handshakeSettled = false;
      let opened = false;
      const finishHandshake = (error?: Error) => {
        if (handshakeSettled) return;
        handshakeSettled = true;
        clearTimeout(handshakeTimer);
        startupSignal.removeEventListener('abort', onStartupAbort);
        socket.removeEventListener('open', onOpen);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => {
        if (this.activeGeneration !== generation || startupSignal.aborted) {
          finishHandshake(startupSignal.aborted
            ? abortReason(startupSignal, 'Codex websocket startup was cancelled.')
            : new Error('Codex websocket startup was superseded.'));
          try { socket.close(); } catch {}
          return;
        }
        opened = true;
        finishHandshake();
      };
      const onMessage = (event: MessageEvent) => {
        if (this.activeGeneration === generation && this.socket === socket) {
          this.handleMessage(String(event.data));
        }
      };
      const onError = () => {
        const error = opened
          ? new Error('Codex app-server websocket failed.')
          : new Error('Failed to connect to Codex app-server websocket.');
        finishHandshake(error);
        if (this.socket === socket) this.handleRuntimeFailure(generation, error);
      };
      const onClose = () => {
        const error = opened
          ? new Error('Codex app-server websocket closed.')
          : new Error('Codex app-server websocket closed before connecting.');
        finishHandshake(error);
        if (this.socket === socket) this.handleRuntimeFailure(generation, error);
      };
      const onStartupAbort = () => {
        const error = abortReason(startupSignal, 'Codex websocket startup was cancelled.');
        finishHandshake(error);
        if (this.socket === socket) this.handleRuntimeFailure(generation, error);
      };
      const handshakeTimer = setTimeout(() => {
        const error = new Error(
          `Timed out connecting Codex app-server websocket after ${this.deadlines.socketConnectMs}ms.`,
        );
        finishHandshake(error);
        if (this.socket === socket) this.handleRuntimeFailure(generation, error);
      }, this.deadlines.socketConnectMs);

      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose, { once: true });
      startupSignal.addEventListener('abort', onStartupAbort, { once: true });
      if (startupSignal.aborted) onStartupAbort();
    });
  }

  private handleRuntimeFailure(generation: number, cause: unknown) {
    if (this.activeGeneration !== generation) return false;
    const error = toError(cause, 'Codex app-server stopped.');
    const socket = this.socket;
    const child = this.process;
    const startupAbort = this.startupAbort?.generation === generation
      ? this.startupAbort.controller
      : null;

    // Invalidate the generation before closing/killing. Both operations can
    // synchronously re-enter through close/exit in fakes and some runtimes.
    this.activeGeneration = null;
    this.socket = null;
    this.process = null;
    this.listenUrl = null;
    this.startPromise = null;
    if (this.startupAbort?.generation === generation) this.startupAbort = null;
    this.rejectAllPending(error);
    if (startupAbort && !startupAbort.signal.aborted) startupAbort.abort(error);

    if (socket) {
      try { socket.close(); } catch {}
    }
    if (child) this.terminateProcess(child);
    this.emit('runtimeStopped');
    return true;
  }

  private terminateProcess(child: ReturnType<typeof spawn>) {
    const stillAlive = () => child.exitCode === null && child.signalCode === null;
    const forceKillTimer = setTimeout(() => {
      child.removeListener('exit', onExit);
      if (!stillAlive()) return;
      try {
        child.kill('SIGKILL');
      } catch (error) {
        this.emit('debug', `Failed to SIGKILL Codex app-server: ${toError(error, 'unknown error').message}`);
      }
    }, this.deadlines.terminateGraceMs);
    forceKillTimer.unref();
    const onExit = () => clearTimeout(forceKillTimer);
    child.once('exit', onExit);

    if (!stillAlive()) {
      child.removeListener('exit', onExit);
      clearTimeout(forceKillTimer);
      return;
    }
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch (error) {
        this.emit('debug', `Failed to SIGTERM Codex app-server: ${toError(error, 'unknown error').message}`);
      }
    }
  }

  private handleMessage(raw: string) {
    const message = JSON.parse(raw) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.takePending(message.id);
      if (!pending) {
        return;
      }
      if (message.error) {
        pending.reject(new Error(message.error.message || 'Unknown JSON-RPC error.'));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method && typeof message.id !== 'undefined') {
      this.emit('serverRequest', message);
      return;
    }

    if (message.method) {
      this.emit('notification', message);
    }
  }

  private send(payload: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server websocket is not connected.');
    }
    this.socket.send(JSON.stringify(payload));
  }

  private takePending(id: number) {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    return pending;
  }

  private rejectPending(id: number, error: Error) {
    const pending = this.takePending(id);
    if (!pending) return;
    pending.reject(error);
  }

  private rejectAllPending(error: Error) {
    // Empty the map before invoking user continuations so re-entrant recovery
    // starts with a clean generation and cannot be drained by this teardown.
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.removeAbortListener?.();
    }
    for (const pending of entries) pending.reject(error);
  }

  private async requestInternal(
    method: string,
    params: unknown,
    options: { generation?: number; signal?: AbortSignal } = {},
  ) {
    const generation = options.generation ?? this.activeGeneration;
    if (generation === null || this.activeGeneration !== generation) {
      throw new Error('Codex app-server runtime is not started.');
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      pending.timer = setTimeout(() => {
        const error = new Error(
          `Codex app-server RPC ${JSON.stringify(method)} timed out after ${this.deadlines.rpcMs}ms.`,
        );
        if (!this.handleRuntimeFailure(generation, error)) this.rejectPending(id, error);
      }, this.deadlines.rpcMs);
      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => {
          const error = abortReason(signal, `Codex app-server RPC ${method} was cancelled.`);
          if (!this.handleRuntimeFailure(generation, error)) this.rejectPending(id, error);
        };
        pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, pending);
      if (options.signal?.aborted) {
        const error = abortReason(options.signal, `Codex app-server RPC ${method} was cancelled.`);
        if (!this.handleRuntimeFailure(generation, error)) this.rejectPending(id, error);
        return;
      }
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (cause) {
        const error = toError(cause, `Failed to send Codex app-server RPC ${method}.`);
        if (!this.handleRuntimeFailure(generation, error)) this.rejectPending(id, error);
      }
    });
  }

  private async request(method: string, params: unknown) {
    await this.ensureStarted();
    const generation = this.activeGeneration;
    if (generation === null) {
      throw new Error('Codex app-server stopped during startup.');
    }
    return this.requestInternal(method, params, { generation });
  }

  async startThread(options: {
    cwd: string;
    model?: string | null;
    ephemeral?: boolean;
  }) {
    const response = await this.request('thread/start', {
      cwd: options.cwd,
      experimentalRawEvents: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.ephemeral ? { ephemeral: true } : {}),
    });
    return normalizeThreadBootstrap(response);
  }

  async resumeThread(threadId: string) {
    return normalizeThreadBootstrap(await this.request('thread/resume', { threadId }));
  }

  async readThread(threadId: string) {
    return this.request('thread/read', {
      threadId,
      includeTurns: true,
    }) as Promise<{ thread: unknown }>;
  }

  async compactThread(threadId: string) {
    return this.request('thread/compact/start', { threadId });
  }

  /** SESSION-NAME-001: set the thread's user-facing display name so it shows
   *  in `codex resume` / Codex app listings. */
  async setThreadName(threadId: string, name: string) {
    return this.request('thread/name/set', { threadId, name });
  }

  /** Read every persisted thread page. `name` is Codex's user-facing title
   *  (including its LM-generated title); `preview` is only a compatibility
   *  fallback when Codex has not assigned a name yet. */
  async listNativeThreads(cwd?: string): Promise<CodexNativeThreadSummary[]> {
    const threads: CodexNativeThreadSummary[] = [];
    const seenThreadIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      const response = await this.request('thread/list', {
        ...(cwd ? { cwd } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 100,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      });
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error('Codex thread/list returned an invalid response.');
      }
      const page = response as { data?: unknown; nextCursor?: unknown };
      if (!Array.isArray(page.data)) {
        throw new Error('Codex thread/list response omitted its data array.');
      }
      for (const value of page.data) {
        const thread = normalizeNativeThread(value, cwd);
        if (!thread || seenThreadIds.has(thread.id)) continue;
        seenThreadIds.add(thread.id);
        threads.push(thread);
      }

      if (page.nextCursor === null || page.nextCursor === undefined || page.nextCursor === '') {
        break;
      }
      if (typeof page.nextCursor !== 'string' || seenCursors.has(page.nextCursor)) {
        throw new Error('Codex thread/list returned an invalid pagination cursor.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return threads;
  }

  async startTurn(
    threadId: string,
    input: InputItem[],
    options: {
      model?: string | null;
      thinking?: ThinkingLevel | null;
      sandbox?: SandboxMode | null;
      sandboxPolicy?: SandboxPolicy | null;
      runtimeWorkspaceRoots?: string[] | null;
      permissions?: string | null;
      approvalPolicy?: ApprovalPolicy | null;
      approvalsReviewer?: ApprovalsReviewer | null;
      collaborationMode?: CollaborationMode | null;
      reasoningSummary?: 'none' | 'auto' | 'concise' | 'detailed' | null;
      serviceTier?: 'fast' | 'flex' | null;
    } = {},
  ) {
    const sandboxParams = options.permissions
      ? { permissions: options.permissions }
      : options.sandboxPolicy
        ? { sandboxPolicy: options.sandboxPolicy }
        : options.sandbox
          ? { sandboxPolicy: toSandboxPolicy(options.sandbox) }
          : {};
    return this.request('turn/start', {
      threadId,
      input,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinking ? { effort: options.thinking } : {}),
      ...(options.runtimeWorkspaceRoots?.length
        ? { runtimeWorkspaceRoots: options.runtimeWorkspaceRoots }
        : {}),
      ...sandboxParams,
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
      ...(options.reasoningSummary ? { summary: options.reasoningSummary } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    }) as Promise<{ turn: { id: string; status: string } }>;
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  /** `turn/steer` — append user input to the in-flight turn without starting
   *  a new one. `expectedTurnId` is required by the server and must match the
   *  active turn, otherwise the request fails with an invalid-request error. */
  async steerTurn(threadId: string, turnId: string, input: unknown[]) {
    return this.request('turn/steer', { threadId, input, expectedTurnId: turnId }) as Promise<{ turnId: string }>;
  }

  async respond(id: number | string, result: unknown) {
    await this.ensureStarted();
    const generation = this.activeGeneration;
    if (generation === null) {
      throw new Error('Codex app-server stopped before the response could be sent.');
    }
    try {
      this.send({ jsonrpc: '2.0', id, result });
    } catch (cause) {
      const error = toError(cause, 'Failed to send Codex app-server response.');
      this.handleRuntimeFailure(generation, error);
      throw error;
    }
  }

  async listSkills(cwd?: string) {
    return this.request('skills/list', {
      ...(cwd ? { cwds: [cwd] } : {}),
    }) as Promise<import('./types.js').SkillsListResponse>;
  }

  async listAllModels() {
    const models: unknown[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.request('model/list', {
        ...(cursor ? { cursor } : {}),
        limit: 100,
        includeHidden: true,
      }) as { data?: unknown[]; nextCursor?: string | null };
      models.push(...(Array.isArray(response.data) ? response.data : []));
      cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : null;
    } while (cursor);
    return models;
  }

  async unsubscribeThread(threadId: string) {
    return this.request('thread/unsubscribe', { threadId });
  }

  async stop() {
    const generation = this.activeGeneration;
    if (generation !== null) {
      this.handleRuntimeFailure(generation, new Error('Codex app-server stopped.'));
      return;
    }

    // Defensive cleanup for a partially constructed instance. Normal runtime
    // paths always have an active generation and use the branch above.
    const socket = this.socket;
    const child = this.process;
    this.socket = null;
    this.process = null;
    this.listenUrl = null;
    this.startPromise = null;
    this.rejectAllPending(new Error('Codex app-server stopped.'));
    if (socket) {
      try { socket.close(); } catch {}
    }
    if (child) this.terminateProcess(child);
  }
}
