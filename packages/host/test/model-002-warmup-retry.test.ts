// Coverage for traceability row:
//   MODEL-002 — Capability warmup must not permanently cache an empty
//               model list. A first probe that returns `models: []`
//               (binary missing, PATH wrong, codex appserver crash, …)
//               must be retryable so a host fix-up heals itself without
//               a daemon restart.
//
// Drives SessionManager.warmCapabilities with a fake proxy that returns
// `models: []` the first time and a populated list the second time.
// Asserts the second call doesn't see the empty cached value AND that
// `proxy.dispose` was invoked so the next call really spawns a fresh
// runtime instead of re-asking a stuck one.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyCatalog, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

// ---------------------------------------------------------------------------
// Fake proxy whose `capabilities()` is scripted per-instance.
// ---------------------------------------------------------------------------

interface ScriptedProxyClient extends ProxyClient {
  capsScript: ProxyCatalog[];
  callCount: number;
}

function modelCatalog(models: Array<{ id: string; displayName: string }>): ProxyCatalog {
  return {
    catalogRevision: models.length > 0 ? 'populated' : 'empty',
    input: [{ type: 'text' }],
    configOptions: models.length > 0 ? [{
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: false,
      defaultValue: models[0]!.id,
      choices: models.map((model) => ({ value: model.id, displayName: model.displayName })),
    }] : [],
    slashCommands: [],
  };
}

