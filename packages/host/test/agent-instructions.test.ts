import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  agentInstructionTargets,
  buildManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  syncAgentInstructionBlocks,
  upsertManagedBlock,
} from '../src/onboarding/agent-instructions.ts';

const ROOT = '/Users/test/Coding';

test('buildManagedBlock carries the workspace root and worktree convention', () => {
  const block = buildManagedBlock(ROOT);
  assert.ok(block.startsWith(MANAGED_BLOCK_BEGIN));
  assert.ok(block.trimEnd().endsWith(MANAGED_BLOCK_END));
  assert.ok(block.includes(`\`${ROOT}\``));
  assert.ok(block.includes(`${ROOT}/worktrees/`));
});

test('upsertManagedBlock creates content for a missing/empty file', () => {
  const block = buildManagedBlock(ROOT);
  assert.equal(upsertManagedBlock(null, block), `${block}\n`);
  assert.equal(upsertManagedBlock('', block), `${block}\n`);
  assert.equal(upsertManagedBlock('  \n', block), `${block}\n`);
});

test('upsertManagedBlock appends after existing user content', () => {
  const block = buildManagedBlock(ROOT);
  const existing = '# my rules\n\ndo things\n';
  const next = upsertManagedBlock(existing, block);
  assert.ok(next.startsWith(existing));
  assert.ok(next.includes(block));
});

test('upsertManagedBlock replaces a stale block in place', () => {
  const stale = buildManagedBlock('/old/root');
  const fresh = buildManagedBlock(ROOT);
  const existing = `# header\n\n${stale}\n\n# footer\n`;
  const next = upsertManagedBlock(existing, fresh);
  assert.ok(next.includes(fresh));
  assert.ok(!next.includes('/old/root'));
  assert.ok(next.startsWith('# header\n\n'));
  assert.ok(next.endsWith('\n\n# footer\n'));
});

test('upsertManagedBlock is idempotent', () => {
  const block = buildManagedBlock(ROOT);
  const once = upsertManagedBlock('# user\n', block);
  assert.equal(upsertManagedBlock(once, block), once);
});

test('syncAgentInstructionBlocks writes all three agent files under home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gian-agent-instructions-'));
  try {
    const written = await syncAgentInstructionBlocks(ROOT, home);
    assert.equal(written.length, agentInstructionTargets(home).length);
    for (const target of agentInstructionTargets(home)) {
      const content = await readFile(target.path, 'utf8');
      assert.ok(content.includes(buildManagedBlock(ROOT)), target.path);
    }
    // Second run is a no-op.
    assert.deepEqual(await syncAgentInstructionBlocks(ROOT, home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('syncAgentInstructionBlocks preserves user content around the block', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gian-agent-instructions-'));
  try {
    const codex = join(home, '.codex', 'AGENTS.md');
    await mkdir(dirname(codex), { recursive: true });
    await writeFile(codex, '# 我的规则\n\n保持这条。\n', 'utf8');
    // Nested mkdir must succeed for the other files.
    await syncAgentInstructionBlocks(ROOT, home);
    const content = await readFile(codex, 'utf8');
    assert.ok(content.startsWith('# 我的规则\n\n保持这条。\n'));
    assert.ok(content.includes(MANAGED_BLOCK_BEGIN));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
