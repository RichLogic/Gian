import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentHomeError, AgentHomeManager, providerHomeEnvironment } from '../src/agents/home.js';

test('managed Agent HOMEs are stable, private, and separated by Agent id', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new AgentHomeManager(root);
  const first = await manager.createManaged('claude', 'agent-1');
  const second = await manager.createManaged('claude', 'agent-2');
  assert.deepEqual(first, { kind: 'managed', path: join(root, 'homes', 'claude', 'agent-1') });
  assert.notEqual(first.path, second.path);
  assert.equal((await stat(first.path)).mode & 0o777, 0o700);
  await assert.rejects(
    manager.createManaged('com.zhipu.zcode', 'agent-3'),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_UNSUPPORTED',
  );
});

test('custom Agent HOME must exist, be a directory, and not overlap another Agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-custom-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new AgentHomeManager(join(root, 'data'));
  const custom = join(root, 'custom');
  await mkdir(custom, { mode: 0o700 });
  assert.deepEqual(await manager.validateCustom(custom, []), { kind: 'custom', path: await realpath(custom) });
  await assert.rejects(
    manager.validateCustom(join(root, 'missing'), []),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_MISSING',
  );
  await assert.rejects(
    manager.validateCustom(join(custom, 'child'), [{ agentId: 'first', path: custom }]),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_MISSING',
  );
  const child = join(custom, 'child');
  await mkdir(child);
  await assert.rejects(
    manager.validateCustom(child, [{ agentId: 'first', path: custom }]),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_IN_USE',
  );
  await chmod(custom, 0o700);
});

test('Provider HOME environment changes state roots without changing process HOME', () => {
  assert.deepEqual(providerHomeEnvironment('claude', '/tmp/a'), { CLAUDE_CONFIG_DIR: '/tmp/a' });
  assert.deepEqual(providerHomeEnvironment('codex', '/tmp/b'), { CODEX_HOME: '/tmp/b' });
  assert.deepEqual(providerHomeEnvironment('kimi', '/tmp/c'), { KIMI_CODE_HOME: '/tmp/c' });
  assert.deepEqual(providerHomeEnvironment('grok', '/tmp/d'), { GROK_HOME: '/tmp/d' });
  assert.deepEqual(providerHomeEnvironment('ai.deepseek.harness', '/tmp/e'), { DSH_HOME: '/tmp/e' });
  assert.deepEqual(providerHomeEnvironment('com.zhipu.zcode', '/tmp/z'), {});
});
