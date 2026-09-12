// Coverage for traceability row:
//   ERR-011 — Native session adopt/delete must reject:
//             • missing native_id (400)
//             • unsupported executor (400)
//             • already-adopted native session (409)
//             • cross-workspace native sessions (404)
//             • delete of an adopted native session (409)
//
// Drives the real Hono app via `makeTestApp` (createApp with proxy
// warmup gated off). The native scanner is exercised by injecting
// `process.env.HOME` to point at a per-test home dir — the scanner reads
// `homedir()` internally, and the dynamic `import('../native/scanner.js')`
// inside the route picks it up the same way.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { ProxyCatalog, ServerToClientMessage } from '@gian/shared';
import { Hono } from 'hono';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { makeNativeHome, type NativeHome } from './fixtures/native-home.js';
import { clearNativeSessionsCache } from '../src/native/scanner.js';
import type { SessionManager } from '../src/session/manager.js';
import { NativeSessionService } from '../src/session/native-session-service.js';
import { SessionRepository } from '../src/session/repository.js';
import { registerNativeSessionRoutes } from '../src/web/routes/native-sessions.js';
import { registerProxyRoutes } from '../src/web/routes/proxy.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

interface NativeTestCtx {
  appCtx: TestAppCtx;
  home: NativeHome;
  workspaceId: string;
  workspacePath: string;
  prevHome: string | undefined;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<NativeTestCtx> {
  const appCtx = await makeTestApp();
  const home = makeNativeHome();
  // Point the scanner at the tmp home. The scanner re-reads homedir() each
  // call, so this is sufficient and a previous test's HOME never leaks in.
  const prevHome = process.env['HOME'];
  process.env['HOME'] = home.path;
  // Always start from a clean scanner cache so per-workspace caching across
  // tests can't bleed.
  clearNativeSessionsCache();

  const workspaceId = randomUUID();
  const workspacePath = '/Users/test-user/projects/native-demo';
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);

  return {
    appCtx,
    home,
    workspaceId,
    workspacePath,
    prevHome,
    cleanup: async () => {
      await appCtx.cleanup();
      home.cleanup();
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      clearNativeSessionsCache();
    },
  };
}

