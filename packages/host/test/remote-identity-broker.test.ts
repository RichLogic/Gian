import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RemoteIdentityBrokerClient } from '../src/remote/identity-broker.js';

async function withStubBroker(
  handler: (body: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gian-broker-client-'));
  const socketPath = join(dir, 'broker.sock');
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const result = await handler(body);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    })().catch(() => {
      response.statusCode = 500;
      response.end('{"error":"stub"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test('broker client waits out a slow Desktop main loop within the raised default timeout', async () => {
  await withStubBroker(
    async () => {
      await new Promise(resolve => setTimeout(resolve, 3_000));
      return { refresh_secret: 'kept' };
    },
    async (socketPath) => {
      const client = new RemoteIdentityBrokerClient(socketPath);
      assert.equal(await client.getRefreshSecret(), 'kept');
    },
  );
});

test('broker client still fails fast when its own timeout is exceeded', async () => {
  await withStubBroker(
    async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { refresh_secret: null };
    },
    async (socketPath) => {
      const client = new RemoteIdentityBrokerClient(socketPath, 50);
      await assert.rejects(() => client.getRefreshSecret(), /timed out/);
    },
  );
});
