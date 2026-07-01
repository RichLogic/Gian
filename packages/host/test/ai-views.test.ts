// Coverage for traceability rows:
//   AI-VIEW-001 — host merges .ai/sessions/<id>.state.md shards into STATE.view.md;
//                 read-on-dirty regeneration (mtime-based).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  regenerateStateView,
  regenerateStateViewIfDirty,
  stateViewPath,
} from '../src/workspace/ai-views.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gian-views-'));
}

function writeShard(root: string, id: string, body: string): string {
  const dir = join(root, '.ai/sessions');
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${id}.state.md`);
  writeFileSync(abs, body, 'utf8');
  return abs;
}

test('AI-VIEW-001: empty workspace yields a placeholder view', () => {
  const dir = tmp();
  try {
    const view = regenerateStateView(dir);
    assert.equal(view, stateViewPath(dir));
    assert.match(readFileSync(view, 'utf8'), /No session shards yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI-VIEW-001: merges every shard into the view', () => {
  const dir = tmp();
  try {
    writeShard(dir, 'sessA', 'A is exploring auth');
    writeShard(dir, 'sessB', 'B refactored the parser');
    const body = readFileSync(regenerateStateView(dir), 'utf8');
    assert.match(body, /session sessA/);
    assert.match(body, /A is exploring auth/);
    assert.match(body, /session sessB/);
    assert.match(body, /B refactored the parser/);
    // Host-generated banner present (agents must not edit it).
    assert.match(body, /HOST-GENERATED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI-VIEW-001: regenerateStateViewIfDirty rebuilds only when stale', () => {
  const dir = tmp();
  try {
    const shard = writeShard(dir, 'sessA', 'first');
    // Missing view → dirty → regenerates.
    assert.equal(regenerateStateViewIfDirty(dir), true);

    // Make the view strictly newer than the shard → not dirty.
    const view = stateViewPath(dir);
    const older = new Date(Date.now() - 10_000);
    const newer = new Date(Date.now() - 5_000);
    utimesSync(shard, older, older);
    utimesSync(view, newer, newer);
    assert.equal(regenerateStateViewIfDirty(dir), false);

    // Touch the shard newer than the view → dirty again.
    const newest = new Date(Date.now());
    utimesSync(shard, newest, newest);
    assert.equal(regenerateStateViewIfDirty(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AI-VIEW-001: a new shard makes the view dirty', () => {
  const dir = tmp();
  try {
    writeShard(dir, 'sessA', 'a');
    regenerateStateView(dir);
    const view = stateViewPath(dir);
    // View freshly written — mark it clearly older, then add a brand-new shard.
    const past = new Date(Date.now() - 10_000);
    utimesSync(view, past, past);
    writeShard(dir, 'sessB', 'b');
    assert.equal(regenerateStateViewIfDirty(dir), true);
    assert.match(readFileSync(view, 'utf8'), /session sessB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
