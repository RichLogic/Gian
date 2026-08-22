import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtocolV2Host } from '../src/proxy/protocol-v2-session-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'fake-kimi-proxy.mjs');

function makeHost() {
  return new ProtocolV2Host({
    executor: 'kimi',
    entry: fixture,
    pluginId: 'kimi',
    pluginVersion: '0.2.0',
    processScope: 'shared',
    dataDir: '/tmp/gian-kimi-v2-client-test',
    hostVersion: '9.9.9',
    runtimeBin: '/unused/fake/kimi',
  });
}

test('Kimi host negotiates gian.proxy/2 and routes catalog, slash, and turns', async () => {
  const host = makeHost();
  try {
    const initialized = await host.initialize();
    assert.equal(initialized.protocol.version, '2.0');
    assert.equal(initialized.plugin.version, '0.2.0');

    const catalog = await host.catalog();
    assert.deepEqual(
      catalog.configOptions.find((option) => option.id === 'mode')?.choices?.map((choice) => choice.value),
      ['default', 'plan', 'auto', 'yolo'],
    );
    assert.equal(catalog.slashCommands[0]?.name, '/skill:review');

    const facade = host.createSessionClient('host-kimi-session');
    const notifications: string[] = [];
    facade.onNotification((notification) => notifications.push(notification.method));
    const created = await facade.createSession({ cwd: '/tmp' });
    assert.match(created.nativeSessionId ?? '', /^kimi_native_/);
    assert.equal(created.session.state, 'idle');

    const slash = await facade.listSlashCommands();
    assert.equal(slash.commands[0]?.name, '/skill:review');

    await facade.startTurn({
      sessionId: created.session.id,
      turnId: 'host-turn-1',
      input: [{ type: 'text', text: 'hi' }],
      config: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(notifications.includes('content.delta'));
    assert.ok(notifications.includes('turn.completed'));
  } finally {
    await host.shutdown();
  }
});

test('Kimi adoption requests replay and preserves Replay Events', async () => {
  const host = makeHost();
  try {
    const facade = host.createSessionClient('host-kimi-adopt');
    const created = await facade.createSession({
      cwd: '/tmp',
      nativeSessionId: 'kimi-existing',
      history: 'replay',
    });
    assert.equal(created.nativeSessionId, 'kimi-existing');
    assert.equal(created.replayEvents?.length, 1);
    assert.equal(created.replayEvents?.[0]?.method, 'turn.started');
  } finally {
    await host.shutdown();
  }
});
