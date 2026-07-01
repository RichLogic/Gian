// Coverage for traceability row:
//   ACTION-AUTH-001 — method↔role hard gate + loop-bounded execute/staged/reject.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { GianAction, TaskLoop } from '@gian/shared';
import { authorizeAction } from '../src/task/action-authorize.js';

const createSubtask: GianAction = {
  method: 'create_subtask',
  params: { workspace: 'repoA', executor: 'claude', brief: 'do X' },
};
const submitStep: GianAction = {
  method: 'submit_step',
  params: { status: 'done', headline: 'done', verdict: 'pass' },
};

function loop(over: Partial<TaskLoop> = {}): TaskLoop {
  return {
    id: 'l1', task_id: 't1', status: 'active',
    allowed_methods: [], allowed_workspaces: [], allowed_executors: [],
    round: 0, max_rounds: 0, current_step: null, current_step_session_id: null,
    expected_role: null, created_at: '', updated_at: '',
    ...over,
  };
}

test('ACTION-AUTH-001: create_subtask from a non-PM is rejected (role gate)', () => {
  const r = authorizeAction({ action: createSubtask, senderRole: 'engineer', senderSessionId: 's1', loop: null });
  assert.equal(r.decision, 'rejected');
});

test('ACTION-AUTH-001: create_subtask from PM with no loop is staged', () => {
  const r = authorizeAction({ action: createSubtask, senderRole: 'pm', senderSessionId: 'm1', loop: null, workspaceId: 'w1' });
  assert.equal(r.decision, 'staged');
});

test('ACTION-AUTH-001: create_subtask from PM inside an authorizing loop executes', () => {
  const r = authorizeAction({ action: createSubtask, senderRole: 'pm', senderSessionId: 'm1', loop: loop({ max_rounds: 3 }), workspaceId: 'w1' });
  assert.equal(r.decision, 'execute');
});

test('ACTION-AUTH-001: loop allowlists gate to staged when out of bounds', () => {
  const wrongExec = authorizeAction({ action: createSubtask, senderRole: 'pm', senderSessionId: 'm1', loop: loop({ allowed_executors: ['codex'] }), workspaceId: 'w1' });
  assert.equal(wrongExec.decision, 'staged');
  const wrongWs = authorizeAction({ action: createSubtask, senderRole: 'pm', senderSessionId: 'm1', loop: loop({ allowed_workspaces: ['w9'] }), workspaceId: 'w1' });
  assert.equal(wrongWs.decision, 'staged');
  const notMethod = authorizeAction({ action: createSubtask, senderRole: 'pm', senderSessionId: 'm1', loop: loop({ allowed_methods: ['submit_step'] }), workspaceId: 'w1' });
  assert.equal(notMethod.decision, 'staged');
});

test('ACTION-AUTH-001: round budget exhausted → staged', () => {
  const r = authorizeAction({ action: createSubtask, senderRole: 'pm', senderSessionId: 'm1', loop: loop({ round: 3, max_rounds: 3 }), workspaceId: 'w1' });
  assert.equal(r.decision, 'staged');
});

test('ACTION-AUTH-001: submit_step from engineer executes (no loop needed)', () => {
  const r = authorizeAction({ action: submitStep, senderRole: 'engineer', senderSessionId: 'e1', loop: null });
  assert.equal(r.decision, 'execute');
});

test('ACTION-AUTH-001: submit_step from PM is rejected (role gate)', () => {
  const r = authorizeAction({ action: submitStep, senderRole: 'pm', senderSessionId: 'm1', loop: null });
  assert.equal(r.decision, 'rejected');
});

test('ACTION-AUTH-001: submit_step from the wrong session is rejected (anti-spoof)', () => {
  const r = authorizeAction({ action: submitStep, senderRole: 'engineer', senderSessionId: 'e2', loop: loop({ current_step_session_id: 'e1' }) });
  assert.equal(r.decision, 'rejected');
});

test('ACTION-AUTH-001: submit_step from the pinned step session executes', () => {
  const r = authorizeAction({ action: submitStep, senderRole: 'engineer', senderSessionId: 'e1', loop: loop({ current_step_session_id: 'e1' }) });
  assert.equal(r.decision, 'execute');
});
