import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import test from 'node:test';
import { initializeResultSchema, proxyErrorResponseSchema } from '@gian/proxy-protocol';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolveExit => child.once('exit', code => resolveExit(code)));
}

function startV1Proxy() {
  const child = spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'codex',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-codex-v1-test',
      GIAN_RUNTIME_BIN: process.execPath,
      GIAN_PROTOCOL_VERSIONS: '1.0',
    },
  });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    const value = JSON.parse(line) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else messages.push(value);
  });
  return {
    child,
    send(value: unknown) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    sendRaw(line: string) {
      child.stdin.write(`${line}\n`);
    },
    next(): Promise<unknown> {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise(resolveMessage => waiters.push(resolveMessage));
    },
  };
}

test('codex CLI negotiates gian.proxy/1 while legacy mode remains opt-in by environment', async () => {
  const proxy = startV1Proxy();
  proxy.send({
    id: 1,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const initialized = proxy.next() as Promise<{ id: number; result: unknown }>;
  assert.equal((await initialized).id, 1);
  assert.equal(initializeResultSchema.parse((await initialized).result).plugin.version, '0.1.0');

  proxy.send({ id: 2, method: 'does.not.exist', params: {} });
  const missing = proxyErrorResponseSchema.parse(await proxy.next());
  assert.equal(missing.error.code, 'METHOD_NOT_FOUND');

  proxy.send({ id: 3, method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { id: 3, result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('codex gian.proxy/1 CLI treats malformed NDJSON as a fatal protocol failure', async () => {
  const proxy = startV1Proxy();
  proxy.sendRaw('{not-json');
  assert.notEqual(await waitForExit(proxy.child), 0);
});
