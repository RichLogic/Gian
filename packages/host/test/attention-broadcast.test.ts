import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ChatEvent } from '@gian/shared';
import {
  ATTENTION_BODY_MAX_BYTES,
  ATTENTION_TITLE_MAX_BYTES,
  attentionMessageForEvent,
} from '../src/session/event-coordinator.js';

const base = {
  session_id: 'session-a',
  turn: 7,
  ts: 1_786_422_400_000,
  provider: 'codex' as const,
  event: 'fixture.event',
  data: {},
};

test('attention maps completion, approval/question, and error display projections', () => {
  const events: ChatEvent[] = [
    {
      ...base,
      call_id: 'turn-7',
      display: {
        type: 'state.turn-completed',
        data: { turnId: 'turn-7', summary: 'Finished the requested work.' },
      },
    },
    {
      ...base,
      call_id: 'approval-7',
      display: {
        type: 'interaction.approval',
        data: {
          approvalId: 'approval-7',
          category: 'command',
          risk: 'high',
          title: 'Approve command execution',
          description: 'Run the project checks.',
          subject: 'pnpm test',
          scopeOptions: ['once'],
        },
      },
    },
    {
      ...base,
      call_id: 'question-7',
      display: {
        type: 'interaction.question',
        data: {
          approvalId: 'question-7',
          category: 'question',
          risk: 'low',
          title: 'Fallback question title',
          description: '',
          scopeOptions: ['once'],
          questions: [{
            question: 'Which release channel should Gian use?',
            multiSelect: false,
            options: [],
          }],
        },
      },
    },
    {
      ...base,
      call_id: 'error-7',
      display: {
        type: 'state.error',
        data: { message: 'The provider stopped unexpectedly.', retryable: true },
      },
    },
  ];

  const attentions = events.map(attentionMessageForEvent);
  assert.deepEqual(attentions.map(message => message?.kind), [
    'turn-completed',
    'approval',
    'question',
    'error',
  ]);
  assert.deepEqual(attentions.map(message => message?.body), [
    'The agent finished turn 7.',
    'The agent needs permission to run a command.',
    'The agent is waiting for your answer.',
    'Open Gian to review the error and retry.',
  ]);
  assert.match(attentions[0]?.id ?? '', /^gian:attention:[A-Za-z0-9_-]{43}$/u);
  assert.equal(attentions[0]?.id, attentionMessageForEvent(events[0]!)?.id);
  for (const attention of attentions) {
    assert.equal(attention?.session_id, 'session-a');
    assert.equal(attention?.turn, 7);
    assert.equal(attention?.timestamp, base.ts);
    assert.equal(attention?.provider, 'codex');
  }
});

test('non-attention display events do not produce a global signal', () => {
  const event: ChatEvent<'message'> = {
    ...base,
    call_id: 'message-7',
    display: {
      type: 'message',
      data: { text: 'ordinary transcript output', delta: false, itemId: 'message-7' },
    },
  };
  assert.equal(attentionMessageForEvent(event), null);
});

test('failed and user-stopped transcript boundaries are not completion attention', () => {
  for (const status of ['error', 'stopped'] as const) {
    const event: ChatEvent<'state.turn-completed'> = {
      ...base,
      call_id: `gian-${status}`,
      event: 'gian.turn.completed',
      data: { turnId: `turn-${status}`, status },
      display: {
        type: 'state.turn-completed',
        data: { turnId: `turn-${status}` },
      },
    };
    assert.equal(attentionMessageForEvent(event), null, status);
  }
});

test('attention strips action blocks, commands, paths, raw payloads, and caps UTF-8 text', () => {
  const command = 'rm -rf /Users/alice/private-project';
  const summary = [
    '完成了请求的工作。'.repeat(40),
    '<<gian:action>>',
    JSON.stringify({ method: 'submit_step', params: { command } }),
    '<</gian:action>>',
    `Read /Users/alice/private-project/secret.txt and ran \`${command}\`.`,
  ].join('\n');
  const event: ChatEvent<'state.turn-completed'> = {
    ...base,
    call_id: 'sensitive-turn',
    data: {
      command,
      file_path: '/Users/alice/private-project/secret.txt',
      rawSecret: 'must-not-cross-the-attention-boundary',
    },
    display: {
      type: 'state.turn-completed',
      data: { turnId: 'sensitive-turn', summary },
    },
  };

  const attention = attentionMessageForEvent(event);
  assert.ok(attention);
  assert.ok(Buffer.byteLength(attention.title, 'utf8') <= ATTENTION_TITLE_MAX_BYTES);
  assert.ok(Buffer.byteLength(attention.body, 'utf8') <= ATTENTION_BODY_MAX_BYTES);
  assert.equal(attention.body, 'The agent finished turn 7.');
  assert.doesNotMatch(attention.body, /gian:action|submit_step|rm -rf|\/Users\/alice/);
  assert.doesNotMatch(attention.body, /\ufffd/);
  const wire = JSON.stringify(attention);
  assert.doesNotMatch(wire, /must-not-cross|rawSecret|file_path|private-project/);
  assert.deepEqual(Object.keys(attention).sort(), [
    'body',
    'id',
    'kind',
    'provider',
    'session_id',
    'timestamp',
    'title',
    'turn',
    'type',
  ]);
});

test('approval attention never copies the command/path subject', () => {
  const subject = 'env SECRET_TOKEN=hidden deploy /Users/alice/private-project';
  const event: ChatEvent<'interaction.approval'> = {
    ...base,
    call_id: 'approval-sensitive',
    data: { command: subject, nested: { cwd: '/Users/alice/private-project' } },
    display: {
      type: 'interaction.approval',
      data: {
        approvalId: 'approval-sensitive',
        category: 'command',
        risk: 'high',
        title: 'Approve command execution',
        description: `The agent requested: ${subject}`,
        subject,
        scopeOptions: ['once'],
      },
    },
  };

  const attention = attentionMessageForEvent(event);
  assert.ok(attention);
  const wire = JSON.stringify(attention);
  assert.doesNotMatch(wire, /SECRET_TOKEN|deploy \/Users|private-project|nested|cwd/);
  assert.equal(attention.body, 'The agent needs permission to run a command.');
});

test('attention identity is bounded and never exposes a provider call id', () => {
  const privateCallId = `/Users/alice/private/${'provider-secret-'.repeat(100)}`;
  const event: ChatEvent<'state.turn-completed'> = {
    ...base,
    call_id: privateCallId,
    display: {
      type: 'state.turn-completed',
      data: { turnId: privateCallId },
    },
  };
  const first = attentionMessageForEvent(event);
  const duplicate = attentionMessageForEvent(event);
  const different = attentionMessageForEvent({ ...event, call_id: `${privateCallId}other` });

  assert.ok(first);
  assert.equal(first.id, duplicate?.id);
  assert.notEqual(first.id, different?.id);
  assert.match(first.id, /^gian:attention:[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(JSON.stringify(first), /provider-secret|Users|alice/);
});
