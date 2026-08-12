import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import {
  SessionLifecycleBusyError,
  WorktreeLifecycleConflictError,
} from '../src/session/lifecycle-service.js';
import type { SessionManager } from '../src/session/manager.js';
import { saveConfig } from '../src/storage/config.js';
import type { Db } from '../src/storage/db.js';
import { registerSessionRoutes } from '../src/web/routes/sessions.js';
import {
  CommandExecutionError,
  GIT_MAX_CONCURRENCY,
  GitQueueFullError,
  RepoMutationLockError,
  runCommand,
  runGit,
  withRepoMutationLock,
} from '../src/workspace/async-command.js';
import { mergeBranchAsync } from '../src/workspace/git.js';
import { makeTestApp } from './fixtures/test-app.js';
import { bareUpstream, createGitRepo } from './fixtures/git-repo.js';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function withFakeGit<T>(
  source: string,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'gian-fake-git-'));
  const executable = join(dir, 'git');
  const previousPath = process.env.PATH;
  try {
    await writeFile(executable, `#!/usr/bin/env node\n${source}`, 'utf8');
    await chmod(executable, 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ''}`;
    return await run(dir);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('GIT async boundary keeps health responsive while a delayed fetch is running', async () => {
  const source = String.raw`
const { appendFileSync } = require('node:fs');
const log = process.env.GIAN_FAKE_GIT_LOG;
appendFileSync(log, 'started\n');
setTimeout(() => {
  appendFileSync(log, 'finished\n');
  process.exit(0);
}, 300);
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const log = join(dir, 'fetch.log');
    const previousLog = process.env.GIAN_FAKE_GIT_LOG;
    process.env.GIAN_FAKE_GIT_LOG = log;
    try {
      const workspaceId = randomUUID();
      ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
        .run(workspaceId, 'slow-fetch', dir);

      let fetchSettled = false;
      const fetchRequest = ctx.fetch(`/api/workspaces/${workspaceId}/fetch`, { method: 'POST' })
        .finally(() => { fetchSettled = true; });
      await waitFor(
        async () => readFile(log, 'utf8').then(() => true, () => false),
        5_000,
      );

      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fetchSettled, false,
        'the delayed git subprocess must still be pending after an unrelated event-loop tick');

      const healthStarted = Date.now();
      const health = await ctx.fetch('/health');
      assert.equal(health.status, 200);
      assert.ok(Date.now() - healthStarted < 150,
        'health must respond before the delayed git operation completes');

      const fetchResponse = await fetchRequest;
      assert.equal(fetchResponse.status, 200);
      assert.match(await readFile(log, 'utf8'), /started\nfinished/);
    } finally {
      if (previousLog === undefined) delete process.env.GIAN_FAKE_GIT_LOG;
      else process.env.GIAN_FAKE_GIT_LOG = previousLog;
      await ctx.cleanup();
    }
  });
});

test('command deadline rejects and cleans up the complete child process group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gian-command-timeout-'));
  const fixture = join(dir, 'hang.cjs');
  const pidsFile = join(dir, 'pids.json');
  // The nested Node fixture must spawn its descendant and publish both PIDs
  // before the deadline; 100ms is not enough when the full suite saturates
  // the machine, and then the test observes fixture startup rather than
  // process-group cleanup.
  const timeoutMs = 1_000;
  try {
    await writeFile(fixture, String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: 'ignore',
});
process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`, 'utf8');

    const failure = await runCommand(process.execPath, [fixture, pidsFile], {
      timeoutMs,
      terminateGraceMs: 40,
    }).then(
      () => null,
      error => error,
    );
    assert.ok(failure instanceof CommandExecutionError);
    assert.equal(failure.timedOut, true);
    assert.match(failure.message, new RegExp(`timed out after ${timeoutMs}ms`));

    const pids = JSON.parse(await readFile(pidsFile, 'utf8')) as { parent: number; child: number };
    await waitFor(() => !processIsAlive(pids.parent) && !processIsAlive(pids.child));
    assert.equal(processIsAlive(pids.parent), false, 'timed-out command process was reaped');
    assert.equal(processIsAlive(pids.child), false, 'descendant in the command process group was killed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-zero command exit exposes stderr and an explicit exit code', async () => {
  const failure = await runCommand(
    process.execPath,
    ['-e', "process.stderr.write('injected failure'); process.exit(7)"],
    { timeoutMs: 1_000 },
  ).then(
    () => null,
    error => error,
  );
  assert.ok(failure instanceof CommandExecutionError);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.stderr, 'injected failure');
  assert.match(failure.message, /injected failure/);
});

test('multi-workspace discovery never exceeds the Host-wide Git fan-out limit', async () => {
  const source = String.raw`
