import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AttachmentTurnLedger,
  HostProtocolValidator,
  IncrementalReplayTracker,
  JSONRPC_ERROR_CODES,
  MAX_NDJSON_LINE_BYTES,
  MAX_REQUEST_JSON_BYTES,
  NdjsonLineDecoder,
  PROTOCOL_V2,
  ProxyProtocolError,
  ReplayPageValidator,
  ReplaySnapshotPager,
  canonicalFingerprint,
  domainError,
  manifestV2Schema,
  parseNdjsonObject,
  parseProxyRequest,
  protocolRangeIncludes,
  proxyNotificationSchema,
  replayEventSchemaUnion,
  type ReplayEvent,
  type TurnStartParams,
} from '../src/index.js';

const timestamp = '2026-08-17T11:30:00.000Z';

function rpc<T extends Record<string, unknown>>(value: T): T & { jsonrpc: '2.0' } {
  return { jsonrpc: '2.0', ...value };
}

function initialize(
  validator: HostProtocolValidator,
  capabilities: Record<string, number> = {},
): void {
  validator.registerRequest(rpc({
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '0.4.5', locale: 'zh-CN' },
    },
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'init',
    result: {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'codex', name: 'Codex', version: '0.3.0' },
      process: { scope: 'shared' },
      capabilities,
    },
  })));
}

function attach(validator: HostProtocolValidator): void {
  validator.registerRequest(rpc({
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
      config: {},
    },
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'create',
    result: {
      session: {
        id: 's_1',
        nativeSession: { id: 'native-1' },
        streamId: 'stream-1',
        state: 'idle',
        sessionConfig: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  })));
}

function startTurn(validator: HostProtocolValidator, turnId = 't_1'): void {
  validator.registerRequest(rpc({
    id: `start-${turnId}`,
    method: 'turn.start',
    params: turnParams({ turnId }),
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: `start-${turnId}`,
    result: { accepted: true, turnId },
  })));
}

function notification(
  method: string,
  sequence: number,
  data: Record<string, unknown>,
  turnId?: string,
  eventId = `evt-${sequence}`,
): string {
  return JSON.stringify(rpc({
    method,
    params: {
      eventId,
      streamId: 'stream-1',
      sequence,
      sessionId: 's_1',
      ...(turnId ? { turnId, sourceTurnId: `src-${turnId}` } : {}),
      emittedAt: timestamp,
      data,
    },
  }));
}

function turnParams(overrides: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    sessionId: 's_1',
    streamId: 'stream-1',
    turnId: 't_1',
    input: [{ type: 'text', text: 'hello' }],
    config: {},
    ...overrides,
  };
}

function replayEvent(
  method: string,
  sequence: number,
  sourceTurnId: string,
  data: Record<string, unknown>,
  eventId = `evt-${sourceTurnId}-${sequence}`,
): ReplayEvent {
  return replayEventSchemaUnion.parse({
    method,
    eventId,
    sessionId: 's_1',
    replayStreamId: 'replay-1',
    sequence,
    sourceTurnId,
    emittedAt: timestamp,
    data,
  });
}

function isSessionFault(
  error: unknown,
  sessionId = 's_1',
  streamId = 'stream-1',
): boolean {
  return error instanceof ProxyProtocolError
    && error.faultClass === 'session'
    && error.sessionId === sessionId
    && error.streamId === streamId;
}

test('manifest v2 accepts a 2.0 protocol range', () => {
  const manifest = manifestV2Schema.parse({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '0.3.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'shared' },
  });
  assert.equal(manifest.pluginVersion, '0.3.0');
  assert.equal(protocolRangeIncludes(manifest.protocol.range, PROTOCOL_V2), true);
  assert.equal(protocolRangeIncludes(manifest.protocol.range, '1.0'), false);
  assert.equal(protocolRangeIncludes('>=1.0 <2.0', PROTOCOL_V2), false);
});

test('NDJSON framing rejects invalid JSON, batches, and oversized lines as connection-fatal', () => {
  assert.throws(
    () => parseNdjsonObject('{'),
    (error: unknown) => error instanceof ProxyProtocolError && error.faultClass === 'connection',
  );
  assert.throws(
    () => parseNdjsonObject('[]'),
    (error: unknown) => error instanceof ProxyProtocolError && error.faultClass === 'connection',
  );
  assert.throws(
    () => parseNdjsonObject('x'.repeat(MAX_NDJSON_LINE_BYTES + 1)),
    (error: unknown) => error instanceof ProxyProtocolError && error.faultClass === 'connection',
  );
});

