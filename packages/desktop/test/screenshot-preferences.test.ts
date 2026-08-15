import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_SCREENSHOT_PREFERENCES,
  FileScreenshotPreferenceStore,
  sanitizeScreenshotPreferences,
} from '../src/screenshot-preferences.js';

describe('screenshot preferences', () => {
  it('defaults to keeping the main window visible during capture', () => {
    assert.equal(DEFAULT_SCREENSHOT_PREFERENCES.hideMainWindowDuringCapture, false);
  });

  it('sanitizes unknown and malformed values to the fallback', () => {
    assert.deepEqual(
      sanitizeScreenshotPreferences(undefined),
      DEFAULT_SCREENSHOT_PREFERENCES,
    );
    assert.deepEqual(
      sanitizeScreenshotPreferences('nope'),
      DEFAULT_SCREENSHOT_PREFERENCES,
    );
    assert.deepEqual(
      sanitizeScreenshotPreferences({ hideMainWindowDuringCapture: 'yes' }),
      DEFAULT_SCREENSHOT_PREFERENCES,
    );
  });

  it('accepts a valid boolean and preserves an explicit fallback', () => {
    assert.deepEqual(
      sanitizeScreenshotPreferences({ hideMainWindowDuringCapture: true }),
      { hideMainWindowDuringCapture: true, shortcut: null },
    );
    assert.deepEqual(
      sanitizeScreenshotPreferences(
        { hideMainWindowDuringCapture: true },
        DEFAULT_SCREENSHOT_PREFERENCES,
      ),
      { hideMainWindowDuringCapture: true, shortcut: null },
    );
    assert.deepEqual(
      sanitizeScreenshotPreferences(
        { other: 1 },
        { hideMainWindowDuringCapture: true, shortcut: null },
      ),
      { hideMainWindowDuringCapture: true, shortcut: null },
    );
  });

  it('loads defaults when the file is missing or unreadable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gian-screenshot-prefs-'));
    try {
      const store = new FileScreenshotPreferenceStore(
        join(directory, 'screenshot-preferences.json'),
      );
      assert.deepEqual(store.load(), DEFAULT_SCREENSHOT_PREFERENCES);

      writeFileSync(
        join(directory, 'screenshot-preferences.json'),
        'not json',
        'utf8',
      );
      assert.deepEqual(store.load(), DEFAULT_SCREENSHOT_PREFERENCES);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('round-trips saved preferences through the file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gian-screenshot-prefs-'));
    try {
      const path = join(directory, 'screenshot-preferences.json');
      const store = new FileScreenshotPreferenceStore(path);
      store.save({ hideMainWindowDuringCapture: true, shortcut: null });
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
        hideMainWindowDuringCapture: true,
        shortcut: null,
      });
      assert.deepEqual(store.load(), { hideMainWindowDuringCapture: true, shortcut: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts a valid remapped shortcut accelerator', () => {
    assert.deepEqual(
      sanitizeScreenshotPreferences({ shortcut: 'Command+Shift+S' }),
      { hideMainWindowDuringCapture: false, shortcut: 'Command+Shift+S' },
    );
  });

  it('treats an explicit null shortcut as a reset to the platform default', () => {
    assert.deepEqual(
      sanitizeScreenshotPreferences(
        { shortcut: null },
        { hideMainWindowDuringCapture: true, shortcut: 'Command+Shift+S' },
      ),
      { hideMainWindowDuringCapture: true, shortcut: null },
    );
  });

  it('rejects malformed accelerators and keeps the fallback', () => {
    const fallback = { hideMainWindowDuringCapture: false, shortcut: 'Command+Shift+S' };
    for (const bad of [
      'S',                       // bare key would steal the letter globally
      'Shift+',                  // trailing modifier, no key
      'Shift+Shift+S',           // duplicate modifier
      'Command+Shift+Unicorn',   // unknown key name
      'x'.repeat(80),            // overlong
      42,
    ]) {
      assert.deepEqual(
        sanitizeScreenshotPreferences({ shortcut: bad }, fallback),
        fallback,
        `expected fallback for ${JSON.stringify(bad)}`,
      );
    }
  });
});