const { appendFileSync } = require('node:fs');
const log = process.env.GIAN_FAKE_GIT_LOG;
const write = kind => appendFileSync(log, JSON.stringify({ kind, pid: process.pid }) + '\n');
write('start');
setTimeout(() => {
  process.stdout.write('worktree ' + process.cwd() + '\nHEAD abcdef1234567890\nbranch refs/heads/main\n\n');
  write('end');
  process.exit(0);
}, 80);
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const log = join(dir, 'fanout.log');
    const previousLog = process.env.GIAN_FAKE_GIT_LOG;
    process.env.GIAN_FAKE_GIT_LOG = log;
    try {
      const workspacePaths: string[] = [];
      for (let index = 0; index < 10; index += 1) {
        const createdPath = join(dir, `workspace-${index}`);
        await mkdir(createdPath);
        const path = await realpath(createdPath);
        workspacePaths.push(path);
        ctx.db.prepare('INSERT INTO workspaces (id, name, path, sort_order) VALUES (?, ?, ?, ?)')
          .run(randomUUID(), `workspace-${index}`, path, index);
      }

      const response = await ctx.fetch('/api/working_trees?refresh=1');
      assert.equal(response.status, 200);
      const rows = await response.json() as Array<{ path: string }>;
      assert.equal(rows.length, workspacePaths.length);

      const events = (await readFile(log, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as { kind: 'start' | 'end'; pid: number });
      let active = 0;
      let maximum = 0;
      for (const event of events) {
        active += event.kind === 'start' ? 1 : -1;
        maximum = Math.max(maximum, active);
        assert.ok(active >= 0, 'a fake git process cannot end before it starts');
      }
      assert.equal(active, 0);
      assert.ok(maximum > 1, 'the scan still performs useful parallel work');
      assert.ok(maximum <= GIT_MAX_CONCURRENCY,
        `observed ${maximum} concurrent git processes; limit is ${GIT_MAX_CONCURRENCY}`);
    } finally {
      if (previousLog === undefined) delete process.env.GIAN_FAKE_GIT_LOG;
      else process.env.GIAN_FAKE_GIT_LOG = previousLog;
      await ctx.cleanup();
    }
  });
});

test('same-repository HTTP mutation cannot interleave a multi-step merge while another repo progresses', async () => {
  const source = String.raw`
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const log = process.env.GIAN_FAKE_GIT_LOG;
const marker = process.env.GIAN_FAKE_GIT_PARALLEL_MARKER;
const otherRepo = process.env.GIAN_FAKE_GIT_OTHER_REPO;
const args = process.argv.slice(2);
const command = args[0] || '';
const write = phase => appendFileSync(log, JSON.stringify({ phase, cwd: process.cwd(), command }) + '\n');
const finish = () => {
  write('end');
  process.exit(0);
};
write('start');
if (command === 'checkout') {
  const deadline = Date.now() + 2000;
  const waitForOtherRepo = () => {
    if (existsSync(marker) || Date.now() >= deadline) finish();
    else setTimeout(waitForOtherRepo, 10);
  };
  waitForOtherRepo();
} else {
  if (command === 'fetch' && process.cwd() === otherRepo) writeFileSync(marker, 'ready');
  setTimeout(finish, command === 'merge' ? 80 : 30);
}
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const log = join(dir, 'mutations.log');
    const previousLog = process.env.GIAN_FAKE_GIT_LOG;
    const previousMarker = process.env.GIAN_FAKE_GIT_PARALLEL_MARKER;
    const previousOtherRepo = process.env.GIAN_FAKE_GIT_OTHER_REPO;
    process.env.GIAN_FAKE_GIT_LOG = log;
    try {
      const createdRepoA = join(dir, 'repo-a');
      const createdRepoB = join(dir, 'repo-b');
      await Promise.all([mkdir(createdRepoA), mkdir(createdRepoB)]);
      const [repoA, repoB] = await Promise.all([
        realpath(createdRepoA),
        realpath(createdRepoB),
      ]);
      process.env.GIAN_FAKE_GIT_PARALLEL_MARKER = join(dir, 'other-repo-started');
      process.env.GIAN_FAKE_GIT_OTHER_REPO = repoB;
      const workspaceA = randomUUID();
      const workspaceB = randomUUID();
      ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
        .run(workspaceA, 'repo-a', repoA);
      ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
        .run(workspaceB, 'repo-b', repoB);

      const merge = mergeBranchAsync(repoA, 'feature', 'main');
      await waitFor(async () => readFile(log, 'utf8')
        .then(value => value.includes(`\"cwd\":\"${repoA}\",\"command\":\"checkout\"`), () => false));

      const [sameRepoFetch, otherRepoFetch] = await Promise.all([
        ctx.fetch(`/api/workspaces/${workspaceA}/fetch`, { method: 'POST' }),
        ctx.fetch(`/api/workspaces/${workspaceB}/fetch`, { method: 'POST' }),
        merge,
      ]);
      assert.equal(sameRepoFetch.status, 200);
      assert.equal(otherRepoFetch.status, 200);

      const events = (await readFile(log, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as {
          phase: 'start' | 'end';
          cwd: string;
          command: string;
        });
      const at = (phase: 'start' | 'end', cwd: string, command: string): number => (
        events.findIndex(event => event.phase === phase && event.cwd === cwd && event.command === command)
      );
      const checkoutStart = at('start', repoA, 'checkout');
      const checkoutEnd = at('end', repoA, 'checkout');
      const mergeStart = at('start', repoA, 'merge');
      const mergeEnd = at('end', repoA, 'merge');
      const sameFetchStart = at('start', repoA, 'fetch');
      const otherFetchStart = at('start', repoB, 'fetch');

      assert.ok(checkoutStart >= 0 && checkoutEnd >= 0 && mergeStart >= 0
        && mergeEnd >= 0 && sameFetchStart >= 0 && otherFetchStart >= 0,
      'all expected Git subprocesses must be observed');
      assert.ok(checkoutStart < checkoutEnd && checkoutEnd < mergeStart && mergeStart < mergeEnd,
        'checkout and merge must retain their program order');
      assert.ok(mergeEnd < sameFetchStart,
        'same-repository fetch must wait until the complete checkout -> merge mutation finishes');
      assert.ok(checkoutStart < otherFetchStart && otherFetchStart < checkoutEnd,
        'a different repository must still use another global Git slot while checkout is running');
    } finally {
      if (previousLog === undefined) delete process.env.GIAN_FAKE_GIT_LOG;
      else process.env.GIAN_FAKE_GIT_LOG = previousLog;
      if (previousMarker === undefined) delete process.env.GIAN_FAKE_GIT_PARALLEL_MARKER;
      else process.env.GIAN_FAKE_GIT_PARALLEL_MARKER = previousMarker;
      if (previousOtherRepo === undefined) delete process.env.GIAN_FAKE_GIT_OTHER_REPO;
      else process.env.GIAN_FAKE_GIT_OTHER_REPO = previousOtherRepo;
      await ctx.cleanup();
    }
  });
});

