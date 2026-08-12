import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ApprovalServer,
  APPROVAL_TOOL_NAME,
  type ApprovalServerOptions,
} from '../src/mcp/approval-server.js';

interface CapturedRequest {
  sessionId: string;
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
}

async function startServer(options?: ApprovalServerOptions) {
  const captured: CapturedRequest[] = [];
  const disconnected: string[] = [];
  const server = new ApprovalServer({
    onPermissionRequest: (sessionId, callId, toolName, input) => {
      captured.push({ sessionId, callId, toolName, input });
    },
    onConnected: () => undefined,
    onDisconnected: sessionId => { disconnected.push(sessionId); },
    onDebug: () => undefined,
  }, options);
  const port = await server.start();
  return { server, port, captured, disconnected };
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

test('ApprovalServer — pending Question survives a transient keepalive callback fault and still submits', async () => {
  let keepaliveAttempts = 0;
  const { server, port, captured } = await startServer({
    keepAliveIntervalMs: 10,
    writeKeepalive(response) {
      keepaliveAttempts += 1;
      if (keepaliveAttempts === 1) throw new Error('injected keepalive write failure');
      response.write(': keepalive\n\n');
    },
  });
  const client = await connectClient(port, 'sess-idle-question');
  try {
    const callPromise = client.callTool({
      name: APPROVAL_TOOL_NAME,
      arguments: {
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Continue?', options: ['Yes', 'No'] }] },
      },
    });

    const deadline = Date.now() + 1_000;
    while ((captured.length === 0 || keepaliveAttempts < 2) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(captured.length, 1);
    assert.ok(keepaliveAttempts >= 2, 'request crossed the failed ping and a later keepalive');

    assert.equal(server.resolve(
      captured[0]!.callId,
      'deny',
      'Q: Continue?\nA: Yes',
    ), true);
    const result = await callPromise as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(JSON.parse(result.content[0]!.text), {
      behavior: 'deny',
      message: 'Q: Continue?\nA: Yes',
    });
  } finally {
    await client.close();
    await server.stop();
  }
});

test('ApprovalServer — a real SSE break clears the old Question and a reconnect can submit', async () => {
  let disconnectNextPing = false;
  const { server, port, captured, disconnected } = await startServer({
    keepAliveIntervalMs: 10,
    writeKeepalive(response) {
      if (disconnectNextPing) {
        disconnectNextPing = false;
        response.destroy();
        return;
      }
      response.write(': keepalive\n\n');
    },
  });
  const firstClient = await connectClient(port, 'sess-disconnected-question');
  let secondClient: Client | undefined;
  try {
    const firstCall = firstClient.callTool({
      name: APPROVAL_TOOL_NAME,
      arguments: {
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Continue?', options: ['Yes', 'No'] }] },
      },
    }).then(
      result => ({ status: 'resolved' as const, result }),
      error => ({ status: 'rejected' as const, error }),
    );

    const firstDeadline = Date.now() + 1_000;
    while (captured.length === 0 && Date.now() < firstDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(captured.length, 1);
    const staleCallId = captured[0]!.callId;

    disconnectNextPing = true;
    const disconnectDeadline = Date.now() + 1_000;
    while (disconnected.length === 0 && Date.now() < disconnectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(disconnected, ['sess-disconnected-question']);
    assert.equal(server.resolve(staleCallId, 'allow'), false, 'stale call was removed on disconnect');
    // Legacy EventSource retries a severed SSE response instead of invoking
    // Protocol.onclose. Explicit client teardown models the provider process
    // abandoning that broken channel and rejects its now-unanswerable call.
    await firstClient.close();
    assert.equal((await firstCall).status, 'rejected');

    secondClient = await connectClient(port, 'sess-disconnected-question');
    const secondCall = secondClient.callTool({
      name: APPROVAL_TOOL_NAME,
      arguments: {
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Continue?', options: ['Yes', 'No'] }] },
      },
    });
    const reconnectDeadline = Date.now() + 1_000;
    while (captured.length < 2 && Date.now() < reconnectDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(captured.length, 2);
    assert.equal(server.resolve(
      captured[1]!.callId,
      'deny',
      'Q: Continue?\nA: Yes',
    ), true);

    const result = await secondCall as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(JSON.parse(result.content[0]!.text), {
      behavior: 'deny',
      message: 'Q: Continue?\nA: Yes',
    });
  } finally {
    try { await firstClient.close(); } catch { /* connection already broken */ }
    try { await secondClient?.close(); } catch { /* test cleanup */ }
    await server.stop();
  }
});
