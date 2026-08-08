import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Workspace } from '@gian/shared';
import { saveConfig } from '../src/storage/config.js';
import { isFilesystemRoot } from '../src/web/routes/workspaces.js';
import { canonicalWorkspacePath } from '../src/workspace/path-reservation.js';
import { makeTestApp } from './fixtures/test-app.js';

async function directorySnapshot(path: string): Promise<Record<string, string>> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    const parent = entry.parentPath.slice(path.length).replace(/^\//, '');
    const rel = parent ? `${parent}/${entry.name}` : entry.name;
    snapshot[`${entry.isDirectory() ? 'dir' : 'file'}:${rel}`] = entry.isFile()
      ? await readFile(join(entry.parentPath, entry.name), 'utf8')
      : '';
  }
  return snapshot;
}

test('SPACE-002: adopt registers an existing directory without modifying any user file', async () => {
  const ctx = await makeTestApp();
  const projectRoot = await mkdtemp(join(tmpdir(), 'gian-adopt-readonly-'));
  const configuredRoot = await mkdtemp(join(tmpdir(), 'gian-adopt-config-root-'));
  try {
    await mkdir(join(projectRoot, 'src'));
    await writeFile(join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n');
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# user-owned\n');
    await writeFile(join(projectRoot, '.gitignore'), 'dist/\n');
    const before = await directorySnapshot(projectRoot);
    const canonicalProjectRoot = await realpath(projectRoot);
    saveConfig(ctx.db, { workspace_root: configuredRoot });

    const response = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'adopted-project', path: projectRoot }),
    });
    const body = await response.json() as { workspace?: Workspace; error?: string; notes?: string[] };

    assert.equal(response.status, 200, body.error);
    assert.equal(body.workspace?.path, canonicalProjectRoot);
    assert.deepEqual(body.notes, [`adopted existing path: ${canonicalProjectRoot}`]);
    assert.deepEqual(await directorySnapshot(projectRoot), before);
    assert.deepEqual(
      ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(body.workspace!.id),
      { path: canonicalProjectRoot },
    );
  } finally {
    await ctx.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(configuredRoot, { recursive: true, force: true });
  }
});

test('SPACE-002: real path and symlink aliases share one canonical workspace identity', async () => {
  const ctx = await makeTestApp();
  const base = await mkdtemp(join(tmpdir(), 'gian-adopt-alias-'));
  const projectRoot = join(base, 'project');
  const alias = join(base, 'project-alias');
  try {
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, 'notes.txt'), 'unchanged\n');
    await symlink(projectRoot, alias, 'dir');
    const canonicalProjectRoot = await realpath(projectRoot);

    const first = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'canonical-project', path: projectRoot }),
    });
    assert.equal(first.status, 200);
    const created = await first.json() as { workspace: Workspace };
    assert.equal(created.workspace.path, canonicalProjectRoot);

    const duplicate = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'aliased-project', path: alias }),
    });
    const failure = await duplicate.json() as { error: string };
    assert.equal(duplicate.status, 409);
    assert.match(failure.error, /already a workspace/);
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
      1,
    );
    assert.equal(await readFile(join(projectRoot, 'notes.txt'), 'utf8'), 'unchanged\n');
  } finally {
    await ctx.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});

test('SPACE-002: duplicate adopt is rejected and remains read-only', async () => {
  const ctx = await makeTestApp();
  const projectRoot = await mkdtemp(join(tmpdir(), 'gian-adopt-duplicate-'));
  try {
    await writeFile(join(projectRoot, 'notes.txt'), 'unchanged\n');
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(randomUUID(), 'existing', projectRoot);
    const before = await directorySnapshot(projectRoot);

    const response = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'duplicate', path: projectRoot }),
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 409);
    assert.match(body.error, /already a workspace/);
    assert.deepEqual(await directorySnapshot(projectRoot), before);
  } finally {
    await ctx.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('SPACE-002: configured project root and filesystem roots are rejected', async () => {
  const ctx = await makeTestApp();
  const configuredRoot = await mkdtemp(join(tmpdir(), 'gian-adopt-root-'));
  try {
    const filesystemRootAlias = join(configuredRoot, 'filesystem-root-alias');
    await symlink('/', filesystemRootAlias, 'dir');
    saveConfig(ctx.db, { workspace_root: configuredRoot });
    for (const [name, path] of [
      ['configured-root', configuredRoot],
      ['filesystem-root', '/'],
      ['filesystem-root-alias', filesystemRootAlias],
    ]) {
      const response = await ctx.fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, path }),
      });
      const body = await response.json() as { error: string };
      assert.equal(response.status, 400);
      assert.match(body.error, /cannot adopt/);
    }
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
      0,
    );
  } finally {
    await ctx.cleanup();
    await rm(configuredRoot, { recursive: true, force: true });
  }
});

test('SPACE-002: filesystem-root detection covers POSIX, drive and UNC roots', () => {
  for (const root of [
    '/',
    '//',
    'C:\\',
    'C:/',
    '\\\\server\\share',
    '\\\\server\\share\\',
    '\\\\?\\C:\\',
    '\\\\?\\UNC\\server\\share\\',
  ]) {
    assert.equal(isFilesystemRoot(root), true, `${root} must be classified as a filesystem root`);
  }
  for (const project of [
    '/tmp/project',
    'C:\\repo',
    '\\\\server\\share\\repo',
    '\\\\?\\C:\\repo',
    '\\\\?\\UNC\\server\\share\\repo',
  ]) {
    assert.equal(isFilesystemRoot(project), false, `${project} must remain adoptable`);
  }
});

