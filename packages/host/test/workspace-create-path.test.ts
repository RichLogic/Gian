import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Workspace } from '@gian/shared';
import { saveConfig } from '../src/storage/config.js';
import { makeTestApp } from './fixtures/test-app.js';

test('ONBOARD-001 creates a new repository directly under the project root', async () => {
  const ctx = await makeTestApp();
  const projectRoot = await mkdtemp(join(tmpdir(), 'gian-project-root-'));
  try {
    saveConfig(ctx.db, { workspace_root: projectRoot });
    const response = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    });
    const body = await response.json() as { workspace?: Workspace; error?: string };

    assert.equal(response.status, 200, body.error);
    assert.equal(body.workspace?.path, join(await realpath(projectRoot), 'demo'));
    await access(join(projectRoot, 'demo', '.git'));
    await assert.rejects(access(join(projectRoot, 'workspaces')));
  } finally {
    await ctx.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
