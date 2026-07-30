import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CcProxyService, formatQuestionAnswers } from '../src/core/service.js';
import { AppError } from '../src/core/errors.js';
import { ClaudeMcpRuntime } from '../src/runtime/claude-mcp-runtime.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from '../src/runtime/types.js';
import {
  parseClaudeAssistantUsage,
  parseClaudeResultUsage,
  parseEffortLevelsFromHelp,
  isClaudeCompactBoundary,
  shouldRetryWithoutNoSessionPersistence,
} from '../src/runtime/claude-mcp-runtime.js';
import type { ModelCapabilities } from '../src/core/types.js';

class FakeRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  readonly spawnCalls: Array<{
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
    forkFromClaudeSessionId?: string;
  }> = [];
  readonly messages: Array<{
    sessionId: string;
    content: string;
    options?: {
      permissionMode?: import('../src/core/types.js').PermissionMode | null;
      effort?: import('../src/core/types.js').EffortLevel | null;
    };
  }> = [];
  readonly permissionResponses: Array<{
    sessionId: string;
    requestId: string;
    behavior: 'allow' | 'deny';
    extra?: { updatedInput?: Record<string, unknown>; message?: string };
  }> = [];
  readonly resetCalls: Array<{ sessionId: string; newClaudeSessionId: string }> = [];
  models: ModelCapabilities[] = [];
  private readonly aliveSessions = new Set<string>();
  started = false;
  stopped = false;

  async start(): Promise<number> {
    this.started = true;
    return 43123;
  }

  async spawnSession(options: {
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
    forkFromClaudeSessionId?: string;
  }): Promise<void> {
    this.spawnCalls.push(options);
    this.aliveSessions.add(options.sessionId);
  }

  async sendMessage(
    sessionId: string,
    content: string,
    options?: {
      permissionMode?: import('../src/core/types.js').PermissionMode | null;
      effort?: import('../src/core/types.js').EffortLevel | null;
    },
  ): Promise<void> {
    const entry: {
      sessionId: string;
      content: string;
      options?: {
        permissionMode?: import('../src/core/types.js').PermissionMode | null;
        effort?: import('../src/core/types.js').EffortLevel | null;
      };
    } = { sessionId, content };
    if (options !== undefined) entry.options = options;
    this.messages.push(entry);
  }

  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void {
    this.resetCalls.push({ sessionId, newClaudeSessionId });
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { updatedInput?: Record<string, unknown>; message?: string },
  ): Promise<void> {
    // Only include `extra` on the recorded row when present so existing
    // tests that deepEqual against `{sessionId, requestId, behavior}` keep
    // matching unchanged.
    const entry: {
      sessionId: string;
      requestId: string;
      behavior: 'allow' | 'deny';
      extra?: { updatedInput?: Record<string, unknown>; message?: string };
    } = { sessionId, requestId, behavior };
    if (extra !== undefined) entry.extra = extra;
    this.permissionResponses.push(entry);
  }

  killSession(sessionId: string): void {
    this.aliveSessions.delete(sessionId);
  }

  isSessionAlive(sessionId: string): boolean {
    return this.aliveSessions.has(sessionId);
  }

  getDetectedModelId(_sessionId: string): string | null {
    return null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.aliveSessions.clear();
  }

  getModels() {
    return this.models;
  }

  async awaitModelDiscovery() {
    /* no-op */
  }
}