test('NDJSON byte framing rejects invalid UTF-8 before exposing the chunk', () => {
  const decoder = new NdjsonLineDecoder();
  assert.throws(
    () => decoder.push(Buffer.from([
      ...Buffer.from('{"ok":true}\n'),
      0xc3,
      0x28,
      0x0a,
    ])),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
});

test('requests require a JSON-RPC 2.0 envelope and a string id', () => {
  assert.throws(
    () => parseProxyRequest({
      id: 'req-1',
      method: 'shutdown',
      params: {},
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_REQUEST'
      && error.jsonRpcCode === JSONRPC_ERROR_CODES.INVALID_REQUEST,
  );
  assert.throws(
    () => parseProxyRequest(rpc({
      id: 1,
      method: 'shutdown',
      params: {},
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_REQUEST',
  );
  assert.doesNotThrow(() => parseProxyRequest(rpc({
    id: 'req-1',
    method: 'shutdown',
    params: {},
  })));
  assert.throws(
    () => parseProxyRequest(rpc({
      id: 'req-2',
      method: 'slash.list',
      params: {},
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'METHOD_NOT_FOUND'
      && error.jsonRpcCode === JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
  );
});

test('initialize is first and static capabilities gate optional methods', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    pluginVersion: '0.3.0',
    processScope: 'shared',
  });
  assert.doesNotThrow(() => validator.registerRequest(rpc({
    id: 'shutdown-before-init',
    method: 'shutdown',
    params: {},
  })));
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'catalog',
      method: 'catalog.list',
      params: {},
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'NOT_INITIALIZED',
  );

  initialize(validator);
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'steer',
      method: 'turn.steer',
      params: {
        sessionId: 's_1',
        streamId: 'stream-1',
        turnId: 't_1',
        input: [{ type: 'text', text: 'more' }],
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED',
  );
});

test('catalog and turn config use binding and CONFIG_* domain codes', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'input.localImage': 1 });
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'turn-file',
      method: 'turn.start',
      params: turnParams({
        input: [{ type: 'localFile', path: '/tmp/file.txt' }],
      }),
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED',
  );

  validator.registerRequest(rpc({ id: 'catalog', method: 'catalog.list', params: {} }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'catalog',
    result: {
      catalogRevision: 'catalog-1',
      input: [{ type: 'text' }],
      slashCommands: [],
      configOptions: [
        {
          id: 'profile',
          displayName: 'Profile',
          binding: 'session',
          control: 'select',
          required: true,
          defaultValue: 'default',
          choices: [{ value: 'default', displayName: 'Default' }],
        },
        {
          id: 'effort',
          displayName: 'Effort',
          binding: 'turn',
          role: 'effort',
          control: 'select',
          required: true,
          defaultValue: 'high',
          choices: [{ value: 'high', displayName: 'High' }],
        },
      ],
    },
  })));

  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'create-missing',
      method: 'session.create',
      params: {
        sessionId: 's_missing',
        workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
        config: {},
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CONFIG_REQUIRED',
  );
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'create-turn-opt',
      method: 'session.create',
      params: {
        sessionId: 's_binding',
        workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
        config: { effort: 'high' },
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CONFIG_BINDING_INVALID',
  );
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'create-unknown',
      method: 'session.create',
      params: {
        sessionId: 's_unknown',
        workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
        config: { invented: true },
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CONFIG_VALUE_INVALID',
  );

  validator.registerRequest(rpc({
    id: 'create-ok',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
      config: { profile: 'default' },
    },
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'create-ok',
    result: {
      session: {
        id: 's_1',
        streamId: 'stream-1',
        state: 'idle',
        sessionConfig: { profile: 'default' },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  })));

  assert.doesNotThrow(() => validator.registerRequest(rpc({
    id: 'turn-ok',
    method: 'turn.start',
    params: turnParams({ config: { effort: 'high' } }),
  })));
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'turn-session-opt',
      method: 'turn.start',
      params: turnParams({ turnId: 't_2', config: { profile: 'default' } }),
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CONFIG_BINDING_INVALID',
  );
});