async function adoptBody(ctx: NativeTestCtx, body: Record<string, unknown>) {
  return ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/native-sessions/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Adopt — input validation
// ---------------------------------------------------------------------------

test('ERR-011: adopt rejects unsupported executor with 400', async () => {
  const ctx = await setup();
  try {
    const res = await adoptBody(ctx, { executor: 'gemini', native_session_id: 'x' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /executor does not support native session adoption/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: grok adopt requires a discoverable native session', async () => {
  const ctx = await setup();
  try {
    const res = await adoptBody(ctx, { executor: 'grok', native_session_id: 'native-grok' });
    assert.ok(res.status === 400 || res.status === 404);
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
    assert.doesNotMatch(body.error, /not available yet/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: canonical official pluginId reaches the bounded legacy native adapter', async () => {
  const ctx = await setup();
  try {
    const res = await adoptBody(ctx, {
      executor: 'com.zhipu.zcode',
      native_session_id: 'missing-zcode-session',
    });
    const body = await res.json() as { error: string };
    assert.doesNotMatch(body.error, /executor does not support native session adoption/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt rejects missing native_session_id with 400', async () => {
  const ctx = await setup();
  try {
    const res = await adoptBody(ctx, { executor: 'claude' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /native_session_id required/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt rejects unknown workspace with 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/does-not-exist/native-sessions/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executor: 'claude', native_session_id: 'x' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /workspace not found/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adopt — already-adopted + scan-miss
// ---------------------------------------------------------------------------

test('ERR-011: adopt rejects a native session that is already adopted with 409 and points at the existing gian session', async () => {
  const ctx = await setup();
  try {
    // Pre-existing adoption: insert a session bound to nativeId 'taken'.
    const existing = randomUUID();
    const now = new Date().toISOString();
    ctx.appCtx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'already-bound', 'coding', ?, 'claude', NULL, 'ask',
              'web', 'new', 0, 'taken', ?, ?)
    `).run(existing, ctx.workspaceId, now, now);

    const res = await adoptBody(ctx, { executor: 'claude', native_session_id: 'taken' });
    assert.equal(res.status, 409);
    const body = await res.json() as { error: string; gian_session_id: string };
    assert.match(body.error, /Already adopted/);
    assert.equal(body.gian_session_id, existing,
      '409 body must point at the existing gian session id so the UI can navigate to it');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt of a native session that does not exist on disk returns 404 (scan miss)', async () => {
  const ctx = await setup();
  try {
    // Home has no .claude/projects/<encoded>/<id>.jsonl for the workspace.
    const res = await adoptBody(ctx, { executor: 'claude', native_session_id: 'ghost' });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /native session not found/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt of a native session that exists for a DIFFERENT workspace returns 404 (cross-workspace boundary)', async () => {
  const ctx = await setup();
  try {
    // Plant a cc session under a different workspace's encoded dir.
    ctx.home.addClaudeSession({
      workspacePath: '/Users/test-user/projects/other-repo',
      sessionId: 'belongs-elsewhere',
    });

    const res = await adoptBody(ctx, {
      executor: 'claude',
      native_session_id: 'belongs-elsewhere',
    });
    assert.equal(res.status, 404,
      'cross-workspace adoption MUST 404 — adopting another workspace\'s native session is a security boundary violation');
    const body = await res.json() as { error: string };
    assert.match(body.error, /native session not found in this workspace/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adopt — exact binding boundary
// ---------------------------------------------------------------------------

test('ERR-011: a scanned native session is not published when adoption cannot establish a binding', async () => {
  const ctx = await setup();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-adoptable',
    });
    const res = await adoptBody(ctx, {
      executor: 'claude',
      native_session_id: sid,
      name: 'Test adopted',
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.ok(body.error.length > 0);
    const row = ctx.appCtx.db.prepare(
      'SELECT id FROM sessions WHERE native_session_id = ?',
    ).get(sid);
    assert.equal(row, undefined, 'an Agent-less fallback must not publish an unbound Session');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: concurrent Agent-less adopts both fail without publishing a Session', async () => {
  const ctx = await setup();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-concurrent-adopt',
    });
    const [first, second] = await Promise.all([
      adoptBody(ctx, { executor: 'claude', native_session_id: sid }),
      adoptBody(ctx, { executor: 'claude', native_session_id: sid }),
    ]);

    assert.deepEqual([first.status, second.status], [400, 400]);
    const rows = ctx.appCtx.db.prepare(
      'SELECT id FROM sessions WHERE executor = ? AND native_session_id = ?',
    ).all('claude', sid);
    assert.equal(rows.length, 0, 'the database must contain no unbound adoption after the race');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: native adopt delegates publication to the exact-binding service', async () => {
  const ctx = await setup();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-origin-adoptable',
    });
    const messages: ServerToClientMessage[] = [];
    const repository = new SessionRepository(ctx.appCtx.db);
    const routeApp = new Hono();
    registerNativeSessionRoutes(routeApp, {
      db: ctx.appCtx.db,
      sessions: {
        listPluginNativeSessions: async () => null,
        adoptPluginNativeSession: async (input: {
          nativeSessionId: string;
          name?: string;
        }) => {
          const id = randomUUID();
          const now = new Date().toISOString();
          ctx.appCtx.db.prepare(`
            INSERT INTO sessions
              (id, name, type, workspace_id, executor, proxy_plugin_id, proxy_binding_json,
               model, approval_mode, active_channel, status, archived,
               native_session_id, created_at, updated_at)
            VALUES (?, ?, 'coding', ?, 'claude', 'claude', ?, NULL, 'ask',
                    'web', 'new', 0, ?, ?, ?)
          `).run(
            id,
            input.name ?? 'adopted',
            ctx.workspaceId,
            JSON.stringify({
              schemaVersion: 1,
              pluginId: 'claude',
              pluginVersion: '1.0.0',
              manifestSha256: 'a'.repeat(64),
              protocolVersion: '2.2',
              processScope: 'session',
              runtimeProfile: null,
            }),
            input.nativeSessionId,
            now,
            now,
          );
          const session = repository.get(id);
          messages.push({ type: 'session:created', session, origin: 'native-adopt' });
          return { session, replay: { turns: 0, events: 0 } };
        },
      } as unknown as SessionManager,
      broadcaster: {
        broadcast: (message: ServerToClientMessage) => messages.push(message),
      } as unknown as WsBroadcaster,
    });

    const res = await routeApp.fetch(new Request(
      `http://test.invalid/api/workspaces/${ctx.workspaceId}/native-sessions/adopt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executor: 'claude', native_session_id: sid }),
      },
    ));
    assert.equal(res.status, 200);
    const body = await res.json() as { session: { proxy_binding: unknown } };
    assert.ok(body.session.proxy_binding, 'the service published an exact Proxy binding');
    const created = messages.find(message => message.type === 'session:created');
    assert.equal(created?.origin, 'native-adopt');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Delete — error paths
// ---------------------------------------------------------------------------

async function deleteNative(
  ctx: NativeTestCtx,
  executor: string,
  nativeId: string,
) {
  return ctx.appCtx.fetch(
    `/api/workspaces/${ctx.workspaceId}/native-sessions/${nativeId}?executor=${executor}`,
    { method: 'DELETE' },
  );
}

test('ERR-011: grok native-session delete uses capability-gated plugin deletion', async () => {
  const ctx = await setup();
  try {
    const res = await deleteNative(ctx, 'grok', 'native-grok');
    assert.ok(res.status === 400 || res.status === 404);
    const body = await res.json() as { error: string };
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
    assert.doesNotMatch(body.error, /not available yet/);
  } finally {
    await ctx.cleanup();
  }
});

test('Grok native-session listing uses the plugin list capability', async () => {
  let created = false;
  const service = new NativeSessionService(
    {} as never,
    {
      usesProtocolV1: () => true,
      getOrCreate: async () => {
        created = true;
        return {
          protocolV1: true,
          initialize: async () => ({}),
          listNativeSessions: async () => ({ sessions: [] }),
        };
      },
      dispose: async () => undefined,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const listed = await service.listPlugin('grok', '/tmp');
  assert.equal(created, true);
  assert.deepEqual(listed, []);
});

test('native-session listing canonicalizes legacy aliases before the Web contract', async () => {
  const service = new NativeSessionService(
    {} as never,
    {
      getOrCreate: async () => ({
        initialize: async () => ({ capabilities: { 'session.native.list': 1 } }),
        listNativeSessions: async () => ({
          sessions: [{
            id: 'native-zcode',
            displayName: 'ZCode session',
            cwd: '/tmp/workspace',
            updatedAt: '2026-09-04T00:00:00.000Z',
          }],
        }),
      }),
      dispose: async () => undefined,
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const listed = await service.listPlugin('zcode', '/tmp/workspace');
  assert.equal(listed?.[0]?.executor, 'com.zhipu.zcode');
});

test('ERR-011: delete rejects unsupported executor query param with 400', async () => {
  const ctx = await setup();
  try {
    const res = await deleteNative(ctx, 'gemini', 'whatever');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /executor does not support native session surfaces/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: delete rejects an adopted native session with 409 and points at the gian session', async () => {
  const ctx = await setup();
  try {
    // Plant a native file and an already-adopted Gian row.
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-bound',
    });
    const gianSessionId = randomUUID();
    const now = new Date().toISOString();
    ctx.appCtx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, proxy_plugin_id, model, approval_mode,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'already adopted', 'coding', ?, 'claude', 'claude', NULL, 'ask',
              'web', 'new', 0, ?, ?, ?)
    `).run(gianSessionId, ctx.workspaceId, sid, now, now);

    const delRes = await deleteNative(ctx, 'claude', sid);
    assert.equal(delRes.status, 409,
      'deleting an adopted native session must 409 — user has to drop the gian session first');
    const body = await delRes.json() as { error: string; gian_session_id: string };
    assert.match(body.error, /currently adopted/);
    assert.equal(body.gian_session_id, gianSessionId);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: delete of a non-existent native session in this workspace returns 404', async () => {
  const ctx = await setup();
  try {
    const res = await deleteNative(ctx, 'claude', 'ghost-id');
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /native session not found/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: delete of a native session in a different workspace returns 404 (cross-workspace boundary)', async () => {
  const ctx = await setup();
  try {
    ctx.home.addClaudeSession({
      workspacePath: '/Users/test-user/projects/another-repo',
      sessionId: 'cross-leak',
    });
    const res = await deleteNative(ctx, 'claude', 'cross-leak');
    assert.equal(res.status, 404,
      'cross-workspace delete must NOT succeed — security boundary mirrors adopt');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: concurrent deletes of one native session yield one deletion and one clean miss', async () => {
  const ctx = await setup();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-concurrent-delete',
    });
    const [first, second] = await Promise.all([
      deleteNative(ctx, 'claude', sid),
      deleteNative(ctx, 'claude', sid),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 404],
      'serialized deletion must not turn the loser into unlink ENOENT/500');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: concurrent adopt/delete resolves to one complete outcome without split-brain state', async () => {
  const ctx = await setup();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-adopt-delete-race',
    });
    const adopt = adoptBody(ctx, { executor: 'claude', native_session_id: sid });
    const remove = deleteNative(ctx, 'claude', sid);
    const [adoptResult, deleteResult] = await Promise.all([adopt, remove]);

    const statuses = [adoptResult.status, deleteResult.status];
    assert.ok(
      statuses[0] === 200 && statuses[1] === 409
      || statuses[0] === 404 && statuses[1] === 200,
      `race must resolve as adopt-wins or delete-wins, got ${statuses.join('/')}`,
    );
    const listed = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/native-sessions`,
    );
    const body = await listed.json() as {
      sessions: Array<{ id: string; adoptedBy?: { gianSessionId: string } }>;
    };
    const listedSession = body.sessions.find(session => session.id === sid);
    if (adoptResult.status === 200) {
      assert.ok(listedSession?.adoptedBy,
        'adopt-wins must preserve and link the native source');
    } else {
      assert.equal(listedSession, undefined,
        'delete-wins must leave no native source that could become a ghost adoption');
      const rows = ctx.appCtx.db.prepare(
        'SELECT id FROM sessions WHERE executor = ? AND native_session_id = ?',
      ).all('claude', sid);
      assert.equal(rows.length, 0, 'delete-wins must not leave a Gian binding');
    }
  } finally {
    await ctx.cleanup();
  }
});

test('DSH capabilities route returns its Protocol 2 Catalog and unknown executors stay 400', async () => {
  const catalog: ProxyCatalog = {
    catalogRevision: 'dsh-route-v2',
    input: [{ type: 'text' }],
    configOptions: [{
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: true,
      defaultValue: 'deepseek-chat',
      choices: [{ value: 'deepseek-chat', displayName: 'DeepSeek Chat' }],
    }],
    slashCommands: [],
  };
  const app = new Hono();
  const sessions = {
    warmCapabilities: async (executor: string) => {
      assert.equal(executor, 'ai.deepseek.harness');
      return catalog;
    },
    getProtocolCapabilities: () => ({ 'catalog.resolve': 1 }),
  } as unknown as SessionManager;
  registerProxyRoutes(app, {} as never, sessions);

  const response = await app.request('/api/proxy/dsh/capabilities');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...catalog,
    capabilities: { 'catalog.resolve': 1 },
  });

  const unknown = await app.request('/api/proxy/other/capabilities');
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'invalid pluginId' });
});

test('catalog.resolve derives the owning Agent path from an existing Session', async () => {
  const app = new Hono();
  const observedPaths: Array<string | null | undefined> = [];
  const db = {
    prepare: () => ({
      get: (sessionId: string) => sessionId === 'session-zcode'
        ? {
            executor: 'zcode',
            proxy_plugin_id: 'com.zhipu.zcode',
            agent_id: 'agent-zcode',
          }
        : undefined,
    }),
  };
  const sessions = {
    warmCapabilities: async (_executor: string, cliPath?: string | null) => {
      observedPaths.push(cliPath);
      return { configOptions: [], input: [], slashCommands: [] };
    },
    getProtocolCapabilities: (_executor: string, cliPath?: string | null) => (
      cliPath === '/Applications/ZCode.app/zcode.cjs' ? { 'catalog.resolve': 1 } : {}
    ),
    resolveCatalog: async (
      _executor: string,
      params: Record<string, unknown>,
      sessionId?: string,
      cliPath?: string | null,
    ) => ({ ...params, sessionId, cliPath }),
  } as unknown as SessionManager;
  registerProxyRoutes(
    app,
    db as never,
    sessions,
    agentId => {
      assert.equal(agentId, 'agent-zcode');
      return {
        pluginId: 'com.zhipu.zcode',
        cliPath: '/Applications/ZCode.app/zcode.cjs',
      };
    },
  );

  const response = await app.request('/api/proxy/zcode/catalog/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      catalogRevision: 'zcode-revision',
      sessionConfig: {},
      turnConfig: { thinking: 'high' },
      sessionId: 'session-zcode',
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(observedPaths, ['/Applications/ZCode.app/zcode.cjs']);
  assert.deepEqual(await response.json(), {
    catalogRevision: 'zcode-revision',
    sessionConfig: {},
    turnConfig: { thinking: 'high' },
    sessionId: 'session-zcode',
    cliPath: '/Applications/ZCode.app/zcode.cjs',
  });
});
