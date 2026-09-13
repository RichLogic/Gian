import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { downloadManagedRuntimeAsset } from '../src/runtime/download.js';

const prefixes = [
  'https://downloads.claude.ai/claude-code-releases/',
  'https://github.com/openai/codex/releases/download/',
] as const;

test('managed Runtime download follows only approved release redirects without credentials', async () => {
  const bytes = Buffer.from('runtime');
  const calls: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
  const result = await downloadManagedRuntimeAsset({
    url: 'https://github.com/openai/codex/releases/download/rust-v1.2.3/runtime.tar.gz',
    sha256: 'a'.repeat(64),
    size: bytes.length,
  }, prefixes, undefined, (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return calls.length === 1
      ? new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/runtime' },
      })
      : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  }) as typeof fetch);

  assert.deepEqual(result, bytes);
  assert.deepEqual(calls, [
    {
      url: 'https://github.com/openai/codex/releases/download/rust-v1.2.3/runtime.tar.gz',
      authorization: null,
      redirect: 'manual',
    },
    {
      url: 'https://release-assets.githubusercontent.com/runtime',
      authorization: null,
      redirect: 'manual',
    },
  ]);
});

test('managed Runtime download accepts a direct pinned vendor asset', async () => {
  const bytes = Buffer.from('claude runtime');
  const result = await downloadManagedRuntimeAsset({
    url: 'https://downloads.claude.ai/claude-code-releases/1.2.3/darwin-arm64/claude',
    sha256: 'b'.repeat(64),
    size: bytes.length,
  }, prefixes, undefined, (async () => new Response(bytes, { status: 200 })) as typeof fetch);
  assert.deepEqual(result, bytes);
});

test('managed Runtime download rejects untrusted sources, redirects, and size drift', async () => {
  let calls = 0;
  await assert.rejects(
    downloadManagedRuntimeAsset({
      url: 'https://evil.example/runtime', sha256: 'a'.repeat(64), size: 1,
    }, prefixes, undefined, (async () => { calls += 1; return new Response('x'); }) as typeof fetch),
    /outside the App-pinned/,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    downloadManagedRuntimeAsset({
      url: 'https://github.com/openai/codex/releases/download/rust-v1.2.3/runtime.tar.gz',
      sha256: 'a'.repeat(64),
      size: 1,
    }, prefixes, undefined, (async () => new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/runtime' },
    })) as typeof fetch),
    /redirected outside approved hosts/,
  );

  await assert.rejects(
    downloadManagedRuntimeAsset({
      url: 'https://downloads.claude.ai/claude-code-releases/1.2.3/darwin-arm64/claude',
      sha256: 'b'.repeat(64),
      size: 2,
    }, prefixes, undefined, (async () => new Response('x', {
      status: 200,
      headers: { 'content-length': '1' },
    })) as typeof fetch),
    /size differs/,
  );
});
