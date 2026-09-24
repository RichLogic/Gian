import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  HostProtocolValidator,
  KNOWN_PROTOCOL_VERSIONS,
  MAX_RUNTIME_CANDIDATES,
  MAX_RUNTIME_CONTENT_ROOTS,
  PROTOCOL_V22,
  PROTOCOL_V23,
  ProxyProtocolError,
  SUPPORTED_PROTOCOL_VERSIONS,
  parseProxyRequest,
  resultSchemas,
  runtimeDiscoverResultSchema,
  runtimeProbeResultSchema,
} from '../src/index.js';

function rpc<T extends Record<string, unknown>>(value: T): T & { jsonrpc: '2.0' } {
  return { jsonrpc: '2.0', ...value };
}

function handshake(
  validator: HostProtocolValidator,
  offered: string[],
  selected: string,
  capabilities: Record<string, number> = {},
): void {
  validator.registerRequest(rpc({
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: offered },
      host: { name: 'Gian', version: '0.5.2' },
    },
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'init',
    result: {
      protocol: { name: 'gian.proxy', version: selected },
      plugin: { id: 'codex', name: 'Codex', version: '0.3.0' },
      process: { scope: 'shared' },
      capabilities,
    },
  })));
}

function initializeV22(
  validator: HostProtocolValidator,
  capabilities: Record<string, number> = {
    'runtime.discover': 1,
    'runtime.probe': 1,
  },
): void {
  handshake(validator, ['2.2', '2.1', '2.0'], '2.2', capabilities);
}

function initializeV23(
  validator: HostProtocolValidator,
  capabilities: Record<string, number> = {
    'runtime.discover': 1,
    'runtime.probe': 1,
    'customization.list': 1,
  },
): void {
  handshake(validator, ['2.3', '2.2', '2.1', '2.0'], '2.3', capabilities);
}

const validDiscoverResult = {
  candidates: [{
    path: '/Users/rich/.local/bin/codex',
    source: 'official-user' as const,
    label: 'Codex CLI',
  }],
  setupActions: [{
    id: 'install-docs',
    kind: 'open_url' as const,
    label: 'Install Codex',
    url: 'https://127.0.0.1/install',
  }, {
    id: 'pick-binary',
    kind: 'select_file' as const,
    label: 'Choose binary',
  }],
};

const validProbeResult = {
  runtimeId: 'codex',
  displayName: 'Codex CLI',
  path: '/Users/rich/.local/bin/codex',
  version: '0.146.0',
  configHome: '/Users/rich/.codex',
  contentRoots: [
    { path: '/Users/rich/.codex', mode: 'directory' as const },
    { path: '/Users/rich/.codex/config.toml', mode: 'file' as const },
  ],
};

function specialCatalog(role?: string) {
  return {
    catalogRevision: 'catalog-22',
    input: [{ type: 'text' }],
    configOptions: [{
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      ...(role ? { role } : {}),
      control: 'select',
      required: false,
      defaultValue: 'm',
      choices: [{ value: 'm', displayName: 'M' }],
    }],
    specialCatalogs: { model: 'model' },
    slashCommands: [],
  };
}

test('SUPPORTED_PROTOCOL_VERSIONS composes 2.3 and 2.2 before legacy versions', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
  assert.equal(PROTOCOL_V23, '2.3');
  assert.equal(PROTOCOL_V22, '2.2');
  assert.deepEqual([...KNOWN_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
  assert.equal((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(PROTOCOL_V22), true);
});

test('initialize accepts gian.proxy/2.2 only when Host offered it', () => {
  const offered = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(offered);
  assert.equal(offered.initializeResult?.protocol.version, '2.2');

  const refused = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  refused.registerRequest(rpc({
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.1', '2.0'] },
      host: { name: 'Gian', version: '0.5.2' },
    },
  }));
  assert.throws(
    () => refused.acceptLine(JSON.stringify(rpc({
      id: 'init',
      result: {
        protocol: { name: 'gian.proxy', version: '2.2' },
        plugin: { id: 'codex', name: 'Codex', version: '0.3.0' },
        process: { scope: 'shared' },
        capabilities: {},
      },
    }))),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'PROTOCOL_VIOLATION'
      && error.message.includes('Host did not offer'),
  );
});

test('non-2.2 initialize results cannot advertise runtime.discover or runtime.probe', () => {
  for (const version of ['2.1', '2.0'] as const) {
    const validator = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
    validator.registerRequest(rpc({
      id: 'init',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.2', '2.1', '2.0'] },
        host: { name: 'Gian', version: '0.5.2' },
      },
    }));
    assert.throws(
      () => validator.acceptLine(JSON.stringify(rpc({
        id: 'init',
        result: {
          protocol: { name: 'gian.proxy', version },
          plugin: { id: 'codex', name: 'Codex', version: '0.3.0' },
          process: { scope: 'shared' },
          capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
        },
      }))),
      (error: unknown) => error instanceof ProxyProtocolError
        && error.code === 'PROTOCOL_VIOLATION'
        && error.message.includes('cannot advertise'),
    );
  }
});

