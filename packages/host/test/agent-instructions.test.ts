import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  agentInstructionTargets,
  buildManagedBlock,
  cleanupAgentInstructionBlocks,
  MANAGED_BLOCK_BEGIN,
  removeManagedBlock,
} from '../src/onboarding/agent-instructions.ts';

const ROOT = '/Users/test/Coding';

test('removeManagedBlock removes only the exact legacy Gian marker pair', () => {
  const before = `# user before\n\n${buildManagedBlock(ROOT)}\n\n# user after\n`;
  assert.equal(removeManagedBlock(before), '# user before\n\n\n\n# user after\n');
});

test('removeManagedBlock leaves malformed and unrelated user content untouched', () => {
  const missingEnd = `# user\n${MANAGED_BLOCK_BEGIN}\nstale\n`;
  assert.equal(removeManagedBlock(missingEnd), missingEnd);
  const plain = '# user rules\n';
  assert.equal(removeManagedBlock(plain), plain);
});

test('cleanupAgentInstructionBlocks cleans existing files and never creates missing targets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'gian-agent-instruction-cleanup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const targets = agentInstructionTargets(home);
  const codex = targets.find(target => target.agent === 'codex')!;
  await mkdir(dirname(codex.path), { recursive: true });
  await writeFile(codex.path, `# user\n${buildManagedBlock(ROOT)}\nkeep\n`);

  assert.deepEqual(await cleanupAgentInstructionBlocks(home), [codex.path]);
  assert.equal(await readFile(codex.path, 'utf8'), '# user\n\nkeep\n');
  assert.deepEqual(await cleanupAgentInstructionBlocks(home), []);

  for (const target of targets.filter(target => target.agent !== 'codex')) {
    await assert.rejects(readFile(target.path, 'utf8'), /ENOENT/);
  }
});
