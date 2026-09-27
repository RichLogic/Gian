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
  ZCODE_SOURCE_READINESS_ISSUE,
  discoverZcodeRuntimes,
} from '../src/runtime/discover.js';
import { planRuntimeInstallation } from '../src/runtime/install.js';
import source from '../src/runtime/source.json' with { type: 'json' };

/** Minimal executable entry so probeZcodeRuntime's `--version` call succeeds. */
function fakeEntry(dir: string): string {
  const entry = join(dir, 'zcode.cjs');
  writeFileSync(entry, `process.stdout.write('${source.cliVersion}\\n');\n`);
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
    assert.equal(probe.version, source.cliVersion);
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
    const agent = join(root, 'agent');
    mkdirSync(agent);
    const entry = fakeEntry(agent);
    mkdirSync(join(agent, 'provider'));
    writeFileSync(join(agent, 'provider', 'zcode-builtin.json'), '{}');
    writeFileSync(join(root, 'gian-source.json'), JSON.stringify(source));
    writeFileSync(join(root, 'gian-integration.json'), JSON.stringify({
      schemaVersion: source.integrationVersion, upstreamEntrypointSha256: source.protocolEntrypointSha256,
      integratedEntrypointSha256: 'a'.repeat(64), catalogProjectionSha256: 'b'.repeat(64),
    }));
    const probe = await probeZcodeRuntime(entry);
    assert.equal(probe.readinessIssue, undefined);
    assert.deepEqual(probe.contentRoots, [{ path: root, mode: 'directory' }]);
    writeFileSync(join(root, 'gian-source.json'), JSON.stringify({ ...source, commit: 'f'.repeat(40) }));
    assert.deepEqual((await probeZcodeRuntime(entry)).readinessIssue, ZCODE_SOURCE_READINESS_ISSUE);
  });
});

test('ZCode installs the pinned archive in a content-addressed managed directory', () => {
  const input = {
    installerVersion: 1 as const, runtimeId: 'zcode', version: source.cliVersion,
    artifactSha256: 'a'.repeat(64), platform: 'darwin-arm64' as const,
    distribution: { kind: 'managed' as const, format: 'tar.gz' as const, entryRelativePath: source.entryRelativePath },
  };
  const plan = planRuntimeInstallation(input);
  assert.deepEqual(plan.operation, {
    ...input.distribution, directory: `zcode/${source.cliVersion}/${input.artifactSha256}`, candidates: [],
  });
  assert.throws(() => planRuntimeInstallation({ ...input, version: '0.16.5' }), /pinned/);
  assert.throws(() => planRuntimeInstallation({ ...input, platform: 'linux-x64' }), /platform/);
  assert.throws(() => planRuntimeInstallation({ ...input,
    distribution: { kind: 'external-app', entryPath: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs' },
  }), /does not match/);
  assert.throws(() => planRuntimeInstallation({ ...input,
    distribution: { ...input.distribution, entryRelativePath: 'bin/zcode' },
  }), /layout/);
});

test('managed CLI discovery does not offer an unrelated installed Desktop runtime', async () => {
  assert.deepEqual((await discoverZcodeRuntimes()).candidates, []);
});
