import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runtimeInstallPlanParamsSchema } from '@gian/proxy-protocol';

import {
  ANTIGRAVITY_CLIENT_INFO,
  PAIRED_PRODUCT_ARCHIVE_ENTRIES,
  planRuntimeInstallation,
} from '../src/runtime/index.js';
import {
  ANTIGRAVITY_AGENT_NAME,
  ANTIGRAVITY_PLUGIN_DISPLAY_NAME,
  ANTIGRAVITY_PLUGIN_ID,
  ANTIGRAVITY_RUNTIME_DISPLAY_NAME,
  ANTIGRAVITY_RUNTIME_ID,
} from '../src/runtime/layout.js';

const sha = 'a'.repeat(64);

function managed(format: 'raw' | 'tar.gz', entryRelativePath: string) {
  return {
    installerVersion: 1 as const,
    runtimeId: ANTIGRAVITY_RUNTIME_ID,
    version: '1.3.0',
    artifactSha256: sha,
    platform: 'darwin-arm64' as const,
    distribution: {
      kind: 'managed' as const,
      format,
      entryRelativePath,
    },
  };
}

test('locks the manifest identity the Host compares exactly', () => {
  assert.equal(ANTIGRAVITY_PLUGIN_ID, 'io.gian.antigravity');
  assert.equal(ANTIGRAVITY_PLUGIN_DISPLAY_NAME, 'Antigravity');
  assert.equal(ANTIGRAVITY_RUNTIME_ID, 'antigravity-acp');
  assert.equal(ANTIGRAVITY_AGENT_NAME, 'antigravity-acp');
  assert.equal(ANTIGRAVITY_RUNTIME_DISPLAY_NAME, 'Antigravity ACP Server');
  assert.equal(ANTIGRAVITY_CLIENT_INFO.version, '0.0.1');
  assert.equal(ANTIGRAVITY_CLIENT_INFO.name, 'gian-antigravity-proxy');
});

test('plans a closed tar.gz layout and does not invent bytes', () => {
  assert.deepEqual(PAIRED_PRODUCT_ARCHIVE_ENTRIES, ['agy_acp_server.par', 'localharness_external']);
  const plan = planRuntimeInstallation(managed('tar.gz', 'agy_acp_server.par'));
  assert.deepEqual(plan.operation, {
    kind: 'managed',
    directory: `antigravity-acp/1.3.0/${sha}`,
    candidates: [],
    format: 'tar.gz',
    entryRelativePath: 'agy_acp_server.par',
  });
});

test('rejects raw, wrong entry, and a non-tar format at the schema', () => {
  assert.throws(
    () => planRuntimeInstallation(managed('raw', 'agy_acp_server.par')),
    /Runtime artifact layout is not supported by this Proxy version\./,
  );
  assert.throws(
    () => planRuntimeInstallation(managed('tar.gz', 'agy_acp_server.exe')),
    /Runtime artifact layout is not supported by this Proxy version\./,
  );
  assert.throws(
    () => planRuntimeInstallation({
      ...managed('tar.gz', 'agy_acp_server.par'),
      runtimeId: 'other-runtime',
    }),
    /Runtime installation recipe does not match the certified distribution\./,
  );
  const zip = runtimeInstallPlanParamsSchema.safeParse({
    ...managed('tar.gz', 'agy_acp_server.par'),
    distribution: { kind: 'managed', format: 'zip', entryRelativePath: 'agy_acp_server.par' },
  });
  assert.equal(zip.success, false);
});
