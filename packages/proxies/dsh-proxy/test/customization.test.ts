import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

function startProxy(bridge = resolve('test/fixtures/fake-dsh-bridge.mjs')): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [resolve('dist/src/cli/spawn.js'), `--bridge=${process.execPath}`, bridge],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
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
    next(timeoutMs = 5_000): Promise<unknown> {
      const value = queue.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolveMessage, reject) => {
        const waiter = (message: unknown) => { clearTimeout(timer); resolveMessage(message); };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for DSH Proxy output.'));
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

test('DSH Proxy negotiates 2.3 and inventories native skills read-only', async () => {
  const child = startProxy();
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

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'customization.list',
      params: { kind: 'skill' },
    });
    const listed = await responseFor(proxy, 'req-2') as { result: {
      kind: string;
      status: string;
      completeness: string;
      items: Array<{ id: string; kind: string; name: string; discovery: { method: string } }>;
      truncated: boolean;
    } };
    assert.equal(listed.result.kind, 'skill');
    assert.equal(listed.result.status, 'ok');
    assert.equal(listed.result.completeness, 'effective');
    assert.equal(listed.result.items.length, 1);
    assert.equal(listed.result.items[0]?.name, 'fake-skill');
    assert.equal(listed.result.items[0]?.discovery.method, 'provider_api');
    assert.equal(listed.result.truncated, false);

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'customization.list',
      params: { kind: 'mcp' },
    });
    const listedMcp = await responseFor(proxy, 'req-3') as { result: { kind: string; status: string; items: unknown[] } };
    assert.equal(listedMcp.result.status, 'provider_unsupported');
    assert.deepEqual(listedMcp.result.items, []);

    proxy.send({
      jsonrpc: '2.0',
      id: 'req-4',
      method: 'customization.detail',
      params: { kind: 'skill', id: listed.result.items[0]?.id },
    });
    const detail = await responseFor(proxy, 'req-4') as { result: { status: string; text: string } };
    assert.equal(detail.result.status, 'ok');
    assert.equal(detail.result.text, 'Fake skill body.');

    proxy.send({ jsonrpc: '2.0', id: 'req-5', method: 'shutdown', params: {} });
    await responseFor(proxy, 'req-5');
    assert.equal(await waitForExit(child), 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('DSH Proxy downgrades to 2.1 without customization when 2.3 is not offered', async () => {
  const child = startProxy();
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