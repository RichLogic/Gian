// Coverage for traceability row:
//   ERR-004 — Codex CLI reports JSON-RPC request errors for malformed
//             NDJSON and unknown methods, then stays responsive.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { initializeResultSchema, proxyErrorResponseSchema } from '@gian/proxy-protocol';
import {
  CodexJsonRpcError,
  CodexProtocolError,
  jsonRpcError,
  parseRequestLine,
} from '../src/transport/protocol.js';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: { domainCode?: string } };
  method?: string;
}

function createQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(item: T) => void> = [];
  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    take(timeoutMs: number, label: string) {
      const queued = items.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<T>((resolveTake, reject) => {
        const waiter = (item: T) => {
          clearTimeout(timer);
          resolveTake(item);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${label}.`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (proc.exitCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for codex-proxy shutdown.')),
      timeoutMs,
    );
    proc.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function startProxy() {
  const proc = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'codex',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-codex-err004',
      GIAN_RUNTIME_BIN: process.execPath,
    },
  });

  const messages = createQueue<JsonRpcMessage>();
  let stderr = '';
  let nextId = 1;

  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    messages.push(parsed);
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 3_000) {
      const id = `req-${nextId}`;
      nextId += 1;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const response = await messages.take(timeoutMs, `response for ${method}`);
      assert.equal(response.id, id, `mismatched response id; stderr=${stderr}`);
      return response;
    },
    sendRaw(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    async nextMessage(timeoutMs = 3_000) {
      return messages.take(timeoutMs, 'next message');
    },
    async close() {
      if (proc.exitCode !== null) return;
      try {
        await this.request('shutdown', {}, 2_000);
      } catch {
        proc.kill('SIGTERM');
      }
      await waitForExit(proc, 2_000).catch(() => {
        proc.kill('SIGKILL');
      });
    },
  };
}

test('ERR-004: Codex CLI reports a JSON-RPC error for malformed JSON', async () => {
  const proxy = startProxy();
  try {
    proxy.sendRaw('{not-json');
    const error = proxyErrorResponseSchema.parse(await proxy.nextMessage());
    assert.equal(error.id, null);
    assert.equal(error.error.code, -32700);
    assert.equal(error.error.data, undefined);
  } finally {
    await proxy.close();
  }
});

test('ERR-004: Codex CLI replies METHOD_NOT_FOUND for unknown method', async () => {
  const proxy = startProxy();
  try {
    await proxy.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    });
    const response = await proxy.request('nonexistent.method');
    const error = proxyErrorResponseSchema.parse(response);
    assert.equal(error.error.code, -32601);
    assert.equal(error.error.data, undefined);
  } finally {
    await proxy.close();
  }
});

test('ERR-004: Codex CLI stays responsive after malformed JSON', async () => {
  const proxy = startProxy();
  try {
    proxy.sendRaw('{not-json');
    proxyErrorResponseSchema.parse(await proxy.nextMessage());
    const response = await proxy.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    });
    const result = initializeResultSchema.parse(response.result);
    assert.equal(result.protocol.version, '2.0');
    assert.equal(result.plugin.version, '0.2.3');
  } finally {
    await proxy.close();
  }
});

test('ERR-004: Codex CLI initialize reports plugin identity and shared scope', async () => {
  const proxy = startProxy();
  try {
    const response = await proxy.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    });
    const result = initializeResultSchema.parse(response.result);
    assert.equal(result.plugin.id, 'codex');
    assert.equal(result.process.scope, 'shared');
    assert.equal(result.capabilities['turn.steer'], 1);
  } finally {
    await proxy.close();
  }
});

test('ERR-004: framing separates parse, invalid request, invalid params, and domain errors', () => {
  const expectStandard = (line: string, expectedCode: number) => {
    assert.throws(
      () => parseRequestLine(line),
      (error: unknown) => error instanceof CodexJsonRpcError
        && error.code === expectedCode
        && jsonRpcError(error).data === undefined,
    );
  };

  expectStandard('{not-json', -32700);
  expectStandard('[]', -32600);
  expectStandard(JSON.stringify({ jsonrpc: '1.0', id: '1', method: 'initialize' }), -32600);
  expectStandard(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'initialize', params: [] }), -32602);

  assert.deepEqual(
    jsonRpcError(new CodexProtocolError('SESSION_BUSY', 'busy', true)),
    {
      code: -32000,
      message: 'busy',
      data: {
        domainCode: 'SESSION_BUSY',
        retryable: true,
        details: {},
      },
    },
  );
});
