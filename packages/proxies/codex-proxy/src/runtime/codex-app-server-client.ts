import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  CollaborationMode,
  InputItem,
  SandboxMode,
  ThinkingLevel,
} from '../core/types.js';
import type { CodexRuntime } from './types.js';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a free port.'));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForReady(url: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // still starting
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for Codex app-server readiness at ${url}`);
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

/** The simple `sandbox` field on `thread/start` accepts the kebab-case enum
 *  directly, so this is a pass-through with explicit narrowing. */
function toThreadSandbox(sandbox: SandboxMode) {
  return sandbox;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class CodexAppServerClient extends EventEmitter implements CodexRuntime {
  private readonly codexBin: string;
  private process: ReturnType<typeof spawn> | null = null;
  private socket: WebSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private listenUrl: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: { codexBin?: string } = {}) {
    super();
    this.codexBin = options.codexBin || (process.platform === 'darwin' ? '/opt/homebrew/bin/codex' : 'codex');
  }

  async ensureStarted() {
    if (!this.startPromise) {
      this.startPromise = this.start();
    }
    return this.startPromise;
  }

  private async start() {
    const port = await findFreePort();
    this.listenUrl = `ws://127.0.0.1:${port}`;
    const child = spawn(this.codexBin, ['app-server', '--listen', this.listenUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    this.process = child;

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit('debug', text);
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit('debug', text);
      }
    });

    child.on('exit', () => {
      this.socket = null;
      this.process = null;
      this.startPromise = null;
      for (const [id, pending] of this.pending.entries()) {
        pending.reject(new Error('Codex app-server stopped.'));
        this.pending.delete(id);
      }
      this.emit('runtimeStopped');
    });

    await waitForReady(`http://127.0.0.1:${port}/readyz`);
    await this.connectSocket();
    await this.requestInternal('initialize', {
      clientInfo: { name: 'codex-proxy', version: '0.1.0' },
      capabilities: null,
    });
    this.send({ jsonrpc: '2.0', method: 'initialized' });
  }

  private async connectSocket() {
    if (!this.listenUrl) {
      throw new Error('Missing listen URL.');
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.listenUrl!);
      socket.addEventListener('open', () => {
        this.socket = socket;
        socket.addEventListener('message', (event) => {
          this.handleMessage(String(event.data));
        });
        socket.addEventListener('close', () => {
          if (this.socket === socket) {
            this.socket = null;
          }
        });
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        reject(new Error('Failed to connect to Codex websocket.'));
      }, { once: true });
    });
  }

  private handleMessage(raw: string) {
    const message = JSON.parse(raw) as { id?: number; method?: string; result?: unknown; error?: { message?: string } };
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
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

  private async requestInternal(method: string, params: unknown) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async request(method: string, params: unknown) {
    await this.ensureStarted();
    return this.requestInternal(method, params);
  }

  async startThread(options: {
    cwd: string;
    model?: string | null;
    ephemeral?: boolean;
  }) {
    // Permissive thread-level defaults; per-turn `startTurn` overrides decide
    // the actual policy on every turn.
    return this.request('thread/start', {
      cwd: options.cwd,
      sandbox: toThreadSandbox('workspace-write'),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      experimentalRawEvents: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.ephemeral ? { ephemeral: true } : {}),
    }) as Promise<{ thread: { id: string } }>;
  }

  async resumeThread(threadId: string) {
    return this.request('thread/resume', { threadId });
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

  async startTurn(
    threadId: string,
    input: InputItem[],
    options: {
      model?: string | null;
      thinking?: ThinkingLevel | null;
      sandbox?: SandboxMode | null;
      approvalPolicy?: ApprovalPolicy | null;
      approvalsReviewer?: ApprovalsReviewer | null;
      collaborationMode?: CollaborationMode | null;
      reasoningSummary?: 'none' | 'auto' | 'concise' | 'detailed' | null;
      serviceTier?: 'fast' | 'flex' | null;
    } = {},
  ) {
    return this.request('turn/start', {
      threadId,
      input,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinking ? { effort: options.thinking } : {}),
      ...(options.sandbox ? { sandboxPolicy: toSandboxPolicy(options.sandbox) } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
      ...(options.collaborationMode ? { mode: options.collaborationMode } : {}),
      ...(options.reasoningSummary ? { summary: options.reasoningSummary } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
    }) as Promise<{ turn: { id: string; status: string } }>;
  }

  async interruptTurn(threadId: string, turnId: string) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async respond(id: number | string, result: unknown) {
    await this.ensureStarted();
    this.send({ jsonrpc: '2.0', id, result });
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
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
    this.process = null;
    this.startPromise = null;
  }
}
