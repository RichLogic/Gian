import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
} from '@gian/shared';
import {
  configureUserSettingsFile,
  ensureUserSettingsFile,
  loadConfig,
  saveConfig,
  savePasswordHash,
} from '../src/storage/config.js';
import { openDatabase } from '../src/storage/db.js';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-settings-file-'));
  const db = openDatabase(dataDir);
  configureUserSettingsFile(dataDir);
  return {
    dataDir,
    db,
    path: join(dataDir, 'settings.json'),
    async cleanup() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('settings.json · boot migration writes the complete user-editable configuration', async () => {
  const ctx = await fixture();
  try {
    saveConfig(ctx.db, { theme: 'dark', locale: 'en' });
    ensureUserSettingsFile(loadConfig(ctx.db));
    const document = JSON.parse(await readFile(ctx.path, 'utf8')) as Record<string, unknown>;
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.theme, 'dark');
    assert.equal(document.locale, 'en');
    assert.deepEqual(document.layout, DEFAULT_LAYOUT_PREFERENCES);
    assert.deepEqual(document.tools, DEFAULT_TOOL_PREFERENCES);
  } finally {
    await ctx.cleanup();
  }
});

test('settings.json · external edits override legacy DB values on the next load', async () => {
  const ctx = await fixture();
  try {
    saveConfig(ctx.db, { theme: 'warm' });
    ensureUserSettingsFile(loadConfig(ctx.db));
    const document = JSON.parse(await readFile(ctx.path, 'utf8')) as Record<string, unknown>;
    document.theme = 'light';
    document.keymap = {
      preset: 'default',
      bindings: { 'tool.terminal': 'mod+alt+6', 'session.archive': null },
    };
    document.layout = { ...DEFAULT_LAYOUT_PREFERENCES, sidebar_width: 336 };
    await writeFile(ctx.path, `${JSON.stringify(document, null, 2)}\n`);

    const config = loadConfig(ctx.db);
    assert.equal(config.theme, 'light');
    assert.equal(config.layout?.sidebar_width, 336);
    assert.equal(config.keymap?.bindings['tool.terminal'], 'mod+alt+6');
    assert.equal(config.keymap?.bindings['session.archive'], null);
  } finally {
    await ctx.cleanup();
  }
});

test('settings.json · UI saves rewrite atomically without exporting credentials', async () => {
  const ctx = await fixture();
  try {
    ensureUserSettingsFile(loadConfig(ctx.db));
    savePasswordHash(ctx.db, 'never-export-this');
    saveConfig(ctx.db, {
      layout: { ...DEFAULT_LAYOUT_PREFERENCES, inspector_width: 344 },
      auth_username: 'local-user',
    });
    const text = await readFile(ctx.path, 'utf8');
    const document = JSON.parse(text) as Record<string, unknown>;
    assert.equal((document.layout as Record<string, unknown>).inspector_width, 344);
    assert.equal(text.includes('never-export-this'), false);
    assert.equal(Object.hasOwn(document, 'auth_username'), false);
  } finally {
    await ctx.cleanup();
  }
});

test('settings.json · invalid external edits retain the last valid configuration', async () => {
  const ctx = await fixture();
  try {
    ensureUserSettingsFile(loadConfig(ctx.db));
    const valid = JSON.parse(await readFile(ctx.path, 'utf8')) as Record<string, unknown>;
    valid.theme = 'dark';
    await writeFile(ctx.path, JSON.stringify(valid));
    assert.equal(loadConfig(ctx.db).theme, 'dark');
    await writeFile(ctx.path, '{ invalid');
    assert.equal(loadConfig(ctx.db).theme, 'dark');
  } finally {
    await ctx.cleanup();
  }
});
