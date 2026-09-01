import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  KimiTerminalService,
  TerminalCleanupError,
  TerminalOwnershipError,
  tailWithinByteLimit,
} from '../src/runtime/terminal-service.js';

const SESSION = 'native-session';
const BASE_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function makeService(options?: ConstructorParameters<typeof KimiTerminalService>[0]) {
  // macOS tmpdir is a /var -> /private/var symlink; commands report the
  // resolved path, so compare against the real path everywhere.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-term-')));
  const service = new KimiTerminalService(options);
  service.bindSession(SESSION, cwd);
  return { service, cwd };
}

/** Runs a command whose own PID (= process group leader) is printed first. */
async function createWithPgid(
  service: KimiTerminalService,
  script: string,
  params: Partial<Parameters<KimiTerminalService['create']>[0]> = {},
): Promise<{ terminalId: string; pgid: number }> {
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sh',
    args: ['-c', `echo $$; ${script}`],
    ...params,
  }, { env: BASE_ENV });
  const { pgid } = await pollPgid(service, created.terminalId);
  return { terminalId: created.terminalId, pgid };
}

async function pollPgid(
  service: KimiTerminalService,
  terminalId: string,
): Promise<{ pgid: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = service.output({ sessionId: SESSION, terminalId });
    const match = /^(\d+)\n/.exec(output.output);
    if (match) return { pgid: Number(match[1]) };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('helper never printed its pgid');
}

test('runs argv commands without a shell and defaults cwd to the session cwd', async () => {
  const { service, cwd } = makeService();
  // Shell metacharacters must arrive as literal argv elements.
  const shellish = await service.create({
    sessionId: SESSION,
    command: '/bin/echo',
    args: ['; touch /tmp/kimi-term-pwned', '$HOME', '`id`'],
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: shellish.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: shellish.terminalId });
  assert.equal(output.output, '; touch /tmp/kimi-term-pwned $HOME `id`\n');
  assert.equal(output.truncated, false);
  await service.release({ sessionId: SESSION, terminalId: shellish.terminalId });

  // Without an explicit cwd the command runs in the bound session cwd.
  const pwd = await service.create({
    sessionId: SESSION,
    command: '/bin/pwd',
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: pwd.terminalId });
  const pwdOutput = service.output({ sessionId: SESSION, terminalId: pwd.terminalId });
  assert.equal(pwdOutput.output.trim(), cwd);
  await service.release({ sessionId: SESSION, terminalId: pwd.terminalId });
  assert.equal(service.activeCount, 0);
});

test('rejects an explicit cwd that is not an existing absolute directory before spawn', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.create({
      sessionId: SESSION,
      command: '/bin/pwd',
      cwd: '/definitely/not/here',
    }, { env: BASE_ENV }),
    /cwd must be an existing directory/,
  );
  await assert.rejects(
    service.create({
      sessionId: SESSION,
      command: '/bin/pwd',
      cwd: 'relative/path',
    }, { env: BASE_ENV }),
    /cwd must be an absolute path/,
  );
  assert.equal(service.activeCount, 0);
});

test('merges request env over the proxy env and rejects NUL bytes', async () => {
  const { service } = makeService();
  const created = await service.create({
    sessionId: SESSION,
    command: '/usr/bin/printenv',
    args: ['KIMI_TERM_TEST_VAR'],
    env: [{ name: 'KIMI_TERM_TEST_VAR', value: 'hello' }],
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: created.terminalId });
  assert.equal(output.output, 'hello\n');
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });

  await assert.rejects(
    service.create({
      sessionId: SESSION,
      command: '/bin/pwd',
      env: [{ name: 'BAD\0NAME', value: 'x' }],
    }, { env: BASE_ENV }),
    /NUL/,
  );
  await assert.rejects(
    service.create({
      sessionId: SESSION,
      command: '/bin/pwd',
      args: ['bad\0arg'],
    }, { env: BASE_ENV }),
    /NUL/,
  );
  assert.equal(service.activeCount, 0);
});

test('spawn failures leave no record or quota behind', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.create({
      sessionId: SESSION,
      command: '/definitely/not/a/real/binary',
    }, { env: BASE_ENV }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
  assert.equal(service.activeCount, 0);
});

