import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CordisDshHost, dshVersionFromEntrypoint } from '../src/cordis-host.js';
import { signHostBinding } from '../src/host-binding.js';

test('DSH runtime version follows the real CLI entry behind an npm launcher symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dsh-version-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const packageDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const binDir = join(root, 'node_modules', '.bin');
  await Promise.all([
    mkdir(join(packageDir, 'lib'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(packageDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.1.1-rc.2',
    })),
    writeFile(join(packageDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n'),
  ]);
  const launcher = join(binDir, 'dsh');
  await symlink(join('..', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), launcher);

  assert.equal(dshVersionFromEntrypoint(launcher), '0.1.1-rc.2');
  assert.equal(dshVersionFromEntrypoint(join(root, 'missing')), null);
});

test('real Cordis host catalog projects registered providers and models', async () => {
  const host = new CordisDshHost({
    llm: {
      listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
      listModels: async () => [{
        id: 'deepseek-v4-flash',
        provider: 'opencode-go',
        name: 'DeepSeek V4 Flash',
      }],
    },
  }, '0.1.0');

  const catalog = await host.catalogList();
  assert.deepEqual(catalog.providers, [{ id: 'opencode-go', label: 'OpenCode Go' }]);
  assert.deepEqual(catalog.models, [{
    id: 'deepseek-v4-flash',
    provider: 'opencode-go',
    label: 'DeepSeek V4 Flash',
  }]);
});

test('first Catalog waits for late latest-DSH Provider registration', async () => {
  const providers = [{ id: 'deepseek-official', name: 'DeepSeek' }];
  let catalogChanged: (() => void) | undefined;
  const host = new CordisDshHost({
    llm: {
      listProviders: () => [...providers],
      listModels: async (provider: string) => [{
        id: 'deepseek-v4-flash',
        provider,
        name: 'DeepSeek V4 Flash',
      }],
    },
    on: (name: string, listener: () => void) => {
      if (name === 'llm/adapters-updated') catalogChanged = listener;
      return () => true;
    },
  } as never, '0.1.1');
  setTimeout(() => {
    providers.push({ id: 'opencode-go', name: 'OpenCode Go' });
    catalogChanged?.();
  }, 50);

  const catalog = await host.catalogList() as { providers: Array<{ id: string }> };
  assert.deepEqual(catalog.providers.map(provider => provider.id), [
    'deepseek-official',
    'opencode-go',
  ]);
});

test('real Cordis host resumes the exact authenticated Host-owned native session id', async () => {
  const hostBindingKey = 'test-host-binding-key';
  const resumed: Array<Record<string, unknown>> = [];
  let createCalled = false;
  const nativeSessionId = 'session-owned-by-gian';
  const agentContext = { on: () => () => true };
  const agent = {
    id: nativeSessionId,
    status: 'idle' as const,
    session: { id: nativeSessionId, header: { createdAt: 1_700_000_000_000 }, events: [] },
    ctx: agentContext,
    cancel: () => undefined,
    whenIdle: async () => undefined,
    followup: () => undefined,
    steer: () => undefined,
  };
  const host = new CordisDshHost({
    agents: {
      create: async () => {
        createCalled = true;
        return { agent, dispose: async () => undefined };
      },
      resume: async (options: Record<string, unknown>) => {
        resumed.push(options);
        (options.setup as ((ctx: unknown) => void) | undefined)?.(agentContext);
        return { agent, dispose: async () => undefined };
      },
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official' }],
    },
    on: () => () => true,
  } as never, '0.1.2', hostBindingKey);
  const request = {
    sessionId: 'gian-session',
    nativeSessionId,
    cwd: '/tmp/project',
    roots: ['/tmp/project'],
    config: {},
  };
  const result = await host.sessionCreate({
    ...request,
    hostBindingProof: signHostBinding(hostBindingKey, {
      pluginId: 'ai.deepseek.harness',
      sessionId: request.sessionId,
      nativeSessionId,
      cwd: request.cwd,
    }),
  }) as { session: { id: string; nativeId: string; createdAt: string } };

  assert.equal(createCalled, false);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]?.resumeSessionId, nativeSessionId);
  assert.deepEqual(resumed[0]?.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  });
  assert.equal(result.session.id, 'gian-session');
  assert.equal(result.session.nativeId, nativeSessionId);
  assert.equal(result.session.createdAt, new Date(1_700_000_000_000).toISOString());
});

