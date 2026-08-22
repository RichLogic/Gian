import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agentInstructionTargets } from '../src/onboarding/agent-instructions.js';

test('agentInstructionTargets maps each agent onto an injected home', () => {
  const home = '/tmp/gian-unit-home';
  const targets = agentInstructionTargets(home);
  assert.deepEqual(
    targets.map((entry) => entry.agent),
    ['codex', 'claude', 'kimi', 'grok'],
  );
  assert.equal(targets.find((entry) => entry.agent === 'codex')?.path, join(home, '.codex', 'AGENTS.md'));
  assert.equal(targets.find((entry) => entry.agent === 'claude')?.path, join(home, '.claude', 'CLAUDE.md'));
  assert.equal(targets.find((entry) => entry.agent === 'kimi')?.path, join(home, '.kimi-code', 'AGENTS.md'));
  assert.equal(targets.find((entry) => entry.agent === 'grok')?.path, join(home, '.grok', 'AGENTS.md'));
});

test('agentInstructionTargets does not point at a shared mutable singleton', () => {
  const a = agentInstructionTargets('/tmp/a');
  const b = agentInstructionTargets('/tmp/b');
  assert.notEqual(a[0]!.path, b[0]!.path);
});
