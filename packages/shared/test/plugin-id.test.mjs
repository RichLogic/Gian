import { strict as assert } from 'node:assert';
import { posix, win32 } from 'node:path';
import { test } from 'node:test';

import {
  EXECUTOR_IDS,
  LEGACY_PLUGIN_ID_BY_EXECUTOR,
  isCanonicalAbsolutePath,
  isProxyPluginId,
  isReservedOfficialPluginId,
  parseProxyPluginId,
  parseSessionProxyBinding,
  sessionAllowsLegacyRuntimeFallback,
  sessionBoundRuntimeCliPath,
  sessionBoundRuntimeProfile,
  sessionExactBindingError,
  sessionProxyPluginVersion,
  sessionRuntimeCliPath,
  sessionRuntimeProxyVersion,
  pluginIdForExecutorId,
  productExecutorForPluginId,
  resolvePluginIdInput,
} from '../dist/index.js';

test('open pluginId accepts reserved official IDs and reverse-domain IDs', () => {
  assert.equal(isProxyPluginId('claude'), true);
  assert.equal(isProxyPluginId('codex'), true);
  assert.equal(isProxyPluginId('kimi'), true);
  assert.equal(isProxyPluginId('grok'), true);
  assert.equal(isProxyPluginId('io.gian.fixture'), true);
  assert.equal(isProxyPluginId('ai.deepseek.harness'), true);
  assert.equal(isProxyPluginId('com.zhipu.zcode'), true);
  assert.equal(isProxyPluginId('dsh'), false);
  assert.equal(isProxyPluginId('zcode'), false);
  assert.equal(isProxyPluginId('Claude'), false);
  assert.equal(isProxyPluginId('io_gian_fixture'), false);
  assert.equal(isProxyPluginId(''), false);
  assert.equal(parseProxyPluginId('io.gian.fixture'), 'io.gian.fixture');
  assert.throws(() => parseProxyPluginId('dsh'));
  assert.equal(isReservedOfficialPluginId('claude'), true);
  assert.equal(isReservedOfficialPluginId('grok'), true);
  assert.equal(isReservedOfficialPluginId('io.gian.fixture'), false);
  assert.equal(isReservedOfficialPluginId('foo-bar'), false);
});

test('legacy aliases canonicalize official executor IDs only in one module', () => {
  assert.equal(pluginIdForExecutorId('dsh'), 'ai.deepseek.harness');
  assert.equal(pluginIdForExecutorId('zcode'), 'com.zhipu.zcode');
  assert.equal(pluginIdForExecutorId('claude'), 'claude');
  assert.equal(resolvePluginIdInput('dsh'), 'ai.deepseek.harness');
  assert.equal(resolvePluginIdInput('zcode'), 'com.zhipu.zcode');
  assert.equal(resolvePluginIdInput('io.gian.fixture'), 'io.gian.fixture');
  assert.equal(resolvePluginIdInput('not an id'), null);
  assert.equal(productExecutorForPluginId('ai.deepseek.harness'), 'dsh');
  assert.equal(productExecutorForPluginId('io.gian.fixture'), null);
  assert.equal(productExecutorForPluginId('grok'), null);
  for (const id of EXECUTOR_IDS) {
    assert.equal(pluginIdForExecutorId(id), LEGACY_PLUGIN_ID_BY_EXECUTOR[id]);
  }
});

