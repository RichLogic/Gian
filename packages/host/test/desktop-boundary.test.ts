import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import {
  DESKTOP_TOKEN_HEADER,
  requireDesktopClient,
} from '../src/web/desktop-boundary.js';

function makeApp(token = 'secret') {
  const app = new Hono();
  app.use('*', requireDesktopClient(token, 'http://127.0.0.1:8990'));
  app.get('/health', c => c.json({ ok: true }));
  app.get('/ws', c => c.json({ upgraded: true }));
  return app;
}

test('desktop boundary rejects requests without the Electron-injected token', async () => {
  const response = await makeApp().request('/health');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'desktop_client_required' });
});
test('desktop boundary accepts the matching token', async () => {
  const response = await makeApp().request('/health', {
    headers: { [DESKTOP_TOKEN_HEADER]: 'secret' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('desktop websocket also requires the Electron application origin', async () => {
  const denied = await makeApp().request('/ws', {
    headers: {
      [DESKTOP_TOKEN_HEADER]: 'secret',
      Origin: 'https://attacker.example',
    },
  });
  assert.equal(denied.status, 403);

  const allowed = await makeApp().request('/ws', {
    headers: {
      [DESKTOP_TOKEN_HEADER]: 'secret',
      Origin: 'http://127.0.0.1:8990',
    },
  });
  assert.equal(allowed.status, 200);
});
