// Coverage for SEC-016 / GitHub #39: /api/settings is a runtime-validated
// public write boundary. TypeScript's Partial<SystemConfig> is not validation.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { loadConfig, loadPasswordHash, saveConfig, savePasswordHash } from '../src/storage/config.js';
import { terminalOptions } from '../src/term/manager.js';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TERMINAL_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
} from '@gian/shared';

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
      { chat_font_size: 11 },
      { chat_font_size: 21 },
      { chat_font_size: 13.5 },
      { chat_font_family: 'papyrus' },
      { shortcuts: [] },
      { shortcuts: { bogusAction: 'mod+k' } },
      { shortcuts: { commandPalette: 'mod+shift' } },
      { shortcuts: { commandPalette: 'mod+shift+shift+k' } },
      { shortcuts: { commandPalette: 'MOD+K' } },
      { keymap: [] },
      { keymap: { preset: 'default', bindings: { 'provider.claude.new': 'mod+n' } } },
      { keymap: { preset: 'default', bindings: { 'tool.terminal': 'mod+mod+6' } } },
      { layout: { ...DEFAULT_LAYOUT_PREFERENCES, sidebar_width: 100 } },
      { layout: { ...DEFAULT_LAYOUT_PREFERENCES, remember_sizes: 'yes' } },
      { tools: { ...DEFAULT_TOOL_PREFERENCES, diffs: { ...DEFAULT_TOOL_PREFERENCES.diffs, layout: 'columns' } } },
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
      { terminal: null },
      { terminal: { ...DEFAULT_TERMINAL_PREFERENCES, font_size: 23 } },
      { terminal: { ...DEFAULT_TERMINAL_PREFERENCES, line_height: 0.9 } },
      { terminal: { ...DEFAULT_TERMINAL_PREFERENCES, cursor_blink: 'yes' } },
      { terminal: { ...DEFAULT_TERMINAL_PREFERENCES, scrollback_lines: 2_000 } },
      { terminal: { ...DEFAULT_TERMINAL_PREFERENCES, shell: '/bin/echo' } },
      { terminal: { ...DEFAULT_TERMINAL_PREFERENCES, extra: true } },
      { terminal: { font_size: 13 } },
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
      chat_font_size: 16,
      chat_font_family: 'mono',
      shortcuts: {
        commandPalette: 'mod+shift+p',
        approveOnce: 'o',
      },
      keymap: {
        preset: 'default' as const,
        bindings: {
          'app.quickSwitcher': 'mod+k',
          'tool.terminal': 'mod+6',
          'session.later': 'mod+shift+l',
          'session.archive': null,
        },
      },
      layout: { ...DEFAULT_LAYOUT_PREFERENCES, sidebar_width: 304 },
      tools: {
        ...DEFAULT_TOOL_PREFERENCES,
        files: { ...DEFAULT_TOOL_PREFERENCES.files, show_hidden_files: true },
        diffs: { ...DEFAULT_TOOL_PREFERENCES.diffs, layout: 'stacked' as const },
      },
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
      terminal: {
        ...DEFAULT_TERMINAL_PREFERENCES,
        font_family: 'sf-mono' as const,
        font_size: 15,
        line_height: 1.3,
        cursor_style: 'underline' as const,
        cursor_blink: false,
        scrollback_lines: 10_000 as const,
        shell: terminalOptions().system_shell,
        start_directory: 'home' as const,
      },
    } as const;

    const response = await patchSettings(ctx, payload);
    assert.equal(response.status, 200);
    const returned = await response.json() as Record<string, unknown>;
    const expected = {
      ...payload,
      density: 'cozy',
      font_scale_chrome: 'md',
      // font_scale_chat joined the retired set when chat font became a
      // concrete px size; the wire value is always md for older clients.
      font_scale_chat: 'md',
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
    assert.equal(stored.chat_font_size, payload.chat_font_size);
    assert.equal(stored.chat_font_family, payload.chat_font_family);
    assert.deepEqual(stored.shortcuts, payload.shortcuts);
    assert.deepEqual(stored.keymap, payload.keymap);
    assert.deepEqual(stored.layout, payload.layout);
    assert.deepEqual(stored.tools, payload.tools);
    assert.equal(stored.locale, payload.locale);
    assert.deepEqual(stored.external_editors, payload.external_editors);
    assert.deepEqual(stored.open_apps, payload.open_apps);
    assert.deepEqual(stored.terminal, payload.terminal);
  } finally {
    await ctx.cleanup();
  }
});

test('TERM-001 · terminal options route returns only discovered executable shells', async () => {
  const ctx = await makeTestApp();
  try {
    const response = await ctx.fetch('/api/settings/terminal-options');
    assert.equal(response.status, 200);
    const options = await response.json() as ReturnType<typeof terminalOptions>;
    assert.ok(options.system_shell.startsWith('/'));
    assert.ok(options.shells.some(shell => shell.path === options.system_shell));
    assert.ok(options.shells.every(shell => shell.path.startsWith('/') && shell.label.length > 0));
  } finally {
    await ctx.cleanup();
  }
});
