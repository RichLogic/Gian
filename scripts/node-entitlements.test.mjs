import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const hook = require('../packages/desktop/ci-sign-node.cjs');
const desktopDir = fileURLToPath(new URL('../packages/desktop/', import.meta.url));
const desktopPackage = JSON.parse(readFileSync(new URL('../packages/desktop/package.json', import.meta.url), 'utf8'));
const readResource = (name) => readFileSync(new URL(`../packages/desktop/resources/${name}`, import.meta.url), 'utf8');

test('bundled Node entitlements are the only stable library-validation exception', () => {
  const node = readResource('entitlements.mac.node.plist');
  assert.match(node, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/);
  assert.match(node, /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/);
  // The declared rationale is managed JS runtimes loading upstream-adhoc-signed native addons.
  assert.match(node, /adhoc-signed/i);
  for (const name of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    assert.doesNotMatch(readResource(name), /disable-library-validation/, `${name} must stay strict`);
  }
});

test('packaging wires the Node signing hook as the bundled Node\'s only signer', () => {
  assert.equal(desktopPackage.build.afterPack, './ci-sign-node.cjs');
  const mac = desktopPackage.build.mac;
  assert.equal(mac.hardenedRuntime, true);
  const ignores = [mac.signIgnore ?? []].flat();
  const pattern = ignores.find((entry) => new RegExp(entry).test('/tmp/out/mac-arm64/Gian.app/Contents/Resources/runtime/node'));
  assert.ok(pattern, 'mac.signIgnore must cover the bundled Node path');
  const ignore = new RegExp(pattern);
  for (const other of [
    '/tmp/out/mac-arm64/Gian.app/Contents/Resources/runtime/node_modules/@koromix/koffi/koffi.node',
    '/tmp/out/mac-arm64/Gian.app/Contents/Resources/runtime/NODE-LICENSE',
    '/tmp/out/mac-arm64/Gian.app/Contents/Frameworks/Gian Helper.app/Contents/MacOS/Gian Helper',
  ]) {
    assert.equal(ignore.test(other), false, `signIgnore must not exclude ${other}`);
  }
  // electron-builder must not also sign the bundled Node with inherited entitlements.
  assert.ok(!('binaries' in mac), 'mac.binaries must not re-add the bundled Node');
  const hookSource = readFileSync(new URL('../packages/desktop/ci-sign-node.cjs', import.meta.url), 'utf8');
  assert.match(hookSource, /entitlements\.mac\.node\.plist/);
  assert.match(hookSource, /--timestamp=none/);
  assert.match(hookSource, /Developer ID Application/);
});

test('afterPack ignores non-macOS packaging', async () => {
  await assert.doesNotReject(() => hook({ electronPlatformName: 'linux' }));
});

const darwin = process.platform === 'darwin';
test('hook ad-hoc signs the bundled Node with hardened runtime and both entitlements', { skip: !darwin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-node-sign-'));
  try {
    const appPath = join(root, 'Fixture.app');
    const runtimeDir = join(appPath, 'Contents', 'Resources', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    copyFileSync('/usr/bin/true', join(runtimeDir, 'node'));
    const node = hook.signBundledNode(appPath, { identity: '-', projectDir: desktopDir });
    execFileSync('codesign', ['--verify', '--strict', node]);
    const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', node], { encoding: 'utf8' });
    assert.match(xml, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/);
    assert.match(xml, /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
    const flags = execFileSync('/bin/sh', ['-c', `codesign -dv "$1" 2>&1`, 'sh', node], { encoding: 'utf8' });
    assert.match(flags, /flags=0x[0-9a-f]+\([^)]*runtime\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hook rejects a missing bundled Node instead of shipping an unsigned runtime', { skip: !darwin }, () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-node-sign-missing-'));
  try {
    assert.throws(
      () => hook.signBundledNode(join(root, 'Fixture.app'), { identity: '-', projectDir: desktopDir }),
      /missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