test('parseEffortLevelsFromHelp reads Claude CLI choices without a Gian enum', () => {
  const help = `
Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session.
`;
  assert.deepEqual(parseEffortLevelsFromHelp(help), ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('shouldRetryWithoutNoSessionPersistence detects older Claude CLI rejection', () => {
  assert.equal(
    shouldRetryWithoutNoSessionPersistence("error: unknown option '--no-session-persistence'"),
    true,
  );
  assert.equal(
    shouldRetryWithoutNoSessionPersistence('authentication failed'),
    false,
  );
});

test('Claude compact boundary detection covers native auto-compaction signals', () => {
  assert.equal(isClaudeCompactBoundary({
    type: 'system',
    subtype: 'compact_boundary',
  }), true);
  assert.equal(isClaudeCompactBoundary({
    type: 'system',
    subtype: 'init',
  }), false);
});

test('Claude auto-compaction clears the pre-boundary context before result parsing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-proxy-compact-boundary-'));
  const fakeClaude = join(dir, 'claude');
  writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "console.log(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 180000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }));",
    "console.log(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: '', usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, modelUsage: { 'claude-opus-4-8': { inputTokens: 100, outputTokens: 25, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, contextWindow: 200000 } } }));",
  ].join('\n'));
  chmodSync(fakeClaude, 0o755);

  const oldClaudeBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = fakeClaude;
  const runtime = new ClaudeMcpRuntime();
  const usageEvents: Array<Record<string, unknown>> = [];
  runtime.on('tokenUsage', (_sessionId, usage) => {
    usageEvents.push(usage as unknown as Record<string, unknown>);
  });
  const exited = new Promise<void>((resolve) => {
    runtime.once('processExited', () => resolve());
  });

  try {
    await runtime.spawnSession({
      sessionId: 'session-auto-compact',
      claudeSessionId: '00000000-0000-4000-8000-000000000001',
      cwd: dir,
      model: null,
      isResume: false,
    });
    await runtime.sendMessage('session-auto-compact', 'continue', {
      permissionMode: 'bypassPermissions',
    });
    await exited;

    assert.deepEqual(usageEvents[0], {
      context: { used: 180_000 },
    });
    assert.deepEqual(usageEvents[1], {
      context: null,
      reason: 'compact_started',
    });
    assert.deepEqual(usageEvents[2], {
      conversation: {
        mode: 'delta',
        inputTokens: 1_100,
        outputTokens: 25,
        cachedInputTokens: 1_000,
        totalTokens: 1_125,
      },
    });
  } finally {
    await runtime.stop();
    if (oldClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = oldClaudeBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude -p native task lifecycle keeps Agent tool id and terminal summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-proxy-agent-task-'));
  const fakeClaude = join(dir, 'claude');
  writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'tool_use', id: 'tool-agent-1', name: 'Agent', input: { description: 'Inspect tests', prompt: 'Read tests' } }] } }));",
    "console.log(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-agent-1', description: 'Inspect tests', subagent_type: 'general-purpose' }));",
    "console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'tool-agent-1', status: 'completed', summary: 'Tests are clean.', output_file: '/tmp/task-1.output' }));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: '' }));",
  ].join('\n'));
  chmodSync(fakeClaude, 0o755);

  const oldClaudeBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = fakeClaude;
  const runtime = new ClaudeMcpRuntime();
  const toolUses: Array<{ name: string; callId: string }> = [];
  const agentUpdates: Array<Record<string, unknown>> = [];
  runtime.on('toolUse', (_sessionId, name, _input, callId) => {
    toolUses.push({ name, callId });
  });
  runtime.on('agentTask', (_sessionId, update) => {
    agentUpdates.push(update as unknown as Record<string, unknown>);
  });
  const exited = new Promise<void>(resolve => runtime.once('processExited', () => resolve()));

  try {
    await runtime.spawnSession({
      sessionId: 'session-agent',
      claudeSessionId: '00000000-0000-4000-8000-000000000002',
      cwd: dir,
      model: null,
      isResume: false,
    });
    await runtime.sendMessage('session-agent', 'delegate', {
      permissionMode: 'bypassPermissions',
    });
    await exited;

    assert.deepEqual(toolUses, [{ name: 'Agent', callId: 'tool-agent-1' }]);
    assert.equal(agentUpdates.length, 2);
    assert.deepEqual(agentUpdates[0], {
      taskId: 'task-1',
      toolUseId: 'tool-agent-1',
      status: 'running',
      description: 'Inspect tests',
      agentType: 'general-purpose',
      startedAt: agentUpdates[0]!.startedAt,
    });
    assert.deepEqual(agentUpdates[1], {
      taskId: 'task-1',
      toolUseId: 'tool-agent-1',
      status: 'done',
      description: 'Inspect tests',
      agentType: 'general-purpose',
      summary: 'Tests are clean.',
      outputFile: '/tmp/task-1.output',
      completedAt: agentUpdates[1]!.completedAt,
    });
  } finally {
    await runtime.stop();
    if (oldClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = oldClaudeBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude stream usage keeps current context separate from result aggregates', () => {
  const assistant = parseClaudeAssistantUsage({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8[1m]',
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 62_000,
        cache_creation_input_tokens: 880,
        output_tokens: 450,
      },
    },
  });
  assert.deepEqual(assistant, {
    context: { used: 63_000 },
    model: 'claude-opus-4-8[1m]',
  });

  const result = parseClaudeResultUsage({
    type: 'result',
    usage: {
      input_tokens: 200,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 1_000,
      output_tokens: 2_000,
    },
    modelUsage: {
      'claude-opus-4-8[1m]': {
        contextWindow: 1_000_000,
      },
    },
  }, assistant!.context, assistant!.model);
  assert.deepEqual(result, {
    context: { used: 63_000, window: 1_000_000 },
    conversation: {
      mode: 'delta',
      inputTokens: 91_200,
      outputTokens: 2_000,
      cachedInputTokens: 91_000,
      totalTokens: 93_200,
    },
  });
});

