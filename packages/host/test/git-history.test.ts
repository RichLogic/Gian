import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { bareUpstream, createGitRepo, type GitRepo } from './fixtures/git-repo.js';

interface HistoryRef {
  kind: 'local' | 'remote' | 'tag';
  name: string;
  shortName: string;
  target: string;
}

interface HistoryCommit {
  sha: string;
  parents: string[];
  author: { name: string; email: string };
  subject: string;
  refs: HistoryRef[];
  isMerge: boolean;
  isRoot: boolean;
}

interface HistoryPage {
  items: HistoryCommit[];
  nextCursor: string | null;
  snapshot: string | null;
  currentRef: string | null;
  headSha: string | null;
  selectedRef: string;
  availableRefs: HistoryRef[];
  availableAuthors: Array<{ name: string; email: string }>;
}

interface Detail extends HistoryCommit {
  base: string;
  body: string;
  files: Array<{
    path: string;
    oldPath?: string;
    status: string;
    added: number;
    removed: number;
    binary: boolean;
  }>;
}

interface Ctx {
  app: TestAppCtx;
  repo: GitRepo;
  treeId: string;
  workspaceId: string;
  rootSha: string;
  aliceSha: string;
  featureSha: string;
  mainSha: string;
  mergeSha: string;
  renameSha: string;
  cleanup: () => Promise<void>;
}

function amendAuthor(repo: GitRepo, name: string, email: string): string {
  repo.git(['commit', '--amend', '--no-edit', `--author=${name} <${email}>`]);
  return repo.git(['rev-parse', 'HEAD']);
}

async function setupHistory(): Promise<Ctx> {
  const app = await makeTestApp();
  const repo = createGitRepo({ initialMessage: 'root commit' });
  const rootSha = repo.git(['rev-parse', 'HEAD']);

  repo.commit('alpha.txt', 'alpha\n', 'Add alpha\n\nbody-search-needle');
  const aliceSha = amendAuthor(repo, 'Alice Example', 'alice@example.invalid');
  repo.git(['tag', '-a', 'v1.0', '-m', 'version one', aliceSha]);

  repo.checkout('feature', { create: true });
  repo.commit('feature.txt', 'feature\n', 'Feature by Bob');
  const featureSha = amendAuthor(repo, 'Bob Example', 'bob@example.invalid');

  repo.checkout('main');
  const mainSha = repo.commit('main.txt', 'main\n', 'Main-only work');
  repo.git(['merge', '--no-ff', 'feature', '-m', 'Merge feature']);
  const mergeSha = repo.git(['rev-parse', 'HEAD']);
  repo.git(['mv', 'feature.txt', 'feature-renamed.txt']);
  repo.git(['commit', '-m', 'Rename feature file']);
  const renameSha = repo.git(['rev-parse', 'HEAD']);

  const workspaceId = randomUUID();
  app.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'history fixture', repo.path);
  return {
    app,
    repo,
    treeId: `ws:${workspaceId}`,
    workspaceId,
    rootSha,
    aliceSha,
    featureSha,
    mainSha,
    mergeSha,
    renameSha,
    cleanup: async () => {
      await app.cleanup();
      repo.cleanup();
    },
  };
}

