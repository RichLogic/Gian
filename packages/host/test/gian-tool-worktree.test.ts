import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/storage/config.js';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Gian Test',
      GIT_AUTHOR_EMAIL: 'gian-test@example.invalid',
      GIT_COMMITTER_NAME: 'Gian Test',
      GIT_COMMITTER_EMAIL: 'gian-test@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function seedRepository(ctx: TestAppCtx): { repo: string; sessionId: string } {
  const repo = join(ctx.dataDir, 'Project');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '--initial-branch', 'main']);
  git(repo, ['config', 'core.hooksPath', '/dev/null']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), '# worktree fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  const sessionId = 'session-worktree-tool';
  ctx.db.prepare(
    `INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
     VALUES ('workspace-worktree-tool', 'Project', ?, 0, 0, datetime('now'), datetime('now'))`,
  ).run(repo);
  ctx.db.prepare(
    `INSERT INTO sessions
      (id, name, type, workspace_id, executor, agent_id, approval_mode,
       status, archived, unread, native_session_id, created_at, updated_at)
     VALUES (?, 'Worktree Tool', 'coding', 'workspace-worktree-tool', 'codex',
             'agent-worktree-tool', 'ask', 'done', 0, 0, 'native-worktree-tool',
             datetime('now'), datetime('now'))`,
  ).run(sessionId);
  return { repo, sessionId };
}

function transport(ctx: TestAppCtx, token: string): StreamableHTTPClientTransport {
  const config = loadConfig(ctx.db);
  return new StreamableHTTPClientTransport(
    new URL(`http://${config.host}:${config.port}/internal/mcp`),
    {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => ctx.app.app.fetch(
        input instanceof Request ? new Request(input, init) : new Request(input, init),
      ),
    },
  );
}

test('internal MCP creates and opens one managed worktree idempotently without Session params', async () => {
  const ctx = await makeTestApp();
  const { repo, sessionId } = seedRepository(ctx);
  const issued = ctx.app.toolCredentials.issueInternalSession({
    sessionId,
    role: 'admin',
    ttlMs: 60_000,
  });
  const client = new Client({ name: 'gian-worktree-test', version: '1.0.0' });
  try {
    await client.connect(transport(ctx, issued.token));
    const listed = await client.listTools();
    const tool = listed.tools.find(candidate => candidate.name === 'worktree.create_and_bind');
    assert.ok(tool);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), [
      'base_ref',
      'branch',
      'idempotency_key',
    ]);

    const request = {
      name: 'worktree.create_and_bind',
      arguments: {
        branch: 'feat/managed-view',
        base_ref: 'HEAD',
        idempotency_key: 'worktree-managed-view-1',
      },
    } as const;
    const first = await client.callTool(request);
    assert.equal(first.isError, undefined);
    const data = first.structuredContent?.data as {
      session_id: string;
      working_tree_id: string;
      path: string;
      branch: string;
      created: boolean;
    };
    assert.equal(data.session_id, sessionId);
    assert.equal(data.branch, 'feat/managed-view');
    assert.equal(data.created, true);
    assert.equal(data.path, join(realpathSync(ctx.dataDir), 'worktrees', 'project-feat-managed-view'));
    assert.match(data.working_tree_id, /^ext:workspace-worktree-tool:/);
    assert.match(git(repo, ['worktree', 'list', '--porcelain']), new RegExp(data.path));
    const row = ctx.db.prepare(
      `SELECT detected_worktree_path, detected_worktree_source, detected_worktree_revision,
              worktree_path, native_session_id, status
       FROM sessions WHERE id = ?`,
    ).get(sessionId) as {
      detected_worktree_path: string;
      detected_worktree_source: string;
      detected_worktree_revision: number;
      worktree_path: string | null;
      native_session_id: string;
      status: string;
    };
    assert.deepEqual(row, {
      detected_worktree_path: data.path,
      detected_worktree_source: 'gian_tool',
      detected_worktree_revision: 1,
      worktree_path: null,
      native_session_id: 'native-worktree-tool',
      status: 'done',
    });

    const retried = await client.callTool(request);
    assert.deepEqual(retried.structuredContent?.data, first.structuredContent?.data);
    assert.equal((git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) ?? []).length, 2);

    const converged = await client.callTool({
      name: 'worktree.create_and_bind',
      arguments: {
        branch: 'feat/managed-view',
        base_ref: 'HEAD',
        idempotency_key: 'worktree-managed-view-reopen',
      },
    });
    assert.equal((converged.structuredContent?.data as { created: boolean }).created, false);
    assert.equal(
      (ctx.db.prepare('SELECT detected_worktree_revision FROM sessions WHERE id = ?')
        .get(sessionId) as { detected_worktree_revision: number }).detected_worktree_revision,
      2,
      'an explicit repeat reopens the same view without creating another checkout',
    );
    assert.equal((git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) ?? []).length, 2);

    const crafted = await client.callTool({
      name: 'worktree.create_and_bind',
      arguments: {
        session_id: 'another-session',
        branch: 'feat/crafted',
        idempotency_key: 'worktree-crafted-1',
      },
    });
    assert.equal(crafted.isError, true);
    assert.equal(
      (crafted.structuredContent as { error: { code: string } }).error.code,
      'INVALID_ARGUMENT',
    );
    const invalidBranch = await client.callTool({
      name: 'worktree.create_and_bind',
      arguments: {
        branch: 'bad..branch',
        idempotency_key: 'worktree-invalid-branch',
      },
    });
    assert.equal(invalidBranch.isError, true);
    assert.equal(
      (invalidBranch.structuredContent as { error: { code: string } }).error.code,
      'INVALID_ARGUMENT',
    );

    ctx.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(sessionId);
    const archived = await client.callTool({
      name: 'worktree.create_and_bind',
      arguments: {
        branch: 'feat/archived',
        idempotency_key: 'worktree-archived-session',
      },
    });
    assert.equal(archived.isError, true);
    assert.equal(
      (archived.structuredContent as { error: { code: string } }).error.code,
      'SESSION_CLOSED',
    );
  } finally {
    await client.close().catch(() => undefined);
    await ctx.cleanup();
  }
});