test('Claude result usage prefers whole-tree modelUsage over the top-level fallback', () => {
  const result = parseClaudeResultUsage({
    type: 'result',
    usage: {
      input_tokens: 5,
      output_tokens: 6,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 8,
    },
    modelUsage: {
      'claude-opus-4-8': {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 50,
        contextWindow: 1_000_000,
      },
      'claude-haiku-4-5': {
        inputTokens: 30,
        outputTokens: 10,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 5,
        contextWindow: 200_000,
      },
    },
  }, { used: 63_000 }, 'claude-opus-4-8');

  assert.deepEqual(result, {
    context: { used: 63_000, window: 1_000_000 },
    conversation: {
      mode: 'delta',
      inputTokens: 1_385,
      outputTokens: 30,
      cachedInputTokens: 1_255,
      totalTokens: 1_415,
    },
  });
});

test('capabilities discovery does not run claude -p unless explicitly opted in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-proxy-billing-safe-'));
  const fakeClaude = join(dir, 'claude');
  const marker = join(dir, 'print-mode-called');
  writeFileSync(fakeClaude, [
    '#!/bin/sh',
    `MARKER='${marker}'`,
    'for arg in "$@"; do',
    '  if [ "$arg" = "-p" ] || [ "$arg" = "--print" ]; then',
    '    echo hit > "$MARKER"',
    '    echo "unexpected print mode" >&2',
    '    exit 42',
    '  fi',
    'done',
    'if [ "$1" = "--help" ]; then',
    '  cat <<EOF',
    'Options:',
    '  --effort <level>                      Effort level for the current session',
    '                                        (low, medium, max)',
    'EOF',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeClaude, 0o755);

  const oldClaudeBin = process.env.CLAUDE_BIN;
  const oldAllowProbe = process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE;
  process.env.CLAUDE_BIN = fakeClaude;
  delete process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE;

  const service = new CcProxyService({ runtime: new ClaudeMcpRuntime() });
  try {
    await service.initialize();
    const caps = await service.listCapabilities();
    assert.equal(existsSync(marker), false, 'capabilities.list must not invoke claude print mode');
    // Static alias menu: Default (no --model) + opus/sonnet/haiku aliases.
    assert.equal(caps.models.length, 4);
    assert.equal(caps.models[0]!.id, 'claude-default');
    assert.equal(caps.models[0]!.model, '');
    assert.equal(caps.models[0]!.isDefault, true);
    assert.deepEqual(caps.models.map(m => m.model), ['', 'opus', 'sonnet', 'haiku']);
    // Every entry carries the same billing-safe effort list parsed from --help.
    for (const m of caps.models) {
      assert.deepEqual(m.supportedEfforts, ['low', 'medium', 'max']);
    }
  } finally {
    await service.close();
    if (oldClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = oldClaudeBin;
    if (oldAllowProbe === undefined) delete process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE;
    else process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE = oldAllowProbe;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withService(
  run: (ctx: {
    runtime: FakeRuntime;
    service: CcProxyService;
    events: Array<{ method: string; params: Record<string, unknown> }>;
  }) => Promise<void>,
) {
  const runtime = new FakeRuntime();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  const service = new CcProxyService({
    runtime,
    emitEvent(method, params) {
      events.push({ method, params });
    },
  });

  try {
    await service.initialize();
    await run({ runtime, service, events });
  } finally {
    await service.close();
  }
}

test('service rejects unsupported input types', async () => {
  await withService(async ({ service }) => {
    const created = await service.createSession({
      cwd: '/tmp',
    });

    await assert.rejects(
      service.startTurn({
        sessionId: created.session.id,
        input: [{ type: 'unknown', data: 'invalid' } as unknown as import('../src/core/types.js').InputItem],
      }),
      (error: unknown) => error instanceof AppError
        && error.code === 'INVALID_REQUEST'
        && error.message.includes('Unsupported input item type'),
    );
  });
});

test('service starts turns with the requested model and emits completion events', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({
      cwd: '/tmp',
    });

    // Stateless proxy: session response carries id + claudeSessionId, no
    // sessionKey field exists anywhere in the public surface.
    assert.ok(typeof created.session.id === 'string');
    assert.ok(typeof created.session.claudeSessionId === 'string');
    assert.equal((created.session as Record<string, unknown>).sessionKey, undefined);

    const started = await service.startTurn({
      sessionId: created.session.id,
      model: 'claude-sonnet-4',
      input: [
        { type: 'text', text: 'alpha' },
        { type: 'text', text: 'beta' },
      ],
    }, 'req-1');

    assert.equal(started.turn.status, 'running');
    assert.equal(runtime.spawnCalls.length, 1);
    assert.equal(runtime.spawnCalls[0]!.model, 'claude-sonnet-4');
    // Host did not pass claudeSessionId at create — first spawn must be fresh
    // (not --resume) so the JSONL is created from scratch.
    assert.equal(runtime.spawnCalls[0]!.isResume, false);
    assert.equal(runtime.messages.length, 1);
    assert.equal(runtime.messages[0]!.content, 'alpha\n\nbeta');

    runtime.emit('channelReply', created.session.id, 'done');

    const snapshot = service.sessionSnapshot({ sessionId: created.session.id });
    assert.equal(snapshot.session.status, 'idle');
    assert.equal(snapshot.session.model, 'claude-sonnet-4');
    assert.equal((snapshot.session as Record<string, unknown>).sessionKey, undefined);

    assert.deepEqual(events.map((event) => event.method), [
      'turn.started',
      'output.text',
      'turn.completed',
    ]);
    // No event payload should carry a sessionKey field anymore.
    for (const ev of events) {
      assert.equal((ev.params as Record<string, unknown>).sessionKey, undefined);
    }
    assert.equal((events[1]!.params.data as { text: string }).text, 'done');
    assert.equal((events[2]!.params.data as { status: string }).status, 'completed');
  });
});

