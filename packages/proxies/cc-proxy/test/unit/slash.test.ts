import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanCommandsDir, listAllSlashCommands, clearSlashCache } from '../../src/core/slash.js';

const stubProbe = (names: string[]) => async () => names;

// ---------------------------------------------------------------------------
// scanCommandsDir
// ---------------------------------------------------------------------------

function withTempDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'slash-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scanCommandsDir — returns [] for non-existent dir', () => {
  const result = scanCommandsDir('/nonexistent/path/that/does/not/exist', 'user');
  assert.deepStrictEqual(result, []);
});

test('scanCommandsDir — reads description from YAML frontmatter', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'code-review.md'), [
      '---',
      'description: Review staged changes for correctness and style.',
      '---',
      '',
      '# Code review',
      '',
      'Review the diff.',
    ].join('\n'));

    const result = scanCommandsDir(dir, 'user');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, '/code-review');
    assert.strictEqual(result[0]?.description, 'Review staged changes for correctness and style.');
    assert.strictEqual(result[0]?.source, 'user');
    assert.strictEqual(result[0]?.filePath, join(dir, 'code-review.md'));
  });
});

test('scanCommandsDir — falls back to first non-heading line when no frontmatter', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'deploy.md'), [
      '# Deploy',
      '',
      'Deploy the current branch to staging.',
    ].join('\n'));

    const result = scanCommandsDir(dir, 'project');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, '/deploy');
    assert.strictEqual(result[0]?.description, 'Deploy the current branch to staging.');
    assert.strictEqual(result[0]?.source, 'project');
  });
});

test('scanCommandsDir — skips files starting with _', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '_draft.md'), '---\ndescription: Draft command.\n---\n');
    writeFileSync(join(dir, 'publish.md'), '---\ndescription: Publish.\n---\n');

    const result = scanCommandsDir(dir, 'user');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, '/publish');
  });
});

test('scanCommandsDir — ignores non-.md files', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'helper.sh'), '#!/bin/sh\necho hello');
    writeFileSync(join(dir, 'notes.txt'), 'some notes');
    writeFileSync(join(dir, 'valid.md'), '# Valid\n\nDoes something.');

    const result = scanCommandsDir(dir, 'user');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, '/valid');
  });
});

// ---------------------------------------------------------------------------
// listAllSlashCommands
// ---------------------------------------------------------------------------

test('listAllSlashCommands — surfaces probe names with descriptions when known', async () => {
  clearSlashCache();
  const all = await listAllSlashCommands(undefined, stubProbe(['clear', 'compact', 'unknown-skill']));
  const byName = new Map(all.map((c) => [c.name, c]));
  assert.ok(byName.get('/clear'), '/clear must be present from probe');
  assert.ok(byName.get('/compact'), '/compact must be present');
  assert.ok(byName.get('/unknown-skill'), 'unknown skill names should still appear');
  // Native descriptions come from the static map.
  assert.match(byName.get('/clear')!.description, /Reset/);
  // Unknown commands fall back to the name as description.
  assert.strictEqual(byName.get('/unknown-skill')!.description, '/unknown-skill');
});

test('listAllSlashCommands — project file commands override probe entries', async () => {
  clearSlashCache();
  const cwd = mkdtempSync(join(tmpdir(), 'slash-test-'));
  try {
    const commandsDir = join(cwd, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'clear.md'), '---\ndescription: Project-level clear.\n---\n');

    const all = await listAllSlashCommands(cwd, stubProbe(['clear']));
    const clearCmd = all.find((c) => c.name === '/clear');
    assert.ok(clearCmd, '/clear must be present');
    assert.strictEqual(clearCmd.source, 'project');
    assert.strictEqual(clearCmd.description, 'Project-level clear.');
    assert.strictEqual(all.filter((c) => c.name === '/clear').length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
