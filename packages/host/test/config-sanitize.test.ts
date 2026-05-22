// Coverage for traceability:
//   UI-ACCENT-001 — runtime sanitize for accent / font_scale / theme.
//   loadConfig validates values against allowlists and falls back to
//   the theme default accent (or 'md' for scales / 'warm' for theme)
//   so an invalid string in the DB never crashes the UI.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeTestApp } from './fixtures/test-app.js';
import { loadConfig } from '../src/storage/config.js';

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

test('UI-ACCENT-001 · defaults when nothing is set', async () => {
  const ctx = await makeTestApp();
  ctx.db.prepare('DELETE FROM config').run();
  const cfg = loadConfig(ctx.db);
  assert.equal(cfg.theme, 'warm');
  assert.equal(cfg.accent, 'ember');           // warm theme default
  assert.equal(cfg.font_scale_chrome, 'md');
  assert.equal(cfg.font_scale_chat, 'md');
  assert.equal(cfg.font_scale_code, 'md');
  await ctx.cleanup?.();
});