test('SPACE-002: canonical path resolution fails closed on a symlink loop', async () => {
  const base = await mkdtemp(join(tmpdir(), 'gian-adopt-loop-'));
  const left = join(base, 'left');
  const right = join(base, 'right');
  try {
    await symlink(right, left);
    await symlink(left, right);
    await assert.rejects(
      canonicalWorkspacePath(left),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'ELOOP');
        return true;
      },
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('SPACE-003: rename and reorder update the canonical database ordering', async () => {
  const ctx = await makeTestApp();
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    ids.forEach((id, index) => {
      ctx.db.prepare('INSERT INTO workspaces (id, name, path, sort_order) VALUES (?, ?, ?, ?)')
        .run(id, `ws-${index}`, `/tmp/ws-${index}-${id}`, index);
    });

    const rename = await ctx.fetch(`/api/workspaces/${ids[1]}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    assert.equal(rename.status, 200);
    assert.equal(
      (ctx.db.prepare('SELECT name FROM workspaces WHERE id = ?').get(ids[1]) as { name: string }).name,
      'renamed',
    );

    const order = [ids[2]!, ids[0]!, ids[1]!];
    const reorder = await ctx.fetch('/api/workspaces/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: order }),
    });
    assert.equal(reorder.status, 200);
    const rows = ctx.db.prepare('SELECT id FROM workspaces ORDER BY sort_order, name').all() as Array<{ id: string }>;
    assert.deepEqual(rows.map(row => row.id), order);
  } finally {
    await ctx.cleanup();
  }
});

test('SPACE-004: CLAUDE.md reads and saves, while real read failures stay errors', async () => {
  const ctx = await makeTestApp();
  const projectRoot = await mkdtemp(join(tmpdir(), 'gian-notes-'));
  const workspaceId = randomUUID();
  try {
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# original\n');
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(workspaceId, 'notes', projectRoot);

    let response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { content: '# original\n' });

    response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# saved\n' }),
    });
    assert.equal(response.status, 200);
    assert.equal(await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8'), '# saved\n');
    assert.equal(
      (await readdir(projectRoot)).some(name => name.startsWith('.CLAUDE.md.gian-')),
      false,
      'an atomic save must not leave its same-directory staging file behind',
    );

    await rm(join(projectRoot, 'CLAUDE.md'));
    await mkdir(join(projectRoot, 'CLAUDE.md'));
    response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`);
    const failure = await response.json() as { error?: string; content?: string };
    assert.equal(response.status, 500);
    assert.equal(failure.content, undefined, 'a failed read must not be represented as empty notes');
    assert.match(failure.error ?? '', /EISDIR|directory/i);

    await rm(projectRoot, { recursive: true, force: true });
    response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`);
    const missingWorkspace = await response.json() as { error?: string; content?: string };
    assert.equal(response.status, 500);
    assert.equal(missingWorkspace.content, undefined,
      'a missing workspace directory must not look like a new empty CLAUDE.md');
    assert.match(missingWorkspace.error ?? '', /ENOENT|no such file/i);
  } finally {
    await ctx.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('SPACE-004: valid and dangling CLAUDE.md symlinks fail without outside writes', async () => {
  const ctx = await makeTestApp();
  const projectRoot = await mkdtemp(join(tmpdir(), 'gian-notes-symlink-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'gian-notes-outside-'));
  const workspaceId = randomUUID();
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  const outsideFile = join(outsideRoot, 'outside.md');
  try {
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(workspaceId, 'linked-notes', projectRoot);
    await writeFile(outsideFile, '# outside original\n');
    await symlink(outsideFile, claudeMd);

    let response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`);
    let failure = await response.json() as { error?: string; content?: string };
    assert.equal(response.status, 409);
    assert.equal(failure.content, undefined);
    assert.match(failure.error ?? '', /symlink/i);

    response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# must not escape\n' }),
    });
    failure = await response.json() as { error?: string };
    assert.equal(response.status, 409);
    assert.match(failure.error ?? '', /symlink/i);
    assert.equal(await readFile(outsideFile, 'utf8'), '# outside original\n');

    await rm(claudeMd);
    await rm(outsideFile);
    await symlink(outsideFile, claudeMd);

    response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`);
    failure = await response.json() as { error?: string; content?: string };
    assert.equal(response.status, 409);
    assert.equal(failure.content, undefined);
    assert.match(failure.error ?? '', /symlink/i);

    response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# must not create outside\n' }),
    });
    failure = await response.json() as { error?: string };
    assert.equal(response.status, 409);
    assert.match(failure.error ?? '', /symlink/i);
    await assert.rejects(readFile(outsideFile, 'utf8'), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
    assert.equal((await lstat(claudeMd)).isSymbolicLink(), true);
    assert.equal(
      (await readdir(projectRoot)).some(name => name.startsWith('.CLAUDE.md.gian-')),
      false,
    );
  } finally {
    await ctx.cleanup();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test('SPACE-004: legacy workspace directory aliases save atomically through their real path', async () => {
  const ctx = await makeTestApp();
  const base = await mkdtemp(join(tmpdir(), 'gian-notes-workspace-alias-'));
  const projectRoot = join(base, 'project');
  const workspaceAlias = join(base, 'project-alias');
  const workspaceId = randomUUID();
  try {
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# original\n');
    await symlink(projectRoot, workspaceAlias, 'dir');
    // Simulate a row persisted before workspace paths were canonicalized.
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(workspaceId, 'legacy-alias', workspaceAlias);

    const response = await ctx.fetch(`/api/workspaces/${workspaceId}/claude_md`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# saved through alias\n' }),
    });

    assert.equal(response.status, 200, await response.text());
    assert.equal(await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8'), '# saved through alias\n');
    assert.equal(
      (await readdir(projectRoot)).some(name => name.startsWith('.CLAUDE.md.gian-')),
      false,
    );
  } finally {
    await ctx.cleanup();
    await rm(base, { recursive: true, force: true });
  }
});
