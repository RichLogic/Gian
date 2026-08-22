import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: string | number; message?: string; data?: { domainCode?: string } };
  method?: string;
  params?: unknown;
}

/**
 * The CLI smoke tests boot the real proxy, which probes a real `claude`
 * binary for slash-command and model discovery. They only run where a usable
 * Claude Code CLI is available (e.g. developer machines). CI runners and
 * environments without a working `claude` skip these tests instead of
 * failing the suite.
 */
async function claudeIsAvailable(): Promise<boolean> {
  const bin = process.env.CLAUDE_BIN?.trim() || 'claude';
  try {
    const probe = spawn(bin, ['--version'], { stdio: 'ignore' });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => {
        probe.kill('SIGKILL');
        resolveExit(null);
      }, 5_000);
      probe.once('error', () => {
        clearTimeout(timer);
        resolveExit(null);
      });
      probe.once('exit', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    return exitCode === 0;
  } catch {
    return false;
  }
}

const claudeAvailable = await claudeIsAvailable();
const smokeSkip: boolean | string = claudeAvailable ? false : 'requires a usable claude CLI';

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
      const id = `req-${nextId}`;
      nextId += 1;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
      const response = await responses.take(timeoutMs, `response for ${method}`);
      assert.equal(response.id, id, stderr);
      return response;
    },
    sendRaw(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    nextResponse(timeoutMs = 2_000) {
      return responses.take(timeoutMs, 'json-rpc response');
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

test('cli smoke covers initialize, session lifecycle, and capabilities', { skip: smokeSkip }, async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'cc-proxy-smoke-'));
  const proxy = startProxy(dataDir);

  try {
    const initialize = await proxy.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    });
    const handshake = initialize.result as {
      protocol: { version: string };
      plugin: { id: string };
      process: { scope: string };
    };
    assert.equal(handshake.protocol.version, '2.0');
    assert.equal(handshake.plugin.id, 'claude');
    assert.equal(handshake.process.scope, 'session');

    const created = await proxy.request('session.create', {
      sessionId: 'smoke-session',
      workspace: { cwd: '/tmp', roots: ['/tmp'] },
      config: {},
    });
    const session = (created.result as {
      session: { id: string; state: string; nativeSession: { id: string }; streamId: string };
    }).session;
    assert.equal(session.id, 'smoke-session');
    assert.equal(session.state, 'idle');
    assert.ok(session.nativeSession.id.length > 0);
    assert.ok(session.streamId.length > 0);

    const fetched = await proxy.request('session.get', {
      sessionId: session.id,
    });
    assert.equal((fetched.result as { session: { id: string } }).session.id, session.id);

    const catalog = await proxy.request('catalog.list', undefined, 20_000);
    const catalogResult = catalog.result as {
      catalogRevision: string;
      configOptions: unknown[];
      slashCommands: unknown[];
    };
    assert.ok(catalogResult.catalogRevision.length > 0);
    assert.ok(Array.isArray(catalogResult.configOptions));
    assert.ok(Array.isArray(catalogResult.slashCommands));

    const missingMethod = await proxy.request('nonexistent.method');
    assert.equal(missingMethod.error?.code, -32601);
    assert.equal(missingMethod.error?.data?.domainCode, 'METHOD_NOT_FOUND');
  } finally {
    await proxy.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cli smoke reports protocol errors for malformed json', { skip: smokeSkip }, async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'cc-proxy-smoke-'));
  const proxy = startProxy(dataDir);

  try {
    proxy.sendRaw('{not-json');
    const error = await proxy.nextResponse();
    assert.equal(error.id, null);
    assert.equal(error.error?.code, -32700);
    assert.equal(error.error?.data?.domainCode, 'PARSE_ERROR');
  } finally {
    await proxy.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
