import assert from 'node:assert/strict';
import test from 'node:test';

import {
  upstreamRuntimeCandidates,
  validateRuntimeCandidateDefinitions,
} from './build-managed-runtime-candidates.mjs';

test('managed Runtime candidates pin exact official Claude and Codex assets', () => {
  assert.equal(validateRuntimeCandidateDefinitions(), true);
  assert.deepEqual(Object.keys(upstreamRuntimeCandidates), ['claude', 'codex']);
  assert.equal(upstreamRuntimeCandidates.claude.format, 'raw');
  assert.match(upstreamRuntimeCandidates.claude.url, /^https:\/\/downloads\.claude\.ai\//);
  assert.equal(upstreamRuntimeCandidates.codex.format, 'tar.gz');
  assert.match(upstreamRuntimeCandidates.codex.url, /^https:\/\/github\.com\/openai\/codex\/releases\/download\//);
});
