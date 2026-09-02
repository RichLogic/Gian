import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProxyNotification } from '@gian/shared';
import { projectNotification } from '../src/event/project-notification.js';
import { projectProtocolV2Notification } from '../src/event/project-protocol-v2.js';
import { InteractionKindRegistry } from '../src/event/interaction-kind-registry.js';

function v2Notification(
  method: string,
  data: Record<string, unknown>,
): ProxyNotification {
  return {
    jsonrpc: '2.0',
    method,
    params: {
      eventId: 'event-1',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      sourceTurnId: 'source-1',
      emittedAt: '2026-08-18T05:30:00.000Z',
      data,
    },
  } as ProxyNotification;
}

test('protocol v2 interaction.requested keeps Proxy actions and inputs', () => {
  const notification = v2Notification('interaction.requested', {
    interactionId: 'ix-1',
    title: 'Need a reason',
    description: 'Tell the agent why.',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [{
      id: 'reason',
      type: 'text',
      label: 'Reason',
      required: true,
    }],
    actions: [
      { id: 'allow_once', label: 'Allow once', style: 'primary' },
      { id: 'reject_once', label: 'Reject', style: 'danger' },
    ],
    context: { subject: { toolName: 'Bash', inputPreview: 'npm install' } },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.approval');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.approvalId, 'ix-1');
  assert.equal(data.interactionKind, 'permission');
  assert.equal(data.tone, 'warning');
  assert.equal(data.subject, 'Bash\nnpm install');
  assert.deepEqual(data.actions, [
    { id: 'allow_once', label: 'Allow once', style: 'primary' },
    { id: 'reject_once', label: 'Reject', style: 'danger' },
  ]);
  assert.deepEqual(data.inputs, [{
    id: 'reason',
    type: 'text',
    label: 'Reason',
    required: true,
  }]);
  assert.deepEqual(
    (data.nativeOptions as Array<{ optionId: string }>).map(option => option.optionId),
    ['allow_once', 'reject_once'],
  );
});

test('protocol v2 interaction.requested whitelists kind/tone and flattens subject', () => {
  // Unknown presentation kind → no interactionKind (web falls back to the
  // default card label); absent tone → no tone.
  const [unknown] = projectNotification('grok', v2Notification('interaction.requested', {
    interactionId: 'ix-unknown',
    presentation: { kind: 'widget' },
    inputs: [],
    actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
  }), 'session-1', 1);
  const unknownData = unknown?.display?.data as Record<string, unknown>;
  assert.equal('interactionKind' in unknownData, false);
  assert.equal('tone' in unknownData, false);
  assert.equal('subject' in unknownData, false);

  // A tone outside the enum never survives schema validation upstream; the
  // projector still whitelists defensively — exercise it directly.
  const [invalidTone] = projectProtocolV2Notification(
    v2Notification('interaction.requested', {
      interactionId: 'ix-blink',
      presentation: { kind: 'permission', tone: 'blink' },
      inputs: [],
      actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
    }),
    'session-1',
    1,
  );
  assert.equal('tone' in (invalidTone?.data as Record<string, unknown>), false);

  // String subject passes through directly.
  const [stringSubject] = projectNotification('grok', v2Notification('interaction.requested', {
    interactionId: 'ix-string',
    presentation: { kind: 'confirmation', tone: 'danger' },
    inputs: [],
    actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
    context: { subject: 'Delete 3 files?' },
  }), 'session-1', 1);
  const stringData = stringSubject?.display?.data as Record<string, unknown>;
  assert.equal(stringData.interactionKind, 'confirmation');
  assert.equal(stringData.tone, 'danger');
  assert.equal(stringData.subject, 'Delete 3 files?');

  // Object subject without inputPreview flattens to the bare tool name.
  const [toolOnly] = projectNotification('claude', v2Notification('interaction.requested', {
    interactionId: 'ix-tool',
    presentation: { kind: 'choice' },
    inputs: [],
    actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
    context: { subject: { toolName: 'AskUserQuestion', inputPreview: '' } },
  }), 'session-1', 1);
  const toolData = toolOnly?.display?.data as Record<string, unknown>;
  assert.equal(toolData.interactionKind, 'choice');
  assert.equal(toolData.subject, 'AskUserQuestion');
});

test('protocol v2 exposes only credential-free HTTPS URL elicitations', () => {
  const project = (url: string) => projectNotification('codex', v2Notification('interaction.requested', {
    interactionId: `ix-${url}`,
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [
      { id: 'accept', label: 'Accept', style: 'primary' },
      { id: 'decline', label: 'Decline', style: 'danger' },
    ],
    context: { subject: { mode: 'url', url } },
  }), 'session-1', 1)[0]?.display?.data as Record<string, unknown>;

  assert.equal(
    project('https://chatgpt.com/apps/linear').externalUrl,
    'https://chatgpt.com/apps/linear',
  );
  assert.equal('externalUrl' in project('http://chatgpt.com/apps/linear'), false);
  assert.equal('externalUrl' in project('https://user:secret@example.com/connect'), false);
  assert.equal('externalUrl' in project('not a url'), false);
});

test('protocol v2 content kinds map to message, reasoning, and notice surfaces', () => {
  const cases = [
    ['content.delta', { contentId: 'text-1', kind: 'text', delta: 'hello' }, 'message'],
    ['content.completed', { contentId: 'reason-1', kind: 'reasoning', content: 'why' }, 'activity.reasoning'],
    ['content.completed', { contentId: 'status-1', kind: 'status', content: 'working' }, 'activity.notice'],
  ] as const;
  for (const [method, data, expected] of cases) {
    const [event] = projectNotification('grok', v2Notification(method, data), 'session-1', 1);
    assert.equal(event?.display?.type, expected);
  }
});

test('protocol v2 activity presentation types cover every Gian card fallback', () => {
  const cases = [
    ['command', { command: 'pnpm test' }, 'activity.command'],
    ['file', { path: 'README.md', operation: 'read' }, 'activity.file-read'],
    ['file', { path: 'output.txt', operation: 'write' }, 'activity.file-change'],
    ['search', { query: 'gian proxy' }, 'activity.web-search'],
    ['agent', { agentId: 'worker-1', state: 'completed' }, 'agent'],
    ['notice', { message: 'careful' }, 'activity.notice'],
    ['tool', { name: 'mock_tool' }, 'activity.tool'],
    ['provider.widget', { value: 1 }, 'activity.tool'],
  ] as const;
  for (const [type, presentationData, expected] of cases) {
    const [event] = projectNotification('grok', v2Notification('activity.updated', {
      activityId: `activity-${type}`,
      kind: type,
      title: `Mock ${type}`,
      status: 'succeeded',
      presentation: { type, data: presentationData },
    }), 'session-1', 1);
    assert.equal(event?.display?.type, expected, type);
  }
});

test('protocol v2 plan, diff, lifecycle, and errors retain their UI facts', () => {
  const [plan] = projectNotification('grok', v2Notification('plan.updated', {
    planId: 'plan-1',
    title: 'Mock plan',
    steps: [{ id: 'step-1', text: 'Verify', status: 'completed' }],
  }), 'session-1', 1);
  assert.equal(plan?.display?.type, 'plan');
  assert.match(String((plan?.display?.data as { text?: string }).text), /Verify/);

  const [diff] = projectNotification('grok', v2Notification('diff.updated', {
    diffId: 'diff-1',
    diff: '--- a/a.txt\n+++ b/a.txt\n',
    truncated: false,
    files: [{ path: 'a.txt', status: 'modified' }],
  }), 'session-1', 1);
  assert.equal(diff?.display?.type, 'activity.file-change');

  const [started] = projectNotification('grok', v2Notification('turn.started', {}), 'session-1', 1);
  const [completed] = projectNotification('grok', v2Notification('turn.completed', {
    stopReason: 'interrupted',
  }), 'session-1', 1);
  const [failed] = projectNotification('grok', v2Notification('turn.failed', {
    error: {
      domainCode: 'RUNTIME_ERROR',
      message: 'mock failed',
      retryable: true,
      details: {},
    },
  }), 'session-1', 1);
  assert.equal(started?.display?.type, 'state.turn-started');
  assert.equal(completed?.display?.type, 'state.turn-completed');
  assert.deepEqual(completed?.display?.data, {
    turnId: 'turn-1',
    sourceTurnId: 'source-1',
    status: 'stopped',
  });
  assert.equal(failed?.display?.type, 'state.error');
});

test('protocol v2 interaction.resolved remains authoritative for card settlement', () => {
  const [event] = projectNotification('grok', v2Notification('interaction.resolved', {
    interactionId: 'ix-1',
    outcome: 'submitted',
    actionId: 'mock-submit',
    displaySummary: 'accepted',
  }), 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.resolved');
  assert.equal(
    (event?.display?.data as { nativeOptionId?: string }).nativeOptionId,
    'mock-submit',
  );
});

test('protocol v2 step and request events remain trace-only', () => {
  const step = projectNotification('grok', v2Notification('step.updated', {
    stepId: 'source-1:0', index: 0, status: 'running',
  }), 'session-1', 1);
  const request = projectNotification('grok', v2Notification('request.updated', {
    requestId: 'request-1',
    reason: 'initial',
    stepId: 'source-1:0',
    model: { id: 'deepseek-chat' },
  }), 'session-1', 1);
  assert.deepEqual(step, []);
  assert.deepEqual(request, []);
});

/** Mirrors the coordinator's projectEventsWithKindTracking: requested events
 *  record their option kinds, resolved events consume them. Used by both the
 *  live path and database replay, so this helper is exactly the parity
 *  contract under test. */
function projectWithKindTracking(
  notification: ProxyNotification,
  registry: InteractionKindRegistry,
  sessionId = 'session-1',
) {
  const events = projectNotification(
    'kimi',
    notification,
    sessionId,
    1,
    (notificationSessionId, approvalId) => registry.lookup(notificationSessionId, approvalId),
  );
  for (const event of events) {
    const type = event.display?.type;
    const data = event.display?.data as Record<string, unknown> | undefined;
    if ((type === 'interaction.approval' || type === 'interaction.question') && data) {
      registry.record(sessionId, String(data.approvalId ?? ''), data.nativeOptions);
    } else if (type === 'interaction.resolved' && data) {
      registry.forget(sessionId, String(data.approvalId ?? ''));
    }
  }
  return events;
}

const kimiPhoneyRequest = v2Notification('interaction.requested', {
  interactionId: 'ix-kimi',
  title: 'Read',
  description: 'Requesting approval to Reading .git/logs/HEAD',
  presentation: { kind: 'permission', tone: 'warning' },
  inputs: [],
  actions: [
    { id: 'approve_once', label: 'Approve once', style: 'primary' },
    { id: 'approve_always', label: 'Approve for this session', style: 'secondary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
  ],
  context: {
    subject: { toolName: 'Read', inputPreview: '.git/logs/HEAD' },
    permissionOptionKinds: {
      approve_once: 'allow_once',
      approve_always: 'allow_always',
      reject: 'reject_once',
    },
  },
});

test('requested context ACP kinds flow into nativeOptions and rejected style', () => {
  const registry = new InteractionKindRegistry();
  const [event] = projectWithKindTracking(kimiPhoneyRequest, registry);
  assert.equal(event?.display?.type, 'interaction.approval');
  const data = event?.display?.data as Record<string, unknown>;
  assert.deepEqual(data.nativeOptions, [
    { optionId: 'approve_once', label: 'Approve once', kind: 'allow_once' },
    { optionId: 'approve_always', label: 'Approve for this session', kind: 'allow_always' },
    { optionId: 'reject', label: 'Reject', kind: 'reject_once' },
  ]);
  // Reject action style is decided by the ACP kind, not the opaque id text.
  assert.deepEqual(data.actions, [
    { id: 'approve_once', label: 'Approve once', style: 'primary' },
    { id: 'approve_always', label: 'Approve for this session', style: 'secondary' },
    { id: 'reject', label: 'Reject', style: 'danger' },
  ]);
});

test('allow_always resolves to allow_session before persistence, live and replay', () => {
  const cases = [
    { actionId: 'approve_once', expected: 'allow_once' },
    { actionId: 'approve_always', expected: 'allow_session' },
    { actionId: 'reject', expected: 'decline' },
  ] as const;
  for (const { actionId, expected } of cases) {
    // Live pass and replay pass build independent registries from the same
    // stream order — both must derive the identical persisted decision.
    for (const label of ['live', 'replay'] as const) {
      const registry = new InteractionKindRegistry();
      projectWithKindTracking(kimiPhoneyRequest, registry);
      const [resolved] = projectWithKindTracking(v2Notification('interaction.resolved', {
        interactionId: 'ix-kimi',
        outcome: 'submitted',
        actionId,
      }), registry);
      const data = resolved?.display?.data as Record<string, unknown>;
      assert.equal(data.decision, expected, `${label} ${actionId}`);
      assert.equal(data.nativeOptionId, actionId);
      assert.equal('kind' in data, false, 'resolved schema gains no kind field');
    }
  }
  // Resolved consumption forgets the mapping: no stale registry entries.
  const drained = new InteractionKindRegistry();
  projectWithKindTracking(kimiPhoneyRequest, drained);
  assert.ok(drained.lookup('session-1', 'ix-kimi'));
  projectWithKindTracking(v2Notification('interaction.resolved', {
    interactionId: 'ix-kimi',
    outcome: 'submitted',
    actionId: 'approve_once',
  }), drained);
  assert.equal(drained.lookup('session-1', 'ix-kimi'), undefined);
});

test('interaction kind registry is session-scoped against id collisions (Finding 5)', () => {
  const registry = new InteractionKindRegistry();
  const allowRequest = v2Notification('interaction.requested', {
    interactionId: 'shared-ix',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [{ id: 'approve_always', label: 'Always', style: 'secondary' }],
    context: { permissionOptionKinds: { approve_always: 'allow_always' } },
  });
  const rejectRequest = v2Notification('interaction.requested', {
    interactionId: 'shared-ix',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [{ id: 'reject', label: 'Reject', style: 'danger' }],
    context: { permissionOptionKinds: { reject: 'reject_once' } },
  });

  projectWithKindTracking(allowRequest, registry, 'session-a');
  projectWithKindTracking(rejectRequest, registry, 'session-b');

  const resolvedFor = (sessionId: string, actionId: string) => {
    const [resolved] = projectWithKindTracking(v2Notification('interaction.resolved', {
      interactionId: 'shared-ix',
      outcome: 'submitted',
      actionId,
    }), registry, sessionId);
    return (resolved?.display?.data as Record<string, unknown>).decision;
  };
  assert.equal(resolvedFor('session-a', 'approve_always'), 'allow_session');
  assert.equal(resolvedFor('session-b', 'reject'), 'decline');

  // forgetSession clears only that session's entries.
  const scoped = new InteractionKindRegistry();
  projectWithKindTracking(allowRequest, scoped, 'session-a');
  projectWithKindTracking(rejectRequest, scoped, 'session-b');
  scoped.forgetSession('session-a');
  assert.equal(scoped.lookup('session-a', 'shared-ix'), undefined);
  assert.ok(scoped.lookup('session-b', 'shared-ix'));
});

test('missing or unknown kinds keep the legacy safe fallback', () => {
  // No permissionOptionKinds in context: kinds stay the legacy action id and
  // the resolved decision keeps the historical submitted→allow_once default.
  const registry = new InteractionKindRegistry();
  const legacyRequest = v2Notification('interaction.requested', {
    interactionId: 'ix-legacy',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [{ id: 'approve_always', label: 'Approve always', style: 'secondary' }],
  });
  projectWithKindTracking(legacyRequest, registry);
  const [requested] = projectNotification('kimi', legacyRequest, 'session-1', 1);
  assert.deepEqual(
    ((requested?.display?.data as Record<string, unknown>).nativeOptions as Array<Record<string, unknown>>),
    [{ optionId: 'approve_always', label: 'Approve always', kind: 'approve_always' }],
  );
  const [resolved] = projectWithKindTracking(v2Notification('interaction.resolved', {
    interactionId: 'ix-legacy',
    outcome: 'submitted',
    actionId: 'approve_always',
  }), registry);
  assert.equal(
    (resolved?.display?.data as Record<string, unknown>).decision,
    'allow_once',
  );

  // Kinds outside the ACP closed set are ignored at the requested boundary.
  const [suspicious] = projectNotification('kimi', v2Notification('interaction.requested', {
    interactionId: 'ix-suspicious',
    presentation: { kind: 'permission', tone: 'warning' },
    inputs: [],
    actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
    context: { permissionOptionKinds: { ok: 'allow_everything_forever' } },
  }), 'session-1', 1);
  assert.equal(
    ((suspicious?.display?.data as Record<string, unknown>).nativeOptions as Array<Record<string, unknown>>)[0]?.kind,
    'ok',
  );
});

test('cancelled resolutions decline regardless of kind knowledge', () => {
  const registry = new InteractionKindRegistry();
  projectWithKindTracking(kimiPhoneyRequest, registry);
  const [resolved] = projectWithKindTracking(v2Notification('interaction.resolved', {
    interactionId: 'ix-kimi',
    outcome: 'cancelled',
  }), registry);
  const data = resolved?.display?.data as Record<string, unknown>;
  assert.equal(data.decision, 'decline');
  assert.equal(data.auto, true);
});
