import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { generateCanonicalId, RemoteProtocolError, type RemoteErrorCode } from '@gian/remote-protocol';
import { registerRemoteControllerRoutes } from '../src/remote/controller-routes.js';
import type { RemoteControllerHub } from '../src/remote/controller-hub.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

test('remote preview and tree errors have stable HTTP semantics and never echo peer secrets or paths', async () => {
  const session = generateCanonicalId();
  const cases: Array<[RemoteErrorCode, number]> = [
    ['REMOTE_CAPABILITY_DENIED', 403], ['AUTH_REQUIRED', 401], ['DEVICE_REVOKED', 403],
    ['RESOURCE_NOT_FOUND', 404], ['ATTACHMENT_NOT_FOUND', 404], ['FILE_REFERENCE_EXPIRED', 410],
    ['FILE_TOO_LARGE', 413], ['HOST_OFFLINE', 503], ['INVALID_FRAME', 400], ['RATE_LIMITED', 429],
  ];
  for (const [code, status] of cases) {
    const reject = async () => { throw new RemoteProtocolError(code, '/private/secret token=do-not-expose'); };
    const hub = { readFile: reject, directory: reject, files: reject, command: reject } as unknown as RemoteControllerHub;
    const app = new Hono();
    registerRemoteControllerRoutes(app, hub, {} as WsBroadcaster);
    for (const path of [
      `/api/remote/sessions/${session}/raw?reference=outside`,
      `/api/remote/sessions/${session}/files/attachment`,
      `/api/working_trees/remote:${session}/file?path=outside`,
      `/api/working_trees/remote:${session}/tree?path=..`,
      `/api/working_trees/remote:${session}/files`,
      `/api/working_trees/remote:${session}/changed`,
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, status, `${code}: ${path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, code);
      assert.doesNotMatch(JSON.stringify(body), /private|do-not-expose/);
    }
  }
});

test('the remote file adapter does not intercept local trees and hides unexpected exceptions', async () => {
  const app = new Hono();
  registerRemoteControllerRoutes(app, { readFile: async () => { throw new Error('sensitive stack'); } } as unknown as RemoteControllerHub,
    {} as WsBroadcaster);
  app.get('/api/working_trees/:id/file', c => c.json({ content: 'local' }));
  assert.deepEqual(await (await app.request('/api/working_trees/ws:local/file')).json(), { content: 'local' });
  const response = await app.request(`/api/remote/sessions/${generateCanonicalId()}/raw?reference=x`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: 'INTERNAL_ERROR', error: 'Remote file request failed' });
});
