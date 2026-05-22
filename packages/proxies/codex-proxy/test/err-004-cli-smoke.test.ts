// Coverage for traceability row:
//   ERR-004 — codex-proxy CLI must mirror cc-proxy's protocol error
//             behavior: malformed JSON yields a `protocol.error`
//             notification with INVALID_JSON, and an unknown method yields
//             a `METHOD_NOT_FOUND` error response on the request id.
//
// The cc-proxy already covers this in its smoke.test.ts; this file ports
// the equivalent assertions to the codex-proxy CLI. The codex runtime
// (`CodexAppServerClient`) is only spawned lazily on first turn, so the
// CLI can boot, read stdin, and reply to protocol errors without a real
// `codex` binary on PATH.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

interface JsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code?: string; message?: string };
  method?: string;
  params?: { code?: string; message?: string };
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
    env: process.env,
  });

  const responses = createQueue<JsonRpcMessage>();
  const notifications = createQueue<JsonRpcMessage>();
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
    if (parsed.id !== undefined) responses.push(parsed);
    else notifications.push(parsed);
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    async request(method: string, params?: unknown, timeoutMs = 3_000) {
      const id = nextId;
      nextId += 1;
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      const response = await responses.take(timeoutMs, `response for ${method}`);
      assert.equal(response.id, id, `mismatched response id; stderr=${stderr}`);
      return response;
    },
    sendRaw(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    async nextNotification(method: string, timeoutMs = 3_000) {
      while (true) {
        const notification = await notifications.take(timeoutMs, `notification ${method}`);
        if (notification.method === method) return notification;
      }
    },
    async close() {
      if (proc.exitCode !== null) return;
      try {
        await this.request('shutdown', undefined, 2_000);
      } catch {
        proc.kill('SIGTERM');
      }
      await waitForExit(proc, 2_000).catch(() => {
        proc.kill('SIGKILL');
      });
    },
  };
}

test('ERR-004: codex-proxy CLI reports protocol.error for malformed JSON', async () => {
  const proxy = startProxy();
  try {
    proxy.sendRaw('{not-json');
    const notification = await proxy.nextNotification('protocol.error');
    assert.equal(notification.params?.code, 'INVALID_JSON',
      'malformed JSON must produce a protocol.error notification with code INVALID_JSON');
    assert.ok(notification.params?.message,
      'protocol.error notification must carry a human-readable message');
  } finally {
    await proxy.close();
  }
});

test('ERR-004: codex-proxy CLI replies METHOD_NOT_FOUND for unknown method', async () => {
  const proxy = startProxy();
  try {
    const response = await proxy.request('nonexistent.method');
    assert.equal(response.error?.code, 'METHOD_NOT_FOUND',
      'unknown method must come back as METHOD_NOT_FOUND on the request id');
    // Note: protocolError() in transport/protocol.ts stringifies non-Error
    // values via String(), so the message text isn't preserved on the wire
    // — but the code is. cc-proxy smoke asserts the same contract and
    // doesn't check the message either. The error envelope being keyed by
    // the originating request id is what matters.
    assert.ok(typeof response.error?.message === 'string',
      'METHOD_NOT_FOUND response must include a message string');
  } finally {
    await proxy.close();
  }
});

test('ERR-004: codex-proxy CLI stays responsive after malformed JSON (no crash)', async () => {
  // The CLI must not exit or stall after a malformed line. Send junk, then
  // verify a subsequent legitimate request still routes back to the right
  // id. Without this, a single bad client could halt the whole proxy.
  const proxy = startProxy();
  try {
    proxy.sendRaw('{not-json');
    await proxy.nextNotification('protocol.error');

    const response = await proxy.request('initialize');
    const result = response.result as { mode: string };
    assert.equal(result.mode, 'spawn',
      'CLI must continue serving requests after protocol.error');
  } finally {
    await proxy.close();
  }
});

test('ERR-004: codex-proxy CLI initialize payload reports its methods registry', async () => {
  // Mirrors cc-proxy smoke's initialize assertion. We don't snapshot every
  // method (that's CONTRACT-003's job) but we verify the CLI responds with
  // a plausible shape so the smoke harness has at least one positive path
  // alongside the negative-protocol tests above.
  const proxy = startProxy();
  try {
    const response = await proxy.request('initialize');
    const result = response.result as { mode: string; protocolVersion: string; methods: string[] };
    assert.equal(result.mode, 'spawn');
    assert.equal(typeof result.protocolVersion, 'string');
    assert.ok(Array.isArray(result.methods), 'methods must be an array');
    // Sanity-check a couple of core method names are present.
    assert.ok(result.methods.includes('turn.start'), 'methods must include turn.start');
    assert.ok(result.methods.includes('session.create'), 'methods must include session.create');
  } finally {
    await proxy.close();
  }
});
