import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GIAN_TOOL_METHODS, GIAN_TOOL_MUTATION_METHODS } from '@gian/shared';
import {
  GIAN_MCP_TOOL_DEFINITIONS,
  dispatchGianMcpCall,
  dispatchGianMcpTool,
  gianMcpCallerId,
} from '../dist/adapter.js';
import { gianMcpToolDefinitions } from '../dist/schemas.js';

test('MCP exposes every Gian Tool method one-to-one with explicit write idempotency', () => {
  assert.deepEqual(
    GIAN_MCP_TOOL_DEFINITIONS.slice(0, GIAN_TOOL_METHODS.length).map(tool => tool.name),
    [...GIAN_TOOL_METHODS],
  );
  assert.equal(GIAN_MCP_TOOL_DEFINITIONS.at(-1).name, 'gian_call');
  for (const tool of GIAN_MCP_TOOL_DEFINITIONS.slice(0, GIAN_TOOL_METHODS.length)) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal('caller_id' in tool.inputSchema.properties, false);
    assert.equal('request_id' in tool.inputSchema.properties, false);
    const mutation = GIAN_TOOL_MUTATION_METHODS.includes(tool.name);
    assert.equal('idempotency_key' in tool.inputSchema.properties, mutation);
    assert.equal(tool.inputSchema.required?.includes('idempotency_key') ?? false, mutation);
  }
});

test('credential-scoped MCP catalogs and dispatch reject methods outside grants', async () => {
  const definitions = gianMcpToolDefinitions(['session.get', 'interaction.list']);
  assert.deepEqual(definitions.map(tool => tool.name), [
    'session.get',
    'interaction.list',
    'gian_call',
  ]);
  assert.deepEqual(definitions.at(-1).inputSchema.properties.method.enum, [
    'session.get',
    'interaction.list',
  ]);

  let called = false;
  const result = await dispatchGianMcpCall({
    args: { method: 'interaction.respond', params: {} },
    requestId: 'scoped-request',
    hostRequestId: () => 'scoped-request',
    dataDir: '/tmp/gian-mcp-test',
    callerId: 'internal-session:session-1',
    allowedMethods: ['session.get'],
    call: async () => {
      called = true;
      throw new Error('must not dispatch');
    },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'PERMISSION_DENIED');
  assert.equal(called, false);
});

test('generic MCP dispatcher reaches deferred method-specific tools without adding domain behavior', async () => {
  const calls = [];
  const result = await dispatchGianMcpCall({
    args: {
      method: 'session.create',
      params: { workspace_id: 'workspace-1', agent_id: 'agent-1' },
      idempotency_key: 'generic-session-create',
    },
    requestId: 'generic-request',
    hostRequestId: () => 'generic-request',
    dataDir: '/tmp/gian-mcp-test',
    callerId: 'caller-1',
    call: async options => {
      calls.push(options);
      return { ok: true, request_id: options.requestId, data: { session: { id: 'session-1' } } };
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.data.session.id, 'session-1');
  assert.deepEqual(calls, [{
    dataDir: '/tmp/gian-mcp-test',
    method: 'session.create',
    params: { workspace_id: 'workspace-1', agent_id: 'agent-1' },
    idempotencyKey: 'generic-session-create',
    callerId: 'caller-1',
    requestId: 'generic-request',
  }]);
});

test('MCP process request IDs never become reusable Host request IDs', async () => {
  const calls = [];
  const generated = ['host-request-a', 'host-request-b'];
  for (const idempotency_key of ['write-a', 'write-b']) {
    await dispatchGianMcpCall({
      args: {
        method: 'task.create',
        params: { name: idempotency_key },
        idempotency_key,
      },
      requestId: 0,
      hostRequestId: () => generated.shift(),
      dataDir: '/tmp/gian-mcp-test',
      callerId: 'caller-1',
      call: async options => {
        calls.push(options);
        return { ok: true, request_id: options.requestId, data: { task: { id: options.requestId } } };
      },
    });
  }
  assert.deepEqual(calls.map(call => call.requestId), ['host-request-a', 'host-request-b']);
});

test('MCP validates and dispatches all methods through the local RPC client', async () => {
  const calls = [];
  const paramsByMethod = {
    'catalog.get_create_options': {},
    'task.list': {},
    'task.get': { task_id: 'task-1' },
    'task.create': { name: 'MCP test' },
    'task.update': { task_id: 'task-1', pinned: true },
    'session.list': {},
    'session.get': { session_id: 'session-1' },
    'session.read': { session_id: 'session-1' },
    'session.create': { workspace_id: 'workspace-1', agent_id: 'agent-1' },
    'session.update': { session_id: 'session-1', name: 'MCP session' },
    'session.assign_task': { session_id: 'session-1', task_id: 'task-1' },
    'session.set_subtask_state': { session_id: 'session-1', state: 'completed' },
    'session.archive': { session_id: 'session-1', archived: true },
    'session.send': { session_id: 'session-1', text: 'hello' },
    'session.cancel_delivery': { delivery_id: 'delivery-1' },
    'session.wait': { session_id: 'session-1', timeout_ms: 0 },
    'session.stop': { session_id: 'session-1' },
    'worktree.create_and_bind': { branch: 'feat/managed-view', base_ref: 'HEAD' },
    'interaction.list': {},
    'interaction.respond': {
      session_id: 'session-1',
      interaction_id: 'interaction-1',
      decision: 'allow_once',
    },
  };

  for (const [index, method] of GIAN_TOOL_METHODS.entries()) {
    const mutation = GIAN_TOOL_MUTATION_METHODS.includes(method);
    const result = await dispatchGianMcpTool({
      method,
      args: {
        ...paramsByMethod[method],
        ...(mutation ? { idempotency_key: `canary-${index}` } : {}),
      },
      requestId: `request-${index}`,
      hostRequestId: () => `request-${index}`,
      dataDir: '/tmp/gian-mcp-test',
      callerId: 'caller-1',
      call: async options => {
        calls.push(options);
        return { ok: true, request_id: options.requestId, data: { method } };
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      ok: true,
      request_id: `request-${index}`,
      data: { method },
    });
  }

  assert.deepEqual(calls.map(call => call.method), [...GIAN_TOOL_METHODS]);
  for (const call of calls) {
    assert.equal(call.callerId, 'caller-1');
    const index = GIAN_TOOL_METHODS.indexOf(call.method);
    assert.equal(call.idempotencyKey, GIAN_TOOL_MUTATION_METHODS.includes(call.method)
      ? `canary-${index}`
      : undefined);
  }
});

test('MCP caller identity is stable and private', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-mcp-id-'));
  const first = await gianMcpCallerId(dataDir);
  const second = await gianMcpCallerId(dataDir);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/u);

  const path = join(dataDir, 'tool', 'mcp-caller-id');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, 'utf8')).trim(), first);
});

test('MCP returns Host errors as MCP tool errors without rewriting the envelope', async () => {
  const hostResult = {
    ok: false,
    request_id: 'request-error',
    error: { code: 'NOT_FOUND', message: 'missing', retryable: false },
  };
  const result = await dispatchGianMcpTool({
    method: 'task.get',
    args: { task_id: 'missing' },
    requestId: 'request-error',
    hostRequestId: () => 'request-error',
    dataDir: '/tmp/gian-mcp-test',
    callerId: 'caller-1',
    call: async () => hostResult,
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, hostResult);
  assert.deepEqual(JSON.parse(result.content[0].text), hostResult);
});
