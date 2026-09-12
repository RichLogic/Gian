import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  RemoteIdentityBroker,
  resolveRemoteIdentityBrokerSocketPath,
} from '../src/remote-identity-broker.js';
import type { RemoteIdentitySecret, RemoteIdentityStore } from '../src/remote-identity-store.js';

class MemoryStore implements RemoteIdentityStore {
  available = true;
  secret: RemoteIdentitySecret | null = null;
  isAvailable(): boolean { return this.available; }
  async load(): Promise<RemoteIdentitySecret | null> { return this.secret; }
  async save(secret: RemoteIdentitySecret): Promise<void> { this.secret = secret; }
}

function requestBroker(options: {
  socketPath: string;
  body: unknown;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const body = Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: options.socketPath,
      path: '/v1/remote-identity',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.write(body);
    request.end();
  });
}

test('Remote identity broker expose sign and refresh secret without returning the private key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-remote-broker-'));
  const socketPath = join(directory, 'broker.sock');
  const store = new MemoryStore();
  const broker = new RemoteIdentityBroker({ socketPath, store });
  try {
    await broker.start();
    const ensured = await requestBroker({ socketPath, body: { op: 'ensure' } });
    assert.equal(ensured.status, 200);
    const publicIdentity = JSON.parse(ensured.body) as {
      public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      fingerprint: string;
    };
    assert.equal(publicIdentity.public_key.kty, 'EC');
    const expectedFingerprint = createHash('sha256').update(JSON.stringify({
      crv: publicIdentity.public_key.crv,
      kty: publicIdentity.public_key.kty,
      x: publicIdentity.public_key.x,
      y: publicIdentity.public_key.y,
    })).digest('hex');
    assert.equal(publicIdentity.fingerprint, expectedFingerprint);
    assert.equal(JSON.stringify(store.secret).includes('"d"'), true);
    assert.equal(ensured.body.includes('"d"'), false);

    const signed = await requestBroker({
      socketPath,
      body: { op: 'sign', bytes_b64: Buffer.from('hello').toString('base64url') },
    });
    assert.equal(signed.status, 200);
    assert.ok(JSON.parse(signed.body).signature);

    const setSecret = await requestBroker({
      socketPath,
      body: { op: 'secret.set', refresh_secret: 'connector-refresh' },
    });
    assert.equal(setSecret.status, 200);
    const got = await requestBroker({ socketPath, body: { op: 'secret.get' } });
    assert.equal(JSON.parse(got.body).refresh_secret, 'connector-refresh');
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('broker socket path stays short and namespaced', () => {
  const path = resolveRemoteIdentityBrokerSocketPath('gian-instance');
  assert.match(path, /gian-remote-[a-f0-9]{24}\.sock$/);
});
