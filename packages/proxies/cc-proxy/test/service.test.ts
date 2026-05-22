import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CcProxyService } from '../src/core/service.js';
import { AppError } from '../src/core/errors.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from '../src/runtime/types.js';

class FakeRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  readonly spawnCalls: Array<{
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
  }> = [];
  readonly messages: Array<{ sessionId: string; content: string }> = [];
  readonly permissionResponses: Array<{ sessionId: string; requestId: string; behavior: 'allow' | 'deny' }> = [];
  readonly resetCalls: Array<{ sessionId: string; newClaudeSessionId: string }> = [];
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
  }): Promise<void> {
    this.spawnCalls.push(options);
    this.aliveSessions.add(options.sessionId);
  }

  async sendMessage(sessionId: string, content: string, _options?: { permissionMode?: import('../src/core/types.js').PermissionMode | null }): Promise<void> {
    this.messages.push({ sessionId, content });
  }

  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void {
    this.resetCalls.push({ sessionId, newClaudeSessionId });
  }

  async respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
    this.permissionResponses.push({ sessionId, requestId, behavior });
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
    return [];
  }

  async awaitModelDiscovery() {
    /* no-op */
  }
}

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
