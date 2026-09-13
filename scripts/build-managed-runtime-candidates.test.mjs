import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  upstreamRuntimeCandidates,
  validateRuntimeCandidateDefinitions,
} from './build-managed-runtime-candidates.mjs';

test('managed Runtime candidates pin exact official Claude, Codex, and Kimi assets', () => {
  assert.equal(validateRuntimeCandidateDefinitions(), true);
  assert.deepEqual(Object.keys(upstreamRuntimeCandidates), ['claude', 'codex', 'kimi']);
  assert.equal(upstreamRuntimeCandidates.claude.format, 'raw');
  assert.match(upstreamRuntimeCandidates.claude.url, /^https:\/\/downloads\.claude\.ai\//);
  assert.equal(upstreamRuntimeCandidates.codex.format, 'tar.gz');
  assert.match(upstreamRuntimeCandidates.codex.url, /^https:\/\/github\.com\/openai\/codex\/releases\/download\//);
  assert.equal(upstreamRuntimeCandidates.kimi.format, 'tar.gz');
  assert.equal(upstreamRuntimeCandidates.kimi.entryRelativePath, 'kimi');
  assert.match(upstreamRuntimeCandidates.kimi.url, /^https:\/\/github\.com\/MoonshotAI\/kimi-code\/releases\/download\//);
});

test('DeepSeek Harness Runtime has a complete exact npm lock', async () => {
  const lock = JSON.parse(await readFile(
    new URL('../runtimes/deepseek-harness/package-lock.json', import.meta.url),
    'utf8',
  ));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].dependencies['@deepseek-ai/dsh'], '0.1.1-rc.2');
  assert.equal(lock.packages['node_modules/@deepseek-ai/dsh'].version, '0.1.1-rc.2');
  for (const [path, candidate] of Object.entries(lock.packages)) {
    if (!path || candidate.link) continue;
    assert.match(candidate.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(candidate.integrity, /^sha512-/, path);
  }
});