test('external credentials cannot discover or dispatch the internal self-context method', async () => {
  const ctx = await makeTestApp();
  seedRepository(ctx);
  const issued = ctx.app.toolCredentials.issueExternalController({
    clientId: 'external-worktree-test',
    role: 'admin',
    ttlMs: 60_000,
  });
  const client = new Client({ name: 'gian-external-worktree-test', version: '1.0.0' });
  try {
    await client.connect(transport(ctx, issued.token));
    const listed = await client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === 'worktree.create_and_bind'), false);
    const dispatcher = listed.tools.find(tool => tool.name === 'gian_call');
    assert.equal(
      (dispatcher?.inputSchema.properties?.method as { enum?: string[] }).enum
        ?.includes('worktree.create_and_bind'),
      false,
    );
    const crafted = await client.callTool({
      name: 'gian_call',
      arguments: {
        method: 'worktree.create_and_bind',
        params: { branch: 'feat/external' },
        idempotency_key: 'worktree-external-1',
      },
    });
    assert.equal(crafted.isError, true);
    assert.equal(
      (crafted.structuredContent as { error: { code: string } }).error.code,
      'PERMISSION_DENIED',
    );
  } finally {
    await client.close().catch(() => undefined);
    await ctx.cleanup();
  }
});

test('managed root symlinks fail closed before Git creates a checkout', async () => {
  const ctx = await makeTestApp();
  const { repo, sessionId } = seedRepository(ctx);
  const outside = join(ctx.dataDir, 'outside-worktrees');
  mkdirSync(outside);
  symlinkSync(outside, join(ctx.dataDir, 'worktrees'));
  const issued = ctx.app.toolCredentials.issueInternalSession({
    sessionId,
    role: 'admin',
    ttlMs: 60_000,
  });
  const client = new Client({ name: 'gian-symlink-worktree-test', version: '1.0.0' });
  try {
    await client.connect(transport(ctx, issued.token));
    const result = await client.callTool({
      name: 'worktree.create_and_bind',
      arguments: {
        branch: 'feat/symlink-root',
        idempotency_key: 'worktree-symlink-root',
      },
    });
    assert.equal(result.isError, true);
    assert.equal(
      (result.structuredContent as { error: { code: string } }).error.code,
      'CONFLICT',
    );
    assert.equal((git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) ?? []).length, 1);
  } finally {
    await client.close().catch(() => undefined);
    await ctx.cleanup();
  }
});
