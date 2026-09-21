import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { dshHome, ensureGianProfile, resolveBridgePackageDir } from '../src/runtime/profile.js';

async function makeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeBridgePackage(root: string, name = '@gian/dsh-bridge'): Promise<string> {
  const dir = join(root, 'bridge');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

function envFor(home: string, bridgeDir: string): NodeJS.ProcessEnv {
  return { DSH_HOME: home, GIAN_DSH_BRIDGE_PACKAGE_DIR: bridgeDir };
}

const LINK_PATH = ['profiles', 'gian', 'node_modules', '@gian', 'dsh-bridge'];

test('dshHome trims DSH_HOME and defaults to ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: '  /tmp/dsh-custom  ' }), '/tmp/dsh-custom');
  assert.match(dshHome({}), /\.dsh$/);
});

test('first boot creates the gian profile manifest and bridge symlink', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.equal(result.profileDir, join(home, 'profiles', 'gian'));
  assert.equal(result.bridgePackageDir, bridge);
  assert.ok(result.actions.length > 0);
  const manifest = JSON.parse(
    await readFile(join(home, 'profiles', 'gian', 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
  assert.equal(manifest.dependencies['@gian/dsh-bridge'], `file:${bridge}`);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@gian/dsh-bridge']);
  const linkPath = join(home, ...LINK_PATH);
  assert.ok((await lstat(linkPath)).isSymbolicLink());
  assert.equal(await readlink(linkPath), bridge);
});

test('a consistent profile is left untouched', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);

  await ensureGianProfile(envFor(home, bridge));
  const manifestPath = join(home, 'profiles', 'gian', 'package.json');
  const before = await readFile(manifestPath, 'utf8');
  const second = await ensureGianProfile(envFor(home, bridge));

  assert.deepEqual(second.actions, []);
  assert.equal(await readFile(manifestPath, 'utf8'), before);
  assert.equal(await readlink(join(home, ...LINK_PATH)), bridge);
});

test('a broken bridge symlink is repaired', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  await ensureGianProfile(envFor(home, bridge));

  const linkPath = join(home, ...LINK_PATH);
  await rm(linkPath);
  await symlink(join(root, 'missing-target'), linkPath, 'dir');

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.equal(await readlink(linkPath), bridge);
  assert.ok(result.actions.some((action) => action.includes('symlink')));
});

test('a bridge symlink pointing at the wrong target is repaired', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  const other = await makeBridgePackage(join(root, 'other'), '@gian/other');
  await ensureGianProfile(envFor(home, bridge));

  const linkPath = join(home, ...LINK_PATH);
  await rm(linkPath);
  await symlink(other, linkPath, 'dir');

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.equal(await readlink(linkPath), bridge);
  assert.ok(result.actions.some((action) => action.includes('symlink')));
});

test('a drifted package.json is rewritten to the canonical manifest', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  await ensureGianProfile(envFor(home, bridge));

  const manifestPath = join(home, 'profiles', 'gian', 'package.json');
  await writeFile(manifestPath, JSON.stringify({
    name: 'gian-dsh-profile',
    private: true,
    dependencies: { '@gian/dsh-bridge': 'file:/somewhere/stale' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }), 'utf8');

  const result = await ensureGianProfile(envFor(home, bridge));

  assert.ok(result.actions.some((action) => action.includes('package.json')));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies: Record<string, string>;
    dsh: { profile: { bundles: string[] } };
  };
  assert.equal(manifest.dependencies['@gian/dsh-bridge'], `file:${bridge}`);
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@gian/dsh-bridge']);
});

test('an explicit bridge dir that is not @gian/dsh-bridge fails closed', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const wrong = await makeBridgePackage(join(root, 'wrong'), '@gian/not-the-bridge');

  await assert.rejects(
    () => ensureGianProfile(envFor(home, wrong)),
    /is not a @gian\/dsh-bridge package directory/,
  );
  await assert.rejects(
    () => resolveBridgePackageDir({ GIAN_DSH_BRIDGE_PACKAGE_DIR: join(root, 'does-not-exist') }),
    /is not a @gian\/dsh-bridge package directory/,
  );
  assert.equal(await lstat(home).catch(() => null), null, 'no profile was created');
});

test('a real directory at the symlink path is refused, not replaced', async (t) => {
  const root = await makeRoot(t);
  const home = join(root, 'home');
  const bridge = await makeBridgePackage(root);
  await ensureGianProfile(envFor(home, bridge));

  const linkPath = join(home, ...LINK_PATH);
  await rm(linkPath);
  await mkdir(linkPath, { recursive: true });

  await assert.rejects(
    () => ensureGianProfile(envFor(home, bridge)),
    /exists and is not a symlink/,
  );
});

test('the development fallback resolves the sibling dsh-bridge package', async () => {
  const dir = await resolveBridgePackageDir({});
  assert.ok(dir.endsWith(join('proxies', 'dsh-bridge')));
});

test('a packaged Proxy prefers its bound Bridge over a legacy App Bridge', async t => {
  const root = await makeRoot(t);
  const bridge = await makeBridgePackage(root);
  const resolved = await resolveBridgePackageDir(
    { GIAN_DSH_BRIDGE_PACKAGE_DIR: join(root, 'old-app-bridge') },
    pathToFileURL(join(root, 'proxy.mjs')).href,
  );
  assert.equal(resolved, bridge);
});
