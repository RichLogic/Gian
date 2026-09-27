import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

function startV2Proxy(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [resolve('dist/src/cli/spawn.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIAN_PLUGIN_ID: 'grok',
      GIAN_PLUGIN_DATA_DIR: '/tmp/gian-grok-customization-test',
      GIAN_RUNTIME_BIN: resolve('test/fixtures/fake-grok-cli.mjs'),
    },
  });
}

function wire(child: ChildProcessWithoutNullStreams) {
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const value = JSON.parse(line) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return {
    send(value: unknown) { child.stdin.write(`${JSON.stringify(value)}\n`); },
    next(timeoutMs = 8_000): Promise<unknown> {
      const value = queue.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolveMessage, reject) => {
        const waiter = (message: unknown) => { clearTimeout(timer); resolveMessage(message); };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for Grok Proxy output.'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function responseFor(proxy: ReturnType<typeof wire>, id: string) {
  while (true) {
    const message = await proxy.next() as { id?: string };
    if (message.id === id) return message as { id: string; result: unknown };
  }
}

test('Grok Proxy negotiates 2.3 with customization.list and answers proxy_unsupported', async () => {
  const child = startV2Proxy();
  try {
    const proxy = wire(child);
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.3', '2.1'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await responseFor(proxy, 'req-1') as {
      result: { protocol: { version: string }; capabilities: Record<string, number> };
    };
    assert.equal(initialized.result.protocol.version, '2.3');
    assert.equal(initialized.result.capabilities['customization.list'], 1);

    proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'customization.list', params: { kind: 'hook' } });
    const listed = await responseFor(proxy, 'req-2') as { result: {
      kind: string; status: string; completeness: string; items: unknown[]; truncated: boolean;
      diagnostics: Array<{ code: string; message: string }>;
    } };
    assert.equal(listed.result.kind, 'hook');
    assert.equal(listed.result.status, 'proxy_unsupported');

    assert.equal(listed.result.completeness, 'none');
    assert.deepEqual(listed.result.items, []);
    assert.equal(listed.result.truncated, false);
    assert.equal(listed.result.diagnostics[0]!.code, 'SOURCE_NOT_ENUMERABLE');
    assert.match(listed.result.diagnostics[0]!.message, /attach a session before listing hooks/);

    // Rules have no native enumeration surface and are reported as such.
    proxy.send({ jsonrpc: '2.0', id: 'req-2b', method: 'customization.list', params: { kind: 'rule' } });
    const rules = await responseFor(proxy, 'req-2b') as { result: { status: string; completeness: string; items: unknown[] } };
    assert.equal(rules.result.status, 'provider_unsupported');
    assert.equal(rules.result.completeness, 'none');
    assert.deepEqual(rules.result.items, []);

    // Skills enumerate through the runtime's own disk reload (x.ai/skills/list).
    proxy.send({ jsonrpc: '2.0', id: 'req-2c', method: 'customization.list', params: { kind: 'skill', cwd: '/tmp' } });
    const skills = await responseFor(proxy, 'req-2c') as { result: { status: string; completeness: string; items: unknown[] } };
    assert.equal(skills.result.status, 'ok');
    assert.equal(skills.result.completeness, 'configured');
    assert.deepEqual(skills.result.items, []);

    proxy.send({ jsonrpc: '2.0', id: 'req-3', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-3');
    assert.equal(await waitForExit(child), 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('Grok Proxy downgrades to 2.1 without customization when 2.3 is not offered', async () => {
  const child = startV2Proxy();
  try {
    const proxy = wire(child);
    proxy.send({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
      params: {
        protocol: { name: 'gian.proxy', versions: ['2.1', '2.0'] },
        host: { name: 'Gian', version: '9.9.9' },
      },
    });
    const initialized = await responseFor(proxy, 'req-1') as {
      result: { protocol: { version: string }; capabilities: Record<string, number> };
    };
    assert.equal(initialized.result.protocol.version, '2.1');
    assert.equal(initialized.result.capabilities['customization.list'], undefined);
    proxy.send({ jsonrpc: '2.0', id: 'req-2', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-2');
    assert.equal(await waitForExit(child), 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
