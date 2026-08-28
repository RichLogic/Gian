import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/storage/config.js';
import { isLoopbackMcpHost } from '../src/tool/mcp-http.js';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { GianToolCredentialManager } from '../src/tool/credentials.js';

function seedSessions(ctx: TestAppCtx): void {
  ctx.db.exec(`
    INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
    INSERT INTO sessions
      (id, name, type, workspace_id, executor, agent_id, approval_mode,
       status, archived, unread, native_session_id, created_at, updated_at)
    VALUES
      ('session-1', 'One', 'primary', 'workspace-1', 'codex', 'agent-1', 'ask',
       'done', 0, 0, 'native-1', datetime('now'), datetime('now')),
      ('session-2', 'Two', 'primary', 'workspace-1', 'codex', 'agent-2', 'ask',
       'done', 0, 0, 'native-2', datetime('now'), datetime('now'));
  `);
}

function mcpTransport(ctx: TestAppCtx, token?: string): StreamableHTTPClientTransport {
  const config = loadConfig(ctx.db);
  const url = new URL(`http://${config.host}:${config.port}/internal/mcp`);
  return new StreamableHTTPClientTransport(url, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    fetch: async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);
      return ctx.app.app.fetch(request);
    },
  });
}

test('Host-listened MCP is available only on loopback bind addresses', () => {
  assert.equal(isLoopbackMcpHost('127.0.0.1'), true);
  assert.equal(isLoopbackMcpHost('127.10.20.30'), true);
  assert.equal(isLoopbackMcpHost('::1'), true);
  assert.equal(isLoopbackMcpHost('localhost'), true);
  assert.equal(isLoopbackMcpHost('0.0.0.0'), false);
  assert.equal(isLoopbackMcpHost('192.168.1.2'), false);
});

test('Host startup revokes prior internal attach generations but preserves external controllers', async () => {
  let internalToken = '';
  let externalToken = '';
  const ctx = await makeTestApp({
    beforeCreateApp: db => {
      db.exec(`
        INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
        VALUES ('workspace-restart', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
        INSERT INTO sessions
          (id, name, type, workspace_id, executor, agent_id, approval_mode,
           status, archived, unread, native_session_id, created_at, updated_at)
        VALUES
          ('session-restart', 'Restart', 'primary', 'workspace-restart', 'codex',
           'agent-restart', 'ask', 'done', 0, 0, 'native-restart', datetime('now'), datetime('now'));
      `);
      const credentials = new GianToolCredentialManager(db);
      internalToken = credentials.issueInternalSession({
        sessionId: 'session-restart',
        role: 'admin',
        ttlMs: 60_000,
        renewable: true,
      }).token;
      externalToken = credentials.issueExternalController({
        clientId: 'restart-external',
        role: 'admin',
        ttlMs: 60_000,
      }).token;
    },
  });
  try {
    assert.equal(ctx.app.toolCredentials.authenticate(`Bearer ${internalToken}`), null);
    assert.equal(ctx.app.toolCredentials.authenticate(`Bearer ${externalToken}`)?.kind, 'external_controller');
  } finally {
    await ctx.cleanup();
  }
});