test('turn.start rejects a policy field and hostServices without capability', () => {
  assert.throws(
    () => parseProxyRequest(rpc({
      id: 'turn',
      method: 'turn.start',
      params: {
        ...turnParams(),
        policy: { approval: 'relay' },
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_PARAMS',
  );

  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'create-mcp',
      method: 'session.create',
      params: {
        sessionId: 's_mcp',
        workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
        config: {},
        hostServices: [{
          id: 'gian.tools',
          protocol: 'mcp',
          transport: {
            type: 'streamable-http',
            url: 'http://127.0.0.1:8991/internal/mcp',
          },
        }],
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED',
  );
});

test('turn.start success must precede turn.started', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  assert.throws(
    () => validator.acceptLine(notification('turn.started', 1, {}, 't_1')),
    (error: unknown) => isSessionFault(error),
  );

  startTurn(validator);
  assert.doesNotThrow(() => validator.acceptLine(notification('turn.started', 1, {}, 't_1')));
});

test('live stream sequence gaps are session-fatal and isolate session identity', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  startTurn(validator);
  assert.throws(
    () => validator.acceptLine(notification('turn.started', 2, {}, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /does not match expected 1/.test(error.message),
  );
});

test('canonical fingerprint excludes attach fields and treats identical live/replay facts as equal', () => {
  const live = proxyNotificationSchema.parse(JSON.parse(notification(
    'content.completed',
    2,
    { contentId: 'answer', kind: 'text', format: 'markdown', content: 'done' },
    't_1',
    'evt-stable',
  )));
  const replay = replayEvent(
    'content.completed',
    9,
    'src-t_1',
    { contentId: 'answer', kind: 'text', format: 'markdown', content: 'done' },
    'evt-stable',
  );
  assert.equal(canonicalFingerprint(live), canonicalFingerprint({
    method: replay.method,
    sourceTurnId: replay.sourceTurnId,
    data: replay.data,
  }));
  assert.notEqual(
    JSON.stringify(live),
    JSON.stringify(replay),
  );
});

test('step.updated and request.updated schemas accept bounded snapshots and replay the same facts', () => {
  const requestData = {
    requestId: 'request-native-turn-1-step-0',
    reason: 'initial',
    stepId: 'native-turn-1:0',
    model: { provider: 'deepseek', id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
    parameters: { effort: 'high', temperature: 0.2, stream: true, seed: null },
    systemPrompt: { text: 'You are a careful coding agent.', truncated: false },
    tools: [{ name: 'read_file', description: 'Read one workspace file.' }],
    context: { window: 128_000 },
    truncated: false,
  } as const;
  const liveStep = proxyNotificationSchema.parse(JSON.parse(notification(
    'step.updated',
    2,
    { stepId: 'native-turn-1:0', index: 0, status: 'running' },
    't_1',
    'evt-step-stable',
  )));
  const liveRequest = proxyNotificationSchema.parse(JSON.parse(notification(
    'request.updated',
    3,
    requestData,
    't_1',
    'evt-request-stable',
  )));
  const replayStep = replayEvent(
    'step.updated',
    2,
    'src-t_1',
    liveStep.params.data,
    'evt-step-stable',
  );
  const replayRequest = replayEvent(
    'request.updated',
    3,
    'src-t_1',
    liveRequest.params.data,
    'evt-request-stable',
  );
  assert.equal(canonicalFingerprint(liveStep), canonicalFingerprint(replayStep));
  assert.equal(canonicalFingerprint(liveRequest), canonicalFingerprint(replayRequest));

  assert.throws(() => proxyNotificationSchema.parse(JSON.parse(notification(
    'request.updated',
    4,
    {
      requestId: 'request-too-large',
      reason: 'change',
      systemPrompt: { text: 'x'.repeat(MAX_REQUEST_JSON_BYTES), truncated: false },
    },
    't_1',
  ))), /request\.updated data exceeds/);
});

test('usage stepId is valid only on Turn-scoped notifications', () => {
  assert.throws(() => proxyNotificationSchema.parse(JSON.parse(notification(
    'usage.updated',
    1,
    { stepId: 'step-1', context: { used: 10, window: 100 } },
  ))), /stepId is valid only on Turn-scoped usage\.updated/);
  assert.doesNotThrow(() => proxyNotificationSchema.parse(JSON.parse(notification(
    'usage.updated',
    1,
    { stepId: 'step-1', context: { used: 10, window: 100 } },
    't_1',
  ))));
});

test('event.step and event.request capabilities gate their events and step-linked data', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'event.usage': 1 });
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('step.updated', 2, {
      stepId: 'step-1', index: 0, status: 'running',
    }, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /without capability event\.step/.test(error.message),
  );
  assert.throws(
    () => validator.acceptLine(notification('request.updated', 2, {
      requestId: 'request-1', reason: 'initial',
    }, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /without capability event\.request/.test(error.message),
  );
  assert.throws(
    () => validator.acceptLine(notification('content.completed', 2, {
      contentId: 'answer', kind: 'text', stepId: 'step-1', content: 'done',
    }, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /with stepId without capability event\.step/.test(error.message),
  );
});

test('same eventId with the same fingerprint is ignored; a different fingerprint is session-fatal', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1', 'evt-start'));
  assert.doesNotThrow(() => {
    validator.acceptLine(notification('turn.started', 1, {}, 't_1', 'evt-start'));
  });
  assert.throws(
    () => validator.acceptLine(notification(
      'content.completed',
      2,
      { contentId: 'answer', kind: 'text', content: 'done' },
      't_1',
      'evt-start',
    )),
    (error: unknown) => isSessionFault(error),
  );
});

test('running activities and open content must finish before a terminal turn event', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('activity.updated', 2, {
    activityId: 'act-1',
    kind: 'shell',
    title: 'Run tests',
    status: 'running',
    presentation: { type: 'tool', data: { name: 'shell' } },
  }, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('turn.completed', 3, {
      stopReason: 'completed',
    }, 't_1')),
    (error: unknown) => isSessionFault(error),
  );

  const contentValidator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(contentValidator);
  attach(contentValidator);
  startTurn(contentValidator);
  contentValidator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  contentValidator.acceptLine(notification('content.delta', 2, {
    contentId: 'answer',
    kind: 'text',
    delta: 'hello',
  }, 't_1'));
  assert.throws(
    () => contentValidator.acceptLine(notification('turn.completed', 3, {
      stopReason: 'completed',
    }, 't_1')),
    (error: unknown) => isSessionFault(error),
  );
});

test('running steps must finish before a terminal turn and content stepId is immutable', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'event.step': 1 });
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('step.updated', 2, {
    stepId: 'step-1', index: 0, status: 'running',
  }, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('turn.completed', 3, {
      stopReason: 'completed',
    }, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /open interactions, activities, steps, or content streams/.test(error.message),
  );
  validator.acceptLine(notification('step.updated', 3, {
    stepId: 'step-1', index: 0, status: 'completed',
  }, 't_1'));
  validator.acceptLine(notification('content.delta', 4, {
    contentId: 'answer', kind: 'text', stepId: 'step-1', delta: 'working',
  }, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('content.completed', 5, {
      contentId: 'answer', kind: 'text', stepId: 'step-2', content: 'done',
    }, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /changed kind, format, or stepId/.test(error.message),
  );
  validator.acceptLine(notification('content.completed', 5, {
    contentId: 'answer', kind: 'text', stepId: 'step-1', content: 'done',
  }, 't_1'));
  assert.doesNotThrow(() => validator.acceptLine(notification('turn.completed', 6, {
    stopReason: 'completed',
  }, 't_1')));
});

test('conversation delta usage applies once per turn and optional step key', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'event.step': 1, 'event.usage': 1 });
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  const delta = (stepId?: string) => ({
    ...(stepId ? { stepId } : {}),
    conversation: { mode: 'delta', inputTokens: 1, outputTokens: 1 },
  });
  validator.acceptLine(notification('usage.updated', 2, delta('step-1'), 't_1'));
  validator.acceptLine(notification('usage.updated', 3, delta('step-2'), 't_1'));
  validator.acceptLine(notification('usage.updated', 4, delta(), 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('usage.updated', 5, delta('step-1'), 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /more than once for step step-1/.test(error.message),
  );
});

test('session live event identities are released with the closed attachment', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1', 'event-reused'));
  validator.acceptLine(notification('turn.completed', 2, {
    stopReason: 'completed',
  }, 't_1', 'event-end'));

  validator.registerRequest(rpc({
    id: 'close-1',
    method: 'session.close',
    params: { sessionId: 's_1', streamId: 'stream-1' },
  }));
  validator.acceptLine(JSON.stringify(rpc({ id: 'close-1', result: { ok: true } })));

  validator.registerRequest(rpc({
    id: 'attach-2',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      workspace: { cwd: '/tmp/project', roots: ['/tmp/project'] },
      config: {},
    },
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'attach-2',
    result: {
      session: {
        id: 's_1',
        streamId: 'stream-2',
        state: 'idle',
        sessionConfig: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  })));
  validator.registerRequest(rpc({
    id: 'start-t2',
    method: 'turn.start',
    params: turnParams({ streamId: 'stream-2', turnId: 't_2' }),
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'start-t2',
    result: { accepted: true, turnId: 't_2' },
  })));
  assert.doesNotThrow(() => validator.acceptLine(JSON.stringify(rpc({
    method: 'turn.started',
    params: {
      eventId: 'event-reused',
      streamId: 'stream-2',
      sequence: 1,
      sessionId: 's_1',
      turnId: 't_2',
      sourceTurnId: 'src-t_2',
      emittedAt: timestamp,
      data: {},
    },
  }))));
});