async function page(ctx: Ctx, query = ''): Promise<{ response: Response; body: HistoryPage }> {
  const response = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history${query}`);
  return { response, body: await response.json() as HistoryPage };
}

test('GIT-HISTORY-001: topology page exposes graph parents, refs, authors, and opaque pagination', async () => {
  const ctx = await setupHistory();
  try {
    const first = await page(ctx, '?limit=2');
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.items.map(item => item.sha), [ctx.renameSha, ctx.mergeSha]);
    assert.equal(first.body.items[1]?.isMerge, true);
    assert.deepEqual(first.body.items[1]?.parents.length, 2);
    assert.ok(first.body.nextCursor);
    assert.equal(first.body.currentRef, 'refs/heads/main');
    assert.equal(first.body.selectedRef, 'refs/heads/main');
    assert.ok(first.body.availableRefs.some(ref => ref.name === 'refs/tags/v1.0' && ref.target === ctx.aliceSha));
    assert.ok(first.body.availableRefs.some(ref => ref.name === 'refs/heads/feature' && ref.target === ctx.featureSha));
    assert.ok(first.body.availableAuthors.some(author => author.email === 'alice@example.invalid'));
    assert.ok(first.body.availableAuthors.some(author => author.email === 'bob@example.invalid'));

    const second = await page(ctx, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.items.length, 2);
    assert.equal(
      second.body.items.some(item => first.body.items.some(firstItem => firstItem.sha === item.sha)),
      false,
      'cursor pages must not overlap',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-001: text, SHA, author, and full-ref filters run before pagination', async () => {
  const ctx = await setupHistory();
  try {
    const byBody = await page(ctx, '?q=body-search-needle&limit=1');
    assert.equal(byBody.response.status, 200);
    assert.deepEqual(byBody.body.items.map(item => item.sha), [ctx.aliceSha]);

    const bySha = await page(ctx, `?q=${ctx.featureSha.slice(0, 10)}`);
    assert.deepEqual(bySha.body.items.map(item => item.sha), [ctx.featureSha]);

    const byAuthor = await page(ctx, '?author=alice%40example.invalid&limit=1');
    assert.equal(byAuthor.body.items.length, 1);
    assert.equal(byAuthor.body.items[0]?.author.email, 'alice@example.invalid');
    assert.equal(byAuthor.body.nextCursor, null);

    const byRef = await page(ctx, '?ref=refs%2Fheads%2Ffeature');
    assert.equal(byRef.body.selectedRef, 'refs/heads/feature');
    assert.deepEqual(byRef.body.items.slice(0, 2).map(item => item.sha), [ctx.featureSha, ctx.aliceSha]);
    assert.equal(byRef.body.items.some(item => item.sha === ctx.mainSha || item.sha === ctx.mergeSha), false);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-001: a cursor becomes stale when the selected ref advances', async () => {
  const ctx = await setupHistory();
  try {
    const first = await page(ctx, '?limit=1');
    assert.ok(first.body.nextCursor);
    ctx.repo.commit('later.txt', 'later\n', 'Later commit');
    const stale = await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history?limit=1&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'history_cursor_stale');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-002: detail reviews roots against the empty tree and merges against first parent', async () => {
  const ctx = await setupHistory();
  try {
    const rootResponse = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${ctx.rootSha}`);
    assert.equal(rootResponse.status, 200, await rootResponse.clone().text());
    const root = await rootResponse.json() as Detail;
    assert.equal(root.isRoot, true);
    assert.ok(root.base);
    assert.ok(root.files.some(file => file.path === 'README.md' && file.status === 'added'));

    const mergeResponse = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${ctx.mergeSha}`);
    assert.equal(mergeResponse.status, 200, await mergeResponse.clone().text());
    const merge = await mergeResponse.json() as Detail;
    assert.equal(merge.isMerge, true);
    assert.equal(merge.base, merge.parents[0], 'merge review base is the first parent');
    assert.ok(merge.files.some(file => file.path === 'feature.txt' && file.status === 'added'));
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-002: detail preserves rename metadata and diff content is loaded per file', async () => {
  const ctx = await setupHistory();
  try {
    const detailResponse = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${ctx.renameSha}`);
    const detail = await detailResponse.json() as Detail;
    assert.equal(detailResponse.status, 200, JSON.stringify(detail));
    assert.ok(detail.files.some(file =>
      file.status === 'renamed'
      && file.oldPath === 'feature.txt'
      && file.path === 'feature-renamed.txt'));

    const diffResponse = await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history/${ctx.renameSha}/diff?path=${encodeURIComponent('feature-renamed.txt')}`,
    );
    assert.equal(diffResponse.status, 200);
    const diff = await diffResponse.json() as { diff: string; truncated: boolean };
    assert.match(diff.diff, /feature-renamed\.txt/);
    assert.equal(diff.truncated, false);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-002: reachability detects rewritten commits while detail remains available as a snapshot', async () => {
  const ctx = await setupHistory();
  try {
    ctx.repo.checkout('ephemeral-history', { create: true });
    const orphanSha = ctx.repo.commit('orphan.txt', 'snapshot\n', 'Soon unreachable');
    ctx.repo.checkout('main');
    ctx.repo.git(['branch', '-D', 'ephemeral-history']);
    assert.equal(ctx.repo.git(['cat-file', '-t', orphanSha]), 'commit', 'object must still exist');

    const current = await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history/${ctx.renameSha}/reachability`,
    );
    assert.deepEqual(await current.json(), { sha: ctx.renameSha, reachable: true });

    const probe = await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history/${orphanSha}/reachability`,
    );
    assert.equal(probe.status, 200, await probe.clone().text());
    assert.deepEqual(await probe.json(), { sha: orphanSha, reachable: false });

    // ORPHANED is a UI marker, not deletion: an already-open tab can still
    // retain/reload its immutable object while Git has not pruned it.
    const detail = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${orphanSha}`);
    assert.equal(detail.status, 200, await detail.clone().text());
    const diff = await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history/${orphanSha}/diff?path=orphan.txt`,
    );
    assert.equal(diff.status, 200, await diff.clone().text());
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-002: binary files retain binary metadata without invented line counts', async () => {
  const ctx = await setupHistory();
  try {
    writeFileSync(join(ctx.repo.path, 'asset.bin'), Buffer.from([0, 1, 2, 0, 255]));
    ctx.repo.git(['add', 'asset.bin']);
    ctx.repo.git(['commit', '-m', 'Add binary asset']);
    const sha = ctx.repo.git(['rev-parse', 'HEAD']);
    const response = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${sha}`);
    assert.equal(response.status, 200, await response.clone().text());
    const detail = await response.json() as Detail;
    const binary = detail.files.find(file => file.path === 'asset.bin');
    assert.ok(binary);
    assert.equal(binary.binary, true);
    assert.equal(binary.added, 0);
    assert.equal(binary.removed, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-001/002: invalid refs and object ids fail explicitly', async () => {
  const ctx = await setupHistory();
  try {
    const badRef = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history?ref=main`);
    assert.equal(badRef.status, 400);
    assert.equal(((await badRef.json()) as { error: { code: string } }).error.code, 'history_ref_invalid');

    const badSha = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/not-a-sha`);
    assert.equal(badSha.status, 400);
    const missing = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/deadbeef`);
    assert.equal(missing.status, 404);
    const traversal = await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history/${ctx.renameSha}/diff?path=${encodeURIComponent('../secret')}`,
    );
    assert.equal(traversal.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-001: an unborn current branch returns an explicit empty history', async () => {
  const ctx = await setupHistory();
  try {
    ctx.repo.git(['checkout', '--orphan', 'empty-history']);
    ctx.repo.git(['rm', '-rf', '.']);
    const response = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as HistoryPage;
    assert.deepEqual(body.items, []);
    assert.equal(body.snapshot, null);
    assert.equal(body.headSha, null);
    assert.equal(body.currentRef, 'refs/heads/empty-history');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-001: detached HEAD stays distinct from a selected ref snapshot', async () => {
  const ctx = await setupHistory();
  try {
    ctx.repo.git(['checkout', '--detach', ctx.aliceSha]);
    const detached = await page(ctx);
    assert.equal(detached.body.currentRef, null);
    assert.equal(detached.body.headSha, ctx.aliceSha);
    assert.equal(detached.body.snapshot, ctx.aliceSha);

    const filtered = await page(ctx, '?ref=refs%2Fheads%2Fmain');
    assert.equal(filtered.body.currentRef, null);
    assert.equal(filtered.body.headSha, ctx.aliceSha, 'actual HEAD must not follow the filter');
    assert.equal(filtered.body.snapshot, ctx.renameSha, 'paging snapshot follows the selected ref');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-001/002: all read routes leave HEAD, refs, index, and worktree untouched', async () => {
  const ctx = await setupHistory();
  try {
    const fingerprint = (): string => [
      ctx.repo.git(['rev-parse', 'HEAD']),
      ctx.repo.git(['for-each-ref', '--format=%(refname):%(objectname)']),
      ctx.repo.git(['status', '--porcelain=v1']),
      ctx.repo.git(['write-tree']),
    ].join('\n--\n');
    const before = fingerprint();
    await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history?limit=2`);
    await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${ctx.mergeSha}`);
    await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/history/${ctx.mergeSha}/reachability`);
    await ctx.app.fetch(
      `/api/working_trees/${ctx.treeId}/history/${ctx.mergeSha}/diff?path=${encodeURIComponent('feature.txt')}`,
    );
    assert.equal(fingerprint(), before);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-HISTORY-003: worktree Fetch advances remote refs without changing local HEAD', async () => {
  const upstream = bareUpstream();
  const app = await makeTestApp();
  const local = createGitRepo({ origin: upstream.path });
  let peer: GitRepo | null = null;
  try {
    local.git(['push', '--force', '-u', 'origin', 'main']);
    const workspaceId = randomUUID();
    app.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(workspaceId, 'fetch fixture', local.path);
    const localHead = local.git(['rev-parse', 'HEAD']);
    const beforeRemote = local.git(['rev-parse', 'refs/remotes/origin/main']);

    peer = createGitRepo({ origin: upstream.path });
    peer.git(['checkout', '-B', 'main', 'origin/main']);
    const remoteHead = peer.commit('remote.txt', 'from remote\n', 'Remote update');
    peer.git(['push', 'origin', 'main']);
    assert.equal(local.git(['rev-parse', 'refs/remotes/origin/main']), beforeRemote);

    const response = await app.fetch(`/api/working_trees/ws:${workspaceId}/fetch`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; refsChanged: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.refsChanged, true);
    assert.equal(local.git(['rev-parse', 'refs/remotes/origin/main']), remoteHead);
    assert.equal(local.git(['rev-parse', 'HEAD']), localHead, 'Fetch must not merge or checkout');
    assert.equal(local.git(['status', '--porcelain=v1']), '');
  } finally {
    peer?.cleanup();
    local.cleanup();
    upstream.cleanup();
    await app.cleanup();
  }
});

test('GIT-HISTORY-003: worktree Fetch presents authentication failure without leaking stderr', async () => {
  const ctx = await setupHistory();
  const fakeSshDir = mkdtempSync(join(tmpdir(), 'gian-history-ssh-'));
  try {
    const fakeSsh = join(fakeSshDir, 'ssh-denied');
    writeFileSync(fakeSsh, [
      '#!/bin/sh',
      "echo \"Permission denied (publickey) for https://secret@example.invalid/repo\" >&2",
      'exit 255',
      '',
    ].join('\n'));
    chmodSync(fakeSsh, 0o755);
    ctx.repo.git(['config', 'core.sshCommand', fakeSsh]);
    ctx.repo.git(['remote', 'add', 'origin', 'ssh://example.invalid/repo']);

    const response = await ctx.app.fetch(`/api/working_trees/${ctx.treeId}/fetch`, { method: 'POST' });
    assert.equal(response.status, 502);
    const body = await response.json() as {
      error: { code: string; message: string; retryable: boolean; unknownOutcome: boolean; refsChanged: boolean };
    };
    assert.deepEqual(body.error, {
      code: 'git_authentication_failed',
      message: 'Git remote authentication failed',
      retryable: false,
      unknownOutcome: false,
      refsChanged: false,
    });
    assert.equal(JSON.stringify(body).includes('secret@example.invalid'), false);
  } finally {
    rmSync(fakeSshDir, { recursive: true, force: true });
    await ctx.cleanup();
  }
});
