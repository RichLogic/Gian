import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyCatalog, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

const CLI = '/bin/claude';
const HOME_A = '/tmp/gian-catalog-home-a';
const HOME_B = '/tmp/gian-catalog-home-b';

function modelCatalog(modelId: string): ProxyCatalog {
  return {
    catalogRevision: modelId,
    input: [{ type: 'text' }],
    configOptions: [{
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: false,
      defaultValue: modelId,
      choices: [{ value: modelId, displayName: modelId }],
    }],
    slashCommands: [],
  };
}

function makeClient(executor: 'claude' | 'codex', modelId: string): ProxyClient & { callCount: number } {
  const client = {
    executor,
    callCount: 0,
    isExited() { return false; },
    async initialize() {
      return {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: { id: executor, name: executor, version: '0.2.0' },
        process: { scope: 'session' as const },
        capabilities: {},
      };
    },
    async catalog() {
      client.callCount += 1;
      return modelCatalog(modelId);
    },
    async createSession(params: { cwd: string; nativeSessionId?: string }) {
      const id = params.nativeSessionId ?? `proxy_${randomUUID()}`;
      return {
        session: {
          id,
          cwd: params.cwd,
          state: 'idle' as const,
          createdAt: '2026-05-17T00:00:00.000Z',
          updatedAt: '2026-05-17T00:00:00.000Z',
          lastError: null,
        },
        nativeSessionId: id,
      };
    },
    async interruptTurn() {},
    async respondInteraction() {},
    async startTurn() {
      return {
        session: {
          id: 'p',
          cwd: '/tmp',
          state: 'running' as const,
          createdAt: '2026-05-17T00:00:00.000Z',
          updatedAt: '2026-05-17T00:00:00.000Z',
          lastError: null,
        },
        turn: { id: 't' },
      };
    },
    async closeSession() {},
    async shutdown() {},
    forceKill() {},
    onNotification(_handler: NotificationHandler) { return () => {}; },
    onExit() { return () => {}; },
  };
  return client;
}

interface ProbeCall {
  key: string;
  env?: Readonly<Record<string, string>>;
}

class HomeKeyedProxy {
  readonly calls: ProbeCall[] = [];
  private readonly clients = new Map<string, ReturnType<typeof makeClient>>();

  async getOrCreate(
    key: string,
    executor: 'claude' | 'codex',
    options?: { env?: Readonly<Record<string, string>> },
  ): Promise<ProxyClient> {
    this.calls.push({ key, ...(options?.env ? { env: options.env } : {}) });
    let client = this.clients.get(key);
    if (!client) {
      const home = options?.env?.CLAUDE_CONFIG_DIR ?? 'default';
      client = makeClient(executor, `model-${home}`);
      this.clients.set(key, client);
    }
    return client;
  }

  get(): undefined { return undefined; }
  async closeAll(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-catalog-home-'));
  const db = openDatabase(dir);
  const proxy = new HomeKeyedProxy();
  const broadcaster = {
    add() {},
    remove() {},
    send() {},
    broadcast(_message: ServerToClientMessage) {},
    get size() { return 0; },
  };
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(broadcaster as unknown as WsBroadcaster),
    new QueueManager(db),
    dir,
  );
  return { dir, db, sessions, proxy };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

function modelId(catalog: ProxyCatalog): string {
  return String(catalog.configOptions[0]?.choices?.[0]?.value);
}

test('warmCapabilities isolates catalogs for the same CLI under different homes', async () => {
  const ctx = setup();
  try {
    const homeA = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);
    const homeB = await ctx.sessions.warmCapabilities('claude', CLI, HOME_B);
    const again = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);

    assert.equal(modelId(homeA), `model-${HOME_A}`);
    assert.equal(modelId(homeB), `model-${HOME_B}`);
    assert.equal(modelId(again), modelId(homeA));
    assert.equal(
      modelId(ctx.sessions.getCapabilities('claude', CLI, HOME_A)!),
      modelId(homeA),
    );
    assert.equal(ctx.sessions.getCapabilities('claude', CLI), null);

    assert.deepEqual(ctx.proxy.calls.map(call => call.key), [
      `__caps__claude${CLI}\u0000${HOME_A}`,
      `__caps__claude${CLI}\u0000${HOME_B}`,
    ]);
    assert.deepEqual(ctx.proxy.calls[0]?.env, {
      GIAN_AGENT_HOME: HOME_A,
      CLAUDE_CONFIG_DIR: HOME_A,
    });
    assert.deepEqual(ctx.proxy.calls[1]?.env, {
      GIAN_AGENT_HOME: HOME_B,
      CLAUDE_CONFIG_DIR: HOME_B,
    });
  } finally {
    teardown(ctx);
  }
});

test('warmCapabilities without a home keeps the executor probe key and shares one process', async () => {
  const ctx = setup();
  try {
    const first = await ctx.sessions.warmCapabilities('claude');
    const second = await ctx.sessions.warmCapabilities('claude');
    assert.equal(modelId(first), 'model-default');
    assert.equal(modelId(second), 'model-default');
    assert.deepEqual(ctx.proxy.calls, [{ key: '__caps__claude' }]);
  } finally {
    teardown(ctx);
  }
});