test('HTTP merge/drop rejects lifecycle contention and preserves merge outcome', async () => {
  const source = String.raw`
const { appendFileSync, existsSync } = require('node:fs');
const command = process.argv[2] || '';
if (command === 'rev-parse' && process.argv.includes('--git-common-dir')) {
  process.stdout.write('.git\n');
  process.exit(0);
}
if (command === 'merge') {
  const entered = process.env.GIAN_FAKE_GIT_MERGE_ENTERED;
  const release = process.env.GIAN_FAKE_GIT_MERGE_RELEASE;
  appendFileSync(entered, 'entered\n');
  const poll = () => existsSync(release) ? process.exit(0) : setTimeout(poll, 10);
  poll();
} else {
  process.exit(0);
}
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const repoPath = join(dir, 'session-repo');
    const entered = join(dir, 'merge-entered');
    const release = join(dir, 'merge-release');
    const previousEntered = process.env.GIAN_FAKE_GIT_MERGE_ENTERED;
    const previousRelease = process.env.GIAN_FAKE_GIT_MERGE_RELEASE;
    process.env.GIAN_FAKE_GIT_MERGE_ENTERED = entered;
    process.env.GIAN_FAKE_GIT_MERGE_RELEASE = release;
    let mergeRequest: Promise<Response> | undefined;
    let dropRequest: Promise<Response> | undefined;
    try {
      await mkdir(join(repoPath, '.git'), { recursive: true });
      const workspaceId = randomUUID();
      const sessionId = randomUUID();
      ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
        .run(workspaceId, 'session-repo', repoPath);
      ctx.db.prepare(`
        INSERT INTO sessions
          (id, name, type, workspace_id, executor, approval_mode, status,
           archived, native_session_id, worktree_path, branch, base_branch,
           created_at, updated_at)
        VALUES (?, ?, 'coding', ?, 'claude', 'auto', 'idle', 0, ?, ?, ?, ?,
                datetime('now'), datetime('now'))
      `).run(
        sessionId,
        'merge-race',
        workspaceId,
        `native-${sessionId}`,
        repoPath,
        'worktree/race',
        'main',
      );

      mergeRequest = ctx.fetch(`/api/sessions/${sessionId}/merge`, { method: 'POST' });
      await waitFor(() => readFile(entered, 'utf8').then(() => true, () => false));

      dropRequest = ctx.fetch(`/api/sessions/${sessionId}/drop`, { method: 'POST' });
      const dropResponse = await dropRequest;
      assert.equal(dropResponse.status, 409);
      assert.match(
        (await dropResponse.json() as { error: string }).error,
        /lifecycle operation already in progress/,
      );

      await writeFile(release, 'go');
      const mergeResponse = await mergeRequest;
      assert.equal(mergeResponse.status, 200);
      assert.deepEqual(await mergeResponse.json(), { ok: true });

      const row = ctx.db.prepare(`
        SELECT worktree_outcome, worktree_path, archived, status
        FROM sessions WHERE id = ?
      `).get(sessionId) as {
        worktree_outcome: string | null;
        worktree_path: string | null;
        archived: number;
        status: string;
      };
      assert.deepEqual(row, {
        worktree_outcome: 'merged',
        worktree_path: null,
        archived: 1,
        status: 'done',
      });
    } finally {
      await writeFile(release, 'go').catch(() => undefined);
      await Promise.allSettled([
        ...(mergeRequest ? [mergeRequest] : []),
        ...(dropRequest ? [dropRequest] : []),
      ]);
      if (previousEntered === undefined) delete process.env.GIAN_FAKE_GIT_MERGE_ENTERED;
      else process.env.GIAN_FAKE_GIT_MERGE_ENTERED = previousEntered;
      if (previousRelease === undefined) delete process.env.GIAN_FAKE_GIT_MERGE_RELEASE;
      else process.env.GIAN_FAKE_GIT_MERGE_RELEASE = previousRelease;
      await ctx.cleanup();
    }
  });
});

test('HTTP session merge maps conflicts, pressure, timeouts, and internal failures', async () => {
  const commandError = (params: Partial<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
  }> = {}): CommandExecutionError => new CommandExecutionError({
    message: 'injected git failure',
    command: 'git',
    args: ['merge'],
    stdout: '',
    stderr: '',
    exitCode: params.exitCode ?? null,
    signal: params.signal ?? null,
    timedOut: params.timedOut,
    aborted: params.aborted,
  });

  let injected: Error = new Error('unset');
  let seenSessionId: string | undefined;
  const sessions = {
    mergeWorktree: async (sessionId: string) => {
      seenSessionId = sessionId;
      throw injected;
    },
  } as unknown as SessionManager;
  const app = new Hono();
  registerSessionRoutes(app, {} as Db, sessions);

  const cases: Array<{ name: string; error: Error; status: number }> = [
    {
      name: 'lifecycle conflict',
      error: new WorktreeLifecycleConflictError('session already merged'),
      status: 400,
    },
    {
      name: 'lifecycle busy',
      error: new SessionLifecycleBusyError('busy-session'),
      status: 409,
    },
    { name: 'normal git conflict', error: commandError({ exitCode: 1 }), status: 400 },
    { name: 'repository queue timeout', error: new RepoMutationLockError('timed_out'), status: 503 },
    { name: 'repository queue full', error: new RepoMutationLockError('queue_full'), status: 503 },
    { name: 'Git queue full', error: new GitQueueFullError(), status: 503 },
    { name: 'Git deadline', error: commandError({ timedOut: true }), status: 504 },
    { name: 'spawn failure', error: commandError(), status: 500 },
    { name: 'signal failure', error: commandError({ signal: 'SIGKILL' }), status: 500 },
    { name: 'internal failure', error: new Error('database unavailable'), status: 500 },
  ];

  for (const entry of cases) {
    injected = entry.error;
    seenSessionId = undefined;
    const response = await app.request(`/api/sessions/status-${entry.status}/merge`, {
      method: 'POST',
    });
    assert.equal(response.status, entry.status, entry.name);
    assert.equal(seenSessionId, `status-${entry.status}`);
    assert.deepEqual(await response.json(), { error: entry.error.message });
  }
});

test('HTTP Git mutation routes map canceled lock acquisition to 503', async () => {
  const ctx = await makeTestApp();
  const repo = createGitRepo({ initialBranch: 'main' });
  try {
    const workspaceId = randomUUID();
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(workspaceId, 'admission-status', repo.path);
    await writeFile(join(repo.path, 'queued.txt'), 'queued');

    const requests: Array<{ path: string; init: RequestInit }> = [
      {
        path: `/api/workspaces/${workspaceId}/branches`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'never-created' }),
        },
      },
      {
        path: `/api/workspaces/${workspaceId}/abort-merge`,
        init: { method: 'POST' },
      },
      {
        path: `/api/workspaces/${workspaceId}/fetch`,
        init: { method: 'POST' },
      },
      {
        path: `/api/working_trees/ws:${workspaceId}/stage`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'queued.txt' }),
        },
      },
      {
        path: `/api/working_trees/ws:${workspaceId}/unstage`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'queued.txt' }),
        },
      },
    ];

    for (const request of requests) {
      const controller = new AbortController();
      controller.abort();
      const response = await ctx.fetch(request.path, {
        ...request.init,
        signal: controller.signal,
      });
      assert.equal(response.status, 503, request.path);
    }
  } finally {
    await ctx.cleanup();
    repo.cleanup();
  }
});

test('repository mutation lock releases a queued waiter after the owner fails', async () => {
  const repo = createGitRepo({ initialBranch: 'main' });
  try {
    let failOwner!: () => void;
    let ownerStarted = false;
    const ownerGate = new Promise<void>(resolve => {
      failOwner = resolve;
    });
    const owner = withRepoMutationLock(repo.path, async () => {
      ownerStarted = true;
      await ownerGate;
      throw new Error('injected mutation failure');
    });
    await waitFor(() => ownerStarted);

    let waiterStarted = false;
    const waiter = withRepoMutationLock(repo.path, async () => {
      waiterStarted = true;
      return 'released';
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(waiterStarted, false, 'the waiter must not enter before its owner releases');

    failOwner();
    await assert.rejects(owner, /injected mutation failure/);
    assert.equal(await waiter, 'released');
    assert.equal(waiterStarted, true);
  } finally {
    repo.cleanup();
  }
});

test('repository mutation lock canonicalizes symlink aliases and linked worktrees', async () => {
  const repo = createGitRepo({ initialBranch: 'main' });
  const aliasesDir = await mkdtemp(join(tmpdir(), 'gian-repo-aliases-'));
  const aliasPath = join(aliasesDir, 'repo-alias');
  const linkedPath = join(aliasesDir, 'linked-worktree');
  let releaseOwner: (() => void) | undefined;
  let owner: Promise<void> | undefined;
  try {
    await symlink(repo.path, aliasPath, 'dir');
    repo.git(['worktree', 'add', '-b', 'lock-linked', linkedPath, 'main']);

    let ownerStarted = false;
    const ownerGate = new Promise<void>(resolve => {
      releaseOwner = resolve;
    });
    owner = withRepoMutationLock(repo.path, async () => {
      ownerStarted = true;
      await ownerGate;
    });
    await waitFor(() => ownerStarted);

    const aliasResults = await Promise.all([aliasPath, linkedPath].map(path => (
      withRepoMutationLock(path, async () => 'entered', { timeoutMs: 100 })
        .then(value => value, error => error)
    )));
    for (const result of aliasResults) {
      assert.ok(result instanceof RepoMutationLockError);
      assert.equal(result.reason, 'timed_out',
        'aliases of a held repository must queue behind the same common-dir lock');
    }
  } finally {
    releaseOwner?.();
    await owner?.catch(() => undefined);
    try { repo.git(['worktree', 'remove', '--force', linkedPath]); } catch { /* cleanup below */ }
    repo.cleanup();
    await rm(aliasesDir, { recursive: true, force: true });
  }
});

test('repository mutation lock bounds, times out, and cancels queued waiters', async () => {
  const repo = createGitRepo({ initialBranch: 'main' });
  let releaseOwner: (() => void) | undefined;
  let owner: Promise<void> | undefined;
  try {
    let ownerStarted = false;
    const ownerGate = new Promise<void>(resolve => {
      releaseOwner = resolve;
    });
    owner = withRepoMutationLock(repo.path, async () => {
      ownerStarted = true;
      await ownerGate;
    });
    await waitFor(() => ownerStarted);

    let timedOutEntered = false;
    const timedOut = await withRepoMutationLock(repo.path, async () => {
      timedOutEntered = true;
    }, { timeoutMs: 50 }).then(
      () => null,
      error => error,
    );
    assert.ok(timedOut instanceof RepoMutationLockError);
    assert.equal(timedOut.reason, 'timed_out');
    assert.equal(timedOutEntered, false);

    const controller = new AbortController();
    let abortedEntered = false;
    const abortedPromise = withRepoMutationLock(repo.path, async () => {
      abortedEntered = true;
    }, { signal: controller.signal, timeoutMs: 1_000 }).then(
      () => null,
      error => error,
    );
    controller.abort();
    const aborted = await abortedPromise;
    assert.ok(aborted instanceof RepoMutationLockError);
    assert.equal(aborted.reason, 'aborted');
    assert.equal(abortedEntered, false);

    let queueFullCount = 0;
    const admitted = Array.from({ length: 3 }, (_, index) => (
      withRepoMutationLock(repo.path, async () => index, {
        maxWaiters: 1,
        timeoutMs: 1_000,
      }).then(
        value => ({ status: 'fulfilled' as const, value }),
        error => {
          if (error instanceof RepoMutationLockError && error.reason === 'queue_full') {
            queueFullCount += 1;
          }
          return { status: 'rejected' as const, reason: error as unknown };
        },
      )
    ));
    await waitFor(() => queueFullCount === 2);
    releaseOwner();
    releaseOwner = undefined;
    await owner;
    owner = undefined;

    const outcomes = await Promise.all(admitted);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => (
      outcome.status === 'rejected'
      && outcome.reason instanceof RepoMutationLockError
      && outcome.reason.reason === 'queue_full'
    )).length, 2);
  } finally {
    releaseOwner?.();
    await owner?.catch(() => undefined);
    repo.cleanup();
  }
});

test('Git semaphore deadline includes queue wait and never spawns expired work', async () => {
  const source = String.raw`
const { appendFileSync, existsSync } = require('node:fs');
const log = process.env.GIAN_FAKE_GIT_LOG;
const release = process.env.GIAN_FAKE_GIT_RELEASE;
const command = process.argv[2] || '';
appendFileSync(log, JSON.stringify({ phase: 'start', command }) + '\n');
const finish = () => {
  appendFileSync(log, JSON.stringify({ phase: 'end', command }) + '\n');
  process.exit(0);
};
if (command === 'hold') {
  const poll = () => existsSync(release) ? finish() : setTimeout(poll, 10);
  poll();
} else {
  setTimeout(finish, 10);
}
`;

  await withFakeGit(source, async dir => {
    const log = join(dir, 'semaphore.log');
    const release = join(dir, 'release');
    const previousLog = process.env.GIAN_FAKE_GIT_LOG;
    const previousRelease = process.env.GIAN_FAKE_GIT_RELEASE;
    process.env.GIAN_FAKE_GIT_LOG = log;
    process.env.GIAN_FAKE_GIT_RELEASE = release;
    const owners = Array.from({ length: GIT_MAX_CONCURRENCY }, (_, index) => (
      runGit(['hold', String(index)], { timeoutMs: 2_000 })
    ));
    try {
      await waitFor(async () => {
        const lines = await readFile(log, 'utf8').catch(() => '');
        return lines.split('\n').filter(line => line.includes('"command":"hold"')).length
          === GIT_MAX_CONCURRENCY;
      });

      const expired = await runGit(['expired'], { timeoutMs: 60 }).then(
        () => null,
        error => error,
      );
      assert.ok(expired instanceof CommandExecutionError);
      assert.equal(expired.timedOut, true);
      assert.doesNotMatch(await readFile(log, 'utf8'), /"command":"expired"/,
        'work whose queue deadline elapsed must never spawn');

      const queued = runGit(['queued'], { timeoutMs: 1_000, maxQueueWaiters: 1 });
      const overflow = await runGit(
        ['overflow'],
        { timeoutMs: 1_000, maxQueueWaiters: 1 },
      ).then(
        () => null,
        error => error,
      );
      assert.ok(overflow instanceof GitQueueFullError);

      const controller = new AbortController();
      const canceledPromise = runGit(
        ['canceled'],
        { timeoutMs: 1_000, signal: controller.signal },
      ).then(
        () => null,
        error => error,
      );
      controller.abort();
      const canceled = await canceledPromise;
      assert.ok(canceled instanceof CommandExecutionError);
      assert.equal(canceled.aborted, true);
      assert.doesNotMatch(await readFile(log, 'utf8'), /"command":"canceled"/);

      await writeFile(release, 'go');
      await Promise.all(owners);
      await queued;

      const handoffController = new AbortController();
      const handoffCanceledPromise = runGit(
        ['handoff-canceled'],
        { timeoutMs: 500, signal: handoffController.signal },
      ).then(
        () => null,
        error => error,
      );
      // `runGit` has acquired a permit, but its await continuation has not
      // run yet. Cancellation at this handoff must release the permit without
      // spawning the command.
      handoffController.abort();
      const handoffCanceled = await handoffCanceledPromise;
      assert.ok(handoffCanceled instanceof CommandExecutionError);
      assert.equal(handoffCanceled.aborted, true);
      assert.doesNotMatch(await readFile(log, 'utf8'), /"command":"handoff-canceled"/);

      await runGit(['after-release'], { timeoutMs: 500 });
      assert.match(await readFile(log, 'utf8'), /"command":"after-release"/,
        'permits remain usable after timeout, cancellation, and queue overflow');
    } finally {
      await writeFile(release, 'go').catch(() => undefined);
      await Promise.allSettled(owners);
      if (previousLog === undefined) delete process.env.GIAN_FAKE_GIT_LOG;
      else process.env.GIAN_FAKE_GIT_LOG = previousLog;
      if (previousRelease === undefined) delete process.env.GIAN_FAKE_GIT_RELEASE;
      else process.env.GIAN_FAKE_GIT_RELEASE = previousRelease;
    }
  });
});

test('workspace target reservation rejects concurrent create/adopt before DB publication', async () => {
  const source = String.raw`
const { appendFileSync, existsSync } = require('node:fs');
const command = process.argv[2] || '';
if (command !== 'init') process.exit(2);
const started = process.env.GIAN_FAKE_GIT_INIT_STARTED;
const release = process.env.GIAN_FAKE_GIT_INIT_RELEASE;
appendFileSync(started, 'started\n');
const poll = () => existsSync(release) ? process.exit(0) : setTimeout(poll, 10);
poll();
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const root = join(dir, 'projects');
    const rootAlias = join(dir, 'projects-alias');
    const target = join(rootAlias, 'owner');
    const started = join(dir, 'init-started');
    const release = join(dir, 'init-release');
    const previousStarted = process.env.GIAN_FAKE_GIT_INIT_STARTED;
    const previousRelease = process.env.GIAN_FAKE_GIT_INIT_RELEASE;
    process.env.GIAN_FAKE_GIT_INIT_STARTED = started;
    process.env.GIAN_FAKE_GIT_INIT_RELEASE = release;
    let ownerRequest: Promise<Response> | undefined;
    try {
      await mkdir(root);
      await symlink(root, rootAlias, 'dir');
      saveConfig(ctx.db, { workspace_root: rootAlias });
      ownerRequest = ctx.fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'owner' }),
      });
      await waitFor(() => readFile(started, 'utf8').then(() => true, () => false));
      // Fresh initialization now stays in a sibling staging directory until
      // publication, so canonicalize the existing parent and append the
      // not-yet-published leaf instead of realpath-ing the target itself.
      const canonicalTarget = join(await realpath(root), 'owner');

      const contender = await ctx.fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'contender', path: canonicalTarget }),
      });
      assert.equal(contender.status, 409);
      assert.deepEqual(await contender.json(), {
        error: 'workspace path initialization is already in progress',
        code: 'WORKSPACE_INIT_IN_PROGRESS',
      });
      assert.equal(
        (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
        0,
        'the losing request must not publish state while initialization is incomplete',
      );

      await writeFile(release, 'go');
      const ownerResponse = await ownerRequest;
      assert.equal(ownerResponse.status, 200, await ownerResponse.text());
      const rows = ctx.db.prepare('SELECT name, path FROM workspaces').all() as Array<{
        name: string;
        path: string;
      }>;
      assert.deepEqual(rows, [{ name: 'owner', path: canonicalTarget }]);
    } finally {
      await writeFile(release, 'go').catch(() => undefined);
      await ownerRequest?.catch(() => undefined);
      if (previousStarted === undefined) delete process.env.GIAN_FAKE_GIT_INIT_STARTED;
      else process.env.GIAN_FAKE_GIT_INIT_STARTED = previousStarted;
      if (previousRelease === undefined) delete process.env.GIAN_FAKE_GIT_INIT_RELEASE;
      else process.env.GIAN_FAKE_GIT_INIT_RELEASE = previousRelease;
      await ctx.cleanup();
    }
  });
});

