import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  probeKimiRuntime,
  recordSelectedKimiActivation,
  resetKimiActivationMemoForTests,
} from '../src/runtime/discover.js';
import {
  compareKimiVersions,
  KimiDataVersionError,
  KimiSessionStoreGuard,
} from '../src/runtime/session-store.js';

async function populatedKimiHome(root: string): Promise<string> {
  const home = join(root, 'kimi-home');
  await mkdir(join(home, 'sessions', 'wd_fixture', 'session_fixture'), { recursive: true });
  await writeFile(
    join(home, 'session_index.jsonl'),
    '{"sessionId":"session_fixture","sessionDir":"fixture","workDir":"fixture"}\n',
  );
  return home;
}

test('Kimi version ordering follows SemVer precedence', () => {
  assert.equal(compareKimiVersions('0.31.1', '0.31.0'), 1);
  assert.equal(compareKimiVersions('0.31.1-beta.2', '0.31.1-beta.10'), -1);
  assert.equal(compareKimiVersions('0.31.1', '0.31.1-rc.1'), 1);
  assert.equal(compareKimiVersions('0.31.1+build.2', '0.31.1+build.1'), 0);
});

test('activation records a monotonic Kimi session-store floor and reports downgrade without blocking', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-proxy-floor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = new KimiSessionStoreGuard(join(root, 'kimi-home'));

  assert.deepEqual(await guard.evaluateCompatibility('0.31.1'), []);
  await guard.recordActivation('0.31.1');
  const downgrade = await guard.evaluateCompatibility('0.30.0');
  assert.equal(downgrade.length, 1);
  assert.equal(downgrade[0]?.kind, 'KIMI_STORE_DOWNGRADE');
  assert.deepEqual(await guard.evaluateCompatibility('0.32.0'), []);
  await Promise.all([
    guard.recordActivation('0.31.1'),
    guard.recordActivation('0.32.0'),
  ]);
  assert.deepEqual(
    (await readdir(join(root, 'kimi-home', '.gian-session-store-compat', 'v1'))).sort(),
    ['0.31.1', '0.32.0'],
  );
});

test('existing Kimi sessions report a missing owner version without blocking', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-proxy-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = await populatedKimiHome(root);
  const guard = new KimiSessionStoreGuard(home);
  const ownerMissing = await guard.evaluateCompatibility('0.31.1');
  assert.equal(ownerMissing.length, 1);
  assert.equal(ownerMissing[0]?.kind, 'KIMI_STORE_OWNER_MISSING');
  assert.deepEqual(await guard.evaluateCompatibility('0.31.1', '0.31.1'), []);
  const downgrade = await guard.evaluateCompatibility('0.30.0', '0.31.1');
  assert.equal(downgrade[0]?.kind, 'KIMI_STORE_DOWNGRADE');
});

test('unknown Kimi compatibility schemas and versions are reported without blocking', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-proxy-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'kimi-home');
  await mkdir(join(home, '.gian-session-store-compat', 'v2'), { recursive: true });
  const guard = new KimiSessionStoreGuard(home);
  const unknownSchema = await guard.evaluateCompatibility('0.31.1');
  assert.equal(unknownSchema.length, 1);
  assert.equal(unknownSchema[0]?.kind, 'KIMI_STORE_UNKNOWN_SCHEMA');

  await rm(join(home, '.gian-session-store-compat'), { recursive: true, force: true });
  await mkdir(join(home, '.gian-session-store-compat', 'v1'), { recursive: true });
  await writeFile(join(home, '.gian-session-store-compat', 'v1', 'future-format'), '');
  const unknownVersion = await guard.evaluateCompatibility('0.31.1');
  assert.equal(unknownVersion[0]?.kind, 'KIMI_STORE_UNKNOWN_SCHEMA');
  assert.equal(new KimiDataVersionError('KIMI_STORE_INCOMPATIBLE', 'x').name, 'KimiDataVersionError');
});

test('session-boundary activation fails closed on a missing managed path', async () => {
  await assert.rejects(
    () => recordSelectedKimiActivation('/managed/kimi'),
    (error: unknown) => (
      error instanceof KimiDataVersionError && error.kind === 'KIMI_ACTIVATION_UNPROBEABLE'
    ),
  );
});

test('session-boundary activation fails closed when --version is not SemVer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-proxy-nosemver-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'kimi');
  await writeFile(bin, '#!/bin/sh\necho not-a-version\n');
  await chmod(bin, 0o755);
  await assert.rejects(
    () => recordSelectedKimiActivation(bin),
    (error: unknown) => (
      error instanceof KimiDataVersionError && error.kind === 'KIMI_ACTIVATION_UNPROBEABLE'
    ),
  );
});

test('existing store probe-ready and activation use the same official owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-store-owner-'));
  const previousHome = process.env.HOME;
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  t.after(async () => {
    resetKimiActivationMemoForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    await rm(root, { recursive: true, force: true });
  });
  resetKimiActivationMemoForTests();
  const home = await populatedKimiHome(root);
  const official = join(home, 'bin', 'kimi');
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(official, '#!/bin/sh\necho kimi 0.38.0\n');
  await chmod(official, 0o755);
  process.env.HOME = root;
  process.env.KIMI_CODE_HOME = home;

  const probed = await probeKimiRuntime(official);
  assert.equal(probed.version, '0.38.0');
  await recordSelectedKimiActivation(official);
  assert.deepEqual(await readdir(join(home, '.gian-session-store-compat', 'v1')), ['0.38.0']);
});

