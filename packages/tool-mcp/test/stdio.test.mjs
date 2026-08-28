import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function startFakeHost(dataDir) {
  const calls = [];
  const runDir = join(dataDir, 'run');
  const socketPath = join(runDir, 'gian-tool-v1.sock');
  await mkdir(runDir, { recursive: true });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.push(call);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        request_id: call.request_id,
        data: call.method === 'task.list'
          ? { tasks: [] }
          : { task: { id: 'task-mcp', name: call.params.name } },
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return { server, calls };
}

test('stdio MCP lists and calls Gian tools against the Host socket', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-mcp-stdio-'));
  const { server, calls } = await startFakeHost(dataDir);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--data-dir', dataDir],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'gian-tool-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 21);
  assert.equal(listed.tools[0].name, 'catalog.get_create_options');

  const read = await client.callTool({ name: 'task.list', arguments: {} });
  assert.equal(read.isError, undefined);
  assert.deepEqual(read.structuredContent.data, { tasks: [] });

  const write = await client.callTool({
    name: 'task.create',
    arguments: { name: 'stdio MCP', idempotency_key: 'stdio-task-create' },
  });
  assert.equal(write.isError, undefined);
  assert.equal(write.structuredContent.data.task.name, 'stdio MCP');
  assert.equal(calls[1].idempotency_key, 'stdio-task-create');
  assert.deepEqual(calls[1].params, { name: 'stdio MCP' });

  const invalid = await client.callTool({
    name: 'task.create',
    arguments: { name: 'missing idempotency' },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal(calls.length, 2);

  const generic = await client.callTool({
    name: 'gian_call',
    arguments: {
      method: 'session.stop',
      params: { session_id: 'session-1' },
      idempotency_key: 'stdio-generic-stop',
    },
  });
  assert.equal(generic.isError, undefined);
  assert.equal(calls[2].method, 'session.stop');
  assert.deepEqual(calls[2].params, { session_id: 'session-1' });
  assert.equal(calls[2].idempotency_key, 'stdio-generic-stop');
});