test('service forwards a sidechat parent into the first Claude fork spawn', async () => {
  await withService(async ({ runtime, service }) => {
    const created = await service.createSession({
      cwd: '/tmp/parent-worktree',
      forkFromClaudeSessionId: 'claude-parent-1',
    });

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'side question' }],
    }, 'req-sidechat');

    assert.equal(runtime.spawnCalls.length, 1);
    assert.equal(runtime.spawnCalls[0]!.cwd, '/tmp/parent-worktree');
    assert.equal(runtime.spawnCalls[0]!.forkFromClaudeSessionId, 'claude-parent-1');
    assert.equal(runtime.spawnCalls[0]!.isResume, false);
  });
});

test('service forwards native Agent lifecycle without changing provider metadata', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({ cwd: '/tmp' });
    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'delegate' }],
    }, 'req-agent');

    runtime.emit('toolUse', created.session.id, 'Agent', {
      description: 'Inspect tests',
    }, 'tool-agent-1');
    runtime.emit('agentTask', created.session.id, {
      taskId: 'task-1',
      toolUseId: 'tool-agent-1',
      description: 'Inspect tests',
      agentType: 'general-purpose',
      status: 'running',
      startedAt: 100,
    });
    runtime.emit('agentTask', created.session.id, {
      taskId: 'task-1',
      toolUseId: 'tool-agent-1',
      status: 'done',
      summary: 'Tests are clean.',
      completedAt: 200,
    });

    const tool = events.find(event => event.method === 'tool.use');
    assert.deepEqual(tool?.params.data, {
      callId: 'tool-agent-1',
      toolName: 'Agent',
      input: { description: 'Inspect tests' },
    });
    const updates = events.filter(event => event.method === 'claude.task');
    assert.equal(updates.length, 2);
    assert.equal((updates[0]!.params.data as { agentType?: unknown }).agentType, 'general-purpose');
    assert.equal((updates[1]!.params.data as { summary?: unknown }).summary, 'Tests are clean.');
  });
});