test('stored Session binding fails closed and stays diagnosable', () => {
  const valid = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: null,
  }));
  assert.equal(valid.ok, true);
  const absent = parseSessionProxyBinding(null);
  assert.equal(absent.ok, false);
  assert.equal(absent.error, 'PROXY_BINDING_ABSENT');
  const malformed = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.fixture',
    pluginVersion: '0.0.0',
    manifestSha256: '',
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: null,
  }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'PROXY_BINDING_INVALID');
  const extra = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: null,
    fabricated: true,
  }));
  assert.equal(extra.ok, false);
  const unknownProtocol = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '9.9',
    processScope: 'session',
    runtimeProfile: null,
  }));
  assert.equal(unknownProtocol.ok, false);
  const incompleteProfile = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: { id: 'profile-1' },
  }));
  assert.equal(incompleteProfile.ok, false);
  const openProfile = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.unknown.plugin',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-open',
      agentId: 'agent-1',
      pluginId: 'io.gian.unknown.plugin',
      runtimeId: 'unknown-runtime',
      path: '/opt/unknown/bin',
      version: '1.2.3',
      configHome: '/tmp/unknown',
      contentFingerprint: null,
      verifiedVersions: ['1.2.3'],
      verification: 'unverified',
    },
  }));
  assert.equal(openProfile.ok, true);
  const extraProfileKey = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.unknown.plugin',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-open',
      agentId: 'agent-1',
      pluginId: 'io.gian.unknown.plugin',
      runtimeId: 'unknown-runtime',
      path: '/opt/unknown/bin',
      version: '1.2.3',
      configHome: '/tmp/unknown',
      contentFingerprint: null,
      verifiedVersions: ['1.2.3'],
      verification: 'unverified',
      extra: true,
    },
  }));
  assert.equal(extraProfileKey.ok, false);
  assert.equal(sessionRuntimeCliPath(openProfile.ok ? openProfile.binding.runtimeProfile : null), '/opt/unknown/bin');
  assert.equal(sessionRuntimeProxyVersion(openProfile.ok ? openProfile.binding.runtimeProfile : null), null);
  assert.equal(sessionProxyPluginVersion({
    proxy_binding: openProfile.ok ? openProfile.binding : null,
    runtime_profile: openProfile.ok ? openProfile.binding.runtimeProfile : null,
  }), '1.2.3');
  const harmlessDotDot = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.unknown.plugin',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-open',
      agentId: 'agent-1',
      pluginId: 'io.gian.unknown.plugin',
      runtimeId: 'unknown-runtime',
      path: '/opt/foo../bin',
      version: '9.9.9',
      configHome: '/tmp/unknown',
      contentFingerprint: null,
      verifiedVersions: ['1.2.3'],
      verification: 'unverified',
    },
  }));
  assert.equal(harmlessDotDot.ok, true);
  const unsafePath = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.unknown.plugin',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-open',
      agentId: 'agent-1',
      pluginId: 'io.gian.unknown.plugin',
      runtimeId: 'unknown-runtime',
      path: '/opt/foo/../bin',
      version: '1.2.3',
      configHome: '/tmp/unknown',
      contentFingerprint: null,
      verifiedVersions: ['1.2.3'],
      verification: 'unverified',
    },
  }));
  assert.equal(unsafePath.ok, false);
  const relativePath = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.unknown.plugin',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-open',
      agentId: 'agent-1',
      pluginId: 'io.gian.unknown.plugin',
      runtimeId: 'unknown-runtime',
      path: 'opt/unknown/bin',
      version: '1.2.3',
      configHome: '/tmp/unknown',
      contentFingerprint: null,
      verifiedVersions: ['1.2.3'],
      verification: 'unverified',
    },
  }));
  assert.equal(relativePath.ok, false);
  const nonSemverSkill = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'codex',
    pluginVersion: '0.2.8',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-legacy',
      agentId: 'agent-1',
      pluginId: 'codex',
      proxy: 'codex',
      cliPath: '/opt/codex',
      cliVersion: '0.146.0',
      configHome: '/tmp/codex',
      cliFingerprint: null,
      proxyVersion: '0.2.8',
      verifiedCliVersions: ['latest'],
      verification: 'verified',
      skill: { name: 'gian-session', version: 'ready-now', state: 'ready' },
    },
  }));
  assert.equal(nonSemverSkill.ok, false);
  assert.equal(sessionProxyPluginVersion({
    proxy_binding: {
      schemaVersion: 1,
      pluginId: 'io.gian.unknown.plugin',
      pluginVersion: '0.4.0',
      manifestSha256: 'a'.repeat(64),
      protocolVersion: '2.1',
      processScope: 'session',
      runtimeProfile: openProfile.ok ? openProfile.binding.runtimeProfile : null,
    },
    runtime_profile: openProfile.ok ? openProfile.binding.runtimeProfile : null,
  }), '0.4.0');
  const mismatchedPluginId = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'claude',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: openProfile.ok ? openProfile.binding.runtimeProfile : null,
  }));
  assert.equal(mismatchedPluginId.ok, false);
  const mismatchedAlias = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'claude',
    pluginVersion: '0.2.8',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-legacy',
      agentId: 'agent-1',
      pluginId: 'claude',
      proxy: 'codex',
      cliPath: '/opt/codex',
      cliVersion: '0.146.0',
      configHome: '/tmp/codex',
      cliFingerprint: null,
      proxyVersion: '0.2.8',
      verifiedCliVersions: ['0.146.0'],
      verification: 'verified',
      skill: { name: 'gian-session', version: '0.2.8', state: 'ready' },
    },
  }));
  assert.equal(mismatchedAlias.ok, false);
  const matchingAlias = parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'ai.deepseek.harness',
    pluginVersion: '0.2.8',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-dsh',
      agentId: 'agent-1',
      pluginId: 'ai.deepseek.harness',
      proxy: 'dsh',
      cliPath: '/opt/dsh',
      cliVersion: '0.1.0',
      configHome: '/tmp/dsh',
      cliFingerprint: null,
      proxyVersion: '0.2.8',
      verifiedCliVersions: ['0.1.0'],
      verification: 'verified',
      skill: { name: 'gian-session', version: '0.2.8', state: 'ready' },
    },
  }));
  assert.equal(matchingAlias.ok, true);
  const columnProfile = openProfile.ok
    ? { ...openProfile.binding.runtimeProfile, path: '/opt/column/bin', version: '8.8.8' }
    : null;
  assert.equal(sessionBoundRuntimeCliPath({
    proxy_binding: openProfile.ok ? openProfile.binding : null,
    runtime_profile: columnProfile,
  }), '/opt/unknown/bin');
  assert.equal(sessionBoundRuntimeProfile({
    proxy_binding: openProfile.ok ? openProfile.binding : null,
    runtime_profile: columnProfile,
  })?.path ?? null, '/opt/unknown/bin');
  assert.equal(sessionAllowsLegacyRuntimeFallback({
    proxy_binding: openProfile.ok ? openProfile.binding : null,
    runtime_profile: columnProfile,
  }), false);
  assert.equal(sessionBoundRuntimeCliPath({
    proxy_binding: null,
    proxy_binding_error: 'PROXY_BINDING_IDENTITY_MISMATCH',
    runtime_profile: columnProfile,
  }), null);
  assert.equal(sessionProxyPluginVersion({
    proxy_binding: null,
    proxy_binding_error: 'PROXY_BINDING_IDENTITY_MISMATCH',
    runtime_profile: {
      id: 'profile-legacy',
      agentId: 'agent-1',
      pluginId: 'codex',
      proxy: 'codex',
      cliPath: '/opt/column/cli',
      cliVersion: '0.146.0',
      configHome: '/tmp/codex',
      cliFingerprint: null,
      proxyVersion: '0.2.8',
      verifiedCliVersions: ['0.146.0'],
      verification: 'verified',
      skill: { name: 'gian-session', version: '0.2.8', state: 'ready' },
    },
  }), null);
  assert.equal(sessionAllowsLegacyRuntimeFallback({
    proxy_binding: null,
    proxy_binding_error: 'PROXY_BINDING_IDENTITY_MISMATCH',
  }), false);
  assert.equal(sessionExactBindingError({
    proxy_binding: null,
    proxy_binding_error: 'PROXY_BINDING_IDENTITY_MISMATCH',
  }), 'PROXY_BINDING_IDENTITY_MISMATCH');
  assert.equal(sessionExactBindingError({
    proxy_binding: openProfile.ok ? openProfile.binding : null,
  }), null);
  assert.equal(sessionExactBindingError({
    proxy_binding: { schemaVersion: 1 },
  }), 'PROXY_BINDING_INVALID');
});

