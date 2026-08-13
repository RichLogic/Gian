import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createGitHubReleaseFetch } from '../src/agents/github-release-fetch.js';

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function brokerSocket(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-github-broker-test-'));
  const socketPath = join(root, 'broker.sock');
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return socketPath;
}

test('release metadata fetch sends structured list and tag operations to Desktop', async t => {
  const requests: unknown[] = [];
  const socketPath = await brokerSocket(t, (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/release-metadata');
    assert.equal(request.headers.authorization, undefined);
    void readRequestJson(request).then(value => {
      requests.push(value);
      const body = JSON.stringify({ source: 'desktop', request: value });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  const releaseFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: socketPath,
    fetchImpl: async () => {
      throw new Error('direct fetch must not run');
    },
  });

  const listResponse = await releaseFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=100',
    { headers: { authorization: 'must-not-cross-the-boundary' } },
  );
  const tagResponse = await releaseFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases/tags/proxy-codex-v1.2.3',
  );

  assert.equal(listResponse.status, 200);
  assert.equal(tagResponse.status, 200);
  assert.deepEqual(requests, [
    { repository: 'RichLogic/Gian', operation: 'list' },
    {
      repository: 'RichLogic/Gian',
      operation: 'tag',
      tag: 'proxy-codex-v1.2.3',
    },
  ]);
  assert.deepEqual(await listResponse.json(), {
    source: 'desktop',
    request: { repository: 'RichLogic/Gian', operation: 'list' },
  });
});

test('release assets and non-matching GitHub API calls stay direct and anonymous', async () => {
  const directCalls: Array<{ url: string; authorization: string | null }> = [];
  const directFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    directCalls.push({
      url: String(input instanceof Request ? input.url : input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return new Response('{}');
  }) as typeof fetch;
  const releaseFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: '/tmp/unused-gian-github-broker.sock',
    fetchImpl: directFetch,
  });

  await releaseFetch(
    'https://github.com/RichLogic/Gian/releases/download/v0.4.2/asset.tar.gz',
  );
  await releaseFetch('https://api.github.com/repos/Someone/Else/releases?per_page=100');
  await releaseFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=50',
  );
  await releaseFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=100',
    { method: 'POST' },
  );

  assert.equal(directCalls.length, 4);
  assert.ok(directCalls.every(call => call.authorization === null));
});

test('unavailable Desktop broker falls back to anonymous fetch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-github-broker-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let directCalls = 0;
  const directFetch = (async () => {
    directCalls += 1;
    return new Response('[{"tag_name":"v0.4.2"}]');
  }) as typeof fetch;
  const unavailableFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: join(root, 'missing.sock'),
    fetchImpl: directFetch,
  });

  assert.equal((await unavailableFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=100',
  )).status, 200);

  assert.equal(directCalls, 1);
});

test('broker timeout before response headers falls back to anonymous fetch', async t => {
  const socketPath = await brokerSocket(t, request => {
    request.resume();
  });
  let directCalls = 0;
  const releaseFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: socketPath,
    fetchImpl: (async () => {
      directCalls += 1;
      return new Response('{}');
    }) as typeof fetch,
    brokerTimeoutMs: 20,
  });

  assert.equal((await releaseFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=100',
  )).status, 200);
  assert.equal(directCalls, 1);
});

test('broker response size limit fails closed without using anonymous fetch', async t => {
  const socketPath = await brokerSocket(t, (request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('x'.repeat(33));
  });
  let directCalls = 0;
  const releaseFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: socketPath,
    fetchImpl: (async () => {
      directCalls += 1;
      return new Response('{}');
    }) as typeof fetch,
    maxResponseBytes: 32,
  });

  await assert.rejects(
    releaseFetch('https://api.github.com/repos/RichLogic/Gian/releases?per_page=100'),
    /broker response is too large/,
  );
  assert.equal(directCalls, 0);
});

test('broker timeout after response headers fails closed without anonymous fetch', async t => {
  const socketPath = await brokerSocket(t, (request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
  });
  let directCalls = 0;
  const releaseFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: socketPath,
    fetchImpl: (async () => {
      directCalls += 1;
      return new Response('{}');
    }) as typeof fetch,
    brokerTimeoutMs: 20,
  });

  await assert.rejects(
    releaseFetch('https://api.github.com/repos/RichLogic/Gian/releases?per_page=100'),
    /broker response timed out/,
  );
  assert.equal(directCalls, 0);
});

test('caller abort cancels the broker request without anonymous fallback', async t => {
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const socketPath = await brokerSocket(t, request => {
    request.resume();
    notifyStarted?.();
  });
  let directCalls = 0;
  const releaseFetch = createGitHubReleaseFetch({
    releaseRepository: 'RichLogic/Gian',
    brokerSocketPath: socketPath,
    fetchImpl: (async () => {
      directCalls += 1;
      return new Response('{}');
    }) as typeof fetch,
    brokerTimeoutMs: 1_000,
  });
  const controller = new AbortController();
  const pending = releaseFetch(
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=100',
    { signal: controller.signal },
  );
  await started;
  controller.abort(new Error('test cancellation'));

  await assert.rejects(pending, /test cancellation/);
  assert.equal(directCalls, 0);
});