test('service does not guess a Claude context window without an explicit capacity', async () => {
  await withService(async ({ runtime, service, events }) => {
    const ordinary = await service.createSession({
      cwd: '/tmp',
      model: 'claude-opus-4-8',
    });
    runtime.emit('tokenUsage', ordinary.session.id, {
      context: { used: 63_000 },
    });
    assert.deepEqual(events.at(-1)?.params.data, {
      context: { used: 63_000 },
    });

    const extended = await service.createSession({
      cwd: '/tmp',
      model: 'claude-opus-4-8[1m]',
    });
    runtime.emit('tokenUsage', extended.session.id, {
      context: { used: 63_000 },
    });
    assert.deepEqual(events.at(-1)?.params.data, {
      context: { used: 63_000, window: 1_000_000 },
    });
  });
});

test('Claude /compact invalidates context and rejects compact-turn context samples', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({ cwd: '/tmp' });
    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: '/compact' }],
    }, 'req-compact');

    assert.deepEqual(events.map(event => event.method), [
      'token_usage.updated',
      'turn.started',
    ]);
    assert.deepEqual(events[0]!.params.data, {
      context: null,
      reason: 'compact_started',
    });
    assert.equal(events[0]!.params.turnId, events[1]!.params.turnId);

    runtime.emit('tokenUsage', created.session.id, {
      context: { used: 190_000, window: 200_000 },
    });
    assert.equal(
      events.filter(event => event.method === 'token_usage.updated').length,
      1,
      'the compaction request must not refill context with its own input size',
    );

    runtime.emit('tokenUsage', created.session.id, {
      context: { used: 190_000, window: 200_000 },
      conversation: { mode: 'delta', totalTokens: 1_200 },
    });
    assert.deepEqual(events.at(-1)?.params.data, {
      conversation: { mode: 'delta', totalTokens: 1_200 },
    });

    runtime.emit('channelReply', created.session.id, '');
    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'next turn' }],
    });
    runtime.emit('tokenUsage', created.session.id, {
      context: { used: 32_000, window: 200_000 },
    });
    assert.deepEqual(events.at(-1)?.params.data, {
      context: { used: 32_000, window: 200_000 },
    });
  });
});

test('service forwards only effort levels discovered from Claude capabilities', async () => {
  await withService(async ({ runtime, service }) => {
    runtime.models = [{
      id: 'claude-current',
      model: 'claude-current',
      displayName: 'claude-current',
      description: '',
      hidden: false,
      isDefault: true,
      defaultEffort: null,
      supportedEfforts: ['low', 'dynamic'],
    }];
    const created = await service.createSession({
      cwd: '/tmp',
      model: 'claude-current',
    });

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'supported effort' }],
      thinking: 'dynamic',
    });
    assert.equal(runtime.messages[0]!.options?.effort, 'dynamic');

    runtime.emit('channelReply', created.session.id, 'done');

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'unsupported effort' }],
      thinking: 'off',
    });
    assert.equal(runtime.messages[1]!.options?.effort, null);
  });
});

test('service uses --resume when host supplies a claudeSessionId at create time', async () => {
  await withService(async ({ runtime, service }) => {
    const adoptedNativeId = '11111111-2222-3333-4444-555555555555';
    const created = await service.createSession({
      cwd: '/tmp',
      claudeSessionId: adoptedNativeId,
    });
    assert.equal(created.session.claudeSessionId, adoptedNativeId);

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'continue from disk' }],
    }, 'req-resume');

    assert.equal(runtime.spawnCalls.length, 1);
    assert.equal(runtime.spawnCalls[0]!.isResume, true);
    assert.equal(runtime.spawnCalls[0]!.claudeSessionId, adoptedNativeId);
  });
});

test('service relays approval requests and process failures', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({
      cwd: '/tmp',
    });

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'needs approval' }],
    }, 'req-2');

    runtime.emit('permissionRequest', created.session.id, 'perm-1', 'exec', 'run command', 'ls -la');

    const approvalEvent = events.find((event) => event.method === 'approval.requested');
    assert.ok(approvalEvent);
    const approvalId = (approvalEvent!.params.data as { approvalId: string }).approvalId;
    // approval payload itself no longer carries sessionKey
    assert.equal((approvalEvent!.params.data as Record<string, unknown>).sessionKey, undefined);

    const pendingSnapshot = service.sessionSnapshot({ sessionId: created.session.id });
    assert.equal(pendingSnapshot.session.status, 'needs-approval');

    const approved = await service.respondApproval({
      sessionId: created.session.id,
      approvalId,
      behavior: 'allow',
    });
    assert.equal(approved.session.status, 'running');
    assert.deepEqual(runtime.permissionResponses, [
      {
        sessionId: created.session.id,
        requestId: 'perm-1',
        behavior: 'allow',
      },
    ]);

    runtime.emit('processExited', created.session.id, 9, null);

    const failedSnapshot = service.sessionSnapshot({ sessionId: created.session.id });
    assert.equal(failedSnapshot.session.status, 'error');
    assert.match(failedSnapshot.session.lastError ?? '', /code=9/);
    assert.ok(events.some((event) => event.method === 'approval.resolved'));
    assert.ok(events.some((event) => event.method === 'turn.failed'));
  });
});

