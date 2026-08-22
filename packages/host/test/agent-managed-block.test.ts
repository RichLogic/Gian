import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  upsertManagedBlock,
} from '../src/onboarding/agent-instructions.js';

const ROOT = '/var/gian-unit';

test('buildManagedBlock wraps the root in Gian markers', () => {
  const block = buildManagedBlock(ROOT);
  assert.ok(block.startsWith(MANAGED_BLOCK_BEGIN));
  assert.ok(block.includes(MANAGED_BLOCK_END));
  assert.ok(block.includes(`${ROOT}/worktrees/`));
});

test('upsertManagedBlock appends when the end marker is missing', () => {
  const block = buildManagedBlock(ROOT);
  const existing = `${MANAGED_BLOCK_BEGIN}\nstale without close\n`;
  const next = upsertManagedBlock(existing, block);
  assert.ok(next.startsWith(existing));
  assert.ok(next.includes(block));
});

test('upsertManagedBlock appends when markers are reversed', () => {
  const block = buildManagedBlock(ROOT);
  const existing = `${MANAGED_BLOCK_END}\nuser note\n${MANAGED_BLOCK_BEGIN}\n`;
  const next = upsertManagedBlock(existing, block);
  assert.ok(next.startsWith(existing));
  assert.ok(next.includes(block));
});