test('keeps a bounded UTF-8 tail and reports truncation without markers', async () => {
  const { service } = makeService();
  // Each '你' is 3 bytes in UTF-8; 7 bytes must retain exactly the last two
  // code points, cut between characters.
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sh',
    args: ['-c', 'printf "你你你"'],
    outputByteLimit: 7,
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: created.terminalId });
  assert.equal(output.output, '你你');
  assert.equal(output.truncated, true);
  assert.ok(!output.output.includes('\uFFFD'));
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });

  // outputByteLimit=0 is legal and keeps nothing.
  const zero = await service.create({
    sessionId: SESSION,
    command: '/bin/sh',
    args: ['-c', 'echo data'],
    outputByteLimit: 0,
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: zero.terminalId });
  const zeroOutput = service.output({ sessionId: SESSION, terminalId: zero.terminalId });
  assert.equal(zeroOutput.output, '');
  assert.equal(zeroOutput.truncated, true);
  await service.release({ sessionId: SESSION, terminalId: zero.terminalId });

  // Kimi may request more than Gian's hard cap. The command still runs, but
  // retained output remains bounded and truthfully reports truncation.
  const capped = await service.create({
    sessionId: SESSION,
    command: process.execPath,
    args: ['-e', `process.stdout.write('x'.repeat(${1024 * 1024 + 32}))`],
    outputByteLimit: 2 * 1024 * 1024,
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: capped.terminalId });
  const cappedOutput = service.output({ sessionId: SESSION, terminalId: capped.terminalId });
  const cappedBytes = Buffer.byteLength(cappedOutput.output, 'utf8');
  assert.ok(cappedBytes > 0);
  assert.ok(cappedBytes <= 1024 * 1024, `tail exceeded the hard cap: ${cappedBytes}`);
  assert.equal(cappedOutput.truncated, true);
  await service.release({ sessionId: SESSION, terminalId: capped.terminalId });
  assert.equal(service.activeCount, 0);
});

test('default byte limit keeps the newest 256 KiB as valid UTF-8', async () => {
  const { service } = makeService();
  const created = await service.create({
    sessionId: SESSION,
    command: '/usr/bin/awk',
    args: ['BEGIN { for (i = 0; i < 200000; i++) printf "\u4f60" }'],
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: created.terminalId });
  const bytes = Buffer.byteLength(output.output, 'utf8');
  assert.ok(bytes <= 256 * 1024, `tail exceeded the default limit: ${bytes}`);
  assert.equal(output.truncated, true);
  assert.ok(output.output.length > 0);
  // Boundary validity: the tail must re-decode identically from UTF-8.
  assert.equal(
    Buffer.from(output.output, 'utf8').toString('utf8'),
    output.output,
  );
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });
});

test('kill terminates the whole process group, keeps the handle and output', async () => {
  const { service } = makeService();
  const { terminalId, pgid } = await createWithPgid(service, 'sleep 30');
  assert.ok(groupAlive(pgid));

  await service.kill({ sessionId: SESSION, terminalId });
  const exit = await service.waitForExit({ sessionId: SESSION, terminalId });
  assert.equal(exit.exitCode, null);
  assert.equal(exit.signal, 'SIGTERM');
  assert.ok(groupAlive(pgid) === false, 'process group survived the kill harvest');
  // Handle survives kill; final output remains readable; release drops it.
  const output = service.output({ sessionId: SESSION, terminalId });
  assert.match(output.output, /^\d+\n/);
  await service.release({ sessionId: SESSION, terminalId });
  assert.equal(service.activeCount, 0);
});

test('release reaps background group members after the root already exited', async () => {
  const { service } = makeService();
  // Root sh exits immediately; the backgrounded sleep stays in the group.
  const { terminalId, pgid } = await createWithPgid(service, 'sleep 30 &');
  const exit = await service.waitForExit({ sessionId: SESSION, terminalId });
  assert.equal(exit.exitCode, 0);
  assert.ok(groupAlive(pgid), 'background member should keep the group alive');

  await service.release({ sessionId: SESSION, terminalId });
  assert.equal(groupAlive(pgid), false, 'release must reap leftover group members');
  assert.equal(service.activeCount, 0);
  assert.throws(
    () => service.output({ sessionId: SESSION, terminalId }),
    TerminalOwnershipError,
  );
});

