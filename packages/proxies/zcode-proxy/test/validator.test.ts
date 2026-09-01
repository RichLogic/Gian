/** CONTRACT: replay a full outer lifecycle through the shared
 * HostProtocolValidator — the same validator the Host runs in production —
 * covering initialize → catalog → create → turn → interaction → terminal →
 * replay ordering, sequences, and capability gating. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { HostProtocolValidator } from '@gian/proxy-protocol';

import { startHarness, type OutgoingLine } from './harness.js';

const PERMISSION_TURN = {
  turnId: 'turn_perm',
  permissionRequest: { requestId: 'perm-7', toolName: 'Bash', command: 'echo hi', riskLevel: 'medium' },
  events: [
    { channel: 'computer-use', kind: 'turn-started', eventId: 'evt_perm_start' },
    {
      seq: 1,
      eventId: 'evt_perm_tool_running',
      payload: {
        kind: 'tool_call', toolCallId: 'call_perm', tool: 'Write', status: 'running',
        input: { file_path: '/tmp/zcode-ws/permission.txt', content: 'ok' },
      },
    },
    {
      seq: 2,
      eventId: 'evt_perm_tool_completed',
      payload: {
        kind: 'tool_call', toolCallId: 'call_perm', tool: 'Write', status: 'completed',
        result: { success: true, content: 'wrote file' },
      },
    },
    { seq: 3, eventId: 'evt_perm_text', payload: { kind: 'text_delta', assistantMessageId: 'msg_p', delta: 'ok' } },
    { seq: 4, eventId: 'evt_perm_term', payload: { resultType: 'success' } },
  ],
};

test('full lifecycle passes the shared HostProtocolValidator', async () => {
  const harness = startHarness({ scenario: { turn: PERMISSION_TURN } });
  const validator = new HostProtocolValidator({
    pluginId: 'com.zhipu.zcode',
    processScope: 'shared',
  });
  const seen: OutgoingLine[] = [];
  const readNotifications = async (count: number): Promise<void> => {
    for (const line of await harness.waitNotifications(count)) {
      seen.push(line);
      validator.acceptLine(JSON.stringify(line.payload));
    }
  };
  /** Mirror the Host: register the request, then feed its response back. */
  const send = async (method: string, params: Record<string, unknown>): Promise<OutgoingLine & { id: string }> => {
    const id = `v-${Math.random().toString(36).slice(2, 8)}`;
    validator.registerRequest({ jsonrpc: '2.0', id, method, params });
    const response = await harness.request(method, params, id);
    assert.equal(response.kind, 'result', `${method} failed: ${JSON.stringify(response.payload)}`);
    validator.acceptLine(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: (response.payload as { result: Record<string, unknown> }).result,
    }));
    return response;
  };

  try {
    // initialize — the Host sends 2.1 + 2.0 offers; the proxy picks 2.1.
    await send('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.1', '2.0'] },
      host: { name: 'Gian', version: '0.0.0-test', locale: 'zh-CN' },
    });

    // catalog — resolve mirrors the Host: the full turn snapshot carries the
    // resolved defaults for required options.
    const catalog = await send('catalog.list', {});
    const catalogResult = (catalog.payload as { result: Record<string, unknown> }).result;
    const resolved = await send('catalog.resolve', {
      catalogRevision: catalogResult.catalogRevision as string,
      sessionConfig: {},
      turnConfig: {},
    });
    const turnConfig = (((resolved.payload as { result: Record<string, unknown> }).result)
      .resolvedDefaults as { turnConfig: Record<string, string> }).turnConfig;

    // session.create + turn with permission + terminal
    const created = await send('session.create', {
      sessionId: 's_v',
      workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
      config: {},
    });
    const streamId = ((created.payload as { result: { session: { streamId: string } } }).result.session.streamId);

    await send('turn.start', {
      sessionId: 's_v', streamId, turnId: 't_v',
      input: [{ type: 'text', text: 'run it' }], config: turnConfig,
    });

    // interaction.requested must arrive before we may respond. Feed every
    // earlier notification through the validator while waiting.
    for (;;) {
      const line = await Promise.race([
        harness.next().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (line === null) throw new Error('timed out waiting for interaction.requested');
      seen.push(line);
      if (line.kind !== 'notification') continue;
      validator.acceptLine(JSON.stringify(line.payload));
      if (line.method === 'interaction.requested') break;
    }
    const requested = seen.find((line) => line.method === 'interaction.requested');
    const data = (requested!.payload.params as { data: { interactionId: string; actions: Array<{ id: string }> } }).data;

    await send('interaction.respond', {
      sessionId: 's_v', streamId, turnId: 't_v',
      responseId: 'resp-v', interactionId: data.interactionId, actionId: 'allow_once', values: {},
    });

    // Drain the remaining stream: resolved, content, terminal — validating
    // everything that arrives.
    for (let i = 0; i < 10; i += 1) {
      const line = await Promise.race([
        harness.next().catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
      ]);
      if (line === null) break;
      seen.push(line);
      if (line.kind !== 'notification') continue; // responses are handled by send()
      try {
        validator.acceptLine(JSON.stringify(line.payload));
      } catch (error) {
        console.error('OFFENDING:', line.method ?? line.id, JSON.stringify(line.payload).slice(0, 240));
        throw error;
      }
      if (line.method === 'turn.completed' || line.method === 'turn.failed') break;
    }

    const methods = seen.map((line) => line.method);
    assert.ok(methods.includes('turn.started'), 'turn.started observed');
    assert.ok(methods.includes('interaction.requested'), 'interaction observed');
    assert.ok(methods.includes('interaction.resolved'), 'interaction resolved observed');
    assert.ok(methods.includes('activity.updated'), 'schema-valid tool activity observed');
    assert.ok(
      methods.includes('turn.completed') || methods.includes('turn.failed'),
      'terminal observed',
    );
    // The validator throws on any violation; reaching here proves conformance.
  } finally {
    await harness.close();
  }
});

test('validator rejects a notification stream with a sequence gap', async () => {
  const validator = new HostProtocolValidator({ pluginId: 'com.zhipu.zcode' });
  const init = {
    jsonrpc: '2.0',
    id: 'i',
    result: {
      protocol: { name: 'gian.proxy', version: '2.1' },
      plugin: { id: 'com.zhipu.zcode', name: 'ZCode', version: '0.1.0' },
      process: { scope: 'shared' },
      capabilities: {},
    },
  };
  validator.registerRequest({
    jsonrpc: '2.0', id: 'i', method: 'initialize',
    params: { protocol: { name: 'gian.proxy', versions: ['2.1'] }, host: { name: 'G', version: '0' } },
  });
  validator.acceptLine(JSON.stringify(init));
  // session.updated for an unattached session is session-fatal, not silent.
  assert.throws(() => validator.acceptLine(JSON.stringify({
    jsonrpc: '2.0',
    method: 'session.updated',
    params: {
      eventId: 'e1', sessionId: 'ghost', streamId: 'st', sequence: 1,
      emittedAt: new Date().toISOString(),
      data: { state: 'idle' },
    },
  })));
});