test('workspace target reservation honors a canceled request before path resolution', async () => {
  const ctx = await makeTestApp();
  const root = await mkdtemp(join(tmpdir(), 'gian-reservation-abort-'));
  try {
    saveConfig(ctx.db, { workspace_root: root });
    const controller = new AbortController();
    controller.abort();
    const response = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'canceled' }),
      signal: controller.signal,
    });
    assert.equal(response.status, 503);
    assert.match(
      (await response.json() as { error: string }).error,
      /path resolution was aborted/,
    );
    await assert.rejects(access(join(root, 'canceled')));
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
      0,
    );
  } finally {
    await ctx.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh workspace publication never replaces a target that appeared during init', async () => {
  const source = String.raw`
const { appendFileSync, existsSync } = require('node:fs');
if ((process.argv[2] || '') !== 'init') process.exit(2);
const started = process.env.GIAN_FAKE_GIT_INIT_STARTED;
const release = process.env.GIAN_FAKE_GIT_INIT_RELEASE;
appendFileSync(started, 'started\n');
const poll = () => existsSync(release) ? process.exit(0) : setTimeout(poll, 10);
poll();
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const root = join(dir, 'projects');
    const target = join(root, 'claimed');
    const started = join(dir, 'init-started');
    const release = join(dir, 'init-release');
    const previousStarted = process.env.GIAN_FAKE_GIT_INIT_STARTED;
    const previousRelease = process.env.GIAN_FAKE_GIT_INIT_RELEASE;
    process.env.GIAN_FAKE_GIT_INIT_STARTED = started;
    process.env.GIAN_FAKE_GIT_INIT_RELEASE = release;
    let request: Promise<Response> | undefined;
    try {
      await mkdir(root);
      saveConfig(ctx.db, { workspace_root: root });
      request = ctx.fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'claimed' }),
      });
      await waitFor(() => readFile(started, 'utf8').then(() => true, () => false));

      await mkdir(target);
      const originalInode = (await stat(target)).ino;
      await writeFile(release, 'go');
      const response = await request;
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, /target appeared/);
      assert.equal((await stat(target)).ino, originalInode,
        'the externally-created empty directory must not be replaced by staging');
      assert.deepEqual(await readdir(target), []);
      assert.equal(
        (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count,
        0,
      );
      assert.equal((await readdir(root)).some(name => name.includes('.gian-init-')), false);
    } finally {
      await writeFile(release, 'go').catch(() => undefined);
      await request?.catch(() => undefined);
      if (previousStarted === undefined) delete process.env.GIAN_FAKE_GIT_INIT_STARTED;
      else process.env.GIAN_FAKE_GIT_INIT_STARTED = previousStarted;
      if (previousRelease === undefined) delete process.env.GIAN_FAKE_GIT_INIT_RELEASE;
      else process.env.GIAN_FAKE_GIT_INIT_RELEASE = previousRelease;
      await ctx.cleanup();
    }
  });
});

test('workspace target reservation allows only one clone into a pre-existing empty target', async () => {
  const source = String.raw`
const { appendFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const command = process.argv[2] || '';
if (command !== 'clone') process.exit(2);
const log = process.env.GIAN_FAKE_GIT_CLONE_LOG;
const release = process.env.GIAN_FAKE_GIT_CLONE_RELEASE;
const target = process.argv.at(-1);
appendFileSync(log, 'clone-start\n');
const poll = () => {
  if (!existsSync(release)) return setTimeout(poll, 10);
  mkdirSync(join(target, '.git'), { recursive: true });
  process.exit(0);
};
poll();
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const root = join(dir, 'projects');
    const target = join(root, 'clone-race');
    const log = join(dir, 'clone.log');
    const release = join(dir, 'clone-release');
    const previousLog = process.env.GIAN_FAKE_GIT_CLONE_LOG;
    const previousRelease = process.env.GIAN_FAKE_GIT_CLONE_RELEASE;
    process.env.GIAN_FAKE_GIT_CLONE_LOG = log;
    process.env.GIAN_FAKE_GIT_CLONE_RELEASE = release;
    let ownerRequest: Promise<Response> | undefined;
    try {
      await mkdir(target, { recursive: true });
      const canonicalTarget = await realpath(target);
      saveConfig(ctx.db, { workspace_root: root });
      const requestInit: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'clone-race', git_remote: 'fake://upstream' }),
      };
      ownerRequest = ctx.fetch('/api/workspaces', requestInit);
      await waitFor(() => readFile(log, 'utf8').then(() => true, () => false));

      const contender = await ctx.fetch('/api/workspaces', requestInit);
      assert.equal(contender.status, 409);
      assert.equal((await readFile(log, 'utf8')).match(/clone-start/g)?.length, 1,
        'the rejected request must not start a second clone');

      await writeFile(release, 'go');
      const ownerResponse = await ownerRequest;
      assert.equal(ownerResponse.status, 200, await ownerResponse.text());
      assert.equal((await readFile(log, 'utf8')).match(/clone-start/g)?.length, 1);
      assert.equal(
        (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE path = ?')
          .get(canonicalTarget) as { count: number }).count,
        1,
      );
    } finally {
      await writeFile(release, 'go').catch(() => undefined);
      await ownerRequest?.catch(() => undefined);
      if (previousLog === undefined) delete process.env.GIAN_FAKE_GIT_CLONE_LOG;
      else process.env.GIAN_FAKE_GIT_CLONE_LOG = previousLog;
      if (previousRelease === undefined) delete process.env.GIAN_FAKE_GIT_CLONE_RELEASE;
      else process.env.GIAN_FAKE_GIT_CLONE_RELEASE = previousRelease;
      await ctx.cleanup();
    }
  });
});

