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
      GIAN_PLUGIN_ID: 'claude',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-claude-v1-test',
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
    send(value: unknown) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    sendRaw(line: string) { child.stdin.write(`${line}\n`); },
    sendBytes(bytes: number[]) { child.stdin.write(Buffer.from(bytes)); },
    next(): Promise<unknown> {
      const value = messages.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise(resolveMessage => waiters.push(resolveMessage));
    },
  };
}

test('Claude CLI negotiates gian.proxy/1 and reports its independent version', async (t) => {
  const proxy = startV1Proxy();
  t.after(() => {
    if (proxy.child.exitCode === null) proxy.child.kill('SIGTERM');
  });
  proxy.send({
    id: 1,
    method: 'initialize',
    params: {
      protocol: { name: 'gian.proxy', versions: ['1.0'] },
      host: { name: 'Gian', version: '9.9.9' },
    },
  });
  const initialized = await proxy.next() as { id: number; result: unknown };
  assert.equal(initialized.id, 1);
  assert.equal(initializeResultSchema.parse(initialized.result).plugin.version, '0.1.1');

  proxy.send({ id: 2, method: 'does.not.exist', params: {} });
  assert.equal(proxyErrorResponseSchema.parse(await proxy.next()).error.code, 'METHOD_NOT_FOUND');

  proxy.send({ id: 3, method: 'shutdown', params: {} });
  assert.deepEqual(await proxy.next(), { id: 3, result: { ok: true } });
  assert.equal(await waitForExit(proxy.child), 0);
});

test('Claude gian.proxy/1 CLI treats malformed NDJSON as a fatal protocol failure', async () => {
  const proxy = startV1Proxy();
  proxy.sendRaw('{not-json');
  assert.notEqual(await waitForExit(proxy.child), 0);
});

test('Claude gian.proxy/1 CLI treats invalid UTF-8 as a fatal protocol failure', async () => {
  const proxy = startV1Proxy();
  proxy.sendBytes([0xc3, 0x28, 0x0a]);
  assert.notEqual(await waitForExit(proxy.child), 0);
});
