import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AttachmentTurnLedger,
  HostProtocolValidator,
  IncrementalReplayTracker,
  MAX_NDJSON_LINE_BYTES,
  NdjsonLineDecoder,
  ProxyProtocolError,
  ReplaySnapshotPager,
  ReplayPageValidator,
  manifestV2Schema,
  parseNdjsonObject,
  parseProxyRequest,
  protocolRangeIncludes,
  proxyNotificationSchema,
  type TurnStartParams,
} from '../src/index.js';

const timestamp = '2026-08-10T05:30:00.000Z';

function initialize(
  validator: HostProtocolValidator,
  capabilities: Record<string, number> = {},
): void {
  validator.registerRequest({
    id: 'init',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '0.3.0' },
    },
  });
  validator.acceptLine(JSON.stringify({
    id: 'init',
    result: {
      protocol: { name: 'gian.proxy', version: '1.0' },
      plugin: { id: 'codex', name: 'Codex', version: '0.3.2' },
      process: { scope: 'shared' },
      capabilities,
    },
  }));
}

function attach(validator: HostProtocolValidator): void {
  validator.registerRequest({
    id: 'create',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      cwd: '/tmp/project',
      workspaceRoots: ['/tmp/project'],
      config: {},
    },
  });
  validator.acceptLine(JSON.stringify({
    id: 'create',
    result: {
      session: {
        id: 's_1',
        nativeSession: { id: 'native-1' },
        streamId: 'stream-1',
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  }));
}

function notification(
  method: string,
  sequence: number,
  data: Record<string, unknown>,
  turnId?: string,
  eventId = `evt-${sequence}`,
): string {
  return JSON.stringify({
    method,
    params: {
      eventId,
      streamId: 'stream-1',
      sequence,
      sessionId: 's_1',
      ...(turnId ? { turnId } : {}),
      emittedAt: timestamp,
      data,
    },
  });
}

function turnParams(overrides: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    sessionId: 's_1',
    streamId: 'stream-1',
    turnId: 't_1',
    input: [{ type: 'text', text: 'hello' }],
    policy: {
      workspaceRoots: ['/tmp/project'],
      approval: 'relay',
      network: 'ask',
    },
    config: { native: {} },
    ...overrides,
  };
}

test('manifest v2 separates plugin and protocol identity', () => {
  const manifest = manifestV2Schema.parse({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '0.3.2',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=1.0 <2.0' },
    process: { scope: 'shared' },
  });
  assert.equal(manifest.pluginVersion, '0.3.2');
  assert.equal(manifest.protocol.name, 'gian.proxy');

  assert.equal(manifestV2Schema.safeParse({
    ...manifest,
    entry: '../proxy.mjs',
  }).success, false);
});

test('protocol ranges are independent from plugin SemVer', () => {
  assert.equal(protocolRangeIncludes('>=1.0 <2.0', '1.0'), true);
  assert.equal(protocolRangeIncludes('^1.0', '1.0'), true);
  assert.equal(protocolRangeIncludes('1.x', '1.0'), true);
  assert.equal(protocolRangeIncludes('>=1.1 <2.0', '1.0'), false);
  assert.equal(protocolRangeIncludes('not-a-range', '1.0'), false);
});