test('alternate newer and older official owners: downgrade is advisory, the floor stays monotonic', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-alt-owner-'));
  const previousHome = process.env.HOME;
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  t.after(async () => {
    resetKimiActivationMemoForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    await rm(root, { recursive: true, force: true });
  });
  const home = await populatedKimiHome(root);
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(join(home, 'bin', 'kimi'), '#!/bin/sh\necho kimi 0.38.0\n');
  await chmod(join(home, 'bin', 'kimi'), 0o755);
  const newer = join(root, 'newer-kimi');
  const older = join(root, 'older-kimi');
  await writeFile(newer, '#!/bin/sh\necho kimi 0.39.0\n');
  await writeFile(older, '#!/bin/sh\necho kimi 0.37.0\n');
  await chmod(newer, 0o755);
  await chmod(older, 0o755);
  process.env.HOME = root;
  process.env.KIMI_CODE_HOME = home;

  resetKimiActivationMemoForTests();
  const newerProbe = await probeKimiRuntime(newer);
  assert.equal(newerProbe.version, '0.39.0');
  await recordSelectedKimiActivation(newer);
  assert.deepEqual(await readdir(join(home, '.gian-session-store-compat', 'v1')), ['0.39.0']);

  // An older binary is never blocked anymore (ADR-0080): activation proceeds
  // and records its marker; the floor stays at the highest observed version.
  resetKimiActivationMemoForTests();
  const olderProbe = await probeKimiRuntime(older);
  assert.equal(olderProbe.version, '0.37.0');
  await recordSelectedKimiActivation(older);
  assert.deepEqual(
    (await readdir(join(home, '.gian-session-store-compat', 'v1'))).sort(),
    ['0.37.0', '0.39.0'],
  );
  const guard = new KimiSessionStoreGuard(home);
  const conditions = await guard.evaluateCompatibility('0.36.0');
  assert.equal(conditions[0]?.kind, 'KIMI_STORE_DOWNGRADE');
});

test('corrupt metadata and floor write failure are advisory and never block activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-fail-closed-'));
  const writeHome = join(root, 'write', 'kimi-home');
  const previousHome = process.env.HOME;
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  t.after(async () => {
    resetKimiActivationMemoForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    await chmod(writeHome, 0o755).catch(() => undefined);
    await chmod(join(writeHome, 'bin'), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  process.env.HOME = root;

  const corruptHome = await populatedKimiHome(join(root, 'corrupt'));
  await mkdir(join(corruptHome, 'bin'), { recursive: true });
  const corruptBin = join(corruptHome, 'bin', 'kimi');
  await writeFile(corruptBin, '#!/bin/sh\necho kimi 0.38.0\n');
  await chmod(corruptBin, 0o755);
  await mkdir(join(corruptHome, '.gian-session-store-compat', 'v1'), { recursive: true });
  await writeFile(join(corruptHome, '.gian-session-store-compat', 'v1', 'not-a-version'), '');
  process.env.KIMI_CODE_HOME = corruptHome;
  resetKimiActivationMemoForTests();
  const corruptProbe = await probeKimiRuntime(corruptBin);
  assert.equal(corruptProbe.version, '0.38.0');
  await recordSelectedKimiActivation(corruptBin);

  await populatedKimiHome(join(root, 'write'));
  await mkdir(join(writeHome, 'bin'), { recursive: true });
  const writeBin = join(writeHome, 'bin', 'kimi');
  const countFile = join(root, 'write-version-count');
  await writeFile(writeBin, `#!/bin/sh
echo $(( $(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0) + 1 )) > ${JSON.stringify(countFile)}
echo kimi 0.38.0
`);
  await chmod(writeBin, 0o755);
  process.env.KIMI_CODE_HOME = writeHome;
  resetKimiActivationMemoForTests();
  await chmod(writeHome, 0o555);
  // The floor cannot be recorded in a read-only home, but activation still
  // proceeds — and the successful activation is memoized, so the binary is
  // not re-probed on the second call.
  await recordSelectedKimiActivation(writeBin);
  const firstCount = Number((await readFile(countFile, 'utf8').catch(() => '0')).trim() || '0');
  await recordSelectedKimiActivation(writeBin);
  const secondCount = Number((await readFile(countFile, 'utf8')).trim());
  assert.equal(secondCount, firstCount);
});

test('two sessions share one successful activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-one-activation-'));
  const previousHome = process.env.HOME;
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  t.after(async () => {
    resetKimiActivationMemoForTests();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    await rm(root, { recursive: true, force: true });
  });
  const home = await populatedKimiHome(root);
  await mkdir(join(home, 'bin'), { recursive: true });
  const official = join(home, 'bin', 'kimi');
  const countFile = join(root, 'version-count');
  await writeFile(official, `#!/bin/sh
echo $(( $(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0) + 1 )) > ${JSON.stringify(countFile)}
echo kimi 0.38.0
`);
  await chmod(official, 0o755);
  process.env.HOME = root;
  process.env.KIMI_CODE_HOME = home;
  resetKimiActivationMemoForTests();
  await recordSelectedKimiActivation(official);
  await recordSelectedKimiActivation(official);
  assert.equal(Number((await readFile(countFile, 'utf8')).trim()), 1);
});

test('session-boundary activation records only after a real binary reports SemVer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-proxy-activate-'));
  const previousHome = process.env.HOME;
  const previousKimiHome = process.env.KIMI_CODE_HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimiHome;
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'kimi-home');
  const bin = join(root, 'kimi');
  process.env.HOME = root;
  process.env.KIMI_CODE_HOME = home;
  await writeFile(bin, '#!/bin/sh\necho kimi 0.38.0\n');
  await chmod(bin, 0o755);
  await recordSelectedKimiActivation(bin);
  assert.deepEqual(await readdir(join(home, '.gian-session-store-compat', 'v1')), ['0.38.0']);
});
