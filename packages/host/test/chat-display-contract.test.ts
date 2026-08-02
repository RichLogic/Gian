import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DisplayEventType, Executor, ProxyNotification } from '@gian/shared';
import { projectNotification } from '../src/event/project-notification.js';

interface Case {
  name: string;
  provider: Executor;
  notification: ProxyNotification;
  displays: DisplayEventType[];
}

interface VersionFixture {
  provider: Executor;
  version: string;
  cases: Array<{
    name: string;
    notification: ProxyNotification;
    displays: DisplayEventType[];
  }>;
}

const cases: Case[] = [
  {
    name: 'Claude assistant output → Message',
    provider: 'claude',
    notification: {
      method: 'output.text',
      params: { sessionId: 'native', data: { itemId: 'cc-message', text: 'hello' } },
    },
    displays: ['message'],
  },
  {
    name: 'Claude AskUserQuestion → Interaction/Question',
    provider: 'claude',
    notification: {
      method: 'approval.requested',
      params: {
        sessionId: 'native',
        data: {
          approvalId: 'cc-question',
          toolName: 'AskUserQuestion',
          inputPreview: JSON.stringify({
            questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
          }),
        },
      },
    },
    displays: ['interaction.question'],
  },
  {
    name: 'Claude plan-file write → Activity and Plan',
    provider: 'claude',
    notification: {
      method: 'tool.use',
      params: {
        sessionId: 'native',
        data: {
          callId: 'cc-plan',
          toolName: 'Write',
          input: { file_path: '/tmp/.claude/plans/a.md', content: '# Plan\n- inspect' },
        },
      },
    },
    displays: ['activity.file-change', 'plan'],
  },
  {
    name: 'Codex reasoning stream → Activity/Reasoning',
    provider: 'codex',
    notification: {
      method: 'output.reasoning.delta',
      params: { sessionId: 'native', data: { itemId: 'cx-reasoning', delta: 'thinking' } },
    },
    displays: ['activity.reasoning'],
  },
  {
    name: 'Codex child-agent update → Agent',
    provider: 'codex',
    notification: {
      method: 'codex.agent',
      params: {
        sessionId: 'native',
        data: { updates: [{ agentId: 'child-1', description: 'Inspect', status: 'running' }] },
      },
    },
    displays: ['agent'],
  },
  {
    name: 'Kimi turn completion → State',
    provider: 'kimi',
    notification: {
      method: 'turn.completed',
      params: { sessionId: 'native', turnId: 'kimi-turn', data: { turnId: 'kimi-turn' } },
    },
    displays: ['state.turn-completed'],
  },
];

for (const fixture of cases) {
  test(`chat display contract · ${fixture.name}`, () => {
    const raw = fixture.notification.params.data as Record<string, unknown>;
    const events = projectNotification(fixture.provider, fixture.notification, 'gian-session', 4);

    assert.deepEqual(events.map(event => event.display?.type), fixture.displays);
    for (const event of events) {
      assert.equal(event.provider, fixture.provider);
      assert.equal(event.event, fixture.notification.method);
      assert.deepEqual(event.data, raw);
      assert.equal(event.session_id, 'gian-session');
      assert.equal(event.turn, 4);
    }
  });
}

test('chat display contract · unknown native events are retained without inventing a UI meaning', () => {
  const notification: ProxyNotification = {
    method: 'future.cli.event',
    params: { sessionId: 'native', data: { version: 99, novel: true } },
  };
  const [event] = projectNotification('codex', notification, 'gian-session', 5);

  assert.equal(event?.event, 'future.cli.event');
  assert.deepEqual(event?.data, { version: 99, novel: true });
  assert.equal(event?.display, undefined);
});

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chat-display');
for (const filename of [
  'claude-2.1.220.json',
  'codex-0.146.0.json',
  'kimi-0.31.1.json',
]) {
  const fixture = JSON.parse(
    readFileSync(join(fixtureRoot, filename), 'utf8'),
  ) as VersionFixture;
  for (const item of fixture.cases) {
    test(`version fixture · ${fixture.provider} ${fixture.version} · ${item.name}`, () => {
      const events = projectNotification(
        fixture.provider,
        item.notification,
        'fixture-session',
        1,
      );
      assert.deepEqual(events.map(event => event.display?.type), item.displays);
      assert.deepEqual(events[0]?.data, item.notification.params.data);
      assert.equal(events[0]?.event, item.notification.method);
    });
  }
}