test('Host-listened MCP authenticates, scopes tools, and dispatches canonical calls', async () => {
  const ctx = await makeTestApp();
  try {
    const issued = ctx.app.toolCredentials.issueExternalController({
      clientId: 'http-test',
      grants: ['task.list', 'session.get'],
      ttlMs: 60_000,
    });
    const client = new Client({ name: 'gian-http-test', version: '1.0.0' });
    await client.connect(mcpTransport(ctx, issued.token));
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map(tool => tool.name), [
        'task.list',
        'session.get',
        'gian_call',
      ]);
      const dispatcher = listed.tools.find(tool => tool.name === 'gian_call');
      assert.deepEqual(
        (dispatcher?.inputSchema.properties?.method as { enum?: string[] }).enum,
        ['session.get', 'task.list'],
      );

      const result = await client.callTool({ name: 'task.list', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent?.data, { tasks: [] });

      const hidden = await client.callTool({
        name: 'gian_call',
        arguments: { method: 'interaction.respond', params: {} },
      });
      assert.equal(hidden.isError, true);
      assert.equal(
        (hidden.structuredContent as { error: { code: string } }).error.code,
        'PERMISSION_DENIED',
      );
    } finally {
      await client.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test('Host-listened MCP keeps internal identity while allowing ordinary global reads', async () => {
  const ctx = await makeTestApp();
  try {
    seedSessions(ctx);
    const issued = ctx.app.toolCredentials.issueInternalSession({
      sessionId: 'session-1',
      grants: ['session.get', 'interaction.list'],
      ttlMs: 60_000,
    });
    const client = new Client({ name: 'gian-internal-test', version: '1.0.0' });
    await client.connect(mcpTransport(ctx, issued.token));
    try {
      const own = await client.callTool({
        name: 'session.get',
        arguments: { session_id: 'session-1' },
      });
      assert.equal(own.isError, undefined);

      const other = await client.callTool({
        name: 'session.get',
        arguments: { session_id: 'session-2' },
      });
      assert.equal(other.isError, undefined);

      const interactions = await client.callTool({ name: 'interaction.list', arguments: {} });
      assert.equal(interactions.isError, undefined);
      assert.deepEqual(interactions.structuredContent?.data, { interactions: [] });
    } finally {
      await client.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test('provisional Session credential supports MCP discovery and activates on the same connection', async () => {
  const ctx = await makeTestApp();
  try {
    ctx.db.exec(`
      INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
      VALUES ('workspace-provisional', 'Workspace', '/tmp/workspace', 0, 0, datetime('now'), datetime('now'));
    `);
    const issued = ctx.app.toolCredentials.issueProvisionalInternalSession({
      sessionId: 'session-provisional',
      agentId: 'agent-provisional',
      workspaceId: 'workspace-provisional',
      taskId: null,
      role: 'admin',
      ttlMs: 30 * 24 * 60 * 60 * 1_000,
    });
    const client = new Client({ name: 'gian-provisional-test', version: '1.0.0' });
    await client.connect(mcpTransport(ctx, issued.token));
    try {
      const listed = await client.listTools();
      assert.equal(listed.tools.some(tool => tool.name === 'task.create'), true);
      const denied = await client.callTool({ name: 'task.list', arguments: {} });
      assert.equal(denied.isError, true);
      assert.equal(
        (denied.structuredContent as { error: { code: string } }).error.code,
        'PERMISSION_DENIED',
      );

      ctx.db.prepare(
        `INSERT INTO sessions
          (id, name, type, workspace_id, executor, agent_id, approval_mode,
           status, archived, unread, native_session_id, created_at, updated_at)
         VALUES
          ('session-provisional', 'Pending', 'primary', 'workspace-provisional',
           'codex', 'agent-provisional', 'ask', 'new', 0, 0, 'native-provisional',
           datetime('now'), datetime('now'))`,
      ).run();
      ctx.app.toolCredentials.activateProvisionalInternalSession(issued.credentialId);
      const active = await client.callTool({ name: 'task.list', arguments: {} });
      assert.equal(active.isError, undefined);
    } finally {
      await client.close();
    }
  } finally {
    await ctx.cleanup();
  }
});

test('Host-listened MCP rejects missing, revoked, browser-origin, and wrong-host credentials', async () => {
  const ctx = await makeTestApp();
  try {
    const config = loadConfig(ctx.db);
    const url = `http://${config.host}:${config.port}/internal/mcp`;
    const missing = await ctx.app.app.fetch(new Request(url, { method: 'POST' }));
    assert.equal(missing.status, 401);
    const desktopOnly = await ctx.app.app.fetch(new Request(url, {
      method: 'POST',
      headers: { 'X-Gian-Desktop-Token': 'not-a-tool-capability' },
    }));
    assert.equal(desktopOnly.status, 401);

    const issued = ctx.app.toolCredentials.issueExternalController({
      clientId: 'revoked-test',
      grants: ['task.list'],
      ttlMs: 60_000,
    });
    ctx.app.toolCredentials.revoke(issued.credentialId);
    const revoked = await ctx.app.app.fetch(new Request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${issued.token}` },
    }));
    assert.equal(revoked.status, 401);

    const live = ctx.app.toolCredentials.issueExternalController({
      clientId: 'boundary-test',
      grants: ['task.list'],
      ttlMs: 60_000,
    });
    const browser = await ctx.app.app.fetch(new Request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${live.token}`,
        Origin: 'https://attacker.invalid',
      },
    }));
    assert.equal(browser.status, 403);

    const wrongHost = await ctx.app.app.fetch(new Request(
      `http://attacker.invalid:${config.port}/internal/mcp`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${live.token}` },
      },
    ));
    assert.equal(wrongHost.status, 421);

    const oversized = await ctx.app.app.fetch(new Request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${live.token}`,
        'Content-Type': 'application/json',
      },
      body: 'x'.repeat(1_048_577),
    }));
    assert.equal(oversized.status, 413);
  } finally {
    await ctx.cleanup();
  }
});

test('Host-listened MCP bounds concurrent waits', async () => {
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  let calls = 0;
  const ctx = await makeTestApp({
    toolMcpLimits: { waits: 1 },
    toolMcpBeforeCall: async method => {
      if (method !== 'session.wait' || calls++ > 0) return;
      firstEntered();
      await release;
    },
  });
  try {
    seedSessions(ctx);
    const issued = ctx.app.toolCredentials.issueExternalController({
      clientId: 'wait-limit-test',
      grants: ['session.wait'],
      ttlMs: 60_000,
    });
    const first = new Client({ name: 'gian-wait-1', version: '1.0.0' });
    const second = new Client({ name: 'gian-wait-2', version: '1.0.0' });
    await first.connect(mcpTransport(ctx, issued.token));
    await second.connect(mcpTransport(ctx, issued.token));
    try {
      const pending = first.callTool({
        name: 'session.wait',
        arguments: {
          session_id: 'session-1',
          until: ['turn_terminal'],
          timeout_ms: 0,
        },
      });
      await entered;
      const limited = await second.callTool({
        name: 'session.wait',
        arguments: {
          session_id: 'session-1',
          until: ['turn_terminal'],
          timeout_ms: 0,
        },
      });
      assert.equal(limited.isError, true);
      assert.equal(
        (limited.structuredContent as { error: { code: string } }).error.code,
        'CONFLICT',
      );
      releaseFirst();
      const completed = await pending;
      assert.equal(completed.isError, undefined);
      assert.equal(
        (completed.structuredContent as { data: { outcome: string } }).data.outcome,
        'idle',
      );
    } finally {
      await first.close();
      await second.close();
    }
  } finally {
    await ctx.cleanup();
  }
});
