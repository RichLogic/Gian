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

test('DSH 0.1.5 transient assistant streams preserve identity and reject duplicate or foreign frames', async () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  const agent = {
    id: 'native-stream', status: 'idle', session: { id: 'native-stream', events: [] }, ctx: {},
    cancel: () => undefined, whenIdle: async () => undefined,
    followup: () => undefined, steer: () => undefined,
  };
  const host = new CordisDshHost({
    agents: { create: async (options: { sessionId: string }) => {
      agent.id = options.sessionId;
      agent.session.id = options.sessionId;
      return { agent, dispose: async () => undefined };
    } },
    llm: {
      listProviders: () => [{ id: 'deepseek' }],
      listModels: async () => [{ id: 'flash', provider: 'deepseek' }],
    },
    on: (name: string, listener: (...args: unknown[]) => unknown, options?: { global?: boolean }) => {
      if (name === 'agent/assistant-stream') assert.deepEqual(options, { global: true });
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  } as never, '0.1.4');
  host.attachSink(event => emitted.push(event));
  try {
    await host.sessionCreate({ sessionId: 'gian-stream', cwd: '/tmp', roots: ['/tmp'], config: {} });
    const send = (frame: Record<string, unknown>, source = agent) => listeners.get('agent/assistant-stream')?.({ agent: source, frame });
    const start = { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 0, step: 0 };
    const chunk = { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'hello' } };
    send(start);
    send(chunk);
    send(chunk);
    send({ ...chunk, index: 1 }, { ...agent, session: { id: 'foreign', events: [] } });
    send({ type: 'end', attemptId: 'attempt-1', revision: 3, index: 1, outcome: { kind: 'committed', seq: 9 } });
    send(start);
    send({ ...chunk, index: 1 });
    const streams = emitted.filter(event => event.method === 'session.event' && event.params.type === 'assistant/chunk');
    assert.equal(streams.length, 1);
    assert.deepEqual(streams[0]?.params, {
      sessionId: 'gian-stream', type: 'assistant/chunk', data: {
        turn: 0, step: 0, liveAttemptId: 'attempt-1', liveChunkIndex: 0,
        chunk: { type: 'text-delta', index: 0, text: 'hello' },
      },
    });
  } finally {
    await host.dispose();
  }
});

