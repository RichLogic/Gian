import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GitHubUserProfile } from '@gian/shared';
import {
  FileGitHubCredentialStore,
  GitHubAuthService,
  resolveGitHubOAuthClientId,
  type GitHubCredentialStore,
} from '../src/github-auth.js';

const user: GitHubUserProfile = {
  id: 42,
  login: 'octocat',
  name: 'The Octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/42',
  profileUrl: 'https://github.com/octocat',
};

function memoryStore(): GitHubCredentialStore & { saved: { token: string; user: GitHubUserProfile } | null } {
  return {
    saved: null,
    isAvailable: () => true,
    async load() {
      return this.saved;
    },
    async save(credential) {
      this.saved = credential;
    },
    async clear() {
      this.saved = null;
    },
  };
}

test('device flow requests no OAuth scopes and returns only public profile data', async () => {
  const store = memoryStore();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let tokenPolls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/login/device/code')) {
      return Response.json({
        device_code: 'device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.endsWith('/login/oauth/access_token')) {
      tokenPolls += 1;
      return tokenPolls === 1
        ? Response.json({ error: 'authorization_pending' })
        : Response.json({ access_token: 'access-secret', token_type: 'bearer', scope: '' });
    }
    if (url.endsWith('/user')) {
      return Response.json({
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatarUrl,
        html_url: user.profileUrl,
      });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof fetch;
  const service = new GitHubAuthService({
    clientId: 'Ov23liExampleClient',
    store,
    fetch: fetchImpl,
    now: () => 1_000,
    sleep: async () => {},
  });

  const started = await service.start();
  assert.deepEqual(started, {
    ok: true,
    authorization: {
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(901_000).toISOString(),
    },
  });
  const deviceBody = new URLSearchParams(String(calls[0]?.init?.body));
  assert.deepEqual([...deviceBody.keys()], ['client_id']);
  assert.equal(deviceBody.get('scope'), null);

  assert.deepEqual(await service.finish(), { ok: true, user });
  assert.deepEqual(store.saved, { token: 'access-secret', user });
  assert.deepEqual(await service.getState(), { status: 'signed_in', user });
  const userRequest = calls.find(call => call.url.endsWith('/user'));
  assert.equal(new Headers(userRequest?.init?.headers).get('authorization'), 'Bearer access-secret');
});

test('device flow exposes denial without persisting a token', async () => {
  const store = memoryStore();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    return url.endsWith('/login/device/code')
      ? Response.json({
          device_code: 'device-secret',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        })
      : Response.json({ error: 'access_denied' });
  }) as typeof fetch;
  const service = new GitHubAuthService({
    clientId: 'Ov23liExampleClient',
    store,
    fetch: fetchImpl,
    now: () => 1_000,
    sleep: async () => {},
  });

  assert.equal((await service.start()).ok, true);
  assert.deepEqual(await service.finish(), { ok: false, error: 'denied' });
  assert.equal(store.saved, null);
});

test('credential file contains encrypted bytes rather than the GitHub token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-github-auth-'));
  const path = join(directory, 'github-auth.json');
  const store = new FileGitHubCredentialStore({
    path,
    encryptionAvailable: () => true,
    encrypt: value => Buffer.from([...value].reverse().join('')),
    decrypt: value => [...value.toString()].reverse().join(''),
  });
  try {
    await store.save({ token: 'access-secret', user });
    const raw = await readFile(path, 'utf8');
    assert.equal(raw.includes('access-secret'), false);
    assert.deepEqual(await store.load(), { token: 'access-secret', user });
    await store.clear();
    assert.equal(await store.load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release metadata requests use the signed-in credential only for exact GitHub API URLs', async () => {
  const token = 'github-token-sentinel';
  const store = memoryStore();
  store.saved = { token, user };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const service = new GitHubAuthService({
    clientId: 'Ov23liExampleClient',
    store,
    fetch: fetchImpl,
  });

  await service.fetchReleaseMetadata({ repository: 'RichLogic/Gian' });
  await service.fetchReleaseMetadata({
    repository: 'RichLogic/Gian',
    tag: 'proxy/codex v0.4.2',
  });

  assert.deepEqual(calls.map(call => call.url), [
    'https://api.github.com/repos/RichLogic/Gian/releases?per_page=100',
    'https://api.github.com/repos/RichLogic/Gian/releases/tags/proxy%2Fcodex%20v0.4.2',
  ]);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    assert.equal(headers.get('accept'), 'application/vnd.github+json');
    assert.equal(headers.get('user-agent'), 'Gian');
    assert.equal(headers.get('x-github-api-version'), '2022-11-28');
    assert.equal(call.init?.redirect, 'error');
  }

  await service.signOut();
  assert.deepEqual(await service.getState(), { status: 'signed_out' });
  await service.fetchReleaseMetadata({ repository: 'RichLogic/Gian' });
  assert.equal(new Headers(calls[2]?.init?.headers).get('authorization'), null);
  assert.equal(calls[2]?.init?.redirect, 'error');
});

test('release metadata rejects arbitrary repositories and unsafe tags before fetching', async () => {
  const calls: string[] = [];
  const service = new GitHubAuthService({
    clientId: 'Ov23liExampleClient',
    store: memoryStore(),
    fetch: (async input => {
      calls.push(String(input));
      return Response.json({ ok: true });
    }) as typeof fetch,
  });

  for (const repository of [
    '',
    'RichLogic',
    'RichLogic/Gian/releases',
    'RichLogic/..',
    'https://api.github.com/repos/RichLogic/Gian',
    'RichLogic/Gian?per_page=1',
  ]) {
    await assert.rejects(
      service.fetchReleaseMetadata({ repository }),
      /invalid GitHub release repository/,
    );
  }
  for (const tag of ['', 'bad\ntag', 'x'.repeat(256)]) {
    await assert.rejects(
      service.fetchReleaseMetadata({ repository: 'RichLogic/Gian', tag }),
      /invalid GitHub release tag/,
    );
  }

  assert.deepEqual(calls, []);
});

test('OAuth client id resolves from development env or packaged runtime config', async () => {
  assert.equal(resolveGitHubOAuthClientId({
    env: { GIAN_GITHUB_CLIENT_ID: ' Ov23liFromEnv ' },
    isPackaged: false,
    resourcesPath: '/unused',
  }), 'Ov23liFromEnv');

  const directory = await mkdtemp(join(tmpdir(), 'gian-github-config-'));
  try {
    await mkdir(join(directory, 'runtime'));
    await writeFile(
      join(directory, 'runtime', 'github-auth.json'),
      JSON.stringify({ clientId: 'Ov23liPackagedClient' }),
    );
    assert.equal(resolveGitHubOAuthClientId({
      env: {},
      isPackaged: true,
      resourcesPath: directory,
    }), 'Ov23liPackagedClient');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
