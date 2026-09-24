import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listAllSlashCommands, clearSlashCache } from '../src/core/slash.js';
import { discoverLegacyCommands } from '../src/core/skill-discovery.js';

const stubProbe = (names: string[]) => async () => names;

function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'slash-test-'));
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

/** Point the user-level Claude root at a temp dir so tests never depend on
 *  the real ~/.claude. Returns a restore function. */
function useTempClaudeHome(home: string): () => void {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  return () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  };
}

// ---------------------------------------------------------------------------
// listAllSlashCommands
// ---------------------------------------------------------------------------

test('listAllSlashCommands — surfaces probe names with descriptions when known', async () => {
  clearSlashCache();
  await withTempDir(async (home) => {
    const restore = useTempClaudeHome(home);
    try {
      const all = await listAllSlashCommands(undefined, stubProbe(['clear', 'compact', 'unknown-skill']));
      const byName = new Map(all.map((c) => [c.name, c]));
      assert.ok(byName.get('/clear'), '/clear must be present from probe');
      assert.ok(byName.get('/compact'), '/compact must be present');
      assert.ok(byName.get('/unknown-skill'), 'unknown skill names should still appear');
      // Native descriptions come from the static map.
      assert.match(byName.get('/clear')!.description, /Reset/);
      // Unknown commands fall back to the name as description.
      assert.strictEqual(byName.get('/unknown-skill')!.description, '/unknown-skill');
    } finally {
      restore();
    }
  });
});

test('listAllSlashCommands — default path scans files without native probe names', async () => {
  clearSlashCache();
  await withTempDir(async (home) => {
    await withTempDir(async (cwd) => {
      const restore = useTempClaudeHome(home);
      try {
        const commandsDir = join(cwd, '.claude', 'commands');
        mkdirSync(commandsDir, { recursive: true });
        writeFileSync(join(commandsDir, 'local-only.md'), '---\ndescription: Local command.\n---\n');

        const all = await listAllSlashCommands(cwd);
        const byName = new Map(all.map((c) => [c.name, c]));
        assert.ok(byName.get('/local-only'), 'project file command should be present');
        assert.equal(byName.get('/native-only'), undefined, 'no native probe names should appear by default');
      } finally {
        restore();
      }
    });
  });
});

test('listAllSlashCommands — project file commands override probe entries', async () => {
  clearSlashCache();
  await withTempDir(async (home) => {
    await withTempDir(async (cwd) => {
      const restore = useTempClaudeHome(home);
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
        restore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Agent-skills in the slash list (shared discovery with the inventory)
// ---------------------------------------------------------------------------

test('listAllSlashCommands — includes user and project agent-skills with inventory names and ids', async () => {
  clearSlashCache();
  await withTempDir(async (home) => {
    await withTempDir(async (cwd) => {
      const restore = useTempClaudeHome(home);
      try {
        mkdirSync(join(home, 'skills', 'plan-dir'), { recursive: true });
        writeFileSync(join(home, 'skills', 'plan-dir', 'SKILL.md'), [
          '---',
          'name: plan-review',
          'description: Review an implementation plan.',
          '---',
          '# Plan Review',
        ].join('\n'));
        mkdirSync(join(cwd, '.claude', 'skills', 'code-review'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'skills', 'code-review', 'SKILL.md'), [
          '---',
          'name: code-review',
          'description: Review the diff.',
          '---',
        ].join('\n'));

        const all = await listAllSlashCommands(cwd);
        const byName = new Map(all.map((c) => [c.name, c]));

        const userSkill = byName.get('/plan-review');
        assert.ok(userSkill, 'user agent-skill must appear in the slash list');
        assert.strictEqual(userSkill.source, 'user');
        assert.strictEqual(userSkill.description, 'Review an implementation plan.');
        assert.strictEqual(userSkill.filePath, join(home, 'skills', 'plan-dir', 'SKILL.md'));
        assert.match(userSkill.customizationId ?? '', /^ci1_[a-f0-9]+$/);

        const projectSkill = byName.get('/code-review');
        assert.ok(projectSkill, 'project agent-skill must appear in the slash list');
        assert.strictEqual(projectSkill.source, 'project');
        assert.strictEqual(projectSkill.description, 'Review the diff.');
        assert.match(projectSkill.customizationId ?? '', /^ci1_[a-f0-9]+$/);
        assert.notStrictEqual(userSkill.customizationId, projectSkill.customizationId);
      } finally {
        restore();
      }
    });
  });
});

test('listAllSlashCommands — slash customizationId equals the inventory id for the same file', async () => {
  clearSlashCache();
  await withTempDir(async (home) => {
    const restore = useTempClaudeHome(home);
    try {
      mkdirSync(join(home, 'commands'), { recursive: true });
      writeFileSync(join(home, 'commands', 'commit.md'), '# Commit\n\nDraft a commit.');
      mkdirSync(join(home, 'skills', 'plan-review'), { recursive: true });
      writeFileSync(join(home, 'skills', 'plan-review', 'SKILL.md'), '---\nname: plan-review\n---\n');

      const all = await listAllSlashCommands();
      const byName = new Map(all.map((c) => [c.name, c]));
      const [discoveredCommand] = await discoverLegacyCommands(home, 'user', null);
      assert.ok(discoveredCommand);
      assert.strictEqual(byName.get('/commit')?.customizationId, discoveredCommand.customizationId);
      assert.strictEqual(byName.get('/commit')?.description, 'Draft a commit.');
    } finally {
      restore();
    }
  });
});

test('listAllSlashCommands — a project skill shadows a same-named user skill; a legacy command wins a same-name tie', async () => {
  clearSlashCache();
  await withTempDir(async (home) => {
    await withTempDir(async (cwd) => {
      const restore = useTempClaudeHome(home);
      try {
        mkdirSync(join(home, 'skills', 'dup'), { recursive: true });
        writeFileSync(join(home, 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: user skill.\n---\n');
        mkdirSync(join(cwd, '.claude', 'skills', 'dup'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'skills', 'dup', 'SKILL.md'), '---\nname: dup\ndescription: project skill.\n---\n');
        // Same scope: a legacy command named like an agent-skill wins the tie.
        mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'commands', 'code-review.md'), '---\ndescription: project command.\n---\n');
        mkdirSync(join(cwd, '.claude', 'skills', 'code-review'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'skills', 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: project skill.\n---\n');

        const all = await listAllSlashCommands(cwd);
        const byName = new Map(all.map((c) => [c.name, c]));

        assert.strictEqual(all.filter((c) => c.name === '/dup').length, 1);
        assert.strictEqual(byName.get('/dup')?.source, 'project');
        assert.strictEqual(byName.get('/dup')?.description, 'project skill.');

        assert.strictEqual(all.filter((c) => c.name === '/code-review').length, 1);
        assert.strictEqual(byName.get('/code-review')?.description, 'project command.');
        assert.strictEqual(byName.get('/code-review')?.filePath, join(cwd, '.claude', 'commands', 'code-review.md'));
      } finally {
        restore();
      }
    });
  });
});