test('unknown, cross-session, and stale ids are indistinguishable', async () => {
  const { service } = makeService();
  const other = new KimiTerminalService();
  const otherCwd = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-term-')));
  other.bindSession('native-other', otherCwd);

  assert.throws(
    () => service.output({ sessionId: SESSION, terminalId: 'does-not-exist' }),
    /Unknown terminal/,
  );
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  assert.throws(
    () => other.output({ sessionId: 'native-other', terminalId: created.terminalId }),
    /Unknown terminal/,
  );
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });
  assert.throws(
    () => service.output({ sessionId: SESSION, terminalId: created.terminalId }),
    /Unknown terminal/,
  );
  await other.drainRuntime();
});

test('enforces per-session and runtime handle quotas on allocated handles', async () => {
  const { service } = makeService({ maxPerSession: 1, maxTotal: 2 });
  const first = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  await assert.rejects(
    service.create({ sessionId: SESSION, command: '/bin/sleep', args: ['30'] }, { env: BASE_ENV }),
    /Session terminal limit \(1\)/,
  );
  await service.release({ sessionId: SESSION, terminalId: first.terminalId });
  const second = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  await service.release({ sessionId: SESSION, terminalId: second.terminalId });
});

test('runtime generation fencing makes old-generation ids unreachable but reapable', async () => {
  const { service } = makeService();
  const { terminalId, pgid } = await createWithPgid(service, 'sleep 30');
  assert.ok(groupAlive(pgid));

  service.advanceGeneration();
  // The ACP surface fails closed for the stale generation...
  assert.throws(
    () => service.output({ sessionId: SESSION, terminalId }),
    TerminalOwnershipError,
  );
  await assert.rejects(
    service.kill({ sessionId: SESSION, terminalId }),
    TerminalOwnershipError,
  );
  // ...while the cleanup path still reaps the stale group.
  await service.drainRuntime();
  assert.equal(groupAlive(pgid), false);
  assert.equal(service.activeCount, 0);
});



test('drainSession reaps every session terminal and keeps the binding for the next turn', async () => {
  const { service, cwd } = makeService();
  const first = await createWithPgid(service, 'sleep 30 &');
  const second = await createWithPgid(service, 'sleep 30 &');
  assert.ok(groupAlive(first.pgid) || groupAlive(second.pgid));

  await service.drainSession(SESSION);
  assert.equal(groupAlive(first.pgid), false);
  assert.equal(groupAlive(second.pgid), false);
  assert.equal(service.activeCount, 0);

  // The binding survived, so a fresh terminal for the same session works.
  const third = await service.create({
    sessionId: SESSION,
    command: '/bin/pwd',
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: third.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: third.terminalId });
  assert.equal(output.output.trim(), cwd);
  await service.release({ sessionId: SESSION, terminalId: third.terminalId });
});

test('drainSessionPermanently reaps, unbinds, and keeps creates rejected', async () => {
  const { service } = makeService();
  const helper = await createWithPgid(service, 'sleep 30 &');
  const orphan = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });

  await service.drainSessionPermanently(SESSION);
  assert.equal(groupAlive(helper.pgid), false);
  assert.equal(service.activeCount, 0);
  assert.throws(
    () => service.output({ sessionId: SESSION, terminalId: orphan.terminalId }),
    TerminalOwnershipError,
  );
  await assert.rejects(
    service.create({ sessionId: SESSION, command: '/bin/pwd' }, { env: BASE_ENV }),
    TerminalOwnershipError,
  );
});

test('a clean native-session rebind does not resurrect its old permanent drain', async () => {
  const { service, cwd } = makeService();

  // Host navigation can close one shared-Proxy attachment and later load the
  // same native Kimi session again. The completed permanent drain belongs to
  // the old attachment, not to every future turn of the native session.
  await service.drainSessionPermanently(SESSION);
  service.bindSession(SESSION, cwd);

  const resumedTurn = await service.create({
    sessionId: SESSION,
    command: '/bin/pwd',
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: resumedTurn.terminalId });
  await service.release({ sessionId: SESSION, terminalId: resumedTurn.terminalId });
  await service.drainSession(SESSION);

  const nextTurn = await service.create({
    sessionId: SESSION,
    command: '/bin/pwd',
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: nextTurn.terminalId });
  assert.equal(
    service.output({ sessionId: SESSION, terminalId: nextTurn.terminalId }).output.trim(),
    cwd,
  );
  await service.release({ sessionId: SESSION, terminalId: nextTurn.terminalId });
});

