/** Runtime discovery regression: the builtin provider config gate.
 *
 * ZCode.app 3.12.3 (2026-09-16) moved zcode-builtin.json to
 * Contents/Resources/config/provider/ while the embedded CLI still resolves
 * it only next to the entry or five levels up. A standalone-spawned
 * app-server then exits at startup (Gian-Dev #163). These tests pin both the
 * mirrored lookup paths and the probe readiness issue that must fail fast
 * instead of the opaque exit-1 loop. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  builtinProviderConfigCandidates,
  locateBuiltinProviderConfig,
  probeZcodeRuntime,
  ZCODE_BUILTIN_PROVIDER_CONFIG_READINESS_ISSUE,
} from '../src/runtime/discover.js';

/** Minimal executable entry so probeZcodeRuntime's `--version` call succeeds. */
function fakeEntry(dir: string): string {
  const entry = join(dir, 'zcode.cjs');
  writeFileSync(entry, "process.stdout.write('0.16.5\\n');\n");
  chmodSync(entry, 0o755);
  return entry;
}

function withFakeHome<T>(fn: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), 'zc-discover-home-'));
  process.env.HOME = home;
  return fn().finally(() => {
    process.env.HOME = previousHome;
  });
}

test('candidates mirror the CLI entry-relative lookup paths', () => {
  const entry = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  assert.deepEqual(builtinProviderConfigCandidates(entry), [
    '/Applications/ZCode.app/Contents/Resources/glm/provider/zcode-builtin.json',
    '/config/provider/zcode-builtin.json',
  ]);
});

test('locator finds the old glm/provider layout next to the entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zc-discover-old-'));
  const glm = join(root, 'ZCode.app', 'Contents', 'Resources', 'glm');
  mkdirSync(glm, { recursive: true });
  const entry = fakeEntry(glm);
  mkdirSync(join(glm, 'provider'));
  writeFileSync(join(glm, 'provider', 'zcode-builtin.json'), '{}');
  assert.equal(await locateBuiltinProviderConfig(entry), join(glm, 'provider', 'zcode-builtin.json'));
});

test('locator cannot see the 3.12.3 Resources/config/provider layout', async () => {
  // The app ships the file one level above glm/, which neither CLI lookup
  // path reaches — the regression this gate reports.
  const root = mkdtempSync(join(tmpdir(), 'zc-discover-new-'));
  const resources = join(root, 'ZCode.app', 'Contents', 'Resources');
  const glm = join(resources, 'glm');
  mkdirSync(glm, { recursive: true });
  const entry = fakeEntry(glm);
  mkdirSync(join(resources, 'config', 'provider'), { recursive: true });
  writeFileSync(join(resources, 'config', 'provider', 'zcode-builtin.json'), '{}');
  assert.equal(await locateBuiltinProviderConfig(entry), null);
});

test('probe reports the builtin-config readiness issue when unlocatable', async () => {
  await withFakeHome(async () => {
    const root = mkdtempSync(join(tmpdir(), 'zc-discover-probe-'));
    const entry = fakeEntry(root);
    const probe = await probeZcodeRuntime(entry);
    assert.equal(probe.version, '0.16.5');
    assert.deepEqual(probe.readinessIssue, { ...ZCODE_BUILTIN_PROVIDER_CONFIG_READINESS_ISSUE });
  });
});

test('probe stays quiet when the builtin config is reachable next to the entry', async () => {
  await withFakeHome(async () => {
    // The cli config check still applies; give the fake HOME a config so the
    // assertion isolates the builtin gate.
    const home = process.env.HOME as string;
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'cli', 'config.json'), '{}');
    const root = mkdtempSync(join(tmpdir(), 'zc-discover-ok-'));
    const entry = fakeEntry(root);
    mkdirSync(join(root, 'provider'));
    writeFileSync(join(root, 'provider', 'zcode-builtin.json'), '{}');
    const probe = await probeZcodeRuntime(entry);
    assert.equal(probe.readinessIssue, undefined);
  });
});