test('real Cordis host rejects a foreign or conflicting native binding proof', async () => {
  const hostBindingKey = 'test-host-binding-key';
  const host = new CordisDshHost({
    agents: {
      create: async () => assert.fail('native attach must not create'),
      resume: async () => assert.fail('invalid proof must not resume'),
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official' }],
    },
    on: () => () => true,
  } as never, '0.1.2', hostBindingKey);

  await assert.rejects(() => host.sessionCreate({
    sessionId: 'gian-session',
    nativeSessionId: 'foreign-session',
    hostBindingProof: signHostBinding(hostBindingKey, {
      pluginId: 'ai.deepseek.harness',
      sessionId: 'different-gian-session',
      nativeSessionId: 'foreign-session',
      cwd: '/tmp/project',
    }),
    cwd: '/tmp/project',
    roots: ['/tmp/project'],
    config: {},
  }), /valid Host ownership proof/);
});

test('real Cordis host reports a missing persisted native Session canonically', async () => {
  const hostBindingKey = 'test-host-binding-key';
  const nativeSessionId = 'native-missing';
  const host = new CordisDshHost({
    agents: {
      create: async () => assert.fail('native attach must not create'),
      resume: async () => { throw new Error(`session "${nativeSessionId}" not found`); },
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official' }],
    },
    on: () => () => true,
  } as never, '0.1.2', hostBindingKey);
  const binding = {
    pluginId: 'ai.deepseek.harness',
    sessionId: 'gian-session',
    nativeSessionId,
    cwd: '/tmp/project',
  };

  await assert.rejects(() => host.sessionCreate({
    sessionId: binding.sessionId,
    nativeSessionId,
    hostBindingProof: signHostBinding(hostBindingKey, binding),
    cwd: binding.cwd,
    roots: [binding.cwd],
    config: {},
  }), (error: unknown) => (
    error instanceof Error
    && (error as Error & { domainCode?: string }).domainCode === 'NATIVE_SESSION_NOT_FOUND'
  ));
});

test('latest DSH turn config selects the advertised model, effort, and approval policy', async () => {
  const waterfalls = new Map<string, (...args: unknown[]) => unknown>();
  const followed: Array<Record<string, unknown>> = [];
  const policies: string[] = [];
  const agentContext = {
    get: (name: string) => name === 'approval' ? {
      setPolicy: (_agent: unknown, policy: string) => policies.push(policy),
    } : undefined,
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      waterfalls.set(name, listener);
      return () => true;
    },
  };
  const agent = {
    id: 'native-agent',
    status: 'idle' as const,
    session: { id: 'native-agent', header: { createdAt: Date.now() }, events: [] },
    ctx: agentContext,
    cancel: () => undefined,
    whenIdle: async () => undefined,
    followup: (message: Record<string, unknown>) => followed.push(message),
    steer: () => undefined,
  };
  const rootContext = {
    agents: {
      create: async (options: { setup?: (ctx: unknown) => void }) => {
        options.setup?.(agentContext);
        return { agent, dispose: async () => undefined };
      },
    },
    llm: {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'opencode-go', name: 'OpenCode Go' },
      ],
      listModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      resolveModelInfo: async (provider: string) => ({
        id: 'deepseek-v4-flash',
        provider,
        name: 'DeepSeek V4 Flash',
        reasoning: {
          efforts: [{ id: 'high', name: 'High' }],
          defaultEffort: 'high',
        },
      }),
      resolveCallConfig: async (config: Record<string, unknown>) => config,
    },
    on: () => () => true,
  };
  const host = new CordisDshHost(rootContext as never, '0.1.1');
  await host.sessionCreate({ sessionId: 'gian-agent', cwd: '/tmp', roots: ['/tmp'], config: {} });
  const catalog = await host.catalogList() as {
    models: Array<{ reasoning?: { defaultEffort?: string } }>;
  };
  assert.equal(catalog.models[0]?.reasoning?.defaultEffort, 'high');

  await host.turnStart({
    sessionId: 'gian-agent',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hello' }],
    config: {
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      effort: 'high',
      approval_policy: 'never',
    },
  });
  const assemble = waterfalls.get('system-prompt/assemble');
  const request = waterfalls.get('agent/request');
  assert.ok(assemble);
  assert.ok(request);
  const assembled = await assemble({}, {}, async () => ({ variables: { existing: true } })) as {
    variables: Record<string, unknown>;
  };
  assert.deepEqual(assembled.variables, {
    existing: true,
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
  });
  const resolved = await request({}, async () => ({
    provider: 'old-provider',
    model: 'old-model',
    reasoningEffort: 'low',
  })) as Record<string, unknown>;
  assert.deepEqual(resolved, {
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
  });
  assert.deepEqual(policies, ['never']);
  assert.equal(followed.length, 1);
});
