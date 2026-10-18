import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ATTENTION_EVENT_LABELS,
  attentionSessionName,
  parseAttentionLookup,
  parseAttentionServerFrame,
  safeAttentionSessionName,
} from '../dist/index.js';

const legacy = {
  type: 'attention',
  id: 'gian:s1:2:turn-completed:done',
  session_id: 's1',
  turn: 2,
  kind: 'turn-completed',
  timestamp: 100,
  title: 'Gian · Session completed',
  body: 'Turn 2 completed.',
  provider: 'codex',
};

const semantic = {
  type: 'attention',
  id: 'gian:s1:2:turn_complete',
  session_id: 's1',
  turn: 2,
  kind: 'turn-completed',
  timestamp: 100,
  title: 'Design notes',
  body: 'Turn complete',
  provider: 'codex',
  event: 'turn_complete',
  session_name: 'Design notes',
  target: { type: 'session', session_id: 's1', turn: 2, interaction_id: null },
  inbox_ref: { id: 'item-01', generation: 3 },
};

test('legacy attention stays valid and semantic frames require name, event, and target', () => {
  assert.deepEqual(parseAttentionServerFrame(legacy), legacy);
  assert.equal(safeAttentionSessionName('Design notes'), 'Design notes');
  assert.equal(safeAttentionSessionName(''), '');
  assert.equal(safeAttentionSessionName('/tmp/secret'), null);
  assert.equal(safeAttentionSessionName('~/repo'), null);
  assert.equal(attentionSessionName('  Design notes  '), 'Design notes');
  assert.equal(attentionSessionName('/tmp/secret'), '');
  assert.equal(safeAttentionSessionName(attentionSessionName('  Design notes  ')), 'Design notes');
  assert.equal(ATTENTION_EVENT_LABELS.plan_review_needed, 'Plan review needed');
  assert.deepEqual(parseAttentionServerFrame(semantic), semantic);
  assert.throws(() => parseAttentionServerFrame({ ...semantic, body: 'The agent finished turn 2.' }));
  assert.throws(() => parseAttentionServerFrame({ ...semantic, session_name: '/Users/a/repo', title: '/Users/a/repo' }));
  assert.throws(() => parseAttentionServerFrame({ ...semantic, kind: 'question' }));
  assert.throws(() => parseAttentionServerFrame({ ...semantic, inbox_ref: { id: 'item-01' } }));
  assert.throws(() => parseAttentionServerFrame({ ...legacy, inbox_ref: { id: 'item-01', generation: 1 } }));
  assert.throws(() => parseAttentionServerFrame({ ...semantic, transcript: 'secret' }));
  const opaqueId = `${'问'.repeat(600)}\u0000id /with space`;
  const sideChat = {
    ...semantic,
    target: {
      type: 'side_chat',
      parent_session_id: 'parent-1',
      sidechat_id: 'side-1',
      turn: 2,
      interaction_id: opaqueId,
    },
  };
  delete sideChat.inbox_ref;
  assert.equal(parseAttentionServerFrame(sideChat).target.interaction_id, opaqueId);
  assert.throws(() => parseAttentionServerFrame({
    ...sideChat,
    target: { ...sideChat.target, interaction_id: '' },
  }));
});

test('schedule confirmation attention omits turn and keeps the confirmation target', () => {
  const confirmation = {
    type: 'attention',
    id: 'gian:attention:confirmation',
    session_id: 's1',
    kind: 'approval',
    timestamp: 100,
    title: 'Design notes',
    body: 'Approval needed',
    provider: 'codex',
    event: 'approval_needed',
    session_name: 'Design notes',
    target: { type: 'schedule_confirmation', confirmation_id: 'conf-1' },
    inbox_ref: { id: 'item-01', generation: 1 },
  };
  assert.equal('turn' in confirmation, false);
  assert.deepEqual(parseAttentionServerFrame(confirmation), confirmation);
  assert.throws(() => parseAttentionServerFrame({ ...confirmation, turn: 1 }));
  const missingRef = { ...confirmation };
  delete missingRef.inbox_ref;
  assert.throws(() => parseAttentionServerFrame(missingRef));
  assert.throws(() => parseAttentionServerFrame({
    ...confirmation,
    event: 'answer_needed',
    kind: 'question',
    body: 'Answer needed',
  }));
  assert.throws(() => parseAttentionServerFrame({
    ...confirmation,
    schedule: { schedule_id: 'sched', run_id: 'run' },
  }));
  const sessionWithoutTurn = { ...semantic };
  delete sessionWithoutTurn.turn;
  assert.throws(() => parseAttentionServerFrame(sessionWithoutTurn));
});

test('control and lookup frames carry ids and read state only', () => {
  const control = {
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 3, revision: 4, read: true, terminal: false }],
  };
  assert.deepEqual(parseAttentionServerFrame(control), control);
  assert.throws(() => parseAttentionServerFrame({
    ...control,
    items: [{ ...control.items[0], title: 'Design notes' }],
  }));
  const lookup = { type: 'attention:lookup', refs: [{ id: 'item-01', generation: 3 }] };
  assert.deepEqual(parseAttentionLookup(lookup), lookup);
  assert.throws(() => parseAttentionLookup({
    type: 'attention:lookup',
    refs: Array.from({ length: 33 }, (_, index) => ({ id: `item-${index}`, generation: 1 })),
  }));
  assert.throws(() => parseAttentionServerFrame({
    type: 'attention:control',
    items: [{ id: 'item-01', generation: 3, revision: 1, read: true, terminal: false, summary: 'body' }],
  }));
});