test('NDJSON framing rejects invalid JSON and oversized lines as fatal', () => {
  assert.throws(
    () => parseNdjsonObject('{'),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
  assert.throws(
    () => parseNdjsonObject('x'.repeat(MAX_NDJSON_LINE_BYTES + 1)),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
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

test('initialize is first and static capabilities gate optional methods', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  assert.throws(
    () => validator.registerRequest({
      id: 1,
      method: 'catalog.list',
      params: {},
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'NOT_INITIALIZED',
  );

  initialize(validator);
  assert.throws(
    () => validator.registerRequest({
      id: 2,
      method: 'turn.steer',
      params: {
        sessionId: 's_1',
        streamId: 'stream-1',
        turnId: 't_1',
        input: [{ type: 'text', text: 'more' }],
      },
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED',
  );
});

test('input and native config values are gated by advertised contracts', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'input.localImage': 1 });
  assert.throws(
    () => validator.registerRequest({
      id: 2,
      method: 'turn.start',
      params: turnParams({
        input: [{ type: 'localFile', path: '/tmp/file.txt' }],
      }),
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'CAPABILITY_NOT_SUPPORTED',
  );

  validator.registerRequest({ id: 3, method: 'catalog.list', params: {} });
  validator.acceptLine(JSON.stringify({
    id: 3,
    result: {
      models: [],
      modes: [],
      sessionOptions: [{
        id: 'profile',
        displayName: 'Profile',
        type: 'select',
        scope: 'session',
        currentValue: 'default',
        choices: [{ value: 'default', displayName: 'Default' }],
      }],
    },
  }));
  assert.doesNotThrow(() => validator.registerRequest({
    id: 4,
    method: 'session.create',
    params: {
      sessionId: 's_2',
      cwd: '/tmp/project',
      workspaceRoots: ['/tmp/project'],
      config: { profile: 'default' },
    },
  }));
  assert.throws(
    () => validator.registerRequest({
      id: 5,
      method: 'session.create',
      params: {
        sessionId: 's_3',
        cwd: '/tmp/project',
        workspaceRoots: ['/tmp/project'],
        config: { invented: true },
      },
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_REQUEST',
  );
});

test('session config validation follows the active session catalog', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'session.config': 1 });
  validator.registerRequest({ id: 'catalog', method: 'catalog.list', params: {} });
  validator.acceptLine(JSON.stringify({
    id: 'catalog',
    result: {
      models: [],
      modes: [],
      sessionOptions: [{
        id: 'profile',
        displayName: 'Profile',
        type: 'select',
        scope: 'session',
        currentValue: 'default',
        choices: [{ value: 'default', displayName: 'Default' }],
      }],
    },
  }));
  validator.registerRequest({
    id: 'create-dynamic',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      cwd: '/tmp/project',
      workspaceRoots: ['/tmp/project'],
      config: { profile: 'default' },
    },
  });
  validator.acceptLine(JSON.stringify({
    id: 'create-dynamic',
    result: {
      session: {
        id: 's_1',
        nativeSession: { id: 'native-1' },
        streamId: 'stream-1',
        status: 'idle',
        configOptions: [
          {
            id: 'profile',
            displayName: 'Profile',
            type: 'select',
            scope: 'session',
            currentValue: 'safe',
            choices: [{ value: 'safe', displayName: 'Safe' }],
          },
          {
            id: 'effort',
            displayName: 'Effort',
            type: 'select',
            scope: 'turn',
            currentValue: 'high',
            choices: [{ value: 'high', displayName: 'High' }],
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  }));

  assert.doesNotThrow(() => validator.registerRequest({
    id: 'set-safe',
    method: 'session.config.set',
    params: {
      sessionId: 's_1',
      streamId: 'stream-1',
      optionId: 'profile',
      value: 'safe',
    },
  }));
  assert.doesNotThrow(() => validator.registerRequest({
    id: 'turn-high',
    method: 'turn.start',
    params: turnParams({ config: { native: { effort: 'high' } } }),
  }));
  assert.throws(
    () => validator.registerRequest({
      id: 'set-turn-option',
      method: 'session.config.set',
      params: {
        sessionId: 's_1',
        streamId: 'stream-1',
        optionId: 'effort',
        value: 'high',
      },
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_REQUEST',
  );

  validator.acceptLine(notification('session.updated', 1, {
    configOptions: [{
      id: 'profile',
      displayName: 'Profile',
      type: 'select',
      scope: 'session',
      currentValue: 'locked',
      choices: [{ value: 'locked', displayName: 'Locked' }],
    }],
    reason: 'configuration-changed',
  }));
  assert.throws(
    () => validator.registerRequest({
      id: 'set-stale',
      method: 'session.config.set',
      params: {
        sessionId: 's_1',
        streamId: 'stream-1',
        optionId: 'profile',
        value: 'safe',
      },
    }),
    (error: unknown) => error instanceof ProxyProtocolError
      && error.code === 'INVALID_REQUEST',
  );
  assert.doesNotThrow(() => validator.registerRequest({
    id: 'set-locked',
    method: 'session.config.set',
    params: {
      sessionId: 's_1',
      streamId: 'stream-1',
      optionId: 'profile',
      value: 'locked',
    },
  }));
});

test('live stream checks sequence, capability, and terminal pairing', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'event.tool': 1 });
  attach(validator);

  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('tool.started', 2, {
    toolCallId: 'tool-1',
    name: 'shell',
  }, 't_1'));

  assert.throws(
    () => validator.acceptLine(notification('turn.completed', 3, {
      stopReason: 'completed',
    }, 't_1')),
    (error: unknown) => error instanceof ProxyProtocolError && error.fatal,
  );
});

test('live stream rejects sequence gaps', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);

  assert.throws(
    () => validator.acceptLine(notification('turn.started', 2, {}, 't_1')),
    /does not match expected 1/,
  );
});

test('live stream rejects reused eventId and mismatched extension namespaces', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'extension.events': 1 });
  attach(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1', 'event-shared'));
  assert.throws(
    () => validator.acceptLine(notification('content.completed', 2, {
      contentId: 'content-1',
      kind: 'text',
      content: 'done',
    }, 't_1', 'event-shared')),
    /changed canonical content/,
  );

  const namespaceValidator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(namespaceValidator, { 'extension.events': 1 });
  attach(namespaceValidator);
  assert.throws(
    () => namespaceValidator.acceptLine(notification('extension.event', 1, {
      namespace: 'io.example.other',
      name: 'native',
      schemaVersion: 1,
      payload: {},
    })),
    /does not match plugin codex/,
  );
});

test('session live event identities are released with the closed attachment', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1', 'event-reused'));
  validator.acceptLine(notification('turn.completed', 2, {
    stopReason: 'completed',
  }, 't_1', 'event-end'));

  validator.registerRequest({
    id: 'close-1',
    method: 'session.close',
    params: { sessionId: 's_1', streamId: 'stream-1' },
  });
  validator.acceptLine(JSON.stringify({ id: 'close-1', result: { ok: true } }));

  validator.registerRequest({
    id: 'attach-2',
    method: 'session.create',
    params: {
      sessionId: 's_1',
      cwd: '/tmp/project',
      workspaceRoots: ['/tmp/project'],
      config: {},
    },
  });
  validator.acceptLine(JSON.stringify({
    id: 'attach-2',
    result: {
      session: {
        id: 's_1',
        streamId: 'stream-2',
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  }));
  assert.doesNotThrow(() => validator.acceptLine(JSON.stringify({
    method: 'turn.started',
    params: {
      eventId: 'event-reused',
      streamId: 'stream-2',
      sequence: 1,
      sessionId: 's_1',
      turnId: 't_2',
      emittedAt: timestamp,
      data: {},
    },
  })));
});

test('session.get validates against the stream owned by the current attachment', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  validator.registerRequest({
    id: 'get-1',
    method: 'session.get',
    params: { sessionId: 's_1' },
  });

  assert.doesNotThrow(() => validator.acceptLine(JSON.stringify({
    id: 'get-1',
    result: {
      session: {
        id: 's_1',
        nativeSession: { id: 'native-1' },
        streamId: 'stream-1',
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  })));

  validator.registerRequest({
    id: 'get-2',
    method: 'session.get',
    params: { sessionId: 's_1' },
  });
  assert.throws(
    () => validator.acceptLine(JSON.stringify({
      id: 'get-2',
      result: {
        session: {
          id: 's_1',
          nativeSession: { id: 'native-1' },
          streamId: 'stream-other',
          status: 'idle',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    })),
    /different session attachment/,
  );
});

test('content kind capability gate is complete', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator);
  attach(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));

  assert.throws(
    () => validator.acceptLine(notification('content.delta', 2, {
      contentId: 'command-1',
      kind: 'command',
      delta: 'pnpm test',
    }, 't_1')),
    /event.command/,
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

test('usage delta requires a turn and approval kinds are closed', () => {
  const usage = proxyNotificationSchema.safeParse({
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
  });
  assert.equal(usage.success, false);

  const approval = proxyNotificationSchema.safeParse({
    method: 'approval.requested',
    params: {
      eventId: 'evt-approval',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 's_1',
      turnId: 't_1',
      emittedAt: timestamp,
      data: {
        approvalId: 'approval-1',
        category: 'command',
        title: 'Run tests',
        description: '',
        options: [{
          id: 'maybe',
          label: 'Maybe',
          kind: 'provider_magic',
        }],
        payload: {},
      },
    },
  });
  assert.equal(approval.success, false);
});

test('approval resolution can select only an advertised opaque option id', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'approval.relay': 1 });
  attach(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('approval.requested', 2, {
    approvalId: 'approval-1',
    category: 'command',
    title: 'Run tests',
    description: '',
    options: [{
      id: 'opaque-provider-option-42',
      label: 'Allow once',
      kind: 'allow_once',
    }],
    payload: {},
  }, 't_1'));

  assert.throws(
    () => validator.acceptLine(notification('approval.resolved', 3, {
      approvalId: 'approval-1',
      resolution: 'selected',
      resolvedBy: 'user',
      optionId: 'invented-option',
    }, 't_1')),
    /was not advertised/,
  );
});

test('conversation delta usage is accepted at most once per turn', () => {
  const validator = new HostProtocolValidator({
    pluginId: 'codex',
    processScope: 'shared',
  });
  initialize(validator, { 'event.usage': 1 });
  attach(validator);
  validator.acceptLine(notification('turn.started', 1, {}, 't_1'));
  validator.acceptLine(notification('usage.updated', 2, {
    conversation: { mode: 'delta', inputTokens: 10 },
  }, 't_1'));
  assert.throws(
    () => validator.acceptLine(notification('usage.updated', 3, {
      conversation: { mode: 'delta', outputTokens: 5 },
    }, 't_1')),
    /more than once/,
  );
});

test('session.rename limits Unicode code points rather than UTF-16 units', () => {
  const base = {
    id: 1,
    method: 'session.rename',
    params: { sessionId: 's_1', streamId: 'stream-1', name: '' },
  } as const;
  assert.doesNotThrow(() => parseProxyRequest({
    ...base,
    params: { ...base.params, name: '😀'.repeat(200) },
  }));
  assert.throws(() => parseProxyRequest({
    ...base,
    params: { ...base.params, name: '😀'.repeat(201) },
  }));
});

test('replay pages use one synthetic stream and continuous sequence', () => {
  const validator = new ReplayPageValidator('s_1');
  validator.acceptPage({
    replayStreamId: 'replay-1',
    events: [{
      method: 'turn.started',
      params: {
        eventId: 'evt-1',
        streamId: 'replay-1',
        sequence: 1,
        sessionId: 's_1',
        turnId: 't_1',
        emittedAt: timestamp,
        data: {},
      },
    }],
    nextCursor: '1',
  });
  validator.acceptPage({
    replayStreamId: 'replay-1',
    events: [{
      method: 'input.recorded',
      params: {
        eventId: 'evt-2',
        streamId: 'replay-1',
        sequence: 2,
        sessionId: 's_1',
        turnId: 't_1',
        emittedAt: timestamp,
        data: {
          inputId: 'input-1',
          input: [{ type: 'text', text: 'original question' }],
        },
      },
    }],
    nextCursor: '2',
  });

  assert.throws(
    () => validator.acceptPage({
      replayStreamId: 'replay-1',
      events: [{
        method: 'turn.completed',
        params: {
          eventId: 'evt-3',
          streamId: 'replay-1',
          sequence: 4,
          sessionId: 's_1',
          turnId: 't_1',
          emittedAt: timestamp,
          data: { stopReason: 'completed' },
        },
      }],
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
      && error.code === 'INVALID_REQUEST',
  );
});

test('replay rejects session-scoped metadata notifications', () => {
  const validator = new ReplayPageValidator('s_1');
  assert.throws(
    () => validator.acceptPage({
      replayStreamId: 'replay-1',
      events: [{
        method: 'session.updated',
        params: {
          eventId: 'evt-session',
          streamId: 'replay-1',
          sequence: 1,
          sessionId: 's_1',
          emittedAt: timestamp,
          data: { reason: 'runtime-state-changed' },
        },
      }],
      nextCursor: null,
    }),
    /only turn-scoped notifications/,
  );
});

test('incremental replay tracks complete changed turns and ignores Gian rebases', () => {
  const replayTurn = (turnId: string, text: string) => [
    proxyNotificationSchema.parse({
      method: 'turn.started',
      params: {
        eventId: `start-${turnId}`,
        streamId: 'replay-1',
        sequence: 1,
        sessionId: 's_1',
        turnId,
        emittedAt: timestamp,
        data: {},
      },
    }),
    proxyNotificationSchema.parse({
      method: 'content.completed',
      params: {
        eventId: `content-${turnId}-${text}`,
        streamId: 'replay-1',
        sequence: 2,
        sessionId: 's_1',
        turnId,
        emittedAt: timestamp,
        data: { contentId: `content-${turnId}`, kind: 'text', content: text },
      },
    }),
    proxyNotificationSchema.parse({
      method: 'turn.completed',
      params: {
        eventId: `end-${turnId}`,
        streamId: 'replay-1',
        sequence: 3,
        sessionId: 's_1',
        turnId,
        emittedAt: timestamp,
        data: { stopReason: 'completed' },
      },
    }),
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
    tracker.replay().events.map(event => 'turnId' in event.params ? event.params.turnId : null),
    ['external', 'external', 'external'],
  );
  assert.deepEqual(
    tracker.replay().events.map(event => 'sequence' in event.params ? event.params.sequence : null),
    [1, 2, 3],
  );

  tracker.acknowledge();
  const nextOwnTurn = replayTurn('own-2', 'local again');
  tracker.rebase({
    streamId: 'replay-1',
    events: [...ownTurn, ...externalTurn, ...nextOwnTurn],
  });
  assert.deepEqual(
    tracker.replay().events.map(event => 'turnId' in event.params ? event.params.turnId : null),
    ['external', 'external', 'external'],
  );

  const secondExternal = replayTurn('external-2', 'second');
  assert.equal(tracker.observe({
    streamId: 'replay-1',
    events: [...ownTurn, ...externalTurn, ...nextOwnTurn, ...secondExternal],
  }), true);
  assert.equal(tracker.replay().streamId, 'replay-1');
  assert.deepEqual(
    tracker.replay().events.map(event => (
      'sequence' in event.params ? event.params.sequence : null
    )),
    [1, 2, 3, 4, 5, 6],
  );

  const rewrittenExternal = replayTurn('external', 'rewritten');
  assert.equal(tracker.observe({
    streamId: 'replay-1',
    events: [...ownTurn, ...rewrittenExternal, ...nextOwnTurn, ...secondExternal],
  }), true);
  assert.match(tracker.replay().streamId, /^replay-1-revision-/);
});
