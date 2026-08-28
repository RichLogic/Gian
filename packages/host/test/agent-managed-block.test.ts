import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  removeManagedBlock,
} from '../src/onboarding/agent-instructions.js';

test('legacy instruction cleanup fails closed for missing or reversed markers', () => {
  const missing = `${MANAGED_BLOCK_BEGIN}\nstale without close\n`;
  assert.equal(removeManagedBlock(missing), missing);
  const reversed = `${MANAGED_BLOCK_END}\nuser note\n${MANAGED_BLOCK_BEGIN}\n`;
  assert.equal(removeManagedBlock(reversed), reversed);
});
