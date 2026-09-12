import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopBrowserBrokerClient } from '../src/tool/browser-broker.js';

test('Host Browser client sends only the closed call and maps Desktop domain errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-host-browser-'));
  const socketPath = join(root, 'browser.sock');
  const requests: unknown[] = [];
  let fail = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.once('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(fail ? 409 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fail
        ? { ok: false, error: { code: 'PRECONDITION_FAILED', message: 'stale page', retryable: false } }
        : { ok: true, data: { revision: 2, tabs: [] } }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const client = new DesktopBrowserBrokerClient(socketPath);
    assert.deepEqual(await client.call('browser.tabs', {}, {
      callerId: 'internal-session:session-1', sessionId: 'session-1',
    }), { revision: 2, tabs: [] });
    assert.deepEqual(requests[0], {
      method: 'browser.tabs',
      params: {},
      actor: { caller_id: 'internal-session:session-1', session_id: 'session-1' },
    });
    fail = true;
    await assert.rejects(
      client.call('browser.click', {
        tab_id: 'tab-1', snapshot_id: 'snapshot-1', ref: '@e1',
      }, { callerId: 'internal-session:session-1', sessionId: 'session-1' }),
      error => (error as { code?: string }).code === 'PRECONDITION_FAILED',
    );
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Host Browser client requires an absolute private socket path', () => {
  assert.throws(() => new DesktopBrowserBrokerClient('relative.sock'), /socket path is invalid/);
});
