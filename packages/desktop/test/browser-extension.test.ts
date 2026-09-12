import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FileBrowserExtensionStore,
  inspectBrowserExtension,
  resolveBrowserSmokeExtensionDirectory,
} from '../src/browser-extension.js';

test('Browser extension inspection returns bounded identity and honest Electron warnings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-browser-extension-'));
  try {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Fixture Extension',
      version: '1.2.3',
      permissions: ['storage', 'scripting', 'debugger'],
      host_permissions: ['https://example.com/*'],
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html' },
    }));
    const inspected = await inspectBrowserExtension(root);
    assert.match(inspected.key, /^extension-[a-f0-9]{32}$/);
    assert.equal(inspected.path, realpathSync(root));
    assert.equal(inspected.name, 'Fixture Extension');
    assert.deepEqual(inspected.permissions, ['storage', 'scripting', 'debugger', 'https://example.com/*']);
    assert.ok(inspected.warnings.some(warning => warning.includes('service workers')));
    assert.ok(inspected.warnings.some(warning => warning.includes('"action"')));
    assert.ok(inspected.warnings.some(warning => warning.includes('permission "debugger"')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Browser extension inspection rejects manifest symlinks and unknown versions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-browser-extension-'));
  const outside = join(root, 'outside.json');
  const extension = join(root, 'extension');
  try {
    mkdirSync(extension);
    writeFileSync(outside, JSON.stringify({ manifest_version: 3, name: 'Outside', version: '1' }));
    symlinkSync(outside, join(extension, 'manifest.json'));
    await assert.rejects(() => inspectBrowserExtension(extension), /manifest is invalid/);
    rmSync(join(extension, 'manifest.json'));
    writeFileSync(join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 4,
      name: 'Future',
      version: '1',
    }));
    await assert.rejects(() => inspectBrowserExtension(extension), /version is unsupported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Browser extension store is private, bounded, and ignores malformed entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-browser-extension-store-'));
  const path = join(root, 'state', 'extensions.json');
  try {
    const store = new FileBrowserExtensionStore(path);
    await store.save({
      version: 1,
      extensions: [
        { path: '/tmp/extension-a', enabled: true },
        { path: '/tmp/extension-a', enabled: false },
        { path: 'relative-extension', enabled: true },
      ],
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(await store.load(), {
      version: 1,
      extensions: [{ path: '/tmp/extension-a', enabled: true }],
    });
    writeFileSync(path, '{broken');
    assert.deepEqual(await store.load(), { version: 1, extensions: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Browser smoke extension selection is confined to unpackaged temporary user data', () => {
  assert.equal(resolveBrowserSmokeExtensionDirectory({
    packaged: false,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke/extensions/fixture',
  }), '/tmp/gian-smoke/extensions/fixture');
  assert.equal(resolveBrowserSmokeExtensionDirectory({
    packaged: false,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke-other/fixture',
  }), null);
  assert.equal(resolveBrowserSmokeExtensionDirectory({
    packaged: true,
    userDataPath: '/tmp/gian-smoke',
    candidate: '/tmp/gian-smoke/extensions/fixture',
  }), null);
});
