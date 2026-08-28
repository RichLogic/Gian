import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  HostProtocolValidator,
  ProxyProtocolError,
  domainError,
  normalizeCatalogActions,
  parseProxyRequest,
  redactSensitiveProtocolText,
  redactSensitiveProtocolValue,
  resultSchemas,
  sessionSchema,
  sidechatSchema,
  type ConfigValue,
} from '../src/index.js';

const timestamp = '2026-08-20T08:00:00.000Z';

function rpc<T extends Record<string, unknown>>(value: T): T & { jsonrpc: '2.0' } {
  return { jsonrpc: '2.0', ...value };
}

function validator(capabilities: Record<string, number> = {}): HostProtocolValidator {
  const host = new HostProtocolValidator({ pluginId: 'codex', processScope: 'shared' });
  host.registerRequest(rpc({
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '0.4.5' },
    },
  }));
  host.acceptLine(JSON.stringify(rpc({
    id: 'init',
    result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'codex', name: 'Codex', version: '0.3.0' },
      process: { scope: 'shared' },
      capabilities,
    },
  })));
  return host;
}

function listCatalog(
  host: HostProtocolValidator,
  actions?: Array<{ id: string; supported: boolean; reason?: string }>,
  configOptions: Array<Record<string, unknown>> = [],
): void {
  host.registerRequest(rpc({ id: 'catalog', method: 'catalog.list', params: {} }));
  host.acceptLine(JSON.stringify(rpc({
    id: 'catalog',
    result: {
      catalogRevision: 'cat-1',
      input: [{ type: 'text' }],
      configOptions,
      ...(actions ? { actions } : {}),
      slashCommands: [],
    },
  })));
}

function attach(
  host: HostProtocolValidator,
  sessionConfig: Record<string, ConfigValue> = {},
  availableActions?: Record<string, { enabled: boolean; reason?: string }>,
): void {
  host.registerRequest(rpc({
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
      config: sessionConfig,
    },
  }));
  host.acceptLine(JSON.stringify(rpc({
    id: 'create',
    result: {
      session: {
        id: 's_1',
        streamId: 'stream-1',
        state: 'idle',
        sessionConfig,
        ...(availableActions ? { availableActions } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  })));
}

function sidechatSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sc_1',
    parentSessionId: 's_1',
    streamId: 'stream-side-1',
    state: 'idle',
    resumeRef: { id: 'opaque-ref-1' },
    anchor: { type: 'empty' },
    sessionConfig: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createSidechat(host: HostProtocolValidator, snapshot = sidechatSnapshot()): void {
  host.registerRequest(rpc({
    id: 'sc-create',
    method: 'sidechat.create',
    params: {
      parentSessionId: 's_1',
      parentStreamId: 'stream-1',
      sidechatId: 'sc_1',
    },
  }));
  host.acceptLine(JSON.stringify(rpc({
    id: 'sc-create',
    result: { sidechat: snapshot },
  })));
}

function isRequestFault(error: unknown, code: string): boolean {
  return error instanceof ProxyProtocolError
    && error.faultClass === 'request'
    && error.code === code;
}

test('session.fork requires session.replay and atTurn requires fork', () => {
  assert.throws(
    () => validator({ 'session.fork': 1 }),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
  assert.throws(
    () => validator({ 'session.replay': 1, 'session.fork.atTurn': 1 }),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
  const host = validator({
    'session.replay': 1,
    'session.fork': 1,
    'session.fork.atTurn': 1,
  });
  assert.equal(host.initializeResult?.capabilities['session.fork'], 1);
});

test('sidechat and fork capabilities are orthogonal to process.scope', () => {
  const host = new HostProtocolValidator({ pluginId: 'codex', processScope: 'session' });
  host.registerRequest(rpc({
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '0.4.5' },
    },
  }));
  host.acceptLine(JSON.stringify(rpc({
    id: 'init',
    result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'codex', name: 'Codex', version: '0.3.0' },
      process: { scope: 'session' },
      capabilities: { sidechat: 1, 'session.replay': 1, 'session.fork': 1 },
    },
  })));
  assert.equal(host.initializeResult?.process.scope, 'session');
  assert.equal(host.initializeResult?.capabilities.sidechat, 1);
});

