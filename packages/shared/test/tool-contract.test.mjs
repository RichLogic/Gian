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
  assert.equal(new Set(GIAN_TOOL_METHODS).size, 45);
  assert.equal(new Set(GIAN_TOOL_MUTATION_METHODS).size, 29);
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('IDEMPOTENCY_CONFLICT'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('AGENT_DELETED'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('PERMISSION_DENIED'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('PRECONDITION_FAILED'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('UNKNOWN_OUTCOME'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('COMMAND_EXPIRED'));
  assert.ok(GIAN_TOOL_ERROR_CODES.includes('SCHEDULE_CREATE_REJECTED'));
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
    'queue.update': { session_id: 'session-1', queue_id: 'queue-1', text: 'Edited' },
    'queue.remove': { session_id: 'session-1', queue_id: 'queue-1' },
    'queue.clear': { session_id: 'session-1' },
    'queue.send_now': { session_id: 'session-1' },
    'worktree.create_and_bind': { branch: 'feat/managed-view', base_ref: 'HEAD' },
    'browser.open': { url: 'https://example.com' },
    'browser.click': { tab_id: 'tab-1', snapshot_id: 'snapshot-1', ref: '@e1' },
    'browser.fill': { tab_id: 'tab-1', snapshot_id: 'snapshot-1', ref: '@e1', text: 'hello' },
    'browser.press': { tab_id: 'tab-1', key: 'Enter' },
    'browser.go_back': { tab_id: 'tab-1' },
    'browser.reload': { tab_id: 'tab-1' },
    'browser.close': { tab_id: 'tab-1' },
    'interaction.respond': { session_id: 'session-1', interaction_id: 'interaction-1', decision: 'decline' },
    'schedule.create': { name: 'Nightly', prompt: 'Run checks', trigger: { kind: 'cron', expression: '30 9 * * *' }, timezone: 'UTC' },
    'schedule.update': { schedule_id: 'schedule-1', expected_revision: 1, name: 'Renamed' },
    'schedule.pause': { schedule_id: 'schedule-1' },
    'schedule.resume': { schedule_id: 'schedule-1' },
    'schedule.run_now': { schedule_id: 'schedule-1' },
    'schedule.archive': { schedule_id: 'schedule-1' },
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

test('session.list accepts an open Proxy pluginId filter', () => {
  assert.deepEqual(validateGianToolParams('session.list', {
    proxy: 'io.gian.fixture',
  }), { proxy: 'io.gian.fixture' });
  assert.throws(() => validateGianToolParams('session.list', {
    proxy: 'not a plugin',
  }), /valid pluginId/);
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
  assert.deepEqual(validateGianToolParams('session.send', {
    session_id: 'session-1',
    text: 'hello',
    items: [{ type: 'text', text: 'hello' }],
  }).items[0].type, 'text');
  assert.throws(() => validateGianToolParams('queue.update', {
    session_id: 'session-1', queue_id: 'queue-1', text: 'x', extra: true,
  }), /unknown field/);
  assert.deepEqual(validateGianToolParams('worktree.create_and_bind', {
    branch: 'feat/managed-view', base_ref: 'origin/main',
  }), { branch: 'feat/managed-view', base_ref: 'origin/main' });
  assert.throws(() => validateGianToolParams('worktree.create_and_bind', {
    session_id: 'session-1', branch: 'feat/crafted',
  }), /unknown field/);
  assert.deepEqual(validateGianToolParams('browser.press', {
    tab_id: 'tab-1', key: 'Enter', snapshot_id: 'snapshot-1', ref: '@e1',
  }), { tab_id: 'tab-1', key: 'Enter', snapshot_id: 'snapshot-1', ref: '@e1' });
  assert.throws(() => validateGianToolParams('browser.press', {
    tab_id: 'tab-1', key: 'Enter', ref: '@e1',
  }), /snapshot_id and ref together/);
  assert.throws(() => validateGianToolParams('browser.wait', {
    tab_id: 'tab-1', condition: 'text',
  }), /requires text/);
  assert.throws(() => validateGianToolParams('browser.screenshot', {
    tab_id: 'tab-1', max_width: 200,
  }), /320 to 2000/);
});
