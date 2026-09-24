import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { stableCustomizationId } from '@gian/proxy-protocol';

import {
  discoverAgentSkills,
  discoverLegacyCommands,
} from '../src/core/skill-discovery.js';
import { ClaudeCustomizationScanner } from '../src/core/customization.js';

function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'skill-discovery-test-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const result = run(dir);
    if (result instanceof Promise) return result.finally(cleanup);
    cleanup();
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// discoverLegacyCommands
// ---------------------------------------------------------------------------

test('discoverLegacyCommands — returns [] for a root without commands/', async () => {
  await withTempDir(async (dir) => {
    assert.deepStrictEqual(await discoverLegacyCommands(dir, 'user', null), []);
  });
});

test('discoverLegacyCommands — reads description from YAML frontmatter', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'code-review.md'), [
      '---',
      'description: Review staged changes for correctness and style.',
      '---',
      '',
      '# Code review',
      '',
      'Review the diff.',
    ].join('\n'));

    const result = await discoverLegacyCommands(dir, 'user', null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, 'code-review');
    assert.strictEqual(result[0]?.description, 'Review staged changes for correctness and style.');
    assert.strictEqual(result[0]?.format, 'legacy-command');
    assert.strictEqual(result[0]?.entryPath, join(dir, 'commands', 'code-review.md'));
  });
});

test('discoverLegacyCommands — falls back to first non-heading line when no frontmatter', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'deploy.md'), [
      '# Deploy',
      '',
      'Deploy the current branch to staging.',
    ].join('\n'));

    const result = await discoverLegacyCommands(dir, 'workspace', null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, 'deploy');
    assert.strictEqual(result[0]?.description, 'Deploy the current branch to staging.');
  });
});

test('discoverLegacyCommands — skips files starting with _', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', '_draft.md'), '---\ndescription: Draft command.\n---\n');
    writeFileSync(join(dir, 'commands', 'publish.md'), '---\ndescription: Publish.\n---\n');

    const result = await discoverLegacyCommands(dir, 'user', null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, 'publish');
  });
});

test('discoverLegacyCommands — ignores non-.md files', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'helper.sh'), '#!/bin/sh\necho hello');
    writeFileSync(join(dir, 'commands', 'notes.txt'), 'some notes');
    writeFileSync(join(dir, 'commands', 'valid.md'), '# Valid\n\nDoes something.');

    const result = await discoverLegacyCommands(dir, 'user', null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, 'valid');
  });
});

test('discoverLegacyCommands — customizationId matches the stable-id inputs of the inventory', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'commit.md'), '# Commit\n\nDraft a commit.');

    const [userCommand] = await discoverLegacyCommands(dir, 'user', null);
    assert.equal(userCommand?.customizationId, stableCustomizationId({
      provider: 'claude',
      kind: 'skill',
      scopeKey: 'user',
      canonicalSourceLocator: resolve(join(dir, 'commands', 'commit.md')),
      nativeIdentity: 'commit',
    }));

    const cwd = '/some/workspace';
    const [wsCommand] = await discoverLegacyCommands(dir, 'workspace', cwd);
    assert.equal(wsCommand?.customizationId, stableCustomizationId({
      provider: 'claude',
      kind: 'skill',
      scopeKey: `workspace:${cwd}`,
      canonicalSourceLocator: resolve(join(dir, 'commands', 'commit.md')),
      nativeIdentity: 'commit',
    }));
    assert.notEqual(userCommand?.customizationId, wsCommand?.customizationId);
  });
});

// ---------------------------------------------------------------------------
// discoverAgentSkills
// ---------------------------------------------------------------------------

test('discoverAgentSkills — returns [] for a root without skills/', async () => {
  await withTempDir(async (dir) => {
    assert.deepStrictEqual(await discoverAgentSkills(dir, 'user', null), []);
  });
});

test('discoverAgentSkills — discovers skills/<dir>/SKILL.md with frontmatter name and description', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'skills', 'plan-review'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'plan-review', 'SKILL.md'), [
      '---',
      'name: plan-review',
      'description: Review an implementation plan before coding.',
      '---',
      '',
      '# Plan Review',
    ].join('\n'));

    const result = await discoverAgentSkills(dir, 'user', null);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.name, 'plan-review');
    assert.strictEqual(result[0]?.description, 'Review an implementation plan before coding.');
    assert.strictEqual(result[0]?.format, 'agent-skill');
    assert.strictEqual(result[0]?.entryPath, join(dir, 'skills', 'plan-review', 'SKILL.md'));
  });
});