test('workspace target reservation releases after failed initialization for a retry', async () => {
  const source = String.raw`
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const command = process.argv[2] || '';
if (command !== 'init') process.exit(2);
const counter = process.env.GIAN_FAKE_GIT_INIT_COUNTER;
const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(count + 1));
if (count === 0) {
  mkdirSync(join(process.cwd(), '.git'), { recursive: true });
  writeFileSync(join(process.cwd(), '.git', 'partial'), 'incomplete');
  process.stderr.write('first init fails');
  process.exit(9);
}
process.exit(0);
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const root = join(dir, 'projects');
    const target = join(root, 'retry');
    const counter = join(dir, 'init-counter');
    const previousCounter = process.env.GIAN_FAKE_GIT_INIT_COUNTER;
    process.env.GIAN_FAKE_GIT_INIT_COUNTER = counter;
    try {
      await mkdir(root);
      const canonicalRoot = await realpath(root);
      const canonicalTarget = join(canonicalRoot, 'retry');
      saveConfig(ctx.db, { workspace_root: root });
      const request: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'retry' }),
      };

      const failed = await ctx.fetch('/api/workspaces', request);
      assert.equal(failed.status, 400);
      assert.equal(
        (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE path = ?')
          .get(canonicalTarget) as { count: number }).count,
        0,
      );
      await assert.rejects(access(target),
        'failed git init must not publish its partially-created .git directory');
      assert.equal((await readdir(root)).some(name => name.includes('.gian-init-')), false,
        'failed git init must remove its Gian-owned staging directory');

      const retried = await ctx.fetch('/api/workspaces', request);
      assert.equal(retried.status, 200, await retried.text());
      assert.equal(await readFile(counter, 'utf8'), '2');
      assert.equal(
        (ctx.db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE path = ?')
          .get(canonicalTarget) as { count: number }).count,
        1,
      );
    } finally {
      if (previousCounter === undefined) delete process.env.GIAN_FAKE_GIT_INIT_COUNTER;
      else process.env.GIAN_FAKE_GIT_INIT_COUNTER = previousCounter;
      await ctx.cleanup();
    }
  });
});

test('failed clone leaves no workspace row or Gian-created partial checkout', async () => {
  const source = String.raw`
const { mkdirSync, writeFileSync } = require('node:fs');
const target = process.argv.at(-1);
mkdirSync(target, { recursive: true });
writeFileSync(require('node:path').join(target, 'partial'), 'incomplete');
process.stderr.write('injected clone failure');
process.exit(9);
`;

  await withFakeGit(source, async dir => {
    const ctx = await makeTestApp();
    const root = join(dir, 'projects');
    await mkdir(root);
    try {
      saveConfig(ctx.db, { workspace_root: root });
      const response = await ctx.fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'broken', git_remote: 'fake://broken' }),
      });
      assert.equal(response.status, 400);
      const body = await response.json() as { error: string };
      assert.match(body.error, /injected clone failure/);
      const row = ctx.db.prepare('SELECT id FROM workspaces WHERE name = ?').get('broken');
      assert.equal(row, undefined, 'failed external operation must not create canonical DB state');
      await assert.rejects(readFile(join(root, 'broken', 'partial')),
        'a clone target Gian created is removed after failure');
    } finally {
      await ctx.cleanup();
    }
  });
});

test('successful clone is atomically published at the canonical workspace path', async () => {
  const ctx = await makeTestApp();
  const root = await mkdtemp(join(tmpdir(), 'gian-clone-root-'));
  const upstream = bareUpstream({ seedBranch: 'main' });
  try {
    saveConfig(ctx.db, { workspace_root: root });
    const canonicalTarget = join(await realpath(root), 'cloned');
    const response = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cloned', git_remote: upstream.path }),
    });
    const body = await response.json() as {
      workspace?: { path: string };
      notes?: string[];
      error?: string;
    };
    assert.equal(response.status, 200, body.error);
    assert.equal(body.workspace?.path, canonicalTarget);
    assert.ok(body.notes?.some(note => note.startsWith('cloned ')));
    await access(join(root, 'cloned', '.git'));
    assert.equal((await readdir(root)).some(name => name.includes('.gian-init-')), false,
      'the staging checkout is renamed away after success');
  } finally {
    await ctx.cleanup();
    upstream.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
