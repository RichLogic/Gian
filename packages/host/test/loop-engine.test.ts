// Coverage for traceability row:
//   LOOP-ENGINE-001 — advanceLoop exits: pass→done, blocked→pause,
//                     changes→continue, round-cap→ask-continue.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { TaskLoop } from '@gian/shared';
import { advanceLoop } from '../src/task/loop-engine.js';

function loop(over: Partial<TaskLoop> = {}): TaskLoop {
  return {
    id: 'l1', task_id: 't1', status: 'active',
    allowed_methods: [], allowed_workspaces: [], allowed_executors: [],
    round: 0, max_rounds: 0, current_step: null, current_step_session_id: null,
    expected_role: null, created_at: '', updated_at: '',
    ...over,
  };
}

test('LOOP-ENGINE-001: pass → done (round unchanged)', () => {
  const d = advanceLoop(loop({ round: 1, max_rounds: 3 }), { status: 'done', verdict: 'pass' });
  assert.equal(d.outcome, 'done');
  assert.equal(d.nextStatus, 'done');
  assert.equal(d.nextRound, 1);
});

test('LOOP-ENGINE-001: blocked → pause (round unchanged)', () => {
  const d = advanceLoop(loop({ round: 1, max_rounds: 3 }), { status: 'blocked', verdict: null });
  assert.equal(d.outcome, 'pause');
  assert.equal(d.nextStatus, 'paused');
  assert.equal(d.nextRound, 1);
});

test('LOOP-ENGINE-001: changes below cap → continue (round++)', () => {
  const d = advanceLoop(loop({ round: 0, max_rounds: 3 }), { status: 'done', verdict: 'changes' });
  assert.equal(d.outcome, 'continue');
  assert.equal(d.nextStatus, 'active');
  assert.equal(d.nextRound, 1);
});

test('LOOP-ENGINE-001: changes hitting the cap → ask-continue (pause)', () => {
  const d = advanceLoop(loop({ round: 2, max_rounds: 3 }), { status: 'done', verdict: 'changes' });
  assert.equal(d.outcome, 'ask-continue');
  assert.equal(d.nextStatus, 'paused');
  assert.equal(d.nextRound, 3);
});

test('LOOP-ENGINE-001: no verdict with unlimited rounds → continue forever', () => {
  const d = advanceLoop(loop({ round: 9, max_rounds: 0 }), { status: 'done' });
  assert.equal(d.outcome, 'continue');
  assert.equal(d.nextRound, 10);
});