test('discoverAgentSkills — frontmatter name wins over the directory name, which is the fallback', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'skills', 'dir-name'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'dir-name', 'SKILL.md'), '---\nname: front-name\n---\n# Body\n');
    mkdirSync(join(dir, 'skills', 'plain-dir'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'plain-dir', 'SKILL.md'), '# No frontmatter\n');

    const byName = new Map(
      (await discoverAgentSkills(dir, 'user', null)).map(skill => [skill.name, skill]),
    );
    assert.ok(byName.has('front-name'), 'frontmatter name must win');
    assert.ok(!byName.has('dir-name'), 'directory name must not be used when frontmatter declares a name');
    assert.ok(byName.has('plain-dir'), 'directory name is the fallback');
    // The id follows the resolved (frontmatter) name, matching the inventory.
    assert.equal(byName.get('front-name')?.customizationId, stableCustomizationId({
      provider: 'claude',
      kind: 'skill',
      scopeKey: 'user',
      canonicalSourceLocator: resolve(join(dir, 'skills', 'dir-name', 'SKILL.md')),
      nativeIdentity: 'front-name',
    }));
  });
});

test('discoverAgentSkills — skips directories without SKILL.md, non-directories, and symlinked dirs', async () => {
  await withTempDir(async (dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'skill-discovery-outside-'));
    try {
      mkdirSync(join(outside, 'evil'), { recursive: true });
      writeFileSync(join(outside, 'evil', 'SKILL.md'), '---\nname: evil\n---\n');
      mkdirSync(join(dir, 'skills', 'empty-dir'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'a-file.md'), '---\nname: a-file\n---\n');
      symlinkSync(join(outside, 'evil'), join(dir, 'skills', 'evil-link'), 'dir');
      mkdirSync(join(dir, 'skills', 'real'), { recursive: true });
      writeFileSync(join(dir, 'skills', 'real', 'SKILL.md'), '---\nname: real\n---\n');

      const names = (await discoverAgentSkills(dir, 'user', null)).map(skill => skill.name);
      assert.deepStrictEqual(names, ['real']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('discoverAgentSkills — reports unreadable entries through the diagnostic sink only', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'skills', 'blocked'), { recursive: true });
    const skillPath = join(dir, 'skills', 'blocked', 'SKILL.md');
    writeFileSync(skillPath, '---\nname: blocked\n---\n');
    chmodSync(skillPath, 0o000);
    try {
      const diagnostics: unknown[] = [];
      const withSink = await discoverAgentSkills(dir, 'user', null, {
        reportDiagnostic: diagnostic => diagnostics.push(diagnostic),
      });
      assert.deepStrictEqual(withSink, []);
      assert.strictEqual(diagnostics.length, 1);
      assert.strictEqual((diagnostics[0] as { code: string }).code, 'SOURCE_UNREADABLE');

      const withoutSink = await discoverAgentSkills(dir, 'user', null);
      assert.deepStrictEqual(withoutSink, []);
    } finally {
      chmodSync(skillPath, 0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-surface: discovery ids are exactly the inventory ids
// ---------------------------------------------------------------------------

test('discovery customizationIds equal the Customization inventory item ids for the same files', async () => {
  await withTempDir(async (home) => {
    await withTempDir(async (ws) => {
      mkdirSync(join(home, 'skills', 'plan-review'), { recursive: true });
      writeFileSync(join(home, 'skills', 'plan-review', 'SKILL.md'), '---\nname: plan-review\n---\n# Plan Review\n');
      mkdirSync(join(home, 'commands'), { recursive: true });
      writeFileSync(join(home, 'commands', 'commit.md'), '# Commit\n\nDraft a commit.');
      mkdirSync(join(ws, '.claude', 'skills', 'code-review'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'skills', 'code-review', 'SKILL.md'), '---\nname: code-review\n---\n');
      mkdirSync(join(ws, '.claude', 'commands'), { recursive: true });
      writeFileSync(join(ws, '.claude', 'commands', 'fix.md'), '# Fix\n\nFix it.');

      const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = home;
      try {
        const scanner = new ClaudeCustomizationScanner();
        const inventory = await scanner.list('skill', ws);
        const inventoryIds = new Map(inventory.items.map(item => [`${item.scope.level}:${item.name}`, item.id]));

        for (const skill of await discoverAgentSkills(home, 'user', null)) {
          assert.equal(skill.customizationId, inventoryIds.get(`user:${skill.name}`), `user skill ${skill.name}`);
        }
        for (const command of await discoverLegacyCommands(home, 'user', null)) {
          assert.equal(command.customizationId, inventoryIds.get(`user:${command.name}`), `user command ${command.name}`);
        }
        const projectRoot = join(ws, '.claude');
        for (const skill of await discoverAgentSkills(projectRoot, 'workspace', ws)) {
          assert.equal(skill.customizationId, inventoryIds.get(`workspace:${skill.name}`), `workspace skill ${skill.name}`);
        }
        for (const command of await discoverLegacyCommands(projectRoot, 'workspace', ws)) {
          assert.equal(command.customizationId, inventoryIds.get(`workspace:${command.name}`), `workspace command ${command.name}`);
        }
        assert.strictEqual(inventory.items.length, 4);
      } finally {
        if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
    });
  });
});