test('session.get validates against the stream owned by the current attachment', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  validator.registerRequest(rpc({
    id: 'get-1',
    method: 'session.get',
    params: { sessionId: 's_1' },
  }));
  assert.doesNotThrow(() => validator.acceptLine(JSON.stringify(rpc({
    id: 'get-1',
    result: {
      session: {
        id: 's_1',
        nativeSession: { id: 'native-1' },
        streamId: 'stream-1',
        state: 'idle',
        sessionConfig: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  }))));

  validator.registerRequest(rpc({
    id: 'get-2',
    method: 'session.get',
    params: { sessionId: 's_1' },
  }));
  assert.throws(
    () => validator.acceptLine(JSON.stringify(rpc({
      id: 'get-2',
      result: {
        session: {
          id: 's_1',
          streamId: 'stream-other',
          state: 'idle',
          sessionConfig: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }))),
    /different session attachment/,
  );
});

test('reasoning content is capability-gated; status is core', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  assert.doesNotThrow(() => validator.acceptLine(notification('content.delta', 2, {
    contentId: 'status-1',
    kind: 'status',
    delta: 'working',
  }, 't_1')));
  assert.throws(
    () => validator.acceptLine(notification('content.delta', 3, {
      contentId: 'think-1',
      kind: 'reasoning',
      delta: 'hmm',
    }, 't_1')),
    (error: unknown) => isSessionFault(error)
      && error instanceof ProxyProtocolError
      && /event.reasoning/.test(error.message),
  );
});

test('turn idempotency is scoped to the active attachment stream', () => {
  const ledger = new AttachmentTurnLedger();
  ledger.attach('s_1', 'stream-1');
  assert.equal(ledger.accept(turnParams()), 'new');
  assert.equal(ledger.accept(turnParams()), 'duplicate');
  assert.throws(
    () => ledger.accept(turnParams({
      input: [{ type: 'text', text: 'different' }],
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CONFLICT',
  );
  ledger.attach('s_1', 'stream-2');
  assert.throws(
    () => ledger.accept(turnParams()),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'SESSION_STALE',
  );
});

test('usage delta requires a turn-scoped envelope', () => {
  const usage = proxyNotificationSchema.safeParse(rpc({
    method: 'usage.updated',
    params: {
      eventId: 'evt-usage',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 's_1',
      emittedAt: timestamp,
      data: {
        conversation: {
          mode: 'delta',
          inputTokens: 10,
        },
      },
    },
  }));
  assert.equal(usage.success, false);
});

test('submitted interaction.resolved before respond success is session-fatal', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { interaction: 1 });
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('interaction.requested', 2, {
    interactionId: 'native-1',
    title: 'Run tests',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [{ id: 'allow-once', label: 'Allow once', style: 'primary' }],
  }, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('interaction.resolved', 3, {
      interactionId: 'native-1',
      outcome: 'submitted',
      actionId: 'allow-once',
    }, 't_1')),
    (error: unknown) => isSessionFault(error),
  );
});

test('interaction IDs round-trip and responseId is idempotent', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { interaction: 1 });
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('interaction.requested', 2, {
    interactionId: 'native-1',
    title: 'Run tests',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [
      { id: 'allow-once', label: 'Allow once', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ],
  }, 't_1'));

  validator.registerRequest(rpc({
    id: 'respond-1',
    method: 'interaction.respond',
    params: {
      responseId: 'response_1',
      sessionId: 's_1',
      streamId: 'stream-1',
      turnId: 't_1',
      interactionId: 'native-1',
      actionId: 'allow-once',
      values: {},
    },
  }));
  validator.acceptLine(JSON.stringify(rpc({
    id: 'respond-1',
    result: {
      accepted: true,
      interactionId: 'native-1',
      responseId: 'response_1',
    },
  })));
  assert.doesNotThrow(() => validator.registerRequest(rpc({
    id: 'respond-dup',
    method: 'interaction.respond',
    params: {
      responseId: 'response_1',
      sessionId: 's_1',
      streamId: 'stream-1',
      turnId: 't_1',
      interactionId: 'native-1',
      actionId: 'allow-once',
      values: {},
    },
  })));
  assert.throws(
    () => validator.registerRequest(rpc({
      id: 'respond-conflict',
      method: 'interaction.respond',
      params: {
        responseId: 'response_1',
        sessionId: 's_1',
        streamId: 'stream-1',
        turnId: 't_1',
        interactionId: 'native-1',
        actionId: 'deny',
        values: {},
      },
    })),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CONFLICT',
  );

  validator.acceptLine(notification('interaction.resolved', 3, {
    interactionId: 'native-1',
    outcome: 'submitted',
    actionId: 'allow-once',
  }, 't_1'));
  validator.acceptLine(notification('turn.completed', 4, {
    stopReason: 'completed',
  }, 't_1'));
});