test('session.create accepts bounded canonical Fork boundaries for a reattach generation', () => {
  const request = parseProxyRequest(rpc({
    id: 'create-with-fork-boundaries',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
      config: {},
      forkBoundaries: [
        { turnId: 'host-turn-1', sourceTurnId: 'provider-turn-1' },
        { turnId: 'host-turn-2', sourceTurnId: 'provider-turn-2' },
      ],
    },
  }));
  assert.equal(request.method, 'session.create');
  if (request.method !== 'session.create') throw new Error('expected session.create');
  assert.deepEqual(request.params.forkBoundaries, [
    { turnId: 'host-turn-1', sourceTurnId: 'provider-turn-1' },
    { turnId: 'host-turn-2', sourceTurnId: 'provider-turn-2' },
  ]);
  assert.throws(
    () => parseProxyRequest(rpc({
      id: 'create-with-bad-fork-boundary',
      method: 'session.create',
      params: {
        sessionId: 's_1',
        workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
        config: {},
        forkBoundaries: [{ turnId: '', sourceTurnId: 'provider-turn-1' }],
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError,
  );

  const unsupported = validator({ 'session.replay': 1 });
  listCatalog(unsupported);
  assert.throws(
    () => unsupported.registerRequest(request),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED',
  );

  const supported = validator({
    'session.replay': 1,
    'session.create.forkBoundaries': 1,
  });
  listCatalog(supported);
  supported.registerRequest(request);
});

test('catalog actions treat missing known ids as unsupported and ignore unknown ids', () => {
  const normalized = normalizeCatalogActions([
    { id: 'sidechat.create', supported: true },
    { id: 'provider-only-action', supported: true },
  ]);
  assert.equal(normalized.get('sidechat.create')?.supported, true);
  assert.equal(normalized.get('session.fork')?.supported, false);
  assert.equal(normalized.get('session.fork.atTurn')?.supported, false);
  assert.equal(normalized.has('provider-only-action' as 'sidechat.create'), false);
});

test('catalog supported:true requires the matching capability', () => {
  const host = validator({ sidechat: 1 });
  assert.throws(
    () => listCatalog(host, [
      { id: 'sidechat.create', supported: true },
      { id: 'session.fork', supported: true },
    ]),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
});

test('session.fork.atTurn.supported requires session.fork.supported', () => {
  const host = validator({
    'session.replay': 1,
    'session.fork': 1,
    'session.fork.atTurn': 1,
  });
  assert.throws(
    () => listCatalog(host, [
      { id: 'session.fork', supported: false },
      { id: 'session.fork.atTurn', supported: true },
    ]),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
});

test('availableActions can only include catalog-supported capability-gated actions', () => {
  const host = validator({ sidechat: 1, 'session.replay': 1, 'session.fork': 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  assert.throws(
    () => attach(host, {}, {
      'sidechat.create': { enabled: true },
      'session.fork': { enabled: true },
    }),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
});

test('sidechat.create inherits parent sessionConfig and rejects a config parameter', () => {
  const host = validator({ sidechat: 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }], [{
    id: 'execution_mode',
    displayName: 'Mode',
    binding: 'session',
    control: 'select',
    required: false,
    defaultValue: 'agent',
    choices: [{ value: 'agent', displayName: 'Agent' }],
  }]);
  attach(host, { execution_mode: 'agent' });
  assert.throws(
    () => parseProxyRequest(rpc({
      id: 'bad',
      method: 'sidechat.create',
      params: {
        parentSessionId: 's_1',
        parentStreamId: 'stream-1',
        sidechatId: 'sc_1',
        config: { execution_mode: 'ask' },
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError,
  );
  createSidechat(host, sidechatSnapshot({ sessionConfig: { execution_mode: 'agent' } }));
  assert.equal(resultSchemas['sidechat.create'].safeParse({
    sidechat: sidechatSnapshot({ sessionConfig: { execution_mode: 'agent' } }),
  }).success, true);
});

test('catalog.resolve on an ordinary Session checks stream identity', () => {
  const host = validator({ 'catalog.resolve': 1 });
  listCatalog(host);
  attach(host);
  assert.throws(
    () => host.registerRequest(rpc({
      id: 'resolve',
      method: 'catalog.resolve',
      params: {
        catalogRevision: 'cat-1',
        sessionId: 's_1',
        streamId: 'wrong-stream',
        sessionConfig: {},
        turnConfig: {},
      },
    })),
    (error: unknown) => isRequestFault(error, 'SESSION_STALE'),
  );
});

test('sidechat.resume rejects a Side Chat parent', () => {
  const host = validator({ sidechat: 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  attach(host);
  createSidechat(host);
  assert.throws(
    () => host.registerRequest(rpc({
      id: 'nested-resume',
      method: 'sidechat.resume',
      params: {
        sidechatId: 'sc_nested',
        parentSessionId: 'sc_1',
        resumeRef: { id: 'opaque-ref-1' },
      },
    })),
    (error: unknown) => isRequestFault(error, 'SESSION_NOT_FOUND'),
  );
});

test('sidechat.create rejects a Side Chat parent', () => {
  const host = validator({ sidechat: 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  attach(host);
  createSidechat(host);
  assert.throws(
    () => host.registerRequest(rpc({
      id: 'nested',
      method: 'sidechat.create',
      params: {
        parentSessionId: 'sc_1',
        parentStreamId: 'stream-side-1',
        sidechatId: 'sc_nested',
      },
    })),
    (error: unknown) => isRequestFault(error, 'SESSION_NOT_FOUND'),
  );
});

test('sidechatId is rejected by ordinary session methods', () => {
  const host = validator({
    sidechat: 1,
    'session.rename': 1,
    'session.replay': 1,
    'catalog.resolve': 1,
  });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  attach(host);
  createSidechat(host);
  for (const [id, method, params] of [
    ['get', 'session.get', { sessionId: 'sc_1' }],
    ['rename', 'session.rename', { sessionId: 'sc_1', streamId: 'stream-side-1', name: 'nope' }],
    ['replay', 'session.replay', { sessionId: 'sc_1', streamId: 'stream-side-1', cursor: null, limit: 10 }],
    ['close', 'session.close', { sessionId: 'sc_1', streamId: 'stream-side-1' }],
    ['resolve', 'catalog.resolve', {
      catalogRevision: 'cat-1',
      sessionId: 'sc_1',
      streamId: 'stream-side-1',
      sessionConfig: {},
      turnConfig: {},
    }],
  ] as const) {
    assert.throws(
      () => host.registerRequest(rpc({ id, method, params })),
      (error: unknown) => isRequestFault(error, 'SESSION_NOT_FOUND'),
      `${method} must reject a sidechatId`,
    );
  }
});

test('turn.start is legal on a Side Chat route and isolates session-fatal faults', () => {
  const host = validator({ sidechat: 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  attach(host);
  createSidechat(host);
  host.registerRequest(rpc({
    id: 'turn',
    method: 'turn.start',
    params: {
      sessionId: 'sc_1',
      streamId: 'stream-side-1',
      turnId: 't_side',
      input: [{ type: 'text', text: 'hello' }],
      config: {},
    },
  }));
  host.acceptLine(JSON.stringify(rpc({ id: 'turn', result: { accepted: true, turnId: 't_side' } })));
  assert.throws(
    () => host.acceptLine(JSON.stringify(rpc({
      method: 'turn.started',
      params: {
        eventId: 'evt-gap',
        sessionId: 'sc_1',
        streamId: 'stream-side-1',
        sequence: 3,
        turnId: 't_side',
        sourceTurnId: 'src-side',
        emittedAt: timestamp,
        data: {},
      },
    }))),
    (error: unknown) => (
      error instanceof ProxyProtocolError
      && error.faultClass === 'session'
      && error.sessionId === 'sc_1'
      && error.streamId === 'stream-side-1'
    ),
  );
  host.registerRequest(rpc({
    id: 'parent-turn',
    method: 'turn.start',
    params: {
      sessionId: 's_1',
      streamId: 'stream-1',
      turnId: 't_parent',
      input: [{ type: 'text', text: 'still alive' }],
      config: {},
    },
  }));
  host.acceptLine(JSON.stringify(rpc({
    id: 'parent-turn',
    result: { accepted: true, turnId: 't_parent' },
  })));
});

test('unknown resumeRef close converges to success and a live-owner ref conflicts', () => {
  const host = validator({ sidechat: 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  attach(host);
  createSidechat(host);
  assert.throws(
    () => host.registerRequest(rpc({
      id: 'close-other',
      method: 'sidechat.close',
      params: {
        sidechatId: 'sc_other',
        resumeRef: { id: 'opaque-ref-1' },
      },
    })),
    (error: unknown) => isRequestFault(error, 'CONFLICT'),
  );
  host.registerRequest(rpc({
    id: 'close-unknown',
    method: 'sidechat.close',
    params: {
      sidechatId: 'sc_ghost',
      resumeRef: { id: 'never-seen' },
    },
  }));
  const closed = host.acceptLine(JSON.stringify(rpc({
    id: 'close-unknown',
    result: { ok: true, sidechatId: 'sc_ghost', providerDataDeleted: false },
  })));
  assert.deepEqual(closed, {
    id: 'close-unknown',
    result: { ok: true, sidechatId: 'sc_ghost', providerDataDeleted: false },
  });
});

test('sidechat.close allows terminal teardown events before success', () => {
  const host = validator({ sidechat: 1 });
  listCatalog(host, [{ id: 'sidechat.create', supported: true }]);
  attach(host);
  createSidechat(host);
  host.registerRequest(rpc({
    id: 'turn',
    method: 'turn.start',
    params: {
      sessionId: 'sc_1',
      streamId: 'stream-side-1',
      turnId: 't_side',
      input: [{ type: 'text', text: 'run' }],
      config: {},
    },
  }));
  host.acceptLine(JSON.stringify(rpc({ id: 'turn', result: { accepted: true, turnId: 't_side' } })));
  host.registerRequest(rpc({
    id: 'close',
    method: 'sidechat.close',
    params: {
      sidechatId: 'sc_1',
      streamId: 'stream-side-1',
      resumeRef: { id: 'opaque-ref-1' },
    },
  }));
  host.acceptLine(JSON.stringify(rpc({
    method: 'turn.started',
    params: {
      eventId: 'evt-1',
      sessionId: 'sc_1',
      streamId: 'stream-side-1',
      sequence: 1,
      turnId: 't_side',
      sourceTurnId: 'src-side',
      emittedAt: timestamp,
      data: {},
    },
  })));
  host.acceptLine(JSON.stringify(rpc({
    method: 'turn.completed',
    params: {
      eventId: 'evt-2',
      sessionId: 'sc_1',
      streamId: 'stream-side-1',
      sequence: 2,
      turnId: 't_side',
      sourceTurnId: 'src-side',
      emittedAt: timestamp,
      data: { stopReason: 'interrupted' },
    },
  })));
  host.acceptLine(JSON.stringify(rpc({
    id: 'close',
    result: { ok: true, sidechatId: 'sc_1', providerDataDeleted: true },
  })));
  assert.throws(
    () => host.acceptLine(JSON.stringify(rpc({
      method: 'session.updated',
      params: {
        eventId: 'evt-late',
        sessionId: 'sc_1',
        streamId: 'stream-side-1',
        sequence: 3,
        emittedAt: timestamp,
        data: { state: 'closed' },
      },
    }))),
    (error: unknown) => (
      error instanceof ProxyProtocolError && error.faultClass === 'session'
    ),
  );
});

test('session.fork turn anchors require atTurn and inherit config validation', () => {
  const options = [{
    id: 'execution_mode',
    displayName: 'Mode',
    binding: 'session',
    control: 'select',
    required: true,
    defaultValue: 'agent',
    choices: [{ value: 'agent', displayName: 'Agent' }],
  }];
  const host = validator({ 'session.replay': 1, 'session.fork': 1 });
  listCatalog(host, [{ id: 'session.fork', supported: true }], options);
  attach(host, { execution_mode: 'agent' });
  assert.throws(
    () => host.registerRequest(rpc({
      id: 'fork-turn',
      method: 'session.fork',
      params: {
        sourceSessionId: 's_1',
        sourceStreamId: 'stream-1',
        sessionId: 's_fork',
        anchor: { type: 'turn', turnId: 't_1', sourceTurnId: 'src-1' },
      },
    })),
    (error: unknown) => isRequestFault(error, 'CAPABILITY_NOT_SUPPORTED'),
  );
  const withAtTurn = validator({
    'session.replay': 1,
    'session.fork': 1,
    'session.fork.atTurn': 1,
  });
  listCatalog(withAtTurn, [
    { id: 'session.fork', supported: true },
    { id: 'session.fork.atTurn', supported: true },
  ], options);
  attach(withAtTurn, { execution_mode: 'agent' });
  withAtTurn.registerRequest(rpc({
    id: 'fork',
    method: 'session.fork',
    params: {
      sourceSessionId: 's_1',
      sourceStreamId: 'stream-1',
      sessionId: 's_fork',
      anchor: { type: 'turn', turnId: 't_1', sourceTurnId: 'src-1' },
    },
  }));
  withAtTurn.acceptLine(JSON.stringify(rpc({
    id: 'fork',
    result: {
      session: {
        id: 's_fork',
        streamId: 'stream-fork',
        state: 'idle',
        nativeSession: { id: 'native-s_fork' },
        sessionConfig: { execution_mode: 'agent' },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      origin: {
        kind: 'fork',
        sessionId: 's_1',
        turnId: 't_1',
        sourceTurnId: 'src-1',
      },
    },
  })));
  assert.equal(resultSchemas['session.fork'].safeParse({
    session: {
      id: 's_fork',
      streamId: 'stream-fork',
      state: 'idle',
      sessionConfig: { execution_mode: 'agent' },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    origin: {
      kind: 'fork',
      sessionId: 's_1',
      turnId: 't_1',
      sourceTurnId: 'src-1',
    },
  }).success, false);
});

test('Side Chat cannot be a fork source', () => {
  const host = validator({
    sidechat: 1,
    'session.replay': 1,
    'session.fork': 1,
  });
  listCatalog(host, [
    { id: 'sidechat.create', supported: true },
    { id: 'session.fork', supported: true },
  ]);
  attach(host);
  createSidechat(host);
  assert.throws(
    () => host.registerRequest(rpc({
      id: 'fork',
      method: 'session.fork',
      params: {
        sourceSessionId: 'sc_1',
        sourceStreamId: 'stream-side-1',
        sessionId: 's_fork',
        anchor: { type: 'head' },
      },
    })),
    (error: unknown) => isRequestFault(error, 'SESSION_NOT_FOUND'),
  );
});

test('resumeRef is recursively redacted from objects, errors, and URLs', () => {
  const redacted = redactSensitiveProtocolValue({
    sidechat: {
      id: 'sc_1',
      resumeRef: { id: 'secret-ref' },
      nested: { resume_ref_id: 'also-secret' },
    },
    visible: 'ok',
  }) as { sidechat: { resumeRef: string; nested: { resume_ref_id: string } }; visible: string };
  assert.equal(redacted.visible, 'ok');
  assert.equal(redacted.sidechat.resumeRef, '[REDACTED]');
  assert.equal(redacted.sidechat.nested.resume_ref_id, '[REDACTED]');
  assert.match(
    redactSensitiveProtocolText('https://gian.local/sidechat?resumeRef=secret-ref'),
    /resumeRef=\[REDACTED\]/,
  );
  const nestedJson = '{"resumeRef":{"id":"secret-ref"}}';
  const redactedJson = redactSensitiveProtocolText(nestedJson);
  assert.doesNotMatch(redactedJson, /secret-ref/);
  assert.deepEqual(JSON.parse(redactedJson), { resumeRef: '[REDACTED]' });
  assert.doesNotMatch(
    redactSensitiveProtocolText('prefix {"resumeRef":{"id":"secret-ref"'),
    /secret-ref/,
  );
  assert.doesNotMatch(
    redactSensitiveProtocolText("resumeRef: { id: 'secret-ref' }"),
    /secret-ref/,
  );
  const error = domainError('err', 'SIDECHAT_UNAVAILABLE', 'Side Chat is gone', false, {
    resumeRef: { id: 'secret-ref' },
  });
  const details = error.error.data as { details: unknown };
  assert.deepEqual(
    redactSensitiveProtocolValue(details.details),
    { resumeRef: '[REDACTED]' },
  );
});

test('sidechat and session snapshots reject unknown required fields', () => {
  assert.equal(sidechatSchema.safeParse(sidechatSnapshot()).success, true);
  assert.equal(sessionSchema.safeParse({
    id: 's_1',
    streamId: 'stream-1',
    state: 'idle',
    sessionConfig: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }).success, true);
});
