import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyNotificationSchema } from '@gian/proxy-protocol';
import { projectNotification } from '../src/event/project-notification.js';

test('protocol v1 notice.created projects to a generic display notice', () => {
  const notification = proxyNotificationSchema.parse({
    method: 'notice.created',
    params: {
      eventId: 'event-notice-1',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAt: '2026-08-10T05:30:00.000Z',
      data: {
        noticeId: 'notice-1',
        severity: 'warning',
        code: 'PROVIDER_POLICY_NOTICE',
        title: 'Action blocked',
        message: 'The provider rejected this action.',
      },
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.call_id, 'notice-1');
  assert.equal(event?.event, 'notice.created');
  assert.deepEqual(event?.display, {
    type: 'activity.notice',
    data: {
      severity: 'warning',
      code: 'PROVIDER_POLICY_NOTICE',
      title: 'Action blocked',
      message: 'The provider rejected this action.',
    },
  });
});

function approvalRequestedNotification(data: Record<string, unknown>) {
  return proxyNotificationSchema.parse({
    method: 'approval.requested',
    params: {
      eventId: 'event-appr-1',
      streamId: 'stream-1',
      sequence: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAt: '2026-08-10T05:30:00.000Z',
      data: {
        approvalId: 'appr-1',
        options: [
          { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
          { id: 'reject_once', label: 'Reject', kind: 'reject_once' },
        ],
        ...data,
      },
    },
  });
}

test('protocol v1 AskUserQuestion approval projects to a structured question', () => {
  const notification = approvalRequestedNotification({
    category: 'question',
    title: 'AskUserQuestion requires approval',
    description: '',
    payload: {
      toolName: 'AskUserQuestion',
      inputPreview: JSON.stringify({
        questions: [{
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: false,
          options: [{ label: 'A', description: 'first' }, { label: 'B' }],
        }],
      }),
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.question');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.category, 'question');
  assert.equal(data.title, 'Which approach?');
  assert.equal(data.risk, 'low');
  assert.deepEqual(data.scopeOptions, ['once']);
  const questions = data.questions as Array<{ question: string; options: Array<{ label: string }> }>;
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.question, 'Which approach?');
  assert.deepEqual(questions[0]!.options.map(o => o.label), ['A', 'B']);
});

test('protocol v1 detects AskUserQuestion by input shape without the canonical name', () => {
  const notification = approvalRequestedNotification({
    category: 'other',
    title: 'Review request',
    description: '',
    payload: {
      toolName: 'mcp__cc_approval__approval_prompt',
      inputPreview: JSON.stringify({
        questions: [{ question: 'Pick one', options: [{ label: 'x' }] }],
      }),
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.question');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.category, 'question');
  assert.equal(data.title, 'Pick one');
});

test('protocol v1 ExitPlanMode approval projects plan title, subject, and three-way actions', () => {
  const notification = approvalRequestedNotification({
    category: 'exit_plan_mode',
    title: 'ExitPlanMode requires approval',
    description: 'Claude has finished planning. Choose how to proceed.',
    payload: {
      toolName: 'ExitPlanMode',
      inputPreview: JSON.stringify({ plan: '# My Plan\n\n1. do the thing' }),
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.approval');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.category, 'exit_plan_mode');
  assert.equal(data.title, 'Plan ready for review');
  assert.equal(data.subject, '# My Plan\n\n1. do the thing');
  assert.deepEqual(data.planActions, ['accept_with_auto', 'accept_with_ask', 'keep_planning']);
  assert.deepEqual(data.scopeOptions, ['once']);
});

test('protocol v1 Bash approval extracts the command as subject', () => {
  const notification = approvalRequestedNotification({
    category: 'command',
    title: 'Bash requires approval',
    description: 'Tool Bash requires permission.',
    options: [
      { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
      { id: 'allow_session', label: 'Allow session', kind: 'allow_session' },
      { id: 'reject_once', label: 'Reject', kind: 'reject_once' },
    ],
    payload: {
      toolName: 'Bash',
      inputPreview: JSON.stringify({ command: 'rm -rf /tmp/x', description: 'Remove temp dir' }),
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.subject, 'rm -rf /tmp/x');
  assert.equal(data.description, 'Remove temp dir');
  assert.deepEqual(data.scopeOptions, ['once', 'session']);
});

test('protocol v1 grok approval extracts the command as subject', () => {
  const notification = approvalRequestedNotification({
    category: 'other',
    title: 'Execute `git status --short`',
    description: '',
    options: [
      { id: 'allow-once', label: 'Yes, proceed', kind: 'allow_once' },
      { id: 'reject-once', label: 'No, and tell Grok what to do differently', kind: 'reject_once' },
    ],
    payload: {
      rawInput: {
        variant: 'Bash',
        command: 'git status --short',
        description: 'Check working tree',
        is_background: false,
      },
      _meta: {
        'x.ai/tool': {
          name: 'run_terminal_command',
          kind: 'execute',
          input: { command: 'git status --short', description: 'Check working tree' },
        },
      },
      title: 'Execute `git status --short`',
      toolCallId: 'call-1',
    },
  });

  const [event] = projectNotification('grok', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.approval');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.subject, 'git status --short');
  assert.equal(data.description, 'Check working tree');
  assert.deepEqual(data.scopeOptions, ['once']);
});

test('protocol v1 approval without a cc payload keeps the generic projection', () => {
  const notification = approvalRequestedNotification({
    category: 'question',
    title: 'AskUserQuestion',
    description: 'Which color?',
    options: [
      { id: 'opt-red', label: 'Red', kind: 'allow_once' },
      { id: 'opt-blue', label: 'Blue', kind: 'allow_once' },
    ],
    payload: { toolCall: { title: 'AskUserQuestion' } },
  });

  const [event] = projectNotification('kimi', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.question');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.title, 'AskUserQuestion');
  assert.equal(data.description, 'Which color?');
  assert.equal(data.questions, undefined);
  assert.deepEqual(
    (data.nativeOptions as Array<{ optionId: string }>).map(o => o.optionId),
    ['opt-red', 'opt-blue'],
  );
});

test('protocol v1 approval.resolved carries AskUserQuestion answers through', () => {
  const notification = proxyNotificationSchema.parse({
    method: 'approval.resolved',
    params: {
      eventId: 'event-appr-2',
      streamId: 'stream-1',
      sequence: 2,
      sessionId: 'session-1',
      turnId: 'turn-1',
      emittedAt: '2026-08-10T05:31:00.000Z',
      data: {
        approvalId: 'appr-1',
        resolution: 'selected',
        resolvedBy: 'user',
        optionId: 'allow_once',
        answers: { 'Which approach?': 'A' },
      },
    },
  });

  const [event] = projectNotification('claude', notification, 'session-1', 1);
  assert.equal(event?.display?.type, 'interaction.resolved');
  const data = event?.display?.data as Record<string, unknown>;
  assert.equal(data.decision, 'allow_once');
  assert.deepEqual(data.answers, { 'Which approach?': 'A' });
});