test('real Cordis host catalog projects registered providers, models, and DSH modes', async () => {
  const mountedPresets: string[] = [];
  const host = new CordisDshHost({
    llm: {
      listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }],
      listModels: async () => [{
        id: 'deepseek-v4-flash',
        provider: 'opencode-go',
        name: 'DeepSeek V4 Flash',
      }],
    },
    approval: {
      config: { policy: 'ask' },
      setPolicy: () => undefined,
    },
    permissionPresets: {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      resolve: (id: string) => id === 'danger-full-access'
        ? { sandbox: 'danger-full-access', approval: 'never' }
        : { sandbox: 'workspace-write', approval: 'ask' },
      optionOf: (id: string) => ({
        value: id,
        name: id,
        description: id === 'danger-full-access'
          ? 'Full file access without approval prompts.'
          : 'Write inside the workspace; wider retries require approval.',
      }),
      set: () => undefined,
    },
    agentPresets: {
      defaultId: 'standard',
      list: async () => [
        { id: 'standard', name: 'Standard', description: 'Full coding Agent', trust: 'system' },
        { id: 'code', name: 'PTC', trust: 'system' },
        { id: 'broken', name: 'Broken', broken: 'invalid composition', trust: 'user' },
      ],
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      mount: async (_ctx: unknown, id?: string) => {
        mountedPresets.push(id ?? 'standard');
        return { id: id ?? 'standard' };
      },
    },
    on: () => () => true,
  }, '0.1.0');

  const catalog = await host.catalogList();
  assert.deepEqual(catalog.providers, [{ id: 'opencode-go', label: 'OpenCode Go' }]);
  assert.deepEqual(catalog.models, [{
    id: 'deepseek-v4-flash',
    provider: 'opencode-go',
    label: 'DeepSeek V4 Flash',
  }]);
  assert.deepEqual(catalog.approvalPolicies, [
    { id: 'ask', label: 'Ask' },
    { id: 'never', label: 'Never' },
  ]);
  assert.equal(catalog.defaultApprovalPolicy, 'ask');
  assert.deepEqual(catalog.permissionPresets, [
    {
      id: 'workspace-write',
      label: 'Workspace Write',
      description: 'Write inside the workspace; wider retries require approval.',
      approvalPolicy: 'ask',
    },
    {
      id: 'danger-full-access',
      label: 'Full access',
      description: 'Full file access without approval prompts.',
      approvalPolicy: 'never',
    },
  ]);
  assert.equal(catalog.defaultPermissionPreset, 'workspace-write');
  assert.equal(catalog.defaultAgentPreset, 'standard');
  assert.deepEqual(catalog.agentPresets, [
    {
      id: 'standard',
      label: 'Standard',
      description: 'Full coding Agent',
      trust: 'system',
    },
    { id: 'code', label: 'PTC', trust: 'system' },
    {
      id: 'broken',
      label: 'Broken',
      trust: 'user',
      broken: 'invalid composition',
    },
  ]);
  assert.deepEqual(mountedPresets, [], 'Catalog enumeration must not mount a preset');
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
  const mountedPresets: string[] = [];
  let createCalled = false;
  const nativeSessionId = 'session-owned-by-gian';
  const agentContext = { on: () => () => true, agent: undefined as unknown };
  const agent = {
    id: nativeSessionId,
    status: 'idle' as const,
    session: {
      id: nativeSessionId,
      header: { createdAt: 1_700_000_000_000, agentPreset: 'standard' },
      events: [],
    },
    ctx: agentContext,
    cancel: () => undefined,
    whenIdle: async () => undefined,
    followup: () => undefined,
    steer: () => undefined,
  };
  agentContext.agent = agent;
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
    agentPresets: {
      defaultId: 'code',
      list: async () => [{ id: 'standard' }, { id: 'code' }],
      resolve: async (id?: string) => ({ id: id ?? 'code' }),
      mount: async (_ctx: unknown, id?: string) => {
        mountedPresets.push(id ?? 'code');
        return { id: id ?? 'code' };
      },
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
  assert.deepEqual(mountedPresets, ['standard']);
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

test('latest DSH turn config selects the advertised model, effort, and permission preset', async () => {
  const waterfalls = new Map<string, (...args: unknown[]) => unknown>();
  const followed: Array<Record<string, unknown>> = [];
  const policies: string[] = [];
  const permissionPresets: string[] = [];
  const presetResolutions: string[] = [];
  const presetMounts: string[] = [];
  let createdMeta: Record<string, unknown> | undefined;
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
      create: async (options: { meta?: Record<string, unknown>; setup?: (ctx: unknown) => void }) => {
        createdMeta = options.meta;
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
    approval: {
      config: { policy: 'ask' as const },
      setPolicy: (_agent: unknown, policy: string) => policies.push(policy),
    },
    permissionPresets: {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      resolve: (id: string) => id === 'danger-full-access'
        ? { sandbox: 'danger-full-access', approval: 'never' as const }
        : { sandbox: 'workspace-write', approval: 'ask' as const },
      optionOf: (id: string) => ({ value: id, name: id }),
      set: (_session: unknown, id: string) => permissionPresets.push(id),
    },
    agentPresets: {
      defaultId: 'standard',
      list: async () => [{ id: 'standard', name: 'Standard' }],
      resolve: async (id?: string) => {
        presetResolutions.push(id ?? 'standard');
        return { id: id ?? 'standard' };
      },
      mount: async (_ctx: unknown, id?: string) => {
        presetMounts.push(id ?? 'standard');
        return { id: id ?? 'standard' };
      },
    },
    on: () => () => true,
  };
  const host = new CordisDshHost(rootContext as never, '0.1.1');
  await host.sessionCreate({
    sessionId: 'gian-agent',
    cwd: '/tmp',
    roots: ['/tmp'],
    config: { agent_preset: 'standard' },
  });
  assert.deepEqual(createdMeta, { cwd: '/tmp', agentPreset: 'standard' });
  assert.deepEqual(presetResolutions, ['standard']);
  assert.deepEqual(presetMounts, ['standard']);
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
      permission_preset: 'danger-full-access',
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
  assert.deepEqual(permissionPresets, ['danger-full-access']);
  assert.deepEqual(policies, []);
  assert.equal(followed.length, 1);
});

test('real Cordis host bridges an ask approval to interaction.respond', async () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const emitted: Array<{ method: string; params: Record<string, unknown> }> = [];
  const agentContext = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => true;
    },
  };
  const agent = {
    id: 'native-approval',
    status: 'idle' as const,
    session: { id: 'native-approval', header: { createdAt: Date.now() }, events: [] },
    ctx: agentContext,
    cancel: () => undefined,
    whenIdle: async () => undefined,
    followup: () => undefined,
    steer: () => undefined,
  };
  const approval = {
    config: { policy: 'ask' as const },
    setPolicy: () => undefined,
  };
  const host = new CordisDshHost({
    agents: {
      create: async (options: { setup?: (ctx: unknown) => void | Promise<void> }) => {
        await options.setup?.(agentContext);
        return { agent, dispose: async () => undefined };
      },
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official' }],
    },
    approval,
    agentPresets: {
      defaultId: 'standard',
      list: async () => [{ id: 'standard', name: 'Standard' }],
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      mount: async () => ({ id: 'standard' }),
    },
    on: () => () => true,
  } as never, '0.1.3');
  host.attachSink(event => emitted.push(event));
  const initialized = await host.initialize() as { capabilities: Record<string, number> };
  assert.equal(initialized.capabilities.interaction, 1);
  await host.sessionCreate({
    sessionId: 'gian-approval',
    cwd: '/tmp',
    roots: ['/tmp'],
    config: { agent_preset: 'standard' },
  });

  const answerer = listeners.get('approval/request');
  assert.ok(answerer);
  const answer = answerer({
    agent,
    toolName: 'bash',
    reason: 'Run tests',
  }, async () => 'unavailable') as Promise<string>;
  const requested = emitted.find(event => event.method === 'interaction.requested');
  assert.ok(requested);
  assert.equal(requested.params.sessionId, 'gian-approval');
  assert.deepEqual(requested.params.actions, [
    { id: 'allow-once', label: 'Allow once', style: 'primary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
  ]);

  await host.interactionRespond({
    sessionId: 'gian-approval',
    interactionId: String(requested.params.interactionId),
    actionId: 'allow-once',
    values: {},
  });
  assert.equal(await answer, 'allowed-once');
  assert.ok(emitted.some(event => event.method === 'interaction.resolved'));
});