test('repeated and concurrent waits share one exit result', async () => {
  const { service } = makeService();
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['0.2'],
  }, { env: BASE_ENV });
  const [a, b, c] = await Promise.all([
    service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId }),
    service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId }),
    service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId }),
  ]);
  const late = await service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId });
  assert.deepEqual(a, { exitCode: 0, signal: null });
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
  assert.deepEqual(late, a);
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });
});

test('stdout and stderr merge in arrival order as valid UTF-8', async () => {
  const { service } = makeService();
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'kimi-term-')), 'both-streams.sh');
  writeFileSync(scriptPath, '#!/bin/sh\nprintf "out1\\n"; printf "err1\\n" >&2; printf "你-尾" >&2\n');
  spawnSync('/bin/chmod', ['+x', scriptPath]);
  const created = await service.create({
    sessionId: SESSION,
    command: scriptPath,
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: created.terminalId });
  assert.equal(
    Buffer.from(output.output, 'utf8').toString('utf8'),
    output.output,
  );
  for (const piece of ['out1', 'err1', '你-尾']) {
    assert.ok(output.output.includes(piece), `missing ${piece} in merged output`);
  }
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });
});

test('tail truncation never strands a lone surrogate (Finding 1)', () => {
  const emoji = '\u{1F600}'.repeat(3);
  // 4 bytes retain exactly one emoji.
  assert.equal(tailWithinByteLimit(emoji, 4), '\u{1F600}');
  // Sub-emoji limits return the empty suffix instead of half an emoji.
  assert.equal(tailWithinByteLimit(emoji, 3), '');
  assert.equal(tailWithinByteLimit(emoji, 2), '');
  assert.equal(tailWithinByteLimit(emoji, 1), '');
  assert.equal(tailWithinByteLimit(emoji, 0), '');
  // BMP + supplementary mixed boundary: 'a'(1) '你'(3) '😀'(4).
  const mixed = 'a\u4f60\u{1F600}b';
  for (let limit = 0; limit <= Buffer.byteLength(mixed, 'utf8') + 2; limit += 1) {
    const tail = tailWithinByteLimit(mixed, limit);
    assert.equal(
      Buffer.from(tail, 'utf8').toString('utf8'),
      tail,
      `limit ${limit} produced invalid UTF-16: ${JSON.stringify(tail)}`,
    );
    assert.ok(Buffer.byteLength(tail, 'utf8') <= limit, `limit ${limit} exceeded`);
    // The tail must be a genuine suffix (nothing prepended).
    assert.ok(mixed.endsWith(tail), `limit ${limit} tail is not a suffix`);
  }
  // Exact byte boundaries: a=1, 你=3, 😀=4 → total 8.
  assert.equal(tailWithinByteLimit('a\u4f60\u{1F600}', 8), 'a\u4f60\u{1F600}');
  assert.equal(tailWithinByteLimit('a\u4f60\u{1F600}', 7), '\u4f60\u{1F600}');
  assert.equal(tailWithinByteLimit('a\u4f60\u{1F600}', 4), '\u{1F600}');
});

test('emoji bytes split across stdout chunks survive the bounded tail (Finding 1)', async () => {
  const { service } = makeService();
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sh',
    args: ['-c', 'printf "\\xf0\\x9f\\x98\\x80\\xf0\\x9f\\x98\\x80\\xf0\\x9f\\x98\\x80"; printf "\\xf0\\x9f\\x98\\x80\\xf0\\x9f\\x98\\x80"'],
    outputByteLimit: 12,
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: created.terminalId });
  const output = service.output({ sessionId: SESSION, terminalId: created.terminalId });
  // 12 bytes = exactly three emoji regardless of chunk boundaries.
  assert.equal(output.output, '\u{1F600}'.repeat(3));
  assert.equal(output.truncated, true);
  assert.equal(Buffer.from(output.output, 'utf8').toString('utf8'), output.output);
  await service.release({ sessionId: SESSION, terminalId: created.terminalId });
});

