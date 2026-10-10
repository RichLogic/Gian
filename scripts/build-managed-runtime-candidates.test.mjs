import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ZCODE_RUNTIME_ASSET_NAME,
  upstreamRuntimeCandidates,
  validateRuntimeCandidateDefinitions,
  selectRuntimeProviders,
} from './build-managed-runtime-candidates.mjs';
import { assertZcodeSourceBinding, validateZcodeRuntimeSource, zcodeRuntimeSource } from './zcode-runtime-source.mjs';
import { verifyZcodeRuntimeProtocol } from './verify-zcode-runtime-protocol.mjs';
import { applyZcodeIntegrationEdits, integrateZcodeEntrypoint } from './zcode-runtime-integration.mjs';

test('managed Runtime candidates pin exact official Claude, Codex, Kimi, and Grok assets', () => {
  assert.equal(validateRuntimeCandidateDefinitions(), true);
  assert.deepEqual(Object.keys(upstreamRuntimeCandidates), ['claude', 'codex', 'kimi', 'grok']);
  assert.equal(upstreamRuntimeCandidates.claude.format, 'raw');
  assert.match(upstreamRuntimeCandidates.claude.url, /^https:\/\/downloads\.claude\.ai\//);
  assert.equal(upstreamRuntimeCandidates.codex.format, 'tar.gz');
  assert.match(upstreamRuntimeCandidates.codex.url, /^https:\/\/github\.com\/openai\/codex\/releases\/download\//);
  assert.equal(upstreamRuntimeCandidates.kimi.format, 'tar.gz');
  assert.equal(upstreamRuntimeCandidates.kimi.entryRelativePath, 'kimi');
  assert.equal(upstreamRuntimeCandidates.grok.format, 'raw');
  assert.equal(upstreamRuntimeCandidates.grok.entryRelativePath, 'bin/grok');
  assert.equal(upstreamRuntimeCandidates.grok.version, '1.0.46');
  assert.equal(upstreamRuntimeCandidates.grok.publish, true);
  assert.match(upstreamRuntimeCandidates.grok.url, /^https:\/\/x\.ai\/cli\/grok-1\.0\.46-macos-aarch64$/);
  assert.match(upstreamRuntimeCandidates.kimi.url, /^https:\/\/github\.com\/MoonshotAI\/kimi-code\/releases\/download\//);
});

test('DeepSeek Harness Runtime has a complete exact npm lock', async () => {
  const lock = JSON.parse(await readFile(
    new URL('../runtimes/deepseek-harness/package-lock.json', import.meta.url),
    'utf8',
  ));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2');
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh'].version, '0.2.0-rc.2');
  for (const [path, candidate] of Object.entries(lock.packages)) {
    if (!path || candidate.link) continue;
    assert.match(candidate.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(candidate.integrity, /^sha512-/, path);
  }
});

test('ZCode source lock binds CLI, immutable Git revision, toolchain and dependencies', () => {
  assert.equal(ZCODE_RUNTIME_ASSET_NAME, 'zcode.tar.gz');
  assert.ok(ZCODE_RUNTIME_ASSET_NAME.length <= 16, 'GitHub CDN redirect must fit existing Host URL bounds');
  assert.equal(validateZcodeRuntimeSource(), zcodeRuntimeSource);
  for (const commit of ['main', 'v3.14.3', '328c1a0']) {
    assert.throws(() => validateZcodeRuntimeSource({ ...zcodeRuntimeSource, commit }), /source lock/);
  }
  const candidate = {
    version: zcodeRuntimeSource.cliVersion, source: zcodeRuntimeSource,
    format: 'tar.gz', entryRelativePath: zcodeRuntimeSource.entryRelativePath,
  };
  assert.doesNotThrow(() => assertZcodeSourceBinding(candidate));
  for (const key of ['commit', 'lockfileSha256', 'nodeVersion', 'pnpmVersion']) {
    assert.throws(() => assertZcodeSourceBinding({ ...candidate,
      source: { ...zcodeRuntimeSource, [key]: 'changed' },
    }), /pinned Git source/);
  }
  assert.throws(() => assertZcodeSourceBinding({ ...candidate, source: undefined }), /pinned Git source/);
  assert.throws(() => assertZcodeSourceBinding({ ...candidate, format: 'raw' }), /pinned Git source/);
});

test('macOS Runtime qualification keeps the ZCode socket path inside sun_path', () => {
  const source = readFileSync(new URL('./verify-managed-runtime-candidates.mjs', import.meta.url), 'utf8');
  assert.match(source, /process\.platform === 'darwin' \? '\/tmp' : tmpdir\(\)/);
  assert.match(source, /'grv-'/);
});

test('ZCode qualification reports a redacted stderr tail when the probe exits early', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-protocol-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'zcode.cjs');
  await writeFile(entry, "console.error('startup failed token=super-secret');\nprocess.exit(7);\n");
  await assert.rejects(
    verifyZcodeRuntimeProtocol(entry, root, root),
    /code 7, signal none; stderr: startup failed \[redacted\]/,
  );
});

test('ZCode qualification rejects an upstream catalog method removal despite a valid version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-protocol-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'zcode.cjs');
  const fixture = reply => `
    const readline = require('node:readline');
    if (process.argv.includes('--version')) { console.log('0.16.9'); process.exit(0); }
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'workspace/readState') process.exit(2);
      const answer = request.method === 'workspace/readPresentation'
        ? { result: { mode: 'build', slashCommands: [] } } : ${JSON.stringify(reply)};
      console.log(JSON.stringify({ id: request.id, ...answer }));
    });
  `;
  await writeFile(entry, fixture({ result: { schemaVersion: 1, models: [] } }));
  await verifyZcodeRuntimeProtocol(entry, root, root);
  await writeFile(entry, fixture({ error: { code: -32601, message: 'Method not found' } }));
  await assert.rejects(verifyZcodeRuntimeProtocol(entry, root, root), /gian\/modelCatalog contract/);
  await writeFile(entry, fixture({ result: { schemaVersion: 99, models: [] } }));
  await assert.rejects(verifyZcodeRuntimeProtocol(entry, root, root), /incompatible schema/);
});

test('the Runtime integration is anchored to reviewed source and owns standalone authentication', () => {
  const snippet = [
    'create: () => startProcessProviderRegistryRuntime(runtimeEnv),',
    '          env: {\n            ...telemetryEnv,',
    '      handleMessage: (message) => server.handleMessage(message),',
  ].join('\n');
  assert.throws(() => integrateZcodeEntrypoint(snippet), /reviewed integration source/);
  const integrated = applyZcodeIntegrationEdits(snippet);
  assert.match(integrated, /startProcessProviderRegistryRuntime\(runtimeEnv, \{ standalone: \{\} \}\)/);
  assert.match(integrated, /providerRuntimeHeadersPort: activeProviderRegistryRuntime.providerRuntimeHeadersPort/);
  assert.match(integrated, /serializeModelCatalog\(modelSelectionFacade.getView\(preferred\)\)/);
  assert.match(integrated, /return server.handleMessage\(message\)/, 'all native session/reverse traffic keeps the upstream handler');
  assert.throws(() => applyZcodeIntegrationEdits(snippet + '\n' + snippet), /ambiguous/);
});


test('explicit Runtime selection excludes unrelated builds and rejects ambiguous providers', () => {
  assert.deepEqual(selectRuntimeProviders(['kimi', 'grok']), ['kimi', 'grok']);
  for (const selection of [[], ['kimi', 'kimi'], ['unknown'], [undefined]]) {
    assert.throws(() => selectRuntimeProviders(selection), /provider selection/);
  }
  assert.deepEqual(selectRuntimeProviders(), ['claude', 'codex', 'kimi', 'grok', 'dsh', 'zcode']);
});
