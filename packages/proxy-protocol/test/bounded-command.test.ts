import { strict as assert } from 'node:assert';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BoundedCommandError, processGroupIsEmpty, runBoundedCommand } from '../src/node.js';

async function script(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

test('bounded command rejects flood, nonzero-with-version, and signals', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-bounded-cmd-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  const flood = await script(root, 'flood.sh', '#!/bin/sh\nwhile true; do printf x; done\n');
  await assert.rejects(
    // Under the full parallel quick gate the process can wait several seconds
    // for CPU before it fills stdout. Keep the timeout well outside that
    // scheduling window so this assertion proves the buffer boundary rather
    // than racing the unrelated timeout boundary.
    () => runBoundedCommand(flood, [], { timeoutMs: 10_000, maxBufferBytes: 4_096 }),
    (error: unknown) => error instanceof BoundedCommandError && /exceeded/.test(error.message),
  );

  const nonzero = await script(root, 'nonzero.sh', '#!/bin/sh\necho tool 1.2.3\nexit 3\n');
  await assert.rejects(
    () => runBoundedCommand(nonzero, [], { timeoutMs: 2_000 }),
    (error: unknown) => error instanceof BoundedCommandError && error.exitCode === 3,
  );

  const signaled = await script(root, 'signal.sh', '#!/bin/sh\nkill -s TERM $$\n');
  await assert.rejects(
    () => runBoundedCommand(signaled, [], { timeoutMs: 2_000 }),
    (error: unknown) => error instanceof BoundedCommandError && error.signal === 'SIGTERM',
  );

  const hung = await script(
    root,
    'hung.mjs',
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
process.on('SIGHUP', () => {});
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setTimeout(()=>{},30000)"], { stdio: 'ignore' });
await new Promise((resolve, reject) => {
  child.once('spawn', resolve);
  child.once('error', reject);
});
child.unref();
setInterval(() => {}, 1000);
await new Promise(() => {});
`,
  );
  await assert.rejects(
    () => runBoundedCommand(hung, [], { timeoutMs: 400, terminateGraceMs: 100 }),
    (error: unknown) => error instanceof BoundedCommandError && error.timedOut,
  );
});

test('bounded command rejects an exit-0 leader that leaves a descendant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-bounded-leftover-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const leftover = await script(root, 'leftover.sh', `#!/bin/sh
set +m
trap "" HUP TERM
/bin/sleep 30 >/dev/null 2>&1 &
printf 'tool 1.2.3\\n'
exit 0
`);
  await assert.rejects(
    () => runBoundedCommand(leftover, [], { timeoutMs: 2_000, terminateGraceMs: 100 }),
    (error: unknown) => error instanceof BoundedCommandError && /descendant/i.test(error.message),
  );

  const ok = await script(root, 'ok.sh', '#!/bin/sh\necho tool 1.2.3\n');
  const result = await runBoundedCommand(ok, [], { timeoutMs: 2_000 });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /1\.2\.3/);
});

test('bounded command observes ESRCH before the Promise settles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-bounded-esrch-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const { readFile } = await import('node:fs/promises');

  const leftoverPgid = join(root, 'leftover.pgid');
  const leftover = await script(root, 'leftover-pgid.sh', `#!/bin/sh
set +m
trap "" HUP TERM
printf '%s\\n' "$$" > ${JSON.stringify(leftoverPgid)}
/bin/sleep 30 >/dev/null 2>&1 &
printf 'tool 1.2.3\\n'
exit 0
`);
  let leftoverSettled = false;
  const leftoverRun = runBoundedCommand(leftover, [], {
    timeoutMs: 2_000,
    terminateGraceMs: 100,
  }).finally(() => {
    leftoverSettled = true;
  });
  const leftoverOutcome = leftoverRun.then(
    () => null,
    (error: unknown) => error,
  );
  let leftoverGroup = 0;
  for (let attempt = 0; attempt < 1000 && leftoverGroup === 0; attempt += 1) {
    try {
      leftoverGroup = Number((await readFile(leftoverPgid, 'utf8')).trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(leftoverGroup > 0);
  while (!processGroupIsEmpty(leftoverGroup)) {
    assert.equal(leftoverSettled, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const leftoverError = await leftoverOutcome;
  assert.equal(leftoverSettled, true);
  assert.ok(leftoverError instanceof BoundedCommandError && /descendant/i.test(leftoverError.message));

  const termPgid = join(root, 'term.pgid');
  const signaled = await script(root, 'term-pgid.sh', `#!/bin/sh
printf '%s\\n' "$$" > ${JSON.stringify(termPgid)}
kill -s TERM $$
`);
  let termSettled = false;
  const termRun = runBoundedCommand(signaled, [], { timeoutMs: 2_000 }).finally(() => {
    termSettled = true;
  });
  const termOutcome = termRun.then(
    () => null,
    (error: unknown) => error,
  );
  let termGroup = 0;
  for (let attempt = 0; attempt < 200 && termGroup === 0; attempt += 1) {
    try {
      termGroup = Number((await readFile(termPgid, 'utf8')).trim());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(termGroup > 0);
  while (!processGroupIsEmpty(termGroup)) {
    assert.equal(termSettled, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const termError = await termOutcome;
  assert.equal(termSettled, true);
  assert.ok(termError instanceof BoundedCommandError && termError.signal === 'SIGTERM');
});

test('first ESRCH permanently disables later probes and signals for that PGID', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-bounded-esrch-reuse-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const ok = await script(root, 'ok.sh', '#!/bin/sh\necho tool 1.2.3\n');
  const probes: number[] = [];
  const signals: Array<{ groupId: number; signal: NodeJS.Signals }> = [];
  const result = await runBoundedCommand(ok, [], {
    timeoutMs: 2_000,
    hooks: {
      probeProcessGroup(groupId) {
        probes.push(groupId);
        if (probes.length === 1) return true;
        return false;
      },
      signalProcessGroup(groupId, signal) {
        signals.push({ groupId, signal });
      },
    },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /1\.2\.3/);
  assert.equal(probes.length, 1);
  assert.deepEqual(signals, []);
});

test('bounded command drains a large final stdout chunk after exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-bounded-drain-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const big = await script(root, 'big-final.mjs', `#!/usr/bin/env node
const chunk = 'x'.repeat(64 * 1024);
process.stdout.write('tool 1.2.3\\n');
process.stdout.write(chunk);
`);
  const result = await runBoundedCommand(big, [], {
    timeoutMs: 4_000,
    maxBufferBytes: 256 * 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tool 1\.2\.3/);
  assert.equal(result.stdout.endsWith('x'.repeat(64 * 1024)), true);
});
