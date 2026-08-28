import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectManagedGianSkill,
  reconcileManagedGianSkill,
} from '../src/agents/managed-skill.ts';

const SKILL = `---
name: gian-session
description: Use Gian MCP only inside a Gian-managed Session.
---

# Gian Session
`;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

test('managed Gian Skill installs, upgrades, and stays idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-managed-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const source = join(root, 'source', 'SKILL.md');
  await mkdir(join(root, 'source'), { recursive: true });
  await writeFile(source, SKILL);

  const first = await reconcileManagedGianSkill(home, {
    name: 'gian-session', version: '0.2.8', path: source, sha256: digest(SKILL),
  });
  assert.equal(first.state, 'ready');
  assert.equal(first.changed, true);
  assert.equal(await readFile(join(first.path, 'SKILL.md'), 'utf8'), SKILL);

  const again = await reconcileManagedGianSkill(home, {
    name: 'gian-session', version: '0.2.8', path: source, sha256: digest(SKILL),
  });
  assert.equal(again.changed, false);
  assert.equal((await inspectManagedGianSkill(home, '0.2.8')).state, 'ready');

  const upgraded = `${SKILL}\nUpgrade.\n`;
  await writeFile(source, upgraded);
  const next = await reconcileManagedGianSkill(home, {
    name: 'gian-session', version: '0.2.9', path: source, sha256: digest(upgraded),
  });
  assert.equal(next.changed, true);
  assert.equal(await readFile(join(next.path, 'SKILL.md'), 'utf8'), upgraded);
});

test('managed Gian Skill never overwrites a user-owned collision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-managed-skill-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const target = join(home, '.agents', 'skills', 'gian-session');
  const source = join(root, 'SKILL.md');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), 'user content\n');
  await writeFile(source, SKILL);

  const result = await reconcileManagedGianSkill(home, {
    name: 'gian-session', version: '0.2.8', path: source, sha256: digest(SKILL),
  });
  assert.equal(result.state, 'conflict');
  assert.equal(result.changed, false);
  assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'user content\n');
});

test('managed Gian Skill rejects a changed source digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-managed-skill-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'SKILL.md');
  await writeFile(source, SKILL);
  const result = await reconcileManagedGianSkill(join(root, 'home'), {
    name: 'gian-session', version: '0.2.8', path: source, sha256: '0'.repeat(64),
  });
  assert.equal(result.state, 'invalid');
  assert.match(result.error ?? '', /digest/);
});