function nodeCanonicalAbsolute(value, impl) {
  return impl.isAbsolute(value)
    && impl.normalize(value) === value
    && !value.split(/[\\/]/).some((part) => part === '.' || part === '..');
}

function bindingWithPath(path) {
  return parseSessionProxyBinding(JSON.stringify({
    schemaVersion: 1,
    pluginId: 'io.gian.unknown.plugin',
    pluginVersion: '1.2.3',
    manifestSha256: 'a'.repeat(64),
    protocolVersion: '2.1',
    processScope: 'session',
    runtimeProfile: {
      id: 'profile-open',
      agentId: 'agent-1',
      pluginId: 'io.gian.unknown.plugin',
      runtimeId: 'unknown-runtime',
      path,
      version: '1.2.3',
      configHome: '/tmp/unknown',
      contentFingerprint: null,
      verifiedVersions: ['1.2.3'],
      verification: 'unverified',
    },
  }));
}

test('Session binding paths stay Node-canonical absolute without node:path', () => {
  const samples = [
    '/opt/unknown/bin',
    '/opt/foo../bin',
    '/Users/test/.codex',
    '/opt/foo/bar/',
    '/',
    '/opt/foo/../bin',
    '/opt/foo/./bin',
    '/opt/foo//bin',
    'opt/unknown/bin',
    './opt',
    'C:\\Users\\foo\\claude.exe',
    'C:/Users/foo/claude.exe',
    '\\\\server\\share\\bin',
    '//server/share/bin',
    '/foo/bar\\..\\baz',
    'C:\\foo\\..\\bar',
    'C:foo',
  ];
  for (const sample of samples) {
    const expected = nodeCanonicalAbsolute(sample, posix) || nodeCanonicalAbsolute(sample, win32);
    assert.equal(isCanonicalAbsolutePath(sample), expected, sample);
    assert.equal(bindingWithPath(sample).ok, expected, `binding ${sample}`);
  }
  assert.equal(bindingWithPath('/opt/foo/bar/').ok, true);
  assert.equal(bindingWithPath('C:\\Users\\foo\\claude.exe').ok, true);
  assert.equal(bindingWithPath('/opt/foo/../bin').ok, false);
  assert.equal(bindingWithPath('/opt/foo/./bin').ok, false);
  assert.equal(bindingWithPath('opt/unknown/bin').ok, false);
});
