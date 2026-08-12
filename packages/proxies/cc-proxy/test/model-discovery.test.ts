import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractClaudeConfigDirFromScript,
  parseAvailableModels,
  resolveClaudeSettingsPath,
  ClaudeMcpRuntime,
} from '../src/runtime/claude-mcp-runtime.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cc-proxy-model-discovery-'));
}

function writeSettings(dir: string, contents: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// extractClaudeConfigDirFromScript
// ---------------------------------------------------------------------------

const HOME = '/home/tester';

test('extractClaudeConfigDirFromScript handles ${VAR:-$HOME/default}', () => {
  const script = '#!/bin/zsh\nexport CLAUDE_CONFIG_DIR="${CLAUDE_MIX_CONFIG_DIR:-$HOME/.claude-mix}"\nexec claude "$@"\n';
  assert.equal(extractClaudeConfigDirFromScript(script, HOME), '/home/tester/.claude-mix');
});

test('extractClaudeConfigDirFromScript handles "$HOME/x"', () => {
  assert.equal(extractClaudeConfigDirFromScript('CLAUDE_CONFIG_DIR="$HOME/x"', HOME), '/home/tester/x');
});

test('extractClaudeConfigDirFromScript handles ~/x', () => {
  assert.equal(extractClaudeConfigDirFromScript('CLAUDE_CONFIG_DIR=~/x', HOME), '/home/tester/x');
});

test('extractClaudeConfigDirFromScript handles a plain absolute path', () => {
  assert.equal(extractClaudeConfigDirFromScript('export CLAUDE_CONFIG_DIR=/opt/claude-conf', HOME), '/opt/claude-conf');
});

test('extractClaudeConfigDirFromScript handles ${VAR-default} without colon', () => {
  assert.equal(extractClaudeConfigDirFromScript('CLAUDE_CONFIG_DIR="${MIX_DIR-$HOME/mix}"', HOME), '/home/tester/mix');
});

test('extractClaudeConfigDirFromScript bails on unresolvable expansions', () => {
  assert.equal(extractClaudeConfigDirFromScript('CLAUDE_CONFIG_DIR="$SOME_VAR/x"', HOME), null);
  assert.equal(extractClaudeConfigDirFromScript('CLAUDE_CONFIG_DIR="${SOME_VAR}/x"', HOME), null);
});

test('extractClaudeConfigDirFromScript bails when there is no assignment', () => {
  assert.equal(extractClaudeConfigDirFromScript('#!/bin/sh\nexec claude "$@"\n', HOME), null);
});

test('extractClaudeConfigDirFromScript bails on relative paths', () => {
  assert.equal(extractClaudeConfigDirFromScript('CLAUDE_CONFIG_DIR=relative/dir', HOME), null);
});

// ---------------------------------------------------------------------------
// parseAvailableModels
// ---------------------------------------------------------------------------

test('parseAvailableModels returns the string list verbatim', () => {
  const models = ['claude-router-kimi-k3[1m]', 'claude-router-kimi-k3-256k'];
  assert.deepEqual(parseAvailableModels({ availableModels: models }), models);
});

test('parseAvailableModels filters non-string / empty entries', () => {
  assert.deepEqual(
    parseAvailableModels({ availableModels: ['a', 1, null, '', 'b'] }),
    ['a', 'b'],
  );
});

test('parseAvailableModels returns [] for missing/invalid shapes', () => {
  assert.deepEqual(parseAvailableModels({}), []);
  assert.deepEqual(parseAvailableModels({ availableModels: 'nope' }), []);
  assert.deepEqual(parseAvailableModels({ availableModels: [] }), []);
  assert.deepEqual(parseAvailableModels(null), []);
  assert.deepEqual(parseAvailableModels('str'), []);
});

// ---------------------------------------------------------------------------
// resolveClaudeSettingsPath
// ---------------------------------------------------------------------------

test('resolveClaudeSettingsPath prefers $CLAUDE_CONFIG_DIR', () => {
  const root = makeTmpDir();
  try {
    const confDir = join(root, 'env-conf');
    const expected = writeSettings(confDir, '{"availableModels": []}');
    assert.equal(
      resolveClaudeSettingsPath({
        env: { CLAUDE_CONFIG_DIR: confDir },
        home: join(root, 'home'),
        executable: join(root, 'missing-bin'),
      }),
      expected,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeSettingsPath expands ~ in $CLAUDE_CONFIG_DIR', () => {
  const root = makeTmpDir();
  try {
    const home = join(root, 'home');
    const expected = writeSettings(join(home, 'mix'), '{}');
    assert.equal(
      resolveClaudeSettingsPath({
        env: { CLAUDE_CONFIG_DIR: '~/mix' },
        home,
        executable: join(root, 'missing-bin'),
      }),
      expected,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeSettingsPath extracts CLAUDE_CONFIG_DIR from a wrapper script', () => {
  const root = makeTmpDir();
  try {
    const home = join(root, 'home');
    const expected = writeSettings(join(home, '.claude-mix'), '{"availableModels": ["m1"]}');
    const wrapper = join(root, 'claude-wrapper');
    writeFileSync(
      wrapper,
      '#!/bin/zsh\nexport CLAUDE_CONFIG_DIR="${CLAUDE_MIX_CONFIG_DIR:-$HOME/.claude-mix}"\nexec claude "$@"\n',
      'utf8',
    );
    assert.equal(
      resolveClaudeSettingsPath({ env: {}, home, executable: wrapper }),
      expected,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeSettingsPath skips binary executables and uses ~/.claude', () => {
  const root = makeTmpDir();
  try {
    const home = join(root, 'home');
    const expected = writeSettings(join(home, '.claude'), '{}');
    const binary = join(root, 'claude-bin');
    // NUL byte in the head marks this as a binary, not a wrapper script.
    writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    assert.equal(
      resolveClaudeSettingsPath({ env: {}, home, executable: binary }),
      expected,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeSettingsPath falls through invalid JSON to the next candidate', () => {
  const root = makeTmpDir();
  try {
    const confDir = join(root, 'env-conf');
    writeSettings(confDir, 'not json {');
    const home = join(root, 'home');
    const expected = writeSettings(join(home, '.claude'), '{}');
    assert.equal(
      resolveClaudeSettingsPath({
        env: { CLAUDE_CONFIG_DIR: confDir },
        home,
        executable: join(root, 'missing-bin'),
      }),
      expected,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveClaudeSettingsPath returns null when nothing usable exists', () => {
  const root = makeTmpDir();
  try {
    assert.equal(
      resolveClaudeSettingsPath({
        env: { CLAUDE_CONFIG_DIR: join(root, 'nope') },
        home: join(root, 'home'),
        executable: join(root, 'missing-bin'),
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// discoverModels end-to-end (via the runtime's public surface)
// ---------------------------------------------------------------------------

/** Discover models with env hermetically pointed at tmp dirs: a fake
 *  `claude` that answers --help with nothing, a tmp HOME, and no print
 *  probe. `configDir` (when given) is exported as CLAUDE_CONFIG_DIR. */
async function discoverModelsWith(configDir: string | null) {
  const root = makeTmpDir();
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const fakeClaude = join(root, 'fake-claude');
  writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(fakeClaude, 0o755);

  const saved = {
    HOME: process.env.HOME,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    GIAN_ALLOW_CLAUDE_PRINT_PROBE: process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE,
  };
  process.env.HOME = home;
  process.env.CLAUDE_BIN = fakeClaude;
  delete process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE;
  if (configDir) process.env.CLAUDE_CONFIG_DIR = configDir;
  else delete process.env.CLAUDE_CONFIG_DIR;

  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  };

  const runtime = new ClaudeMcpRuntime();
  try {
    await runtime.start();
    await runtime.awaitModelDiscovery();
    return runtime.getModels();
  } finally {
    await runtime.stop().catch(() => undefined);
    restore();
  }
}

test('discoverModels builds the menu from settings availableModels, Default first', async () => {
  const confRoot = makeTmpDir();
  try {
    const availableModels = [
      'claude-router-kimi-k3[1m]',
      'claude-router-kimi-k3-256k',
      'claude-router-gpt-5-6-sol-fast[1m]',
    ];
    writeSettings(confRoot, JSON.stringify({ model: 'claude-router-kimi-k3-256k', availableModels }));

    const models = await discoverModelsWith(confRoot);

    assert.equal(models.length, 1 + availableModels.length);
    const [first, ...rest] = models;
    assert.equal(first!.id, 'claude-default');
    assert.equal(first!.model, '');
    assert.equal(first!.isDefault, true);
    assert.deepEqual(rest.map((m) => m.model), availableModels);
    assert.deepEqual(rest.map((m) => m.displayName), availableModels);
    for (const m of rest) {
      assert.match(m.id, /^claude-settings-/);
      assert.equal(m.isDefault, false);
      assert.equal(m.hidden, false);
      assert.equal(m.defaultEffort, null);
      assert.deepEqual(m.supportedEfforts, []); // fake claude --help prints nothing
      assert.equal(m.description, 'From Claude settings availableModels.');
    }
    // Ids are unique even though slugs may collide.
    assert.equal(new Set(rest.map((m) => m.id)).size, rest.length);
  } finally {
    rmSync(confRoot, { recursive: true, force: true });
  }
});

test('discoverModels falls back to static aliases without usable availableModels', async () => {
  // CLAUDE_CONFIG_DIR points at a dir with no settings.json; tmp HOME has no
  // ~/.claude either, so no availableModels can be found anywhere.
  const models = await discoverModelsWith(null);
  assert.deepEqual(models.map((m) => m.id), [
    'claude-default',
    'claude-alias-opus',
    'claude-alias-sonnet',
    'claude-alias-haiku',
  ]);
});

test('discoverModels falls back to static aliases on invalid settings JSON', async () => {
  const confRoot = makeTmpDir();
  try {
    writeSettings(confRoot, 'not json {');
    const models = await discoverModelsWith(confRoot);
    assert.deepEqual(models.map((m) => m.id), [
      'claude-default',
      'claude-alias-opus',
      'claude-alias-sonnet',
      'claude-alias-haiku',
    ]);
  } finally {
    rmSync(confRoot, { recursive: true, force: true });
  }
});
