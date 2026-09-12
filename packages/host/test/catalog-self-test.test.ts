import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ManifestV4 } from '@gian/proxy-protocol';

import { acquireAgentProxyUpdateLock } from '../src/agents/update-lock.js';
import { runCatalogProxySelfTest } from '../src/plugin-store/self-test.js';
import { PluginStoreError } from '../src/plugin-store/errors.js';
import { MAX_PROTECTED_CHILD_STDOUT_BYTES } from '../src/proxy/protected-handshake.js';

function manifest(): ManifestV4 {
  return {
    schemaVersion: 4,
    id: 'io.gian.fixture',
    displayName: 'Gian Fixture',
    pluginVersion: '0.1.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '^2.2' },
    process: { scope: 'session' },
    runtime: { kind: 'none' },
    branding: {
      logo: {
        light: { path: 'logo-light.png', mediaType: 'image/png', sha256: 'a'.repeat(64) },
        dark: { path: 'logo-dark.png', mediaType: 'image/png', sha256: 'a'.repeat(64) },
      },
    },
  };
}

function script(body: string): string {
  return `#!/usr/bin/env node
${body}
`;
}

async function runSelfTest(root: string, source: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'proxy.mjs'), source);
  const lease = await acquireAgentProxyUpdateLock(root, 'io.gian.fixture', 'catalog-self-test');
  try {
    await runCatalogProxySelfTest(root, manifest(), ['2.2', '2.1', '2.0'], lease);
  } finally {
    await lease.release();
  }
}

test('self-test rejects valid JSON with a non-zero exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-self-test-exit2-'));
  await assert.rejects(
    () => runSelfTest(root, script(`
process.stdout.write(JSON.stringify({
  schemaVersion: 4,
  id: 'io.gian.fixture',
  pluginVersion: '0.1.0',
  ok: true,
}) + '\\n');
process.exit(2);
`)),
    (error: unknown) => error instanceof PluginStoreError && /exited 2/.test(error.message),
  );
});

test('self-test rejects a signal exit even with valid JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-self-test-signal-'));
  await assert.rejects(
    () => runSelfTest(root, script(`
process.stdout.write(JSON.stringify({
  schemaVersion: 4,
  id: 'io.gian.fixture',
  pluginVersion: '0.1.0',
  ok: true,
}) + '\\n');
process.kill(process.pid, 'SIGTERM');
`)),
    (error: unknown) => error instanceof PluginStoreError && /SIGTERM|exited/.test(error.message),
  );
});

test('self-test observes an exit that happens before the listener is installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-self-test-race-'));
  await runSelfTest(root, script(`
process.stdout.write(JSON.stringify({
  schemaVersion: 4,
  id: 'io.gian.fixture',
  pluginVersion: '0.1.0',
  ok: true,
}) + '\\n');
process.exit(0);
`));
});

test('self-test rejects oversized stdout even when the suffix is valid JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-self-test-overflow-'));
  await assert.rejects(
    () => runSelfTest(root, script(`
const prefix = 'x'.repeat(${MAX_PROTECTED_CHILD_STDOUT_BYTES + 8});
await new Promise((resolve, reject) => {
  process.stdout.write(prefix, (error) => error ? reject(error) : resolve());
});
await new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify({
    schemaVersion: 4,
    id: 'io.gian.fixture',
    pluginVersion: '0.1.0',
    ok: true,
  }) + '\\n', (error) => error ? reject(error) : resolve());
});
`)),
    (error: unknown) => error instanceof PluginStoreError && /stdout limit/.test(error.message),
  );
});
