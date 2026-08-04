import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ApprovalServer,
  APPROVAL_TOOL_NAME,
} from '../../src/mcp/approval-server.js';

interface CapturedRequest {
  sessionId: string;
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
}

async function startServer() {
  const captured: CapturedRequest[] = [];
  const server = new ApprovalServer({
    onPermissionRequest: (sessionId, callId, toolName, input) => {
      captured.push({ sessionId, callId, toolName, input });
    },
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onDebug: () => undefined,
  });
  const port = await server.start();
  return { server, port, captured };
}

async function connectClient(port: number, sessionId: string) {
  const url = new URL(`http://127.0.0.1:${port}/session/${sessionId}/sse`);
  const transport = new SSEClientTransport(url);
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test('ApprovalServer — exposes approval_prompt via ListTools', async () => {
  const { server, port } = await startServer();
  const client = await connectClient(port, 'list-test');
  try {
    const result = await client.listTools();
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]!.name, APPROVAL_TOOL_NAME);
  } finally {
    await client.close();
    await server.stop();
  }
});

test('ApprovalServer — CallTool suspends until resolve(allow)', async () => {
  const { server, port, captured } = await startServer();
  const client = await connectClient(port, 'sess-allow');
  try {
    const callPromise = client.callTool({
      name: APPROVAL_TOOL_NAME,
      arguments: { tool_name: 'Bash', input: { command: 'ls' } },
    });

    // Wait for the request to land in our callback.
    const start = Date.now();
    while (captured.length === 0 && Date.now() - start < 1_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(captured.length, 1);
    const req = captured[0]!;
    assert.equal(req.sessionId, 'sess-allow');
    assert.equal(req.toolName, 'Bash');
    assert.deepEqual(req.input, { command: 'ls' });

    const resolved = server.resolve(req.callId, 'allow');
    assert.equal(resolved, true);

    const result = await callPromise as { content: Array<{ type: string; text: string }> };
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, 'text');
    const payload = JSON.parse(result.content[0]!.text);
    // Allow now echoes the original input as `updatedInput` per Claude SDK
    // contract — bare `{behavior:'allow'}` wedges newer claude versions.
    assert.deepEqual(payload, { behavior: 'allow', updatedInput: { command: 'ls' } });
  } finally {
    await client.close();
    await server.stop();
  }
});

test('ApprovalServer — CallTool resolves to deny with message', async () => {
  const { server, port, captured } = await startServer();
  const client = await connectClient(port, 'sess-deny');
  try {
    const callPromise = client.callTool({
      name: APPROVAL_TOOL_NAME,
      arguments: { tool_name: 'Bash', input: { command: 'rm -rf /' } },
    });

    const start = Date.now();
    while (captured.length === 0 && Date.now() - start < 1_000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(captured.length, 1);

    server.resolve(captured[0]!.callId, 'deny', 'user said no');

    const result = await callPromise as { content: Array<{ type: string; text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    assert.deepEqual(payload, { behavior: 'deny', message: 'user said no' });
  } finally {
    await client.close();
    await server.stop();
  }
});

test('ApprovalServer — dropConnection denies any pending approvals', async () => {
  const { server, port, captured } = await startServer();
  const client = await connectClient(port, 'sess-drop');
  try {
    const callPromise = client.callTool({
      name: APPROVAL_TOOL_NAME,
      arguments: { tool_name: 'Bash', input: {} },
    });

    const start = Date.now();
    while (captured.length === 0 && Date.now() - start < 1_000) {
      await new Promise((r) => setTimeout(r, 5));
    }

    server.dropConnection('sess-drop');

    const result = await callPromise as { content: Array<{ type: string; text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    assert.equal(payload.behavior, 'deny');
    assert.equal(payload.message, 'session closed');
  } finally {
    try { await client.close(); } catch { /* connection already closed */ }
    await server.stop();
  }
});

test('ApprovalServer — resolve returns false for unknown callId', async () => {
  const { server } = await startServer();
  try {
    assert.equal(server.resolve('does-not-exist', 'allow'), false);
  } finally {
    await server.stop();
  }
});
