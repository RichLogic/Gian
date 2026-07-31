import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { MessagingPlatformOptions } from '../src/im/messaging/types.js';
import type { MessagingSession, ModelOption } from '../src/im/types.js';
import {
  approvalMessageBody,
  approvalReplyAction,
  chunkMessage,
  isInterruptedMessage,
} from '../src/im/messaging/presentation.js';
import {
  loadCurrentMessagingContext,
  resolveModelOption,
} from '../src/im/messaging/session-context.js';

const model = (id: string, name = id): ModelOption => ({
  id,
  displayName: name,
  model: id,
  description: '',
  isDefault: false,
  hidden: false,
  defaultReasoningEffort: 'high',
  supportedReasoningEfforts: ['high'],
});

test('IM shared presentation keeps chunking, interruption, and approval vocabulary canonical', () => {
  assert.deepEqual(chunkMessage('abc\ndef', 5), ['abc', 'def']);
  assert.equal(isInterruptedMessage('Run interrupted by user'), true);
  assert.deepEqual(approvalReplyAction('/b'), { decision: 'approve', scope: 'session' });
  assert.match(approvalMessageBody({
    id: 'approval-1',
    sessionId: 'session-1',
    rpcRequestId: 1,
    method: 'command',
    title: 'Run tests',
    risk: 'low',
    scopeOptions: ['once'],
    source: 'codex',
    payload: {},
    createdAt: '2026-07-31T00:00:00.000Z',
  }), /回复 1 或 a：批准一次[\s\S]*回复 3 或 c：拒绝/);
});

test('IM model lookup accepts an unambiguous fuzzy display-name match', () => {
  const models = [model('gpt-5.1', 'GPT Standard'), model('gpt-5.2', 'GPT Pro')];
  const options = {
    findModelOption: () => null,
    listModelOptions: () => models,
  } as unknown as MessagingPlatformOptions;

  assert.equal(resolveModelOption(options, 'pro')?.id, 'gpt-5.2');
  assert.equal(resolveModelOption(options, 'gpt'), null);
});

test('IM context auto-selects the sole canonical session and reads its Gian queue', async () => {
  const session = {
    id: 'session-1',
    ownerUserId: 'user-1',
    ownerUsername: 'admin',
    sessionType: 'code',
    executor: 'codex',
    workspaceId: 'workspace-1',
    threadId: 'thread-1',
    activeTurnId: null,
    title: 'Only session',
    autoTitle: false,
    workspace: '/repo',
    archivedAt: null,
    approvalMode: 'ask',
    status: 'idle',
    lastIssue: null,
    model: null,
    reasoningEffort: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  } satisfies MessagingSession;
  const options = {
    listUsers: () => [{ id: 'user-1', username: 'admin' }],
    getWorkspace: async () => ({
      id: 'workspace-1',
      name: 'repo',
      path: '/repo',
      visible: true,
      sortOrder: 0,
    }),
    listSessionsForWorkspace: async () => [session],
    getSession: async () => null,
    getQueueLength: (sessionId: string) => sessionId === session.id ? 2 : 0,
  } as unknown as MessagingPlatformOptions;
  const patches: unknown[] = [];

  const context = await loadCurrentMessagingContext(
    options,
    {
      ownerUserId: 'user-1',
      selectedWorkspaceId: 'workspace-1',
      selectedSessionId: null,
    },
    async (bot, patch) => {
      patches.push(patch);
      return { ...bot, ...patch };
    },
  );

  assert.equal(context.session?.id, session.id);
  assert.equal(context.queuedTurnCount, 2);
  assert.deepEqual(patches, [{ selectedSessionId: session.id }]);
});
