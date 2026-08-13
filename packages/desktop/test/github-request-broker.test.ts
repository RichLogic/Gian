import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GitHubReleaseMetadataBroker,
  resolveGitHubReleaseBrokerSocketPath,
} from '../src/github-request-broker.js';

interface BrokerResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function requestBroker(options: {
  socketPath: string;
  path?: string;
  method?: string;
  body?: unknown;
}): Promise<BrokerResponse> {
  const body = options.body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: options.socketPath,
      path: options.path ?? '/v1/release-metadata',
      method: options.method ?? 'POST',
      headers: body.length > 0
        ? {
            'content-type': 'application/json',
            'content-length': String(body.length),
          }
        : undefined,
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.once('error', reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

test('release broker accepts structured list and tag requests over its Unix socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-github-broker-'));
  const socketPath = join(directory, 'broker.sock');
  const token = 'github-token-sentinel';
  const calls: Array<{ repository: string; tag?: string }> = [];
  const broker = new GitHubReleaseMetadataBroker({
    socketPath,
    allowedRepository: 'RichLogic/Gian',
    async fetchReleaseMetadata(request) {
      calls.push(request);
      return Response.json(
        request.tag
          ? { tag_name: request.tag }
          : [{ tag_name: 'proxy-codex-v0.4.2' }],
        { headers: { 'x-upstream-authorization': `Bearer ${token}` } },
      );
    },
  });

  try {
    await broker.start();
    const list = await requestBroker({
      socketPath,
      body: { repository: 'RichLogic/Gian', operation: 'list' },
    });
    const tag = await requestBroker({
      socketPath,
      body: {
        repository: 'RichLogic/Gian',
        operation: 'tag',
        tag: 'proxy-codex-v0.4.2',
      },
    });

    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body), [{ tag_name: 'proxy-codex-v0.4.2' }]);
    assert.equal(tag.status, 200);
    assert.deepEqual(JSON.parse(tag.body), { tag_name: 'proxy-codex-v0.4.2' });
    assert.deepEqual(calls, [
      { repository: 'RichLogic/Gian' },
      { repository: 'RichLogic/Gian', tag: 'proxy-codex-v0.4.2' },
    ]);
    for (const response of [list, tag]) {
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(response.headers['x-upstream-authorization'], undefined);
      assert.equal(JSON.stringify(response).includes(token), false);
    }
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('release broker rejects other repositories, paths, and methods without calling GitHub', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-github-broker-'));
  const socketPath = join(directory, 'broker.sock');
  let fetches = 0;
  const broker = new GitHubReleaseMetadataBroker({
    socketPath,
    allowedRepository: 'RichLogic/Gian',
    async fetchReleaseMetadata() {
      fetches += 1;
      return Response.json({ ok: true });
    },
  });

  try {
    await broker.start();
    const otherRepository = await requestBroker({
      socketPath,
      body: { repository: 'someone-else/private', operation: 'list' },
    });
    const otherPath = await requestBroker({
      socketPath,
      path: '/v1/arbitrary-github-request',
      body: { repository: 'RichLogic/Gian', operation: 'list' },
    });
    const get = await requestBroker({
      socketPath,
      method: 'GET',
    });
    const unsafeTag = await requestBroker({
      socketPath,
      body: {
        repository: 'RichLogic/Gian',
        operation: 'tag',
        tag: 'bad\ntag',
      },
    });

    assert.deepEqual(
      [otherRepository.status, otherPath.status, get.status, unsafeTag.status],
      [400, 404, 404, 400],
    );
    assert.deepEqual(JSON.parse(otherRepository.body), { error: 'invalid_request' });
    assert.deepEqual(JSON.parse(otherPath.body), { error: 'not_found' });
    assert.deepEqual(JSON.parse(get.body), { error: 'not_found' });
    assert.deepEqual(JSON.parse(unsafeTag.body), { error: 'invalid_request' });
    assert.equal(fetches, 0);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('release broker returns a fixed error without exposing credential-bearing failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-github-broker-'));
  const socketPath = join(directory, 'broker.sock');
  const token = 'github-token-sentinel';
  const broker = new GitHubReleaseMetadataBroker({
    socketPath,
    allowedRepository: 'RichLogic/Gian',
    async fetchReleaseMetadata() {
      throw new Error(`upstream rejected Bearer ${token}`);
    },
  });

  try {
    await broker.start();
    const response = await requestBroker({
      socketPath,
      body: { repository: 'RichLogic/Gian', operation: 'list' },
    });

    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), { error: 'github_request_failed' });
    assert.equal(JSON.stringify(response).includes(token), false);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('release broker socket path is deterministic and short', () => {
  const first = resolveGitHubReleaseBrokerSocketPath('/Users/test/.gian');
  const second = resolveGitHubReleaseBrokerSocketPath('/Users/test/.gian');
  const other = resolveGitHubReleaseBrokerSocketPath('/Users/test/.gian-dev');

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /gian-github-[a-f0-9]{24}\.sock$/);
  assert.ok(Buffer.byteLength(first) < 104);
});
