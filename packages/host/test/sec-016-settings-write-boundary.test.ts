// Coverage for SEC-016 / GitHub #39: /api/settings is a runtime-validated
// public write boundary. TypeScript's Partial<SystemConfig> is not validation.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadConfig, loadPasswordHash, saveConfig, savePasswordHash } from '../src/storage/config.js';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

async function patchSettings(ctx: TestAppCtx, body: unknown): Promise<Response> {
  return ctx.fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function storedConfig(ctx: TestAppCtx): Array<{ key: string; value: string }> {
  return ctx.db.prepare('SELECT key, value FROM config ORDER BY key').all() as Array<{
    key: string;
    value: string;
  }>;
}

test('SEC-016 · sensitive and unknown fields reject the whole patch without mutation', async () => {
  const ctx = await makeTestApp();
  try {
    saveConfig(ctx.db, { auth_username: 'admin', theme: 'warm' });
    savePasswordHash(ctx.db, 'hash-before');
    const before = storedConfig(ctx);

    for (const payload of [
      { theme: 'dark', auth_password_hash: 'attacker-hash' },
      { theme: 'dark', auth_username: 'attacker' },
      { theme: 'dark', future_setting: 'enabled' },
      { theme: 'dark', host: '0.0.0.0' },
      { theme: 'dark', workspace_root: '/tmp/other' },
      { theme: 'dark', default_codex_model: 'attacker-model' },
    ]) {
      const response = await patchSettings(ctx, payload);
      assert.equal(response.status, 400);
      assert.deepEqual(storedConfig(ctx), before, `payload must be atomic: ${JSON.stringify(payload)}`);
    }

    assert.equal(loadPasswordHash(ctx.db), 'hash-before');
    assert.equal(loadConfig(ctx.db).auth_username, 'admin');
    assert.equal(loadConfig(ctx.db).theme, 'warm');
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-016 · malformed, non-object, wrong-type, and out-of-range bodies return 400', async () => {
  const ctx = await makeTestApp();
  try {
    const before = storedConfig(ctx);
    const malformed = await ctx.fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);

    const invalidPayloads: unknown[] = [
      null,
      [],
      'dark',
      { port: '8991' },
      { port: 0 },
      { port: 65_536 },
      { port: 8991.5 },
      { theme: 'galaxy' },
      { accent: 'violet' },
      { density: 'dense' },
      { locale: 'fr' },
      { font_scale_chat: 'xxl' },
      { external_editors: {} },
      { external_editors: [{ id: 'editor', name: '', command: 'code', args: [] }] },
      { external_editors: [{ id: 'editor', name: 'Code', command: 'code', args: [42] }] },
      { external_editors: [
        { id: 'duplicate', name: 'Code', command: 'code', args: [] },
        { id: 'duplicate', name: 'Code 2', command: 'code', args: [] },
      ] },
      { open_apps: [] },
      { open_apps: { executable: 'Calculator' } },
      { open_apps: { code: 42 } },
    ];

    for (const payload of invalidPayloads) {
      const response = await patchSettings(ctx, payload);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
    }
    assert.deepEqual(storedConfig(ctx), before);
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-016 · retired appearance preferences normalize while current settings retain PATCH compatibility', async () => {
  const ctx = await makeTestApp();
  try {
    const payload = {
      port: 49_152,
      theme: 'dark',
      accent: 'azure',
      density: 'roomy',
      font_scale_chrome: 'sm',
      font_scale_chat: 'lg',
      font_scale_code: 'xl',
      locale: 'en',
      external_editors: [
        {
          id: 'vscode',
          name: 'Visual Studio Code',
          command: 'open',
          args: ['-a', 'Visual Studio Code', '{path}'],
        },
      ],
      open_apps: {
        code: 'Visual Studio Code',
        web: '@newtab',
        images: 'Preview',
        pdf: '@finder',
        other: 'TextEdit',
      },
    } as const;

    const response = await patchSettings(ctx, payload);
    assert.equal(response.status, 200);
    const returned = await response.json() as Record<string, unknown>;
    const expected = {
      ...payload,
      density: 'cozy',
      font_scale_chrome: 'md',
      font_scale_code: 'md',
    } as const;
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(returned[key], value, `round-trip field ${key}`);
    }

    const stored = loadConfig(ctx.db);
    assert.equal(stored.port, payload.port);
    assert.equal(stored.theme, payload.theme);
    assert.equal(stored.accent, payload.accent);
    assert.equal(stored.density, expected.density);
    assert.equal(stored.font_scale_chrome, expected.font_scale_chrome);
    assert.equal(stored.font_scale_chat, expected.font_scale_chat);
    assert.equal(stored.font_scale_code, expected.font_scale_code);
    assert.equal(stored.locale, payload.locale);
    assert.deepEqual(stored.external_editors, payload.external_editors);
    assert.deepEqual(stored.open_apps, payload.open_apps);
  } finally {
    await ctx.cleanup();
  }
});