test('ExitPlanMode permission request is tagged category=exit_plan_mode and resolves through MCP', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({ cwd: '/tmp' });

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'plan something' }],
    }, 'req-plan');

    // Claude's SDK fires canUseTool for ExitPlanMode → cc-proxy's permission
    // MCP bridge emits permissionRequest. The approval must carry the
    // category tag so the host renders the plan card.
    const planJson = JSON.stringify({ plan: 'Step 1: do X\nStep 2: do Y' });
    runtime.emit(
      'permissionRequest',
      created.session.id,
      'callid-exit-plan',
      'ExitPlanMode',
      'Tool ExitPlanMode requires permission.',
      planJson,
    );

    const approvalEvent = events.find((event) => event.method === 'approval.requested');
    assert.ok(approvalEvent, 'approval.requested should have been emitted');
    const data = approvalEvent!.params.data as Record<string, unknown>;
    assert.equal(data.category, 'exit_plan_mode');
    assert.equal(data.toolName, 'ExitPlanMode');
    assert.equal(data.inputPreview, planJson);
    const approvalId = data.approvalId as string;

    // Accept the plan — must forward to runtime so Claude's blocked MCP
    // CallTool gets a response (the bug we just fixed: skipping this hung
    // the agent until SESSION_BUSY surfaced on the next message).
    const approved = await service.respondApproval({
      sessionId: created.session.id,
      approvalId,
      behavior: 'allow',
    });
    assert.equal(approved.ok, true);

    assert.deepEqual(runtime.permissionResponses, [
      { sessionId: created.session.id, requestId: 'callid-exit-plan', behavior: 'allow' },
    ]);

    assert.ok(events.some((event) => event.method === 'approval.resolved'));
  });
});

test('ExitPlanMode approval is cleared when the planning process exits', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({ cwd: '/tmp' });
    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'plan something' }],
    }, 'req-plan');

    runtime.emit(
      'permissionRequest',
      created.session.id,
      'callid-exit-plan',
      'ExitPlanMode',
      'Tool ExitPlanMode requires permission.',
      JSON.stringify({ plan: 'do thing' }),
    );

    const approvalEvent = events.find((event) => event.method === 'approval.requested');
    const approvalId = (approvalEvent!.params.data as Record<string, unknown>).approvalId as string;

    runtime.emit('processExited', created.session.id, 1, null);

    // The MCP CallTool died with the process; responding now should 404.
    await assert.rejects(
      service.respondApproval({
        sessionId: created.session.id,
        approvalId,
        behavior: 'allow',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'APPROVAL_NOT_FOUND',
    );
  });
});

test('regular runtime approvals are cleared when the process exits', async () => {
  await withService(async ({ runtime, service }) => {
    const created = await service.createSession({ cwd: '/tmp' });
    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'do thing' }],
    }, 'req-perm');

    runtime.emit('permissionRequest', created.session.id, 'perm-x', 'Bash', 'run cmd', 'ls');
    runtime.emit('processExited', created.session.id, 1, null);

    // The MCP CallTool tied to perm-x is gone — answering should now 404.
    await assert.rejects(
      service.respondApproval({
        sessionId: created.session.id,
        approvalId: 'this-id-doesnt-matter',
        behavior: 'allow',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'APPROVAL_NOT_FOUND',
    );
  });
});

