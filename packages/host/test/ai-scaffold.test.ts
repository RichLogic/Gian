// Coverage for traceability rows:
//   AI-SCAFFOLD-001 — sharded .ai/ layout: dirs, gian-task playbooks, gitignore,
//                     back-compat legacy files, idempotent + non-destructive.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAiDir } from '../src/workspace/ai-scaffold.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gian-scaffold-'));
}

test('AI-SCAFFOLD-001: creates shard dirs + gian-task playbooks', () => {
  const dir = tmp();
  try {
    scaffoldAiDir(dir);
    for (const sub of ['.ai/sessions', '.ai/log', '.ai/gian-task']) {
      assert.ok(statSync(join(dir, sub)).isDirectory(), `missing dir ${sub}`);
    }
    // .ai/.history is NOT scaffolded — it is created lazily by backups.
    assert.ok(!existsSync(join(dir, '.ai/.history')), '.history must not be pre-created');
    for (const f of ['SKILL.md', 'individual.md', 'engineer.md', 'pm.md']) {
      const abs = join(dir, '.ai/gian-task', f);
      assert.ok(existsSync(abs), `missing playbook ${f}`);
      assert.ok(readFileSync(abs, 'utf8').length > 0, `empty playbook ${f}`);
    }
    // The role headers reference these files; the INDIVIDUAL playbook must name
    // the shard-write rule.
    assert.match(readFileSync(join(dir, '.ai/gian-task/individual.md'), 'utf8'), /INDIVIDUAL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI-SCAFFOLD-001: keeps legacy single-file scaffold (back-compat)', () => {
  const dir = tmp();
  try {
    scaffoldAiDir(dir);
    for (const f of ['.ai/MEMORY.md', '.ai/STATE.md', '.ai/HANDOFF.md', '.ai/SESSION_LOG.md']) {
      assert.ok(existsSync(join(dir, f)), `missing legacy file ${f}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI-SCAFFOLD-001: gitignores derived paths but not MEMORY/legacy', () => {
  const dir = tmp();
  try {
    scaffoldAiDir(dir);
    const ignore = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').map(l => l.trim());
    for (const line of ['CLAUDE.local.md', '.ai/sessions/', '.ai/log/', '.ai/.history/', '.ai/STATE.view.md', '.ai/gian-task/']) {
      assert.ok(ignore.includes(line), `expected gitignore line ${line}`);
    }
    // MEMORY / legacy single-files stay committable (plane-A portable truth).
    assert.ok(!ignore.includes('.ai/MEMORY.md'));
    assert.ok(!ignore.includes('.ai/'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI-SCAFFOLD-001: non-destructive to user content, idempotent, no dup gitignore', () => {
  const dir = tmp();
  try {
    scaffoldAiDir(dir);
    // User owns MEMORY — a second scaffold must NOT overwrite it.
    const mem = join(dir, '.ai/MEMORY.md');
    writeFileSync(mem, '# my memory\nkeep me\n', 'utf8');
    // Playbooks are Gian-owned — a stale/edited one IS refreshed.
    const pm = join(dir, '.ai/gian-task/pm.md');
    writeFileSync(pm, 'STALE', 'utf8');

    assert.doesNotThrow(() => scaffoldAiDir(dir));

    assert.equal(readFileSync(mem, 'utf8'), '# my memory\nkeep me\n', 'MEMORY overwritten');
    assert.notEqual(readFileSync(pm, 'utf8'), 'STALE', 'playbook not refreshed');
    assert.match(readFileSync(pm, 'utf8'), /ROLE: PM/);

    // Gitignore lines are not duplicated across repeated calls.
    scaffoldAiDir(dir);
    const body = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter(l => l.trim());
    const counts = new Map<string, number>();
    for (const l of body) counts.set(l.trim(), (counts.get(l.trim()) ?? 0) + 1);
    for (const [line, n] of counts) assert.equal(n, 1, `duplicate gitignore line ${line}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