test('conversation delta usage is accepted at most once per turn', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'event.usage': 1 });
  attach(validator);
  startTurn(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('usage.updated', 2, {
    conversation: { mode: 'delta', inputTokens: 10 },
  }, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('usage.updated', 3, {
      conversation: { mode: 'delta', outputTokens: 5 },
    }, 't_1')),
    (error: unknown) => isSessionFault(error),
  );
});

test('process catalog.changed is connection-scoped; history.changed is session-scoped', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'session.replay': 1 });
  attach(validator);
  assert.doesNotThrow(() => validator.acceptLine(JSON.stringify(rpc({
    method: 'catalog.changed',
    params: {
      eventId: 'evt-catalog',
      emittedAt: timestamp,
      data: { reason: 'models-updated', revision: 'catalog-2' },
    },
  }))));
  assert.doesNotThrow(() => validator.acceptLine(notification('history.changed', 1, {
    reason: 'native-append',
  })));
});

test('domainError helper builds a JSON-RPC 2.0 domain object', () => {
  assert.deepEqual(domainError('req-1', 'SESSION_NOT_FOUND', 'missing', false), {
    jsonrpc: '2.0',
    id: 'req-1',
    error: {
      code: JSONRPC_ERROR_CODES.DOMAIN_ERROR,
      message: 'missing',
      data: {
        domainCode: 'SESSION_NOT_FOUND',
        retryable: false,
        details: {},
      },
    },
  });
});