type GroupState = { alive: boolean; termWorks: boolean; killWorks: boolean; signals: string[] };

/** The controlled adapter never signals the REAL process, so scripted tests
 *  must reap leaked children themselves. */
function killRealGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Controlled adapter: real children spawn, but signal delivery and group
 *  liveness are scripted so cleanup failures are deterministic. */
function makeControlledService(
  groups: Map<number, GroupState>,
  overrides: {
    groupExists?: (pgid: number) => boolean;
    exitSettleMs?: number;
  } = {},
) {
  const adapter = {
    signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) {
      if (signal === 0) return;
      const group = groups.get(pgid)!;
      group.signals.push(signal);
      if (signal === 'SIGTERM' && group.termWorks) group.alive = false;
      if (signal === 'SIGKILL' && group.killWorks) group.alive = false;
    },
    groupExists(pgid: number) {
      const scripted = overrides.groupExists;
      if (scripted) return scripted(pgid);
      return groups.get(pgid)?.alive ?? false;
    },
  };
  const service = new KimiTerminalService({
    processGroupAdapter: adapter,
    termGraceMs: 40,
    groupVerifyMs: 40,
    groupPollMs: 4,
    exitSettleMs: overrides.exitSettleMs ?? 60,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  service.bindSession(SESSION, realpathSync(mkdtempSync(join(tmpdir(), 'kimi-term-'))));
  return service;
}

test('scripted unkillable group keeps the record and fails the drain (Finding 3)', async () => {
  const groups = new Map<number, GroupState>();
  const service = makeControlledService(groups);
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  const record = service.recordForTest(created.terminalId)!;
  const pgid = record.pid;
  groups.set(pgid, { alive: true, termWorks: false, killWorks: false, signals: [] });

  await assert.rejects(
    service.kill({ sessionId: SESSION, terminalId: created.terminalId }),
    (error: unknown) => error instanceof TerminalCleanupError && error.pgid === pgid,
  );
  assert.match(groups.get(pgid)!.signals.join(','), /SIGTERM/);
  assert.match(groups.get(pgid)!.signals.join(','), /SIGKILL/);
  // Not released, not deleted: still owned and diagnosable.
  assert.equal(service.activeCount, 1);
  assert.ok(service.recordForTest(created.terminalId)?.lastCleanupError?.includes('survived SIGKILL'));

  // Turn-scoped drain fails with the failing terminal named, barrier stays.
  await assert.rejects(
    service.drainSession(SESSION),
    (error: unknown) => error instanceof TerminalCleanupError
      && error.message.includes(created.terminalId),
  );
  // Create stays blocked while the failed barrier is in force.
  await assert.rejects(
    service.create({ sessionId: SESSION, command: '/bin/pwd' }, { env: BASE_ENV }),
    /blocked for this session/,
  );
  killRealGroup(pgid);
});

test('EPERM while signaling becomes a TerminalCleanupError with the cause (Finding 3)', async () => {
  const groups = new Map<number, GroupState>();
  const service = makeControlledService(groups);
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  const pgid = service.recordForTest(created.terminalId)!.pid;
  groups.set(pgid, { alive: true, termWorks: false, killWorks: false, signals: [] });
  const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
  const originalSignal = (service as unknown as {
    groups: { signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL' | 0): void };
  }).groups.signalGroup;
  (service as unknown as {
    groups: { signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL' | 0): void };
  }).groups.signalGroup = (signalPgid, signal) => {
    if (signal !== 0) throw eperm;
    originalSignal(signalPgid, signal);
  };

  await assert.rejects(
    service.release({ sessionId: SESSION, terminalId: created.terminalId }),
    (error: unknown) => error instanceof TerminalCleanupError
      && (error as TerminalCleanupError).cause === eperm,
  );
  assert.equal(service.activeCount, 1, 'failed record must stay for diagnosis');
  killRealGroup(pgid);
});

test('a root exit that never settles is bounded and fails the cleanup (Finding 3)', async () => {
  const groups = new Map<number, GroupState>();
  const service = makeControlledService(groups, { groupExists: () => false });
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  // The root never exits within the scripted settle budget; group is absent
  // so release goes straight to the bounded exit wait.
  await assert.rejects(
    service.release({ sessionId: SESSION, terminalId: created.terminalId }),
    (error: unknown) => error instanceof TerminalCleanupError
      && error.message.includes('did not settle'),
  );
  assert.equal(service.activeCount, 1);
  assert.ok(service.recordForTest(created.terminalId)?.lastCleanupError?.includes('did not settle'));
  killRealGroup(service.recordForTest(created.terminalId)!.pid);
});

test('drain keeps reaping healthy records when a sibling fails and aggregates (Finding 3)', async () => {
  const groups = new Map<number, GroupState>();
  // The scripted adapter never signals real processes; the healthy record's
  // root must exit on its own within the settle budget.
  const service = makeControlledService(groups, { exitSettleMs: 1_000 });
  const healthy = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['0.2'],
  }, { env: BASE_ENV });
  const doomed = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['30'],
  }, { env: BASE_ENV });
  const doomedPgid = service.recordForTest(doomed.terminalId)!.pid;
  const healthyPgid = service.recordForTest(healthy.terminalId)!.pid;
  groups.set(doomedPgid, { alive: true, termWorks: false, killWorks: false, signals: [] });
  groups.set(healthyPgid, { alive: true, termWorks: true, killWorks: true, signals: [] });

  await assert.rejects(
    service.drainSession(SESSION),
    (error: unknown) => error instanceof TerminalCleanupError
      && error.message.includes(doomed.terminalId),
  );
  assert.equal(service.activeCount, 1, 'only the failed record may remain');
  assert.equal(service.recordForTest(doomed.terminalId)?.pid, doomedPgid, 'failed record retained');
  assert.equal(service.recordForTest(healthy.terminalId), undefined, 'healthy record reaped');
  killRealGroup(healthyPgid);
  killRealGroup(doomedPgid);
});

