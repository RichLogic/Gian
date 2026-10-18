import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AntigravityRuntimeError } from '../src/runtime/errors.js';
import { antigravityChildEnv, resolveGeminiHome } from '../src/runtime/home.js';

test('prefers GIAN_AGENT_HOME over GEMINI_HOME and the default', () => {
  const resolved = resolveGeminiHome({
    HOME: '/Users/owner',
    GIAN_AGENT_HOME: '/srv/agent',
    GEMINI_HOME: '/srv/gemini',
  });
  assert.equal(resolved, '/srv/agent');
});

test('keeps an explicit GEMINI_HOME when no Agent home is set', () => {
  assert.equal(resolveGeminiHome({
    HOME: '/Users/owner',
    GEMINI_HOME: '/srv/gemini',
    GIAN_AGENT_HOME: '',
  }), '/srv/gemini');
});

test('uses ~/.gemini when neither explicit home is set', () => {
  assert.equal(resolveGeminiHome({ HOME: '/Users/owner' }), '/Users/owner/.gemini');
  assert.equal(resolveGeminiHome({ HOME: '/Users/owner', GEMINI_HOME: '', GIAN_AGENT_HOME: '' }), '/Users/owner/.gemini');
});

test('expands ~ against absolute HOME', () => {
  assert.equal(resolveGeminiHome({ HOME: '/Users/owner', GIAN_AGENT_HOME: '~' }), '/Users/owner');
  assert.equal(resolveGeminiHome({ HOME: '/Users/owner', GEMINI_HOME: '~/work' }), '/Users/owner/work');
});

test('rejects a relative or NUL Gemini home', () => {
  assert.throws(
    () => resolveGeminiHome({ HOME: '/Users/owner', GEMINI_HOME: 'relative' }),
    (error: unknown) => error instanceof AntigravityRuntimeError && /absolute path/.test(error.message),
  );
  assert.throws(
    () => resolveGeminiHome({ HOME: '/Users/owner', GIAN_AGENT_HOME: '/tmp/bad\0home' }),
    (error: unknown) => error instanceof AntigravityRuntimeError,
  );
});

test('child env sets GEMINI_HOME without rewriting HOME or copying files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-home-'));
  const child = antigravityChildEnv({
    HOME: '/Users/owner',
    GIAN_AGENT_HOME: '/srv/agent',
    GEMINI_HOME: '/srv/ignored',
    GOOGLE_APPLICATION_CREDENTIALS: join(directory, 'missing.json'),
  });
  assert.equal(child.HOME, '/Users/owner');
  assert.equal(child.GEMINI_HOME, '/srv/agent');
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, join(directory, 'missing.json'));
  assert.deepEqual(await readdir(directory), []);
});

test('child env omits GEMINI_HOME when no explicit home is configured', () => {
  const child = antigravityChildEnv({
    HOME: '/Users/owner',
    GEMINI_HOME: '',
    PATH: '/usr/bin',
  });
  assert.equal(child.HOME, '/Users/owner');
  assert.equal(child.PATH, '/usr/bin');
  assert.equal(Object.hasOwn(child, 'GEMINI_HOME'), false);
  assert.equal(Object.hasOwn(child, 'ANTIGRAVITY_HARNESS_PATH'), false);
});
