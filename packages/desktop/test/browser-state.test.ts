import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BROWSER_PREFERENCES,
  FileBrowserStateStore,
  sanitizeBrowserState,
} from '../src/browser-state.js';

test('Browser state sanitizes preferences and restorable tabs fail closed', () => {
  const state = sanitizeBrowserState({
    version: 1,
    preferences: {
      home_page: 'https://home.example',
      restore_last_page: false,
      external_links: 'system',
    },
    tabs: [
      {
        id: 'tab-a',
        sourceSessionId: 'session-a',
        url: 'https://example.com/path',
        title: 'Example',
        zoomFactor: 99,
      },
      {
        id: 'tab-project',
        sourceSessionId: ' invalid ',
        url: 'gian-browser://temporary/site.html',
        title: 'Temporary project title',
        zoomFactor: 1,
      },
      { id: 'tab-a', url: 'https://duplicate.example' },
      { id: '', url: 'https://invalid.example' },
    ],
    permissions: [
      { origin: 'https://example.com/path', kinds: ['camera', 'unknown'] },
      { origin: 'https://example.com', kinds: ['microphone', 'camera'] },
      { origin: 'gian-browser://project', kinds: ['clipboard'] },
      { origin: 'not a url', kinds: ['geolocation'] },
    ],
  });

  assert.deepEqual(state.preferences, {
    home_page: 'https://home.example',
    restore_last_page: false,
    external_links: 'system',
  });
  assert.deepEqual(state.tabs, [
    {
      id: 'tab-a',
      sourceSessionId: 'session-a',
      url: 'https://example.com/path',
      title: 'Example',
      zoomFactor: 5,
    },
    {
      id: 'tab-project',
      sourceSessionId: null,
      url: '',
      title: '',
      zoomFactor: 1,
    },
  ]);
  assert.deepEqual(state.permissions, [{
    origin: 'https://example.com',
    kinds: ['camera', 'microphone'],
  }]);
});

test('Browser state rejects unknown versions instead of guessing a migration', () => {
  assert.deepEqual(sanitizeBrowserState({
    version: 2,
    preferences: { home_page: 'https://unexpected.example' },
    tabs: [{ id: 'tab-a', url: 'https://unexpected.example' }],
  }), {
    version: 1,
    preferences: DEFAULT_BROWSER_PREFERENCES,
    tabs: [],
    permissions: [],
  });
  assert.deepEqual(sanitizeBrowserState({
    preferences: { home_page: 'https://unversioned.example' },
    tabs: [{ id: 'tab-a', url: 'https://unversioned.example' }],
  }), {
    version: 1,
    preferences: DEFAULT_BROWSER_PREFERENCES,
    tabs: [],
    permissions: [],
  });
});

test('FileBrowserStateStore atomically round-trips sanitized state and recovers corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-browser-state-'));
  const path = join(root, 'nested', 'browser-state.json');
  try {
    const store = new FileBrowserStateStore(path);
    store.save({
      version: 1,
      preferences: DEFAULT_BROWSER_PREFERENCES,
      tabs: [{
        id: 'tab-a',
        sourceSessionId: null,
        url: 'https://example.com',
        title: 'Example',
        zoomFactor: 1.1,
      }],
      permissions: [{ origin: 'https://example.com', kinds: ['notifications'] }],
    });
    assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(root, 'nested')), ['browser-state.json']);
    assert.equal(store.load().tabs[0]?.url, 'https://example.com/');
    assert.deepEqual(store.load().permissions, [{
      origin: 'https://example.com',
      kinds: ['notifications'],
    }]);

    writeFileSync(path, '{broken', 'utf8');
    assert.deepEqual(store.load(), {
      version: 1,
      preferences: DEFAULT_BROWSER_PREFERENCES,
      tabs: [],
      permissions: [],
    });

    writeFileSync(path, 'x'.repeat(1_048_577), 'utf8');
    assert.deepEqual(store.load(), {
      version: 1,
      preferences: DEFAULT_BROWSER_PREFERENCES,
      tabs: [],
      permissions: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
