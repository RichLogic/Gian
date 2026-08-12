import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeMcpRuntime, sanitizeDisplayName } from '../src/runtime/claude-mcp-runtime.js';

// SESSION-NAME-001: the Claude CLI `--name` value is sanitized before it hits
// the argv so a pasted multi-line name can't smuggle extra args / blow up the
// terminal title.
test('sanitizeDisplayName trims surrounding whitespace', () => {
  assert.equal(sanitizeDisplayName('  hello world  '), 'hello world');
});

test('sanitizeDisplayName replaces control chars (CR/LF/tab) with spaces', () => {
  assert.equal(sanitizeDisplayName('a\nb\tc\rd'), 'a b c d');
});

test('sanitizeDisplayName returns null for empty / whitespace / nullish', () => {
  assert.equal(sanitizeDisplayName(''), null);
  assert.equal(sanitizeDisplayName('   '), null);
  assert.equal(sanitizeDisplayName('\n\t'), null);
  assert.equal(sanitizeDisplayName(null), null);
  assert.equal(sanitizeDisplayName(undefined), null);
});

test('sanitizeDisplayName caps length at 200 chars', () => {
  assert.equal(sanitizeDisplayName('x'.repeat(300))!.length, 200);
});

test('sanitizeDisplayName preserves unicode', () => {
  assert.equal(sanitizeDisplayName('我的会话 🚀'), '我的会话 🚀');
});

test('first fake Claude turn receives sanitized --name; resume never reasserts a stale name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-claude-name-argv-'));
  const fakeClaude = join(dir, 'claude');
  const argvFile = join(dir, 'argv.json');
  writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "require('node:fs').writeFileSync(process.env.GIAN_TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: '' }));",
  ].join('\n'));
  chmodSync(fakeClaude, 0o755);

  const previousClaudeBin = process.env.CLAUDE_BIN;
  const previousArgvFile = process.env.GIAN_TEST_ARGV_FILE;
  process.env.CLAUDE_BIN = fakeClaude;
  process.env.GIAN_TEST_ARGV_FILE = argvFile;
  const runtime = new ClaudeMcpRuntime();
  const nativeSessionId = '00000000-0000-4000-8000-000000000031';

  try {
    await runtime.spawnSession({
      sessionId: 'session-name-argv',
      claudeSessionId: nativeSessionId,
      cwd: dir,
      model: null,
      isResume: false,
    });

    let exited = new Promise<void>(resolve => runtime.once('processExited', () => resolve()));
    await runtime.sendMessage('session-name-argv', 'first', {
      permissionMode: 'bypassPermissions',
      displayName: '  My\nClaude Session  ',
    });
    await exited;
    const firstArgs = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.deepEqual(
      firstArgs.slice(firstArgs.indexOf('--session-id'), firstArgs.indexOf('--session-id') + 4),
      ['--session-id', nativeSessionId, '--name', 'My Claude Session'],
    );
    assert.equal(firstArgs.includes('--resume'), false);

    exited = new Promise<void>(resolve => runtime.once('processExited', () => resolve()));
    await runtime.sendMessage('session-name-argv', 'resume', {
      permissionMode: 'bypassPermissions',
      displayName: 'Stale Gian Name',
    });
    await exited;
    const resumeArgs = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    assert.deepEqual(
      resumeArgs.slice(resumeArgs.indexOf('--resume'), resumeArgs.indexOf('--resume') + 2),
      ['--resume', nativeSessionId],
    );
    assert.equal(resumeArgs.includes('--name'), false);
  } finally {
    await runtime.stop();
    if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBin;
    if (previousArgvFile === undefined) delete process.env.GIAN_TEST_ARGV_FILE;
    else process.env.GIAN_TEST_ARGV_FILE = previousArgvFile;
    rmSync(dir, { recursive: true, force: true });
  }
});