test('2.2 fixture can register and validate runtime.discover and runtime.probe', () => {
  const validator = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(validator);
  const discover = parseProxyRequest(rpc({
    id: 'discover',
    method: 'runtime.discover',
    params: {},
  }));
  assert.equal(discover.method, 'runtime.discover');
  validator.registerRequest(discover);
  validator.acceptLine(JSON.stringify(rpc({
    id: 'discover',
    result: validDiscoverResult,
  })));

  const probe = parseProxyRequest(rpc({
    id: 'probe',
    method: 'runtime.probe',
    params: { path: '/Users/rich/.local/bin/codex' },
  }));
  assert.equal(probe.method, 'runtime.probe');
  validator.registerRequest(probe);
  validator.acceptLine(JSON.stringify(rpc({
    id: 'probe',
    result: validProbeResult,
  })));
});

test('2.3 inherits and validates runtime.discover and runtime.probe', () => {
  const validator = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV23(validator);

  validator.registerRequest(parseProxyRequest(rpc({
    id: 'discover-v23',
    method: 'runtime.discover',
    params: {},
  })));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'discover-v23',
    result: validDiscoverResult,
  })));

  validator.registerRequest(parseProxyRequest(rpc({
    id: 'probe-v23',
    method: 'runtime.probe',
    params: { path: '/Users/rich/.local/bin/codex' },
  })));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'probe-v23',
    result: validProbeResult,
  })));
});

test('2.1 and 2.0 fail closed for 2.2-only runtime methods', () => {
  for (const version of ['2.1', '2.0'] as const) {
    const validator = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
    handshake(validator, ['2.2', '2.1', '2.0'], version);
    assert.throws(
      () => validator.registerRequest(rpc({
        id: 'discover',
        method: 'runtime.discover',
        params: {},
      })),
      (error: unknown) => error instanceof ProxyProtocolError
        && error.code === 'CAPABILITY_NOT_SUPPORTED'
        && error.message.includes(`gian.proxy/${version}`),
    );
  }
});

test('unadvertised 2.2 runtime methods fail closed', () => {
  const validator = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(validator, {});
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'discover',
      method: 'runtime.discover',
      params: {},
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED'
      && error.message.includes('does not advertise'),
  );
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'probe',
      method: 'runtime.probe',
      params: { path: '/usr/bin/codex' },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED'
      && error.message.includes('does not advertise'),
  );
});

test('gian.proxy/2.2 Catalog follows 2.1 specialCatalogs rules', () => {
  const valid = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(valid);
  valid.registerRequest(rpc({ id: 'catalog', method: 'catalog.list', params: {} }));
  assert.doesNotThrow(() => valid.acceptLine(JSON.stringify(rpc({
    id: 'catalog',
    result: specialCatalog(),
  }))));

  const missing = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(missing);
  missing.registerRequest(rpc({ id: 'catalog', method: 'catalog.list', params: {} }));
  assert.throws(
    () => missing.acceptLine(JSON.stringify(rpc({
      id: 'catalog',
      result: {
        catalogRevision: 'catalog-22-missing',
        input: [{ type: 'text' }],
        configOptions: [],
        slashCommands: [],
      },
    }))),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.message.includes('specialCatalogs'),
  );

  const role = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(role);
  role.registerRequest(rpc({ id: 'catalog', method: 'catalog.list', params: {} }));
  assert.throws(
    () => role.acceptLine(JSON.stringify(rpc({
      id: 'catalog',
      result: specialCatalog('model'),
    }))),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.message.includes('legacy role field'),
  );
});

test('catalog slash commands accept optional disabled/customizationId and reject malformed ids', () => {
  const catalog = (slashCommands: unknown[]) => ({
    ...specialCatalog(),
    slashCommands,
  });
  const base = {
    name: '/review',
    description: 'Review',
    source: 'user',
    argHints: [],
  };
  assert.equal(resultSchemas['catalog.list'].safeParse(catalog([base])).success, true);
  assert.equal(resultSchemas['catalog.list'].safeParse(catalog([
    { ...base, disabled: true },
  ])).success, true);
  assert.equal(resultSchemas['catalog.list'].safeParse(catalog([
    { ...base, customizationId: 'ci1_0123456789abcdef0123456789abcdef' },
  ])).success, true);
  // Strict object: unrelated extra keys stay rejected.
  assert.equal(resultSchemas['catalog.list'].safeParse(catalog([
    { ...base, filePath: '/tmp/x.md' },
  ])).success, false);
  assert.equal(resultSchemas['catalog.list'].safeParse(catalog([
    { ...base, customizationId: 'not-a-stable-id' },
  ])).success, false);
});

