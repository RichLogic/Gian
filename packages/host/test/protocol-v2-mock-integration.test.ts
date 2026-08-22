import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { ProtocolV2Host } from '../src/proxy/protocol-v2-session-client.js';

function mockEntry(executor: 'grok' | 'codex'): string {
  return resolve(
    process.cwd(),
    `../proxies/${executor}-proxy/scripts/fake-catalog-ui-proxy.mjs`,
  );
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for mock Proxy state.');
}

async function control(dataDir: string, command: Record<string, unknown>): Promise<unknown> {
  const descriptorPath = join(dataDir, 'mock-control.json');
  await waitFor(() => existsSync(descriptorPath) ? true : undefined);
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
    controlFile: string;
    responseFile: string;
  };
  const requestId = randomUUID();
  await appendFile(descriptor.controlFile, `${JSON.stringify({ requestId, ...command })}\n`);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const responses = (await readFile(descriptor.responseFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { requestId?: string });
    const response = responses.find(item => item.requestId === requestId);
    if (response) return response;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for mock Proxy control response.');
}

function latest(
  notifications: ProxyNotification[],
  method: ProxyNotification['method'],
): ProxyNotification | undefined {
  return notifications.findLast(notification => notification.method === method);
}

test('controllable mock Proxy covers every gian.proxy/2 request and UI event family', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-v2-mock-'));
  const dataDir = join(root, 'data');
  const host = new ProtocolV2Host({
    executor: 'grok',
    entry: mockEntry('grok'),
    pluginId: 'grok',
    pluginVersion: '0.3.0',
    processScope: 'session',
    dataDir,
    hostVersion: '0.5.0-test',
  });
  t.after(async () => {
    await host.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const client = host.createSessionClient('host-session-1');
  const notifications: ProxyNotification[] = [];
  client.onNotification(notification => notifications.push(notification));

  const initialized = await client.initialize();
  assert.equal(initialized.protocol.version, '2.0');
  assert.equal(initialized.process.scope, 'session');
  assert.ok(initialized.capabilities['turn.steer']);
  assert.ok(initialized.capabilities['input.localFile']);
  assert.equal(initialized.capabilities['event.step'], 1);
  assert.equal(initialized.capabilities['event.request'], 1);

  const catalog = await client.catalog();
  assert.equal(catalog.catalogRevision, 'ui-mock-grok-1');
  assert.deepEqual(catalog.input.map(item => item.type), [
    'text',
    'localFile',
    'localImage',
    'skill',
  ]);
  const resolved = await client.resolveCatalog({
    catalogRevision: catalog.catalogRevision,
    sessionConfig: { workspace_mode: 'strict' },
    turnConfig: { model: 'mock-vision' },
  });
  assert.equal(resolved.resolvedDefaults.turnConfig.mock_trace, true);
  await assert.rejects(
    client.resolveCatalog({
      catalogRevision: catalog.catalogRevision,
      sessionConfig: {},
      turnConfig: { execution_mode: 'broken' },
    }),
    /CONFIG_VALUE_INVALID/,
  );

  const created = await client.createSession({
    cwd: '/tmp/mock-workspace',
    workspaceRoots: ['/tmp/mock-workspace', '/tmp/mock-attachments'],
    sessionConfig: { workspace_mode: 'strict' },
  });
  assert.equal(created.session.id, 'host-session-1');
  assert.equal(created.nativeSessionId, 'native-grok-host-session-1');
  const streamId = client.streamId();
  assert.ok(streamId);

  const fetched = await host.request<{ session: { id: string; streamId: string } }>(
    'session.get',
    { sessionId: 'host-session-1' },
  );
  assert.equal(fetched.session.id, 'host-session-1');
  assert.equal(fetched.session.streamId, streamId);

  await client.setName('Mock renamed session');
  const native = await client.listNativeSessions({ cwd: '/tmp/mock-workspace', limit: 10 }) as {
    sessions: Array<{ id: string }>;
  };
  assert.equal(native.sessions[0]?.id, 'native-grok-existing');
  await client.deleteNativeSession('native-grok-existing');
  const replay = await client.replaySession();
  assert.deepEqual(replay.events.map(event => event.method), [
    'turn.started',
    'input.recorded',
    'content.completed',
    'turn.completed',
  ]);

  const galleryStart = notifications.length;
  await client.startTurn({
    sessionId: 'host-session-1',
    turnId: 'turn-gallery',
    input: [{ type: 'text', text: '/mock gallery' }],
    config: { model: 'mock-sonnet' },
  });
  await waitFor(() => latest(notifications, 'turn.completed'));
  const gallery = notifications.slice(galleryStart);
  const galleryMethods = new Set(gallery.map(notification => notification.method));
  for (const method of [
    'turn.started',
    'content.delta',
    'content.completed',
    'activity.updated',
    'plan.updated',
    'diff.updated',
    'usage.updated',
    'turn.completed',
    'session.updated',
  ] as const) {
    assert.ok(galleryMethods.has(method), `gallery emitted ${method}`);
  }

  const stepRequestStart = notifications.length;
  await client.startTurn({
    sessionId: 'host-session-1',
    turnId: 'turn-step-request',
    input: [{ type: 'text', text: '/mock step-request' }],
    config: { model: 'mock-sonnet' },
  });
  await waitFor(() => notifications.slice(stepRequestStart).find(
    item => item.method === 'turn.completed',
  ));
  const stepRequest = notifications.slice(stepRequestStart);
  const steps = stepRequest.filter(item => item.method === 'step.updated');
  assert.deepEqual(steps.map(item => item.params.data.status), ['running', 'completed']);
  const stepId = steps[0]?.params.data.stepId;
  assert.equal(stepId, 'source-turn-step-request:0');
  const request = stepRequest.find(item => item.method === 'request.updated');
  assert.equal(request?.params.data.requestId, 'source-turn-step-request:request:initial');
  assert.equal(request?.params.data.reason, 'initial');
  assert.equal(request?.params.data.stepId, stepId);
  for (const method of ['content.completed', 'activity.updated', 'usage.updated'] as const) {
    const linked = stepRequest.find(item => item.method === method);
    assert.equal(linked?.params.data.stepId, stepId, `${method} keeps the step coordinate`);
  }

    const interactionCases: Array<{
      scenario: string;
      kind: string;
      title: string;
      inputCount: number;
      actionId: string;
      values: Record<string, string | boolean | string[]>;
    }> = [
      {
        scenario: 'interaction-permission',
        kind: 'permission',
        title: 'Allow file edit?',
        inputCount: 0,
        actionId: 'allow-once',
        values: {},
      },
      {
        scenario: 'interaction-question',
        kind: 'question',
        title: 'What should the mock change?',
        inputCount: 1,
        actionId: 'submit-answer',
        values: { answer: 'Keep the interaction concise.' },
      },
      {
        scenario: 'interaction-choice',
        kind: 'choice',
        title: 'Choose a validation target',
        inputCount: 1,
        actionId: 'submit-choice',
        values: { environment: 'ci' },
      },
      {
        scenario: 'interaction-confirmation',
        kind: 'confirmation',
        title: 'Delete generated mock artifacts?',
        inputCount: 0,
        actionId: 'confirm',
        values: {},
      },
      {
        scenario: 'interaction-form',
        kind: 'form',
        title: 'Mock form interaction',
        inputCount: 5,
        actionId: 'mock-submit',
        values: {
          reason: 'safe',
          details: 'full details',
          choice: 'alpha',
          tags: ['one', 'two'],
          confirmed: true,
        },
      },
    ];

    for (const [index, interaction] of interactionCases.entries()) {
      const interactionStart = notifications.length;
      const turnId = `turn-${interaction.scenario}`;
      await client.startTurn({
        sessionId: 'host-session-1',
        turnId,
        input: [{ type: 'text', text: `/mock ${interaction.scenario}` }],
        config: { model: 'mock-sonnet' },
      });
      const requested = await waitFor(() => (
        notifications.slice(interactionStart).find(item => item.method === 'interaction.requested')
      ));
      assert.equal(requested.params.data.presentation.kind, interaction.kind);
      assert.equal(requested.params.data.title, interaction.title);
      assert.equal(requested.params.data.inputs.length, interaction.inputCount);
      assert.ok(requested.params.data.actions.some(action => action.id === interaction.actionId));
      await client.respondInteraction({
        sessionId: 'host-session-1',
        turnId,
        interactionId: requested.params.data.interactionId,
        responseId: `response-${index + 1}`,
        actionId: interaction.actionId,
        values: interaction.values,
      });
      assert.equal(client.hasAttachedSession(), true);
      await waitFor(() => (
        notifications.slice(interactionStart).find(item => item.method === 'interaction.resolved')
      ));
      await waitFor(() => (
        notifications.slice(interactionStart).find(item => item.method === 'turn.completed')
      ));
    }

  const runningStart = notifications.length;
  await client.startTurn({
    sessionId: 'host-session-1',
    turnId: 'turn-running',
    input: [{ type: 'text', text: '/mock running' }],
    config: { model: 'mock-sonnet' },
  });
  await client.steerTurn({
    turnId: 'turn-running',
    input: [{ type: 'text', text: 'continue carefully' }],
  });
  await client.interruptTurn();
  assert.equal(
    notifications.slice(runningStart).some(item => item.method === 'turn.completed'),
    false,
    'interrupt Result is not a terminal event',
  );
  const interrupted = await waitFor(() => (
    notifications.slice(runningStart).find(item => item.method === 'turn.completed')
  ));
  assert.equal(interrupted.params.data.stopReason, 'interrupted');

  const catalogChangedAt = notifications.length;
  const catalogControl = await control(dataDir, { action: 'catalog.changed' }) as {
    ok: boolean;
    catalogRevision: number;
  };
  assert.equal(catalogControl.ok, true);
  assert.equal(catalogControl.catalogRevision, 2);
  await waitFor(() => (
    notifications.slice(catalogChangedAt).find(item => item.method === 'catalog.changed')
  ));
  assert.equal((await client.catalog()).catalogRevision, 'ui-mock-grok-2');

  const processErrorAt = notifications.length;
  await control(dataDir, {
    action: 'runtime.error',
    scope: 'process',
    message: 'mock process disconnected',
  });
  const processError = await waitFor(() => (
    notifications.slice(processErrorAt).find(item => item.method === 'runtime.error')
  ));
  assert.equal(processError.params.data.message, 'mock process disconnected');

  await client.shutdown();
  await host.shutdown();
  const requests = (await readFile(join(dataDir, 'received.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { method: string });
  const methods = new Set(requests.map(request => request.method));
  for (const method of [
    'initialize',
    'catalog.list',
    'catalog.resolve',
    'session.create',
    'session.get',
    'turn.start',
    'turn.interrupt',
    'session.close',
    'shutdown',
    'session.rename',
    'session.native.list',
    'session.native.delete',
    'session.replay',
    'turn.steer',
    'interaction.respond',
  ]) {
    assert.ok(methods.has(method), `Mock captured ${method}`);
  }
});

test('shared mock Proxy fans out process events and isolates one bad Session stream', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-v2-shared-mock-'));
  const dataDir = join(root, 'data');
  const host = new ProtocolV2Host({
    executor: 'codex',
    entry: mockEntry('codex'),
    pluginId: 'codex',
    pluginVersion: '0.2.0',
    processScope: 'shared',
    dataDir,
    hostVersion: '0.5.0-test',
  });
  t.after(async () => {
    await host.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const first = host.createSessionClient('shared-session-1');
  const second = host.createSessionClient('shared-session-2');
  const firstNotifications: ProxyNotification[] = [];
  const secondNotifications: ProxyNotification[] = [];
  const firstFaults: Error[] = [];
  const secondFaults: Error[] = [];
  first.onNotification(notification => firstNotifications.push(notification));
  second.onNotification(notification => secondNotifications.push(notification));
  first.onSessionFault(error => firstFaults.push(error));
  second.onSessionFault(error => secondFaults.push(error));

  await Promise.all([first.initialize(), second.initialize()]);
  await Promise.all([first.catalog(), second.catalog()]);
  await first.createSession({ cwd: '/tmp/shared-1' });
  await second.createSession({ cwd: '/tmp/shared-2' });

  await first.startTurn({
    sessionId: 'shared-session-1',
    turnId: 'faulty-turn',
    input: [{ type: 'text', text: '/mock fault' }],
    config: { model: 'mock-sonnet' },
  });
  await waitFor(() => firstFaults[0]);
  assert.equal(secondFaults.length, 0);

  await second.startTurn({
    sessionId: 'shared-session-2',
    turnId: 'healthy-turn',
    input: [{ type: 'text', text: 'healthy' }],
    config: { model: 'mock-sonnet' },
  });
  await waitFor(() => secondNotifications.find(item => item.method === 'turn.completed'));
  assert.equal(secondFaults.length, 0);

  await control(dataDir, { action: 'catalog.changed' });
  await waitFor(() => firstNotifications.find(item => item.method === 'catalog.changed'));
  await waitFor(() => secondNotifications.find(item => item.method === 'catalog.changed'));
  assert.equal((await first.catalog()).catalogRevision, 'ui-mock-codex-2');
  assert.equal((await second.catalog()).catalogRevision, 'ui-mock-codex-2');

  await control(dataDir, {
    action: 'runtime.error',
    scope: 'process',
    message: 'shared process unavailable',
  });
  await waitFor(() => firstNotifications.find(item => item.method === 'runtime.error'));
  await waitFor(() => secondNotifications.find(item => item.method === 'runtime.error'));

  await first.shutdown();
  await second.shutdown();
  await host.shutdown();
});
