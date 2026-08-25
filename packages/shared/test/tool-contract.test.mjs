import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GIAN_TOOL_ERROR_CODES,
  GIAN_TOOL_METHODS,
  GIAN_TOOL_MUTATION_METHODS,
  validateGianToolCall,
  validateGianToolParams,
  validateGianToolResult,
} from '../dist/tool.js';

test('Gian Tool contract exposes a closed method and error surface', () => {
  assert.equal(new Set(GIAN_TOOL_METHODS).size, 19);
  assert.equal(new Set(GIAN_TOOL_MUTATION_METHODS).size, 11);
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('IDEMPOTENCY_CONFLICT'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('AGENT_DELETED'));
});

test('every mutation requires a stable idempotency key', () => {
  const params = {
    'task.create': { name: 'Ship Tool' },
    'task.update': { task_id: 'task-1', pinned: true },
    'session.create': { workspace_id: 'workspace-1', agent_id: 'agent-1' },
    'session.update': { session_id: 'session-1', name: 'Renamed' },
    'session.assign_task': { session_id: 'session-1', task_id: 'task-1' },
    'session.set_subtask_state': { session_id: 'session-1', state: 'completed' },
    'session.archive': { session_id: 'session-1', archived: true },
    'session.send': { session_id: 'session-1', text: 'Continue' },
    'session.cancel_delivery': { delivery_id: 'delivery-1' },
    'session.stop': { session_id: 'session-1' },
    'interaction.respond': { session_id: 'session-1', interaction_id: 'interaction-1', decision: 'decline' },
  };
  assert.deepEqual(Object.keys(params), [...GIAN_TOOL_MUTATION_METHODS]);
  for (const [method, methodParams] of Object.entries(params)) {
    assert.throws(() => validateGianToolCall({
      request_id: 'request-1',
      caller_id: 'caller-1',
      method,
      params: methodParams,
    }), /idempotency_key is required/, method);
  }

  assert.deepEqual(validateGianToolCall({
    request_id: 'request-1',
    caller_id: 'caller-1',
    idempotency_key: 'task-create-1',
    method: 'task.create',
    params: { name: 'Ship Tool' },
  }).params, { name: 'Ship Tool' });
});

test('result envelopes reject open error codes and contradictory payloads', () => {
  assert.deepEqual(validateGianToolResult({
    ok: true,
    request_id: 'request-1',
    data: { tasks: [] },
  }).data, { tasks: [] });
  assert.throws(() => validateGianToolResult({
    ok: false,
    request_id: 'request-1',
    error: { code: 'SURPRISE', message: 'nope', retryable: false },
  }), /code is invalid/);
  assert.throws(() => validateGianToolResult({
    ok: true,
    request_id: 'request-1',
    data: {},
    error: { code: 'INTERNAL_ERROR', message: 'nope', retryable: true },
  }), /must not contain error/);
});

test('session.create is Agent-based and accepts standard plus generic config', () => {
  const params = validateGianToolParams('session.create', {
    workspace_id: 'workspace-1',
    task_id: 'task-1',
    agent_id: 'agent-1',
    config: {
      model: null,
      thinking_effort: 'high',
      approval_mode: 'ask',
      session: { mode: 'default', enabled: true },
      turn: { effort: 'high', count: 2 },
    },
  });
  assert.equal(params.agent_id, 'agent-1');
  assert.equal(params.config.turn.effort, 'high');
  assert.throws(() => validateGianToolParams('session.create', {
    workspace_id: 'workspace-1',
    executor: 'grok',
  }), /unknown field|agent_id/);
});

test('bounded inputs and closed enums fail at the contract boundary', () => {
  assert.throws(() => validateGianToolParams('session.wait', {
    session_id: 'session-1', timeout_ms: 45_001,
  }), /0 to 45000/);
  assert.throws(() => validateGianToolParams('task.update', {
    task_id: 'task-1', status: 'deleted',
  }), /status is invalid/);
  assert.throws(() => validateGianToolParams('interaction.respond', {
    session_id: 'session-1', interaction_id: 'interaction-1', decision: 'approve_everything',
  }), /decision is invalid/);
  assert.throws(() => validateGianToolParams('session.send', {
    session_id: 'session-1', text: 'hello', attachment: '/tmp/secret',
  }), /unknown field/);
});