test('runtime.discover and runtime.probe schemas reject malformed values', () => {
  assert.throws(() => parseProxyRequest(rpc({
    id: 'discover',
    method: 'runtime.discover',
    params: { shell: 'ls' },
  })));
  assert.throws(() => parseProxyRequest(rpc({
    id: 'probe',
    method: 'runtime.probe',
    params: { path: 'relative/codex' },
  })));
  assert.throws(() => parseProxyRequest(rpc({
    id: 'probe',
    method: 'runtime.probe',
    params: { path: '/tmp/../etc/passwd' },
  })));
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    candidates: validDiscoverResult.candidates,
    setupActions: [{
      id: 'install',
      kind: 'open_url',
      label: 'Install',
      url: 'http://example.com/install',
    }],
  }));
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    candidates: validDiscoverResult.candidates,
    setupActions: [{
      id: 'install',
      kind: 'open_url',
      label: 'Install',
      url: 'https://user:secret@example.com/install',
    }],
  }));
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    candidates: validDiscoverResult.candidates,
    setupActions: [
      { id: 'dup', kind: 'select_file', label: 'A' },
      { id: 'dup', kind: 'select_file', label: 'B' },
    ],
  }));
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    candidates: Array.from({ length: MAX_RUNTIME_CANDIDATES + 1 }, (_, index) => ({
      path: `/usr/bin/c${index}`,
      source: 'path',
    })),
    setupActions: [],
  }));
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    ...validDiscoverResult,
    command: 'brew install',
  }));
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    version: 'latest',
  }));
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    contentRoots: [{ path: 'relative', mode: 'directory' }],
  }));
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    env: { TOKEN: 'secret' },
  }));
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    digest: 'a'.repeat(64),
  }));
  assert.doesNotThrow(() => runtimeDiscoverResultSchema.parse(validDiscoverResult));
  assert.doesNotThrow(() => runtimeDiscoverResultSchema.parse({
    candidates: [{ path: '/usr/bin/codex', source: 'path' }],
    setupActions: [],
  }));
  assert.doesNotThrow(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    configHome: null,
    readinessIssue: { code: 'NOT_FOUND', message: 'Binary missing', repairable: true },
  }));
});

test('runtime.discover candidates are unique by exact path and reject invented id or required displayName', () => {
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    candidates: [
      { path: '/usr/bin/codex', source: 'path', label: 'PATH' },
      { path: '/usr/bin/codex', source: 'configured', label: 'Configured' },
    ],
    setupActions: [],
  }));
  assert.throws(() => runtimeDiscoverResultSchema.parse({
    candidates: [{
      id: 'codex-user',
      displayName: 'Codex CLI',
      path: '/usr/bin/codex',
      source: 'path',
    }],
    setupActions: [],
  }));
  const parsed = runtimeDiscoverResultSchema.parse({
    candidates: [{ path: '/usr/bin/codex', source: 'path' }],
    setupActions: validDiscoverResult.setupActions,
  });
  assert.equal('id' in parsed.candidates[0]!, false);
  assert.equal('displayName' in parsed.candidates[0]!, false);
  assert.equal(parsed.candidates[0]?.label, undefined);
});

test('runtime.probe uses readinessIssue and rejects a JSON-RPC success error field', () => {
  assert.doesNotThrow(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    readinessIssue: { code: 'NOT_FOUND', message: 'Binary missing', repairable: true },
  }));
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    error: { code: 'NOT_FOUND', message: 'Binary missing', repairable: true },
  }));
});

test('runtime.probe contentRoots require at least one root and reject one over the bound', () => {
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    contentRoots: [],
  }));
  assert.doesNotThrow(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    contentRoots: Array.from({ length: MAX_RUNTIME_CONTENT_ROOTS }, (_, index) => ({
      path: `/tmp/root-${index}`,
      mode: 'directory' as const,
    })),
  }));
  assert.throws(() => runtimeProbeResultSchema.parse({
    ...validProbeResult,
    contentRoots: Array.from({ length: MAX_RUNTIME_CONTENT_ROOTS + 1 }, (_, index) => ({
      path: `/tmp/root-${index}`,
      mode: 'directory' as const,
    })),
  }));
});

test('runtime.probe result.path must exactly match the pending request path', () => {
  const validator = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(validator);
  validator.registerRequest(rpc({
    id: 'probe-mismatch',
    method: 'runtime.probe',
    params: { path: '/expected/bin' },
  }));
  assert.throws(
    () => validator.acceptLine(JSON.stringify(rpc({
      id: 'probe-mismatch',
      result: { ...validProbeResult, path: '/different/bin' },
    }))),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'PROTOCOL_VIOLATION'
      && error.faultClass === 'connection'
      && error.message.includes('must exactly match request.params.path'),
  );

  const matched = new HostProtocolValidator({ pluginId: 'codex', pluginVersion: '0.3.0' });
  initializeV22(matched);
  matched.registerRequest(rpc({
    id: 'probe-match',
    method: 'runtime.probe',
    params: { path: '/expected/bin' },
  }));
  assert.doesNotThrow(() => matched.acceptLine(JSON.stringify(rpc({
    id: 'probe-match',
    result: { ...validProbeResult, path: '/expected/bin' },
  }))));
});
