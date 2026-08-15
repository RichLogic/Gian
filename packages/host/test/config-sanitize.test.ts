// Coverage for traceability:
//   UI-ACCENT-001 — runtime sanitize for accent / font_scale / theme.
//   loadConfig validates values against allowlists and falls back to
//   the theme default accent (or 'md' for scales / 'warm' for theme)
//   so an invalid string in the DB never crashes the UI.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeTestApp } from './fixtures/test-app.js';
import { loadConfig, saveConfig } from '../src/storage/config.js';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';

test('UI-ACCENT-001 · invalid accent falls back to theme default', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('accent', 'banana')`).run();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('theme',  'dark')`).run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.accent, 'plum', 'dark theme default = plum');
  await ctx.cleanup?.();
});

test('UI-ACCENT-001 · invalid font scale falls back to md', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('font_scale_chat', 'huge')`).run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.font_scale_chat, 'md');
  await ctx.cleanup?.();
});

test('chat font · invalid px / family fall back to the defaults', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('chat_font_size', 'huge')`).run();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('chat_font_family', 'papyrus')`).run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.chat_font_size, 14);
  assert.equal(cfg.chat_font_family, 'system');
  await ctx.cleanup?.();
});

test('chat font · valid px / family round-trip', async () => {
  const ctx = await makeTestApp();
  saveConfig(ctx.db, { chat_font_size: 17, chat_font_family: 'serif' });
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.chat_font_size, 17);
  assert.equal(cfg.chat_font_family, 'serif');
  await ctx.cleanup?.();
});

test('shortcuts · saveConfig→loadConfig round-trips valid overrides only', async () => {
  const ctx = await makeTestApp();
  saveConfig(ctx.db, {
    shortcuts: {
      commandPalette: 'mod+shift+p',
      decline: 'x',
      bogusAction: 'mod+k',
      approveOnce: 'not a combo!',
    } as never,
  });
  const cfg = loadConfig(ctx.db);
  assert.deepEqual(cfg.shortcuts, {
    commandPalette: 'mod+shift+p',
    decline: 'x',
  });
  await ctx.cleanup?.();
});

test('shortcuts · a malformed stored JSON loads as {} without crashing', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('shortcuts', '[object Object]')`).run();
  const cfg = loadConfig(ctx.db);
  assert.deepEqual(cfg.shortcuts, {});
  await ctx.cleanup?.();
});

test('UI-ACCENT-001 · legacy plum accent is preserved', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('accent', 'plum')`).run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.accent, 'plum');
  await ctx.cleanup?.();
});

test('UI-ACCENT-001 · invalid theme falls back to warm', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('theme', 'galaxy')`).run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.theme, 'warm');
  await ctx.cleanup?.();
});

// ---------------------------------------------------------------------------
// open_apps round-trip — regression for "Default apps 设置完没有反应".
// saveConfig used to fall through to String(value) for the open_apps OBJECT,
// storing the literal "[object Object]"; loadConfig's JSON.parse then threw
// and silently reset the user's choice to {}. saveConfig must JSON-serialize.
// ---------------------------------------------------------------------------

test('open_apps · saveConfig→loadConfig round-trips the per-category app map', async () => {
  const ctx = await makeTestApp();
  saveConfig(ctx.db, { open_apps: { code: 'Visual Studio Code', web: '@newtab', pdf: 'Preview' } });
  const cfg = loadConfig(ctx.db);
  assert.deepEqual(cfg.open_apps, { code: 'Visual Studio Code', web: '@newtab', pdf: 'Preview' });
  await ctx.cleanup?.();
});

test('open_apps · the stored DB value is real JSON, never "[object Object]"', async () => {
  const ctx = await makeTestApp();
  saveConfig(ctx.db, { open_apps: { images: 'Preview' } });
  const row = ctx.db.prepare(`SELECT value FROM config WHERE key = 'open_apps'`).get() as { value: string };
  assert.notEqual(row.value, '[object Object]', 'must not coerce the object via String()');
  assert.deepEqual(JSON.parse(row.value), { images: 'Preview' }, 'stored value must be parseable JSON');
  await ctx.cleanup?.();
});

test('open_apps · legacy "[object Object]" rows load as {} without crashing', async () => {
  // Existing installs already have the broken value in the DB; loadConfig must
  // tolerate it (so the UI shows built-in defaults until the user re-picks).
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('open_apps', '[object Object]')`).run();
  const cfg = loadConfig(ctx.db);
  assert.deepEqual(cfg.open_apps, {});
  await ctx.cleanup?.();
});

test('open_apps · saveConfig drops unknown categories and non-string values', async () => {
  const ctx = await makeTestApp();
  saveConfig(ctx.db, {
    open_apps: { code: 'TextEdit', bogus: 'x', images: '', pdf: 42 } as never,
  });
  const cfg = loadConfig(ctx.db);
  assert.deepEqual(cfg.open_apps, { code: 'TextEdit' });
  await ctx.cleanup?.();
});

test('UI-ACCENT-001 · defaults when nothing is set', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare('DELETE FROM config').run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.theme, 'warm');
  assert.equal(cfg.accent, 'ember');           // warm theme default
  assert.equal(cfg.font_scale_chrome, 'md');
  assert.equal(cfg.font_scale_chat, 'md');
  assert.equal(cfg.font_scale_code, 'md');
  assert.deepEqual(cfg.terminal, DEFAULT_TERMINAL_PREFERENCES);
  await ctx.cleanup?.();
});

test('TERM-001 · terminal preferences round-trip as JSON', async () => {
  const ctx = await makeTestApp();
  const terminal = {
    ...DEFAULT_TERMINAL_PREFERENCES,
    font_family: 'menlo' as const,
    font_size: 16,
    line_height: 1.35,
    cursor_style: 'bar' as const,
    cursor_blink: false,
    scrollback_lines: 10_000 as const,
    shell: '/bin/bash',
    start_directory: 'home' as const,
  };
  saveConfig(ctx.db, { terminal });
  assert.deepEqual(loadConfig(ctx.db).terminal, terminal);
  const row = ctx.db.prepare(`SELECT value FROM config WHERE key = 'terminal'`).get() as { value: string };
  assert.deepEqual(JSON.parse(row.value), terminal);
  await ctx.cleanup?.();
});

test('TERM-001 · malformed terminal preferences fall back field by field', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('terminal', ?)`)
    .run(JSON.stringify({
      ...DEFAULT_TERMINAL_PREFERENCES,
      font_size: 99,
      line_height: 'wide',
      cursor_style: 'beam',
      scrollback_lines: 123,
      start_directory: 'root',
      cursor_blink: false,
    }));
  assert.deepEqual(loadConfig(ctx.db).terminal, {
    ...DEFAULT_TERMINAL_PREFERENCES,
    cursor_blink: false,
  });
  await ctx.cleanup?.();
});

test('retired density and interface/code scale preferences stay Cozy + MD', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('density', 'compact')`).run();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('font_scale_chrome', 'xl')`).run();
  ctx.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('font_scale_code', 'sm')`).run();
  saveConfig(ctx.db, {
    density: 'roomy',
    font_scale_chrome: 'lg',
    font_scale_code: 'lg',
  });
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.density, 'cozy');
  assert.equal(cfg.font_scale_chrome, 'md');
  assert.equal(cfg.font_scale_code, 'md');
  await ctx.cleanup?.();
});
