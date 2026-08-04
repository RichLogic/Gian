// Coverage for PRD-v3 P2a — the gian-managed `.ai/` scaffold.
//
// Exercises `scaffoldAiDir` directly against a real temp dir:
//   • all `.ai/*` files + CLAUDE.local.md are created with their headers
//   • CLAUDE.local.md is appended to .gitignore exactly once
//   • re-running is idempotent: hand-edited content survives, no dup gitignore
//   • the user's CLAUDE.md / AGENTS.md are never touched

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAiDir } from '../src/workspace/index.js';

const AI_FILES = [
  '.ai/HANDOFF.md',
  '.ai/STATE.md',
  '.ai/MEMORY.md',
  '.ai/SESSION_LOG.md',
];

function makeWs(): string {
  return mkdtempSync(join(tmpdir(), 'gian-p2a-scaffold-'));
}

test('P2a: scaffold creates all .ai files + pointer + gitignore', () => {
  const ws = makeWs();
  try {
    scaffoldAiDir(ws);

    for (const rel of AI_FILES) {
      const abs = join(ws, rel);
      assert.ok(existsSync(abs), `${rel} should exist`);
      const body = readFileSync(abs, 'utf8');
      // Each .ai file carries its gian-managed header comment.
      assert.match(body, new RegExp(`gian:${rel.replace('.', '\\.')}`), `${rel} header`);
      assert.match(body, /加载策略/, `${rel} states a load policy`);
    }

    const pointer = join(ws, 'CLAUDE.local.md');
    assert.ok(existsSync(pointer), 'CLAUDE.local.md should exist');
    const pointerBody = readFileSync(pointer, 'utf8');
    assert.ok(pointerBody.split('\n').length <= 12, 'pointer is ≤10 content lines');
    assert.match(pointerBody, /\.ai\/HANDOFF\.md/, 'pointer references .ai files');

    const gitignore = readFileSync(join(ws, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').filter(l => l.trim() === 'CLAUDE.local.md');
    assert.equal(lines.length, 1, 'gitignore has exactly one CLAUDE.local.md line');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P2a: scaffold is idempotent and non-destructive', () => {
  const ws = makeWs();
  try {
    scaffoldAiDir(ws);

    // Hand-edit one .ai file and the pointer.
    const handoff = join(ws, '.ai/HANDOFF.md');
    const edited = '# Handoff\n\nDO NOT CLOBBER — edited by a prior subtask.\n';
    writeFileSync(handoff, edited, 'utf8');

    // Second run must NOT overwrite existing content nor dup the gitignore line.
    scaffoldAiDir(ws);

    assert.equal(readFileSync(handoff, 'utf8'), edited, 'edited HANDOFF preserved');

    const gitignore = readFileSync(join(ws, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n').filter(l => l.trim() === 'CLAUDE.local.md');
    assert.equal(lines.length, 1, 'no duplicate gitignore line after re-run');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P2a: scaffold never touches user CLAUDE.md / AGENTS.md', () => {
  const ws = makeWs();
  try {
    const claude = join(ws, 'CLAUDE.md');
    const agents = join(ws, 'AGENTS.md');
    writeFileSync(claude, '# user claude\n', 'utf8');
    writeFileSync(agents, '# user agents\n', 'utf8');

    scaffoldAiDir(ws);

    assert.equal(readFileSync(claude, 'utf8'), '# user claude\n', 'CLAUDE.md untouched');
    assert.equal(readFileSync(agents, 'utf8'), '# user agents\n', 'AGENTS.md untouched');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('P2a: scaffold appends to an existing .gitignore without clobbering', () => {
  const ws = makeWs();
  try {
    // Pre-existing .gitignore with no trailing newline — exercise the guard.
    writeFileSync(join(ws, '.gitignore'), 'node_modules\ndist', 'utf8');

    scaffoldAiDir(ws);

    const gitignore = readFileSync(join(ws, '.gitignore'), 'utf8');
    assert.match(gitignore, /node_modules/, 'existing entries preserved');
    assert.match(gitignore, /dist/, 'existing entries preserved');
    const lines = gitignore.split('\n').filter(l => l.trim() === 'CLAUDE.local.md');
    assert.equal(lines.length, 1, 'CLAUDE.local.md appended exactly once');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// Guard that an existing .ai subdir (e.g. partial prior scaffold) doesn't break.
test('P2a: scaffold tolerates a pre-existing .ai dir and partial files', () => {
  const ws = makeWs();
  try {
    mkdirSync(join(ws, '.ai'), { recursive: true });
    const memory = join(ws, '.ai/MEMORY.md');
    writeFileSync(memory, 'pre-existing memory\n', 'utf8');

    scaffoldAiDir(ws);

    assert.equal(readFileSync(memory, 'utf8'), 'pre-existing memory\n', 'existing MEMORY kept');
    assert.ok(existsSync(join(ws, '.ai/HANDOFF.md')), 'missing files still filled in');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