test('permission presets that require approval are hidden without an interaction answerer', async () => {
  const host = new CordisDshHost({
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official' }],
    },
    approval: {
      config: { policy: 'ask' },
      setPolicy: () => undefined,
    },
    permissionPresets: {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      resolve: (id: string) => id === 'danger-full-access'
        ? { sandbox: 'danger-full-access', approval: 'never' }
        : { sandbox: 'workspace-write', approval: 'ask' },
      optionOf: (id: string) => ({ value: id, name: id }),
      set: () => undefined,
    },
  }, '0.1.3');

  const initialized = await host.initialize() as { capabilities: Record<string, number> };
  assert.equal(initialized.capabilities.interaction, undefined);
  const catalog = await host.catalogList();
  assert.deepEqual(catalog.approvalPolicies, [{ id: 'never', label: 'Never' }]);
  assert.equal(catalog.defaultApprovalPolicy, 'never');
  assert.deepEqual(catalog.permissionPresets, [{
    id: 'danger-full-access',
    label: 'Full access',
    approvalPolicy: 'never',
  }]);
  assert.equal(catalog.defaultPermissionPreset, undefined);
});

test('missing optional Cordis services remain absent when ctx.get rejects uninjected names', async () => {
  const host = new CordisDshHost({
    get: (name: string) => {
      if (name === 'llm') {
        return {
          listProviders: () => [{ id: 'deepseek-official' }],
          listModels: async () => [{ id: 'deepseek-chat', provider: 'deepseek-official' }],
        };
      }
      throw new Error(`cannot get property ${name} without inject`);
    },
  }, '0.1.3');

  const initialized = await host.initialize() as { capabilities: Record<string, number> };
  assert.equal(initialized.capabilities.interaction, undefined);
  const catalog = await host.catalogList();
  assert.deepEqual(catalog.approvalPolicies, []);
  assert.deepEqual(catalog.permissionPresets, []);
  assert.deepEqual(catalog.agentPresets, []);
  assert.equal(catalog.defaultAgentPreset, undefined);
});