test('/clear intercept rotates claudeSessionId and emits session.rotated notification', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({
      cwd: '/tmp',
    });
    const stableId = created.session.id;
    const oldNativeId = created.session.claudeSessionId;

    const result = await service.startTurn({
      sessionId: stableId,
      input: [{ type: 'text', text: '/clear' }],
    }, 'req-clear');

    // /clear is intercepted: no spawn, no sendMessage to runtime.
    assert.equal(runtime.spawnCalls.length, 0);
    assert.equal(runtime.messages.length, 0);
    // runtime was told to reset its native session id.
    assert.equal(runtime.resetCalls.length, 1);
    assert.equal(runtime.resetCalls[0]!.sessionId, stableId);

    const newNativeId = runtime.resetCalls[0]!.newClaudeSessionId;
    assert.notEqual(newNativeId, oldNativeId);

    // Session id must NOT change across rotation — only the native one does.
    assert.equal(result.session.id, stableId);
    assert.equal(result.session.claudeSessionId, newNativeId);

    // Verify the rotated notification fires with both old and new ids.
    const rotated = events.find((ev) => ev.method === 'session.rotated');
    assert.ok(rotated, 'expected session.rotated notification');
    assert.equal(rotated!.params.sessionId, stableId);
    const data = rotated!.params.data as { oldNativeSessionId: string; newNativeSessionId: string };
    assert.equal(data.oldNativeSessionId, oldNativeId);
    assert.equal(data.newNativeSessionId, newNativeId);

    // Synthetic turn trio still fires for transcript rendering.
    const methods = events.map((e) => e.method);
    assert.ok(methods.includes('turn.started'));
    assert.ok(methods.includes('output.text'));
    assert.ok(methods.includes('turn.completed'));
  });
});

test('respondApproval with `answers` routes to deny+message (AskUserQuestion bridge)', async () => {
  await withService(async ({ runtime, service, events }) => {
    const created = await service.createSession({ cwd: '/tmp' });

    await service.startTurn({
      sessionId: created.session.id,
      input: [{ type: 'text', text: 'pls ask me' }],
    }, 'req-q');

    runtime.emit(
      'permissionRequest',
      created.session.id,
      'perm-q',
      'AskUserQuestion',
      'Question from agent',
      JSON.stringify({ questions: [{ question: 'Which color?', options: [{ label: 'red' }] }] }),
    );

    const reqEvent = events.find((e) => e.method === 'approval.requested');
    assert.ok(reqEvent);
    const approvalId = (reqEvent!.params.data as { approvalId: string }).approvalId;

    // Web sends `allow_once` (host translates to behavior='allow') plus the
    // structured answers. Bridge must rewrite the SDK call to deny+message.
    await service.respondApproval({
      sessionId: created.session.id,
      approvalId,
      behavior: 'allow',
      answers: { 'Which color?': 'red' },
    });

    assert.equal(runtime.permissionResponses.length, 1);
    const recorded = runtime.permissionResponses[0]!;
    assert.equal(recorded.behavior, 'deny', 'SDK call must be deny when answers present');
    assert.equal(recorded.extra?.updatedInput, undefined, 'no updatedInput on the deny path');
    const msg = recorded.extra?.message ?? '';
    assert.match(msg, /Which color\?/, 'message contains the question');
    assert.match(msg, /A: red/, 'message contains the user answer');
    assert.match(msg, /AskUserQuestion/, 'message explains the bridge to the model');

    // The emitted `approval.resolved` still reflects the user's original
    // intent (allow), not the SDK-level deny — UI rendering depends on this.
    const resolved = events.find((e) => e.method === 'approval.resolved');
    assert.ok(resolved);
    assert.equal((resolved!.params.data as { behavior: string }).behavior, 'allow');
  });
});

test('formatQuestionAnswers serializes single, multi, and multi-question payloads', () => {
  // Single-select answer.
  const single = formatQuestionAnswers({ 'Pick one?': 'A' });
  assert.match(single, /^The user answered your AskUserQuestion/);
  assert.match(single, /Q: Pick one\?\nA: A$/);

  // Multi-select serializes with `; ` separator so the model sees one line.
  const multi = formatQuestionAnswers({ 'Pick many?': ['X', 'Y', 'Z'] });
  assert.match(multi, /A: X; Y; Z/);

  // Two questions in one payload — blank line between, no trailing whitespace.
  const both = formatQuestionAnswers({ 'Q1?': 'a1', 'Q2?': ['b1', 'b2'] });
  const lines = both.split('\n');
  assert.equal(lines[lines.length - 1], 'A: b1; b2', 'no trailing blank line');
  assert.ok(lines.includes('Q: Q1?'));
  assert.ok(lines.includes('A: a1'));
  assert.ok(lines.includes('Q: Q2?'));
});
