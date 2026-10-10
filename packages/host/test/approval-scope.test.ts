// P3a-1. ApprovalManager session scope. NOT_RUN.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalManager, ApprovalScopeError, type ApprovalRequest } from '../src/approval/manager.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

interface SeenApproval {
  type: string;
  approval?: { id: string; session_id?: string; status: string };
}

function harness(): { approvals: ApprovalManager; messages: SeenApproval[] } {
  const messages: SeenApproval[] = [];
  const broadcaster = {
    broadcast(message: SeenApproval) { messages.push(message); },
  };
  return { approvals: new ApprovalManager(broadcaster as unknown as WsBroadcaster), messages };
}

function request(sessionId: string, approvalId: string, description: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    sessionId,
    turnId: `turn-${sessionId}`,
    category: 'question',
    risk: 'high',
    description,
    ...extra,
    payload: { approvalId, ...(extra.payload ?? {}) },
  };
}

test('two sessions keep one native approval id through register, resolve, and clear', async () => {
  const { approvals, messages } = harness();
  const first = approvals.request(request('sess-a', 'shared-native', 'from a'));
  const second = approvals.request(request('sess-b', 'shared-native', 'from b'));

  assert.equal(approvals.listPending().length, 2);
  assert.equal(approvals.getPending('shared-native', 'sess-a')?.id, 'shared-native');
  assert.equal(approvals.getPending('shared-native', 'sess-a')?.description, 'from a');
  assert.equal(approvals.getPending('shared-native', 'sess-b')?.sessionId, 'sess-b');
  assert.throws(() => approvals.getPending('shared-native'), ApprovalScopeError);
  assert.throws(() => approvals.resolve('shared-native', 'decline', 'web'), ApprovalScopeError);
  assert.throws(() => approvals.markResolutionSource('shared-native', 'web'), ApprovalScopeError);
  assert.equal(approvals.listPending().length, 2);
  assert.equal(messages.filter(message => message.type === 'approval:created').length, 2);

  approvals.markResolutionSource('shared-native', 'web', 'sess-a');
  approvals.markResolutionSource('shared-native', 'tool', 'sess-b');
  assert.equal(approvals.consumeResolutionSource('shared-native', 'sess-a'), 'web');
  assert.equal(approvals.consumeResolutionSource('shared-native', 'sess-b'), 'tool');

  approvals.resolve('shared-native', 'allow_once', 'web', 'sess-a');
  assert.equal(await first, 'allow_once');
  assert.equal(approvals.getPending('shared-native', 'sess-a'), undefined);
  assert.equal(approvals.getPending('shared-native', 'sess-b')?.description, 'from b');
  let secondSettled = false;
  void second.then(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false);

  approvals.clearSession('sess-a');
  assert.equal(approvals.getPending('shared-native', 'sess-b')?.id, 'shared-native');
  approvals.clearSession('sess-b');
  assert.equal(await second, 'decline');
  assert.equal(secondSettled, true);
  assert.equal(approvals.listPending().length, 0);
  const declined = messages.filter(message => message.type === 'approval:updated' && message.approval?.status === 'declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0]?.approval?.session_id, 'sess-b');
});

test('the same session keeps the first waiter when the native id is requested again', async () => {
  const { approvals, messages } = harness();
  const first = approvals.request(request('sess-a', 'again', 'first'));
  const second = approvals.request(request('sess-a', 'again', 'second'));
  assert.equal(approvals.listPending().length, 1);
  assert.equal(approvals.getPending('again', 'sess-a')?.description, 'first');
  assert.equal(messages.filter(message => message.type === 'approval:created').length, 1);
  approvals.resolve('again', 'decline', 'web', 'sess-a');
  assert.equal(await first, 'decline');
  assert.equal(await second, 'decline');
  assert.equal(approvals.listPending().length, 0);
});

test('a single session still resolves without an explicit scope', async () => {
  const { approvals } = harness();
  const pending = approvals.request(request('only', 'one', 'solo', { category: 'command' }));
  assert.equal(approvals.getPending('one')?.sessionId, 'only');
  approvals.markResolutionSource('one', 'im');
  assert.equal(approvals.consumeResolutionSource('one'), 'im');
  approvals.resolve('one', 'allow_once', 'web');
  assert.equal(await pending, 'allow_once');
  assert.equal(approvals.getPending('one'), undefined);
});

test('auto and allow_session stay on the existing per-session policy', async () => {
  const { approvals } = harness();
  approvals.setGetModeFn(() => 'auto');
  const automatic = await approvals.request(request('only', 'auto-1', 'echo', {
    category: 'command',
    risk: 'low',
  }));
  assert.equal(automatic, 'allow_once');
  assert.equal(approvals.listPending().length, 0);

  const question = approvals.request(request('only', 'question-1', 'which path'));
  assert.equal(approvals.getPending('question-1', 'only')?.category, 'question');
  approvals.resolve('question-1', 'allow_once', 'web', 'only');
  assert.equal(await question, 'allow_once');

  approvals.setGetModeFn(() => 'ask');
  const allowed = approvals.request(request('sess-a', 'cmd-1', 'first command', {
    category: 'command',
    risk: 'high',
  }));
  approvals.resolve('cmd-1', 'allow_session', 'web', 'sess-a');
  assert.equal(await allowed, 'allow_session');
  const repeat = await approvals.request(request('sess-a', 'cmd-2', 'second command', {
    category: 'command',
    risk: 'high',
  }));
  assert.equal(repeat, 'allow_once');
  assert.equal(approvals.listPending().length, 0);

  const other = approvals.request(request('sess-b', 'cmd-3', 'other session', {
    category: 'command',
    risk: 'high',
  }));
  assert.equal(approvals.getPending('cmd-3', 'sess-b')?.sessionId, 'sess-b');
  approvals.resolve('cmd-3', 'decline', 'web', 'sess-b');
  assert.equal(await other, 'decline');
});

test('clearSession drops a source that has no pending record and can run twice', async () => {
  const { approvals } = harness();
  const pending = approvals.request(request('sess-a', 'shared', 'from a'));
  approvals.markResolutionSource('shared', 'web', 'sess-a');
  approvals.resolve('shared', 'allow_once', 'web', 'sess-a');
  assert.equal(await pending, 'allow_once');
  assert.equal(approvals.getPending('shared', 'sess-a'), undefined);
  approvals.markResolutionSource('shared', 'tool', 'sess-b');
  assert.equal(approvals.listPending().length, 0);

  approvals.clearSession('sess-a');
  approvals.clearSession('sess-a');
  assert.equal(approvals.consumeResolutionSource('shared', 'sess-a'), undefined);
  assert.equal(approvals.consumeResolutionSource('shared', 'sess-b'), 'tool');
});

test('an unscoped source operation changes neither session when the native id is shared', () => {
  const { approvals } = harness();
  approvals.markResolutionSource('shared', 'web', 'sess-a');
  approvals.markResolutionSource('shared', 'tool', 'sess-b');
  assert.throws(() => approvals.markResolutionSource('shared', 'im'), ApprovalScopeError);
  assert.throws(() => approvals.consumeResolutionSource('shared'), ApprovalScopeError);
  assert.throws(() => approvals.clearResolutionSource('shared'), ApprovalScopeError);
  assert.equal(approvals.consumeResolutionSource('shared', 'sess-a'), 'web');
  assert.equal(approvals.consumeResolutionSource('shared', 'sess-b'), 'tool');
});
