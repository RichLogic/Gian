import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

interface JsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code?: string; message?: string };
  method?: string;
  params?: unknown;
}

function createQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(item: T) => void> = [];

  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(item);
      } else {
        items.push(item);
      }
    },
    take(timeoutMs: number, label: string) {
      const queued = items.shift();
      if (queued) {
        return Promise.resolve(queued);
      }

      return new Promise<T>((resolve, reject) => {
        const waiter = (item: T) => {
          clearTimeout(timer);
          resolve(item);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for ${label}.`));
        }, timeoutMs);

        waiters.push(waiter);
      });
    },
  };
}

async function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (proc.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for proxy shutdown.')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function startProxy(dataDir: string) {
  const proc = spawn(process.execPath, [resolve('dist/src/cli/spawn.js'), '--data-dir', dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  const responses = createQueue<JsonRpcMessage>();
  const notifications = createQueue<JsonRpcMessage>();
  let stderr = '';
  let nextId = 1;

  createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) {
      return;
    }

    const parsed = JSON.parse(line) as JsonRpcMessage;
    if (parsed.id !== undefined) {
      responses.push(parsed);
    } else {
      notifications.push(parsed);
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    async request(method: string, params?: unknown, timeoutMs = 2_000) {
      const id = nextId;
      nextId += 1;
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      const response = await responses.take(timeoutMs, `response for ${method}`);
      assert.equal(response.id, id, stderr);
      return response;
    },
    sendRaw(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    async nextNotification(method: string, timeoutMs = 2_000) {
      while (true) {
        const notification = await notifications.take(timeoutMs, `notification ${method}`);
        if (notification.method === method) {
          return notification;
        }
      }
    },
    async close() {
      if (proc.exitCode !== null) {
        return;
      }

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

test('cli smoke covers initialize, session lifecycle, and capabilities', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'cc-proxy-smoke-'));
  const proxy = startProxy(dataDir);

  try {
    const initialize = await proxy.request('initialize');
    assert.equal((initialize.result as { mode: string }).mode, 'spawn');

    const created = await proxy.request('session.create', {
      cwd: '/tmp',
    });
    const session = (created.result as {
      session: { id: string; status: string; claudeSessionId: string; sessionKey?: string };
    }).session;
    assert.equal(session.status, 'idle');
    // Stateless proxy: response carries id + claudeSessionId, no sessionKey.
    assert.ok(typeof session.claudeSessionId === 'string' && session.claudeSessionId.length > 0);
    assert.equal(session.sessionKey, undefined);

    const fetched = await proxy.request('session.get', {
      sessionId: session.id,
    });
    assert.equal((fetched.result as { session: { id: string } }).session.id, session.id);

    // capabilities now exposes only models + slashCommands; mode/defaultMode
    // were dropped in the 4-mode redesign (per-turn permissionMode replaces).
    // Probes a real `claude -p` for slash commands (~1-15s), so allow more
    // headroom than the default 2s — especially when the model-discovery
    // probes (kicked off at startup) are still resolving in parallel.
    const capabilities = await proxy.request('capabilities.list', undefined, 20_000);
    const capabilityResult = capabilities.result as { models: unknown[]; slashCommands: unknown[] };
    assert.ok(Array.isArray(capabilityResult.models));
    assert.ok(Array.isArray(capabilityResult.slashCommands));

    const missingMethod = await proxy.request('nonexistent.method');
    assert.equal(missingMethod.error?.code, 'METHOD_NOT_FOUND');
  } finally {
    await proxy.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cli smoke reports protocol errors for malformed json', async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'cc-proxy-smoke-'));
  const proxy = startProxy(dataDir);

  try {
    proxy.sendRaw('{not-json');
    const notification = await proxy.nextNotification('protocol.error');
    assert.equal((notification.params as { code: string }).code, 'INVALID_JSON');
  } finally {
    await proxy.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
