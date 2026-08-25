import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  initializeResultSchema,
  proxyErrorResponseSchema,
} from '@gian/proxy-protocol';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
}

function startV2Proxy(runtimeBin = process.execPath) {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'codex',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-codex-v2-test',
      GIAN_RUNTIME_BIN: runtimeBin,
      GIAN_PROTOCOL_VERSIONS: '2.0',
    },
  });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const value = JSON.parse(line) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  return {
    child,
    send(value: unknown) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    sendRaw(line: string) { child.stdin.write(`${line}\n`); },
    next(timeoutMs = 5_000): Promise<unknown> {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolveMessage, reject) => {
        const waiter = (message: unknown) => {
          clearTimeout(timer);
          resolveMessage(message);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for Codex Proxy output.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function responseFor(
  proxy: ReturnType<typeof startV2Proxy>,
  id: string,
): Promise<{ response: Record<string, unknown>; preceding: Record<string, unknown>[] }> {
  const preceding: Record<string, unknown>[] = [];
  while (true) {
    const message = await proxy.next() as Record<string, unknown>;
    if (message.id === id) return { response: message, preceding };
    preceding.push(message);
  }
}

test('Codex CLI negotiates gian.proxy/2.0 independently from its app-server version', async () => {
  const proxy = startV2Proxy();
  proxy.send({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const initialized = await proxy.next() as { id: string; result: unknown };
  assert.equal(initialized.id, 'req-1');
  const result = initializeResultSchema.parse(initialized.result);
  assert.equal(result.protocol.version, '2.0');
  assert.equal(result.plugin.id, 'codex');
  assert.equal(result.plugin.version, '0.2.3');
  assert.equal(result.process.scope, 'shared');
  assert.equal(result.capabilities.interaction, 1);
  assert.equal(result.capabilities['session.replay'], 1);
  assert.equal(result.capabilities['session.rename'], 1);
  assert.equal(result.capabilities['session.native.list'], 1);
  assert.equal(result.capabilities['turn.steer'], 1);
  assert.equal(result.capabilities['event.diff'], 1);
  assert.equal(result.capabilities['slash.list'], undefined);
  assert.equal(result.capabilities['session.native.delete'], undefined);
  assert.equal(result.capabilities['integration.mcp.streamableHttp'], undefined);

  proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'does.not.exist', params: {} });
  const missing = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(missing.error.code, -32601);
  assert.equal(missing.error.data, undefined);

  proxy.send({ jsonrpc: '2.0', id: 'req-4', method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { jsonrpc: '2.0', id: 'req-4', result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Codex gian.proxy/2 CLI reports a JSON-RPC parse error for malformed NDJSON', async () => {
  const proxy = startV2Proxy();
  proxy.sendRaw('{not-json');
  const error = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(error.id, null);
  assert.equal(error.error.code, -32700);
  assert.equal(error.error.data, undefined);
  proxy.send({ jsonrpc: '2.0', id: 'req-shutdown', method: 'shutdown', params: {} });
  await proxy.next();
  assert.equal(await waitForExit(proxy.child), 0);
});

test('real Codex Proxy CLI completes a full lifecycle through the Fake app-server', async () => {
  const fakeRuntime = resolve('dist/test/fixtures/fake-codex-lifecycle-server.js');
  chmodSync(fakeRuntime, 0o755);
  const proxy = startV2Proxy(fakeRuntime);
  try {
    proxy.send({
      jsonrpc: '2.0',
      id: 'lifecycle-initialize',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    await responseFor(proxy, 'lifecycle-initialize');

    proxy.send({ jsonrpc: '2.0', id: 'lifecycle-catalog', method: 'catalog.list', params: {} });
    const catalogResponse = (await responseFor(proxy, 'lifecycle-catalog')).response;
    const configOptions = (
      catalogResponse.result as {
        configOptions: Array<{
          id: string;
          role?: string;
          control: string;
          defaultValue: unknown;
          enabledWhen?: Array<{ optionId: string; oneOf: unknown[] }>;
          choices?: Array<{ value: unknown; displayName: string; description?: string }>;
        }>;
      }
    ).configOptions;
    const approval = configOptions.find(option => option.role === 'approval_mode');
    assert.equal(approval?.id, 'approval_mode');
    assert.equal(approval?.defaultValue, 'ask');
    assert.deepEqual(approval?.choices, [
      { value: 'ask', displayName: 'Ask for approval', description: 'Always ask to edit external files and use the internet.' },
      { value: 'auto', displayName: 'Approve for me', description: 'Let Codex review approval requests automatically.' },
      { value: 'full-access', displayName: 'Full access', description: 'Run without sandbox restrictions or approval prompts.' },
      { value: 'custom', displayName: 'Custom (config.toml)', description: 'Use the permission configuration loaded from config.toml.' },
    ]);
    assert.deepEqual(
      configOptions.filter(option => [
        'approval_policy',
        'sandbox',
        'approvals_reviewer',
        'collaboration_mode',
      ].includes(option.id)),
      [],
    );
    const fast = configOptions.find(option => option.role === 'fast');
    assert.equal(fast?.id, 'service_tier');
    assert.equal(fast?.control, 'boolean');
    assert.equal(fast?.defaultValue, false);
    assert.equal(fast?.choices, undefined);

    proxy.send({
      jsonrpc: '2.0',
      id: 'lifecycle-create',
      method: 'session.create',
      params: {
        sessionId: 'fake-host-session',
        workspace: { cwd: '/tmp/fake-codex-workspace', roots: ['/tmp/fake-codex-workspace'] },
        config: {},
      },
    });
    const createResponse = (await responseFor(proxy, 'lifecycle-create')).response;
    assert.ok(createResponse.result, `session.create failed: ${JSON.stringify(createResponse)}`);
    const created = createResponse.result as {
      session: { streamId: string };
    };

    proxy.send({
      jsonrpc: '2.0',
      id: 'lifecycle-turn',
      method: 'turn.start',
      params: {
        sessionId: 'fake-host-session',
        streamId: created.session.streamId,
        turnId: 'fake-host-turn',
        input: [{ type: 'text', text: 'exercise fake runtime' }],
        config: {
          approval_mode: 'ask',
          service_tier: false,
        },
      },
    });
    const turnResponse = await responseFor(proxy, 'lifecycle-turn');
    assert.equal(
      turnResponse.preceding.some(message => message.params
        && (message.params as { turnId?: unknown }).turnId === 'fake-host-turn'),
      false,
      'turn.start response must precede notifications caused by that request',
    );

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    while (!events.some(event => event.method === 'interaction.requested')) {
      const event = await proxy.next() as { method: string; params: Record<string, unknown> };
      if ((event.params as { turnId?: unknown })?.turnId === 'fake-host-turn') events.push(event);
    }
    proxy.send({
      jsonrpc: '2.0',
      id: 'lifecycle-interaction',
      method: 'interaction.respond',
      params: {
        sessionId: 'fake-host-session',
        streamId: created.session.streamId,
        turnId: 'fake-host-turn',
        interactionId: '700',
        responseId: 'fake-response-700',
        actionId: 'accept',
      },
    });
    const interactionResponse = await proxy.next() as Record<string, unknown>;
    assert.equal(
      interactionResponse.id,
      'lifecycle-interaction',
      'interaction.respond response must precede interaction.resolved',
    );
    const resolved = await proxy.next() as { method: string; params: Record<string, unknown> };
    assert.equal(resolved.method, 'interaction.resolved');
    events.push(resolved);
    while (!events.some(event => event.method === 'turn.completed')) {
      const event = await proxy.next() as { method: string; params: Record<string, unknown> };
      if ((event.params as { turnId?: unknown })?.turnId === 'fake-host-turn') events.push(event);
    }
    assert.deepEqual(events.map(event => event.method), [
      'turn.started',
      'content.delta',
      'activity.updated',
      'interaction.requested',
      'interaction.resolved',
      'activity.updated',
      'content.completed',
      'turn.completed',
    ]);
    assert.ok(events.every(event => event.params.sourceTurnId === 'fake-turn-1'));
    const activityEvents = events.filter(event => event.method === 'activity.updated');
    assert.match(
      String((activityEvents[0]?.params.data as { title?: unknown }).title),
      /fixture\.inspect/,
    );
    assert.deepEqual(
      activityEvents.map(event => {
        const data = event.params.data as { activityId?: unknown; status?: unknown };
        return { activityId: data.activityId, status: data.status };
      }),
      [
        { activityId: 'fake-tool-1', status: 'running' },
        { activityId: 'fake-tool-1', status: 'succeeded' },
      ],
    );
    assert.equal(
      ((activityEvents[0]?.params.data as {
        presentation?: { type?: unknown };
      }).presentation?.type),
      'tool',
      'native item lifecycle must use a semantic presentation',
    );

    proxy.send({ jsonrpc: '2.0', id: 'lifecycle-shutdown', method: 'shutdown', params: {} });
    await responseFor(proxy, 'lifecycle-shutdown');
    assert.equal(await waitForExit(proxy.child), 0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGTERM');
  }
});
