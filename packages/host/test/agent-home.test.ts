import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AgentHomeError,
  AgentHomeManager,
  agentLoginArgs,
  providerHomeEnvironment,
  providerRuntimeEnvironment,
} from '../src/agents/home.js';

test('managed Agent HOMEs are stable, private, and separated by Agent id', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new AgentHomeManager(root);
  const first = await manager.createManaged('claude', 'agent-1');
  const second = await manager.createManaged('claude', 'agent-2');
  assert.deepEqual(first, { kind: 'managed', path: join(root, 'homes', 'claude', 'agent-1') });
  assert.notEqual(first.path, second.path);
  assert.equal((await stat(first.path)).mode & 0o777, 0o700);
  const zcode = await manager.createManaged('com.zhipu.zcode', 'agent-3');
  assert.deepEqual(zcode, {
    kind: 'managed', path: join(root, 'homes', 'com.zhipu.zcode', 'agent-3', '.zcode'),
  });
});

test('native HOME defaults and login commands follow each supported CLI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-native-agent-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new AgentHomeManager(join(root, 'data'), join(root, 'user'));
  const cases = [
    ['claude', '.claude', ['auth', 'login']],
    ['codex', '.codex', ['login']],
    ['kimi', '.kimi-code', ['login']],
    ['grok', '.grok', ['login']],
    ['ai.deepseek.harness', '.dsh', null],
    ['com.zhipu.zcode', '.zcode', ['login']],
  ] as const;
  for (const [pluginId, directory, args] of cases) {
    const path = join(root, 'user', directory);
    assert.equal(manager.defaultPath(pluginId), path);
    assert.deepEqual(await manager.useDefault(pluginId, []), {
      kind: 'custom', path: await realpath(path),
    });
    assert.deepEqual(agentLoginArgs(pluginId), args);
    await assert.rejects(
      manager.useDefault(pluginId, [{ agentId: 'existing', path }]),
      (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_IN_USE',
    );
  }
  const alternateKimiHome = join(root, 'other-kimi-home');
  assert.equal(new AgentHomeManager(join(root, 'data'), join(root, 'user'), alternateKimiHome)
    .defaultPath('kimi'), alternateKimiHome);
  await assert.rejects(
    manager.validateCustom(join(root, 'other-zcode'), [], undefined, 'com.zhipu.zcode'),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_INVALID',
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
  // Every provider also receives the Host-provided constrained universal
  // GIAN_AGENT_HOME; per-provider variables are a compat bridge for Catalog
  // Proxies that predate the gate. Grok has migrated and maps it itself.
  assert.deepEqual(providerHomeEnvironment('claude', '/tmp/a'), {
    GIAN_AGENT_HOME: '/tmp/a',
    CLAUDE_CONFIG_DIR: '/tmp/a',
  });
  const defaultClaudeHome = join(homedir(), '.claude');
  assert.deepEqual(providerHomeEnvironment('claude', defaultClaudeHome), {
    GIAN_AGENT_HOME: defaultClaudeHome,
  });
  assert.deepEqual(providerRuntimeEnvironment('claude', defaultClaudeHome), {
    GIAN_AGENT_HOME: defaultClaudeHome,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
  });
  assert.deepEqual(providerRuntimeEnvironment('claude', '/tmp/a'), {
    GIAN_AGENT_HOME: '/tmp/a',
    CLAUDE_CONFIG_DIR: '/tmp/a',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
  });
  assert.deepEqual(providerHomeEnvironment('codex', '/tmp/b'), {
    GIAN_AGENT_HOME: '/tmp/b', CODEX_HOME: '/tmp/b',
  });
  assert.deepEqual(providerHomeEnvironment('kimi', '/tmp/c'), {
    GIAN_AGENT_HOME: '/tmp/c', KIMI_CODE_HOME: '/tmp/c',
  });
  assert.deepEqual(providerHomeEnvironment('grok', '/tmp/d'), {
    GIAN_AGENT_HOME: '/tmp/d',
  }, 'grok maps GIAN_AGENT_HOME inside its Proxy; no GROK_HOME from the Host');
  assert.deepEqual(providerHomeEnvironment('ai.deepseek.harness', '/tmp/e'), {
    GIAN_AGENT_HOME: '/tmp/e', DSH_HOME: '/tmp/e',
  });
  // ZCode's state root ends in .zcode; its CLI additionally receives the
  // parent of that root as its process HOME.
  assert.deepEqual(providerHomeEnvironment('com.zhipu.zcode', '/tmp/z/.zcode'), {
    GIAN_AGENT_HOME: '/tmp/z/.zcode', HOME: '/tmp/z',
  });
});

test('Claude default config scope is preserved when ~/.claude is a symlink', async t => {
  const userHome = await mkdtemp(join(tmpdir(), 'gian-claude-default-home-'));
  const previousHome = process.env.HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(userHome, { recursive: true, force: true });
  });
  const configHome = join(userHome, 'claude-config');
  await mkdir(configHome);
  await symlink(configHome, join(userHome, '.claude'));
  process.env.HOME = userHome;

  assert.deepEqual(providerHomeEnvironment('claude', await realpath(configHome)), {
    GIAN_AGENT_HOME: await realpath(configHome),
  });
  assert.deepEqual(providerHomeEnvironment('claude', join(userHome, 'other-claude')), {
    GIAN_AGENT_HOME: join(userHome, 'other-claude'),
    CLAUDE_CONFIG_DIR: join(userHome, 'other-claude'),
  });
});