test('create is refused for the whole drain window and re-enabled only on success (Finding 2)', async () => {
  const groups = new Map<number, GroupState>();
  const service = makeControlledService(groups, { exitSettleMs: 1_000 });
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sh',
    args: ['-c', 'sleep 0.2'],
  }, { env: BASE_ENV });
  const pgid = service.recordForTest(created.terminalId)!.pid;
  groups.set(pgid, { alive: true, termWorks: true, killWorks: true, signals: [] });

  const drain = service.drainSession(SESSION);
  // While the harvest is in flight, a concurrent create must be refused.
  await assert.rejects(
    service.create({ sessionId: SESSION, command: '/bin/pwd' }, { env: BASE_ENV }),
    /blocked for this session/,
  );
  await drain;
  assert.equal(groupAlive(pgid), false);
  assert.equal(service.activeCount, 0);
  // Success lifts the barrier: the next turn can create again.
  const next = await service.create({
    sessionId: SESSION,
    command: '/bin/pwd',
  }, { env: BASE_ENV });
  await service.waitForExit({ sessionId: SESSION, terminalId: next.terminalId });
  await service.release({ sessionId: SESSION, terminalId: next.terminalId });
});

test('a failed drain keeps the barrier; close drains permanently (Finding 2)', async () => {
  const groups = new Map<number, GroupState>();
  const service = makeControlledService(groups, { exitSettleMs: 1_000 });
  const created = await service.create({
    sessionId: SESSION,
    command: '/bin/sleep',
    args: ['0.2'],
  }, { env: BASE_ENV });
  const pgid = service.recordForTest(created.terminalId)!.pid;
  groups.set(pgid, { alive: true, termWorks: false, killWorks: false, signals: [] });

  await assert.rejects(service.drainSession(SESSION), TerminalCleanupError);
  await assert.rejects(
    service.create({ sessionId: SESSION, command: '/bin/pwd' }, { env: BASE_ENV }),
    /blocked for this session/,
  );

  // The close path's permanent drain reaps and deletes the binding; creates
  // stay rejected through the close window and after it (ownership).
  groups.set(pgid, { alive: true, termWorks: true, killWorks: true, signals: [] });
  await service.drainSessionPermanently(SESSION);
  await assert.rejects(
    service.create({ sessionId: SESSION, command: '/bin/pwd' }, { env: BASE_ENV }),
    TerminalOwnershipError,
  );
  killRealGroup(pgid);
});
