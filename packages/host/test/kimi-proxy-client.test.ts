import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KimiProxyHost, KimiProxySessionClient } from '../src/proxy/kimi-proxy-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'fake-kimi-proxy.mjs');

test('Kimi host normalizes capabilities, native config, slash and routing', async () => {
  const host = new KimiProxyHost({
    entry: fixture,
    kimiBin: '/unused/fake/kimi',
  });
  try {
    const capabilities = await host.capabilities();
    assert.equal(capabilities.protocolVersion, '1');
    assert.equal(capabilities.agentInfo?.version, '0.29.2');
    assert.deepEqual(capabilities.sessionCapabilities, {
      load: true,
      list: true,
      resume: true,
      close: false,
    });
    assert.deepEqual(capabilities.modes, []);

    const facade = new KimiProxySessionClient(host);
    const notifications: string[] = [];
    facade.onNotification(notification => notifications.push(notification.method));
    const created = await facade.createSession({ cwd: '/tmp' });
    assert.match(created.nativeSessionId, /^kimi_native_/);
    assert.deepEqual(created.configOptions?.[0]?.choices?.map(choice => choice.value), [
      'default',
      'plan',
      'auto',
      'yolo',
    ]);

    const slash = await facade.listSlashCommands();
    assert.equal(slash.commands[0]?.name, '/skill:review');
    const updated = await facade.setNativeConfig?.('mode', 'yolo');
    assert.equal(updated?.state.values.mode, 'yolo');

    await facade.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'hi' }],
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(notifications, ['acp.sessionUpdate']);
  } finally {
    await host.shutdown();
  }
});

test('Kimi adoption requests load and preserves replay updates', async () => {
  const host = new KimiProxyHost({
    entry: fixture,
    kimiBin: '/unused/fake/kimi',
  });
  try {
    const facade = new KimiProxySessionClient(host);
    const created = await facade.createSession({
      cwd: '/tmp',
      nativeSessionId: 'kimi-existing',
      resumeMode: 'load',
    });
    assert.equal(created.nativeSessionId, 'kimi-existing');
    assert.equal(created.replayUpdates?.length, 1);
  } finally {
    await host.shutdown();
  }
});