test('session.rename limits Unicode code points rather than UTF-16 units', () => {
  const base = {
    id: 'rename',
    method: 'session.rename',
    params: { sessionId: 's_1', streamId: 'stream-1', name: '' },
  } as const;
  assert.doesNotThrow(() => parseProxyRequest(rpc({
    ...base,
    params: { ...base.params, name: '😀'.repeat(200) },
  })));
  assert.throws(() => parseProxyRequest(rpc({
    ...base,
    params: { ...base.params, name: '😀'.repeat(201) },
  })));
});

test('replay pages use the dedicated event shape and continuous sequence', () => {
  const validator = new ReplayPageValidator('s_1');
  validator.acceptPage({
    replayStreamId: 'replay-1',
    events: [replayEvent('turn.started', 1, 'src-1', {})],
    nextCursor: '1',
  });
  validator.acceptPage({
    replayStreamId: 'replay-1',
    events: [replayEvent('input.recorded', 2, 'src-1', {
      input: [{ type: 'text', text: 'original question' }],
    })],
    nextCursor: '2',
  });
  assert.throws(
    () => validator.acceptPage({
      replayStreamId: 'replay-1',
      events: [replayEvent('turn.completed', 4, 'src-1', { stopReason: 'completed' })],
      nextCursor: null,
    }),
    /does not match expected 3/,
  );
});