function makeClient(executor: 'claude' | 'codex'): ScriptedProxyClient {
  const client: ScriptedProxyClient = {
    executor,
    capsScript: [],
    callCount: 0,
    isExited() { return false; },
    async initialize() {
      return {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: { id: executor, name: executor, version: '0.2.0' },
        process: { scope: executor === 'codex' ? 'shared' : 'session' },
        capabilities: {},
      };
    },
    async catalog() {
      client.callCount += 1;
      return client.capsScript.shift() ?? modelCatalog([]);
    },
    async createSession(params) {
      const id = params.nativeSessionId ?? `proxy_${randomUUID()}`;
      return {
        session: {
          id, cwd: params.cwd,
          state: 'idle' as const,
          createdAt: '2026-05-17T00:00:00.000Z', updatedAt: '2026-05-17T00:00:00.000Z',
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
          id: 'p', cwd: '/tmp', state: 'running' as const,
          createdAt: '2026-05-17T00:00:00.000Z', updatedAt: '2026-05-17T00:00:00.000Z',
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

class FakeProxyManager {
  /** Each session/key gets its own client so we can drive `dispose` by
   *  tracking key creation. */
  clientByKey = new Map<string, ScriptedProxyClient>();
  disposedKeys: string[] = [];

  /** Per-executor scripts SHARED across recreates: a `dispose` followed
   *  by a fresh `getOrCreate` keeps consuming from the same array so a
   *  test can express "empty, then populated" across two probes that
   *  span a dispose. */
  scriptByExecutor = new Map<'claude' | 'codex', ProxyCatalog[]>();

  setScript(executor: 'claude' | 'codex', script: ProxyCatalog[]): void {
    this.scriptByExecutor.set(executor, [...script]);
  }

  async getOrCreate(key: string, executor: 'claude' | 'codex'): Promise<ProxyClient> {
    let client = this.clientByKey.get(key);
    if (!client) {
      client = makeClient(executor);
      // Bind the SHARED script — popping from it is what advances the
      // sequence even when the manager disposes + recreates clients.
      const script = this.scriptByExecutor.get(executor) ?? [];
      client.capsScript = script;
      this.clientByKey.set(key, client);
    }
    return client;
  }
  get(key: string): ProxyClient | undefined {
    return this.clientByKey.get(key);
  }
  async closeAll(): Promise<void> {}
  async dispose(key: string): Promise<void> {
    this.disposedKeys.push(key);
    this.clientByKey.delete(key);
  }
}

class CapturingBroadcaster {
  add() {} remove() {} send() {}
  broadcast(_msg: ServerToClientMessage): void {}
  get size() { return 0; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-model002-'));
  const db = openDatabase(dir);

  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals, queue, dir,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);
  return { dir, db, sessions, proxyMgr };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// MODEL-002 — empty model list must NOT be cached permanently
// ---------------------------------------------------------------------------

test('MODEL-002: warmCapabilities returns the populated list on first call (sanity)', async () => {
  const ctx = setup();
  try {
    ctx.proxyMgr.setScript('claude', [modelCatalog([{ id: 'claude-sonnet-4-5', displayName: 'Sonnet' }])]);

    const caps = await ctx.sessions.warmCapabilities('claude');
    assert.equal(caps.configOptions[0]?.choices?.length, 1, 'first call returns populated models');
    assert.equal(caps.configOptions[0]?.choices?.[0]?.value, 'claude-sonnet-4-5');

    const client = ctx.proxyMgr.get('__caps__claude') as ScriptedProxyClient;
    assert.equal(client.callCount, 1);
    const cached = await ctx.sessions.warmCapabilities('claude');
    assert.equal(cached.configOptions[0]?.choices?.length, 1);
    assert.equal(client.callCount, 1,
      'populated cache must short-circuit subsequent warmCapabilities calls');
  } finally {
    teardown(ctx);
  }
});

test('MODEL-002: empty model result on first call is NOT cached — second call re-probes', async () => {
  const ctx = setup();
  try {
    ctx.proxyMgr.setScript('claude', [
      modelCatalog([]),
      modelCatalog([{ id: 'claude-haiku-4-5', displayName: 'Haiku' }]),
    ]);

    const first = await ctx.sessions.warmCapabilities('claude');
    assert.equal(first.configOptions.some((option) => option.role === 'model'), false,
      'first call surfaces the empty result so the UI can show "no models"');

    const second = await ctx.sessions.warmCapabilities('claude');
    assert.equal(second.configOptions[0]?.choices?.length, 1,
      'second call must NOT return the cached empty result; it must re-probe the proxy');
    assert.equal(second.configOptions[0]?.choices?.[0]?.value, 'claude-haiku-4-5');
  } finally {
    teardown(ctx);
  }
});

test('MODEL-002: empty cache disposes the prior proxy client so the next call spawns a fresh runtime', async () => {
  const ctx = setup();
  try {
    ctx.proxyMgr.setScript('codex', [
      modelCatalog([]),
      modelCatalog([{ id: 'codex-default', displayName: 'GPT' }]),
    ]);

    await ctx.sessions.warmCapabilities('codex');
    assert.deepEqual(ctx.proxyMgr.disposedKeys, [],
      'first call (no prior cache) must NOT dispose anything');

    await ctx.sessions.warmCapabilities('codex');
    assert.deepEqual(ctx.proxyMgr.disposedKeys, ['__caps__codex'],
      'second call after an empty cache must dispose the prior temp client so the next probe runs on a fresh runtime');
  } finally {
    teardown(ctx);
  }
});

test('MODEL-002: empty -> empty -> populated still recovers (chained retries)', async () => {
  const ctx = setup();
  try {
    ctx.proxyMgr.setScript('claude', [
      modelCatalog([]),
      modelCatalog([]),
      modelCatalog([{ id: 'late', displayName: 'Late' }]),
    ]);

    const a = await ctx.sessions.warmCapabilities('claude');
    assert.equal(a.configOptions.some((option) => option.role === 'model'), false);
    const b = await ctx.sessions.warmCapabilities('claude');
    assert.equal(b.configOptions.some((option) => option.role === 'model'), false);
    const c = await ctx.sessions.warmCapabilities('claude');
    assert.equal(c.configOptions[0]?.choices?.length, 1,
      'the third probe must return the recovered model list — empty cache never sticks');

    assert.equal(ctx.proxyMgr.disposedKeys.filter(k => k === '__caps__claude').length, 2,
      'two empty-cache hits → two dispose calls; populated success does not dispose');
  } finally {
    teardown(ctx);
  }
});

test('MODEL-002: warmup is keyed per-executor — empty claude cache does not affect codex', async () => {
  const ctx = setup();
  try {
    ctx.proxyMgr.setScript('claude', [modelCatalog([])]);
    ctx.proxyMgr.setScript('codex', [
      modelCatalog([{ id: 'codex-ok', displayName: 'Codex' }]),
    ]);

    const claude = await ctx.sessions.warmCapabilities('claude');
    assert.equal(claude.configOptions.some((option) => option.role === 'model'), false,
      'claude probe was empty');

    const codex = await ctx.sessions.warmCapabilities('codex');
    assert.equal(codex.configOptions[0]?.choices?.length, 1,
      'codex probe is a separate key and gets a fresh client + non-empty result');

    assert.equal(ctx.proxyMgr.disposedKeys.filter(k => k === '__caps__codex').length, 0,
      'codex never had an empty cache → never disposed');
  } finally {
    teardown(ctx);
  }
});