test('replay pagination pins the first-page snapshot across live refreshes', () => {
  const pager = new ReplaySnapshotPager<number>();
  const first = pager.page('s_1', {
    streamId: 'replay-1',
    events: [1, 2, 3, 4],
  }, null, 2);
  assert.deepEqual(first, {
    replayStreamId: 'replay-1',
    events: [1, 2],
    nextCursor: '2',
  });
  const second = pager.page('s_1', {
    streamId: 'replay-2',
    events: [9],
  }, first.nextCursor, 2);
  assert.deepEqual(second, {
    replayStreamId: 'replay-1',
    events: [3, 4],
    nextCursor: null,
  });
  assert.throws(
    () => pager.page('s_1', { streamId: 'replay-2', events: [9] }, '2', 2),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_PARAMS',
  );
});

test('replay rejects session-scoped metadata events', () => {
  const validator = new ReplayPageValidator('s_1');
  assert.throws(
    () => validator.acceptPage({
      replayStreamId: 'replay-1',
      events: [{
        method: 'session.updated',
        eventId: 'evt-session',
        sessionId: 's_1',
        replayStreamId: 'replay-1',
        sequence: 1,
        sourceTurnId: 'src-1',
        emittedAt: timestamp,
        data: { state: 'idle' },
      }],
      nextCursor: null,
    }),
    /Invalid replay page/,
  );
});

test('incremental replay tracks complete changed turns by sourceTurnId', () => {
  const replayTurn = (sourceTurnId: string, text: string): ReplayEvent[] => [
    replayEvent('turn.started', 1, sourceTurnId, {}, `start-${sourceTurnId}`),
    replayEvent(
      'content.completed',
      2,
      sourceTurnId,
      { contentId: `content-${sourceTurnId}`, kind: 'text', content: text },
      `content-${sourceTurnId}-${text}`,
    ),
    replayEvent(
      'turn.completed',
      3,
      sourceTurnId,
      { stopReason: 'completed' },
      `end-${sourceTurnId}`,
    ),
  ];
  const tracker = new IncrementalReplayTracker();
  const ownTurn = replayTurn('own', 'local');
  tracker.attach({ streamId: 'replay-1', events: ownTurn }, false);
  assert.deepEqual(tracker.replay().events, []);

  const externalTurn = replayTurn('external', 'first');
  assert.equal(tracker.observe({
    streamId: 'replay-1',
    events: [...ownTurn, ...externalTurn],
  }), true);
  assert.deepEqual(
    tracker.replay().events.map((event) => event.sourceTurnId),
    ['external', 'external', 'external'],
  );
  assert.deepEqual(
    tracker.replay().events.map((event) => event.sequence),
    [1, 2, 3],
  );

  tracker.acknowledge();
  const nextOwnTurn = replayTurn('own-2', 'local again');
  tracker.rebase({
    streamId: 'replay-1',
    events: [...ownTurn, ...externalTurn, ...nextOwnTurn],
  });
  assert.deepEqual(
    tracker.replay().events.map((event) => event.sourceTurnId),
    ['external', 'external', 'external'],
  );

  const secondExternal = replayTurn('external-2', 'second');
  assert.equal(tracker.observe({
    streamId: 'replay-1',
    events: [...ownTurn, ...externalTurn, ...nextOwnTurn, ...secondExternal],
  }), true);
  assert.equal(tracker.replay().streamId, 'replay-1');
  assert.deepEqual(
    tracker.replay().events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  );

  const rewrittenExternal = replayTurn('external', 'rewritten');
  assert.equal(tracker.observe({
    streamId: 'replay-1',
    events: [...ownTurn, ...rewrittenExternal, ...nextOwnTurn, ...secondExternal],
  }), true);
  assert.match(tracker.replay().streamId, /^replay-1-revision-/);
});
