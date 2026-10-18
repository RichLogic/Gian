import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RuntimeBootstrapError } from '../src/runtime/bootstrap.js';
import {
  DEV_RUNTIME_PROXY_PROBE_TIMEOUT_MS,
  DevRuntimeProbeError,
  probeDevRuntimeVersion,
  type ProbeDevRuntimeVersionInput,
} from '../src/runtime/dev-runtime-probe.js';

const coordinate = {
  pluginId: 'example.proxy',
  runtimeId: 'example',
  version: '1.2.3',
  probe: { kind: 'proxy' },
};

function declaration(entryPath: string): ProbeDevRuntimeVersionInput['declaration'] {
  return {
    pluginId: coordinate.pluginId,
    runtimeId: coordinate.runtimeId,
    versions: [coordinate.version],
    pluginVersion: '1.0.0',
    processScope: 'session',
    displayName: 'Example Runtime',
    entryPath,
  };
}

function fakeProxySource(trace: string, mode: string): string {
  return `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = ${JSON.stringify(trace)};
const mode = ${JSON.stringify(mode)};
const note = (method) => {
  appendFileSync(trace, JSON.stringify({
    method,
    pid: process.pid,
    HOME: process.env.HOME ?? null,
    GEMINI_HOME: process.env.GEMINI_HOME ?? null,
    GIAN_AGENT_HOME: process.env.GIAN_AGENT_HOME ?? null,
  }) + '\\n');
};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  note(req.method);
  const reply = (result) => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  };
  if (req.method === 'initialize') {
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id: 'example.proxy', name: 'Example', version: '1.0.0' },
      process: { scope: 'session' },
      capabilities: mode === 'no-capability'
        ? { 'runtime.discover': 1 }
        : { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'runtime.probe') {
    if (mode === 'timeout') return;
    const path = req.params.path;
    reply({
      runtimeId: mode === 'bad-id' ? 'other' : 'example',
      displayName: mode === 'bad-name' ? 'Other Runtime' : 'Example Runtime',
      path: mode === 'bad-path' ? path + '-other' : path,
      version: mode === 'bad-version' ? '9.9.9' : '1.2.3',
      configHome: null,
      contentRoots: [{ path, mode: 'file' }],
    });
    return;
  }
  if (req.method === 'shutdown') {
    reply({ ok: true });
    process.exit(0);
  }
});
`;
}

async function fixture(mode: string): Promise<{
  root: string;
  entry: string;
  executable: string;
  trace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-probe-'));
  const trace = join(root, 'trace.log');
  const entry = join(root, 'proxy.mjs');
  const executable = join(root, 'bin', 'example');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(entry, fakeProxySource(trace, mode));
  await writeFile(executable, `#!/bin/sh
printf 'executed\\n' >> ${JSON.stringify(trace)}
printf '1.2.3\\n'
`);
  await chmod(executable, 0o755);
  return { root, entry, executable, trace };
}

function tracedMethods(raw: string): Array<{
  method: string;
  pid: number;
  HOME: string | null;
  GEMINI_HOME: string | null;
  GIAN_AGENT_HOME: string | null;
}> {
  return raw.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as {
    method: string;
    pid: number;
    HOME: string | null;
    GEMINI_HOME: string | null;
    GIAN_AGENT_HOME: string | null;
  });
}

test('runtime.probe confirms identity inside an isolated home and does not execute the Runtime', async () => {
  const { root, entry, executable, trace } = await fixture('ok');
  try {
    const version = await probeDevRuntimeVersion({
      executable,
      coordinate,
      declaration: declaration(entry),
      hostVersion: '0.0.0-test',
      timeoutMs: 5_000,
    });
    assert.equal(version, '1.2.3');
    const events = tracedMethods(await readFile(trace, 'utf8'));
    assert.deepEqual(events.map((event) => event.method), ['initialize', 'runtime.probe', 'shutdown']);
    const probe = events[1];
    assert.ok(probe);
    assert.equal(probe.HOME, probe.GEMINI_HOME);
    assert.equal(probe.HOME, probe.GIAN_AGENT_HOME);
    assert.notEqual(probe.HOME, homedir());
    assert.match(probe.HOME ?? '', /[/]gian-dev-runtime-probe-/);
    await assert.rejects(stat(probe.HOME ?? ''));
    assert.equal((await readFile(trace, 'utf8')).includes('executed'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime.probe mismatches, missing capability, and timeout fail closed', async () => {
  const cases: Array<{ mode: string; pattern: RegExp; timeoutMs?: number }> = [
    { mode: 'bad-id', pattern: /RUNTIME_ID_MISMATCH|returned runtimeId/ },
    { mode: 'bad-name', pattern: /RUNTIME_DISPLAY_MISMATCH|displayName/ },
    { mode: 'bad-version', pattern: /RUNTIME_VERSION_MISMATCH|returned 9\.9\.9/ },
    { mode: 'bad-path', pattern: /exactly match/ },
    { mode: 'no-capability', pattern: /runtime\.probe/ },
    { mode: 'timeout', pattern: /exceeded/, timeoutMs: 300 },
  ];
  for (const item of cases) {
    const { root, entry, executable, trace } = await fixture(item.mode);
    try {
      await assert.rejects(probeDevRuntimeVersion({
        executable,
        coordinate,
        declaration: declaration(entry),
        hostVersion: '0.0.0-test',
        timeoutMs: item.timeoutMs ?? 5_000,
      }), item.pattern);
      const raw = await readFile(trace, 'utf8').catch(() => '');
      assert.equal(raw.includes('executed'), false);
      assert.equal(raw.includes('session.create'), false);
      assert.equal(raw.includes('authenticate'), false);
      if (item.mode === 'timeout') {
        const pid = tracedMethods(raw).at(-1)?.pid ?? 0;
        assert.ok(pid > 1);
        assert.throws(() => process.kill(pid, 0));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('proxy probe rejects a missing binding, a bad path, and a non-finite budget before bootstrap', async () => {
  let calls = 0;
  const bootstrap: NonNullable<ProbeDevRuntimeVersionInput['bootstrap']> = async () => {
    calls += 1;
    return '1.2.3';
  };
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-probe-guard-'));
  try {
    const entry = join(root, 'proxy.mjs');
    await writeFile(entry, 'export {}\n');
    await assert.rejects(probeDevRuntimeVersion({
      executable: join(root, 'runtime'),
      coordinate,
      declaration: {
        pluginId: coordinate.pluginId,
        runtimeId: coordinate.runtimeId,
        versions: [coordinate.version],
      },
      bootstrap,
    }), (error: unknown) => error instanceof DevRuntimeProbeError && error.code === 'BINDING_MISSING');
    await assert.rejects(probeDevRuntimeVersion({
      executable: 'bin/example',
      coordinate,
      declaration: declaration(entry),
      bootstrap,
    }), /absolute Host path/);
    await assert.rejects(probeDevRuntimeVersion({
      executable: join(root, 'runtime'),
      coordinate,
      declaration: declaration(entry),
      timeoutMs: Number.POSITIVE_INFINITY,
      bootstrap,
    }), /finite positive/);
    await assert.rejects(probeDevRuntimeVersion({
      executable: join(root, 'runtime'),
      coordinate: { ...coordinate, probe: undefined },
      declaration: declaration(entry),
      bootstrap,
    }), /unsupported Dev Runtime probe/);
    const link = join(root, 'linked.mjs');
    await symlink(entry, link);
    await assert.rejects(probeDevRuntimeVersion({
      executable: join(root, 'runtime'),
      coordinate,
      declaration: declaration(link),
      bootstrap,
    }), /regular file/);
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy probe passes the exact entry and isolated homes, and cleanup failure stays closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-probe-seam-'));
  const leaked: string[] = [];
  try {
    const entry = join(root, 'proxy.mjs');
    await writeFile(entry, 'export {}\n');
    const executable = join(root, 'runtime');
    await writeFile(executable, 'runtime\n');
    let home = '';
    const version = await probeDevRuntimeVersion({
      executable,
      coordinate,
      declaration: declaration(entry),
      hostVersion: '0.0.0-test',
      bootstrap: async (request) => {
        home = request.env?.HOME ?? '';
        assert.equal(request.entryPath, entry);
        assert.equal(request.pluginId, coordinate.pluginId);
        assert.equal(request.pluginVersion, '1.0.0');
        assert.equal(request.processScope, 'session');
        assert.equal(request.timeoutMs, DEV_RUNTIME_PROXY_PROBE_TIMEOUT_MS);
        assert.deepEqual(request.env, {
          HOME: home,
          GEMINI_HOME: home,
          GIAN_AGENT_HOME: home,
        });
        assert.notEqual(home, homedir());
        assert.equal((await stat(home)).isDirectory(), true);
        return coordinate.version;
      },
    });
    assert.equal(version, coordinate.version);
    await assert.rejects(stat(home));
    assert.equal(home.startsWith(process.platform === 'darwin' ? '/tmp/' : tmpdir()), true);

    const failRemoval: ProbeDevRuntimeVersionInput['removeDirectory'] = async (directory) => {
      leaked.push(directory);
      throw new Error('home busy');
    };
    await assert.rejects(probeDevRuntimeVersion({
      executable,
      coordinate,
      declaration: declaration(entry),
      bootstrap: async () => coordinate.version,
      removeDirectory: failRemoval,
    }), (error: unknown) => (
      error instanceof RuntimeBootstrapError && error.code === 'RUNTIME_BOOTSTRAP_CLEANUP'
    ));
    await assert.rejects(probeDevRuntimeVersion({
      executable,
      coordinate,
      declaration: declaration(entry),
      bootstrap: async () => {
        throw new RuntimeBootstrapError('RUNTIME_BOOTSTRAP_TIMEOUT', 'timed out');
      },
      removeDirectory: failRemoval,
    }), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
  } finally {
    await Promise.all(leaked.map((directory) => rm(directory, { recursive: true, force: true })));
    await rm(root, { recursive: true, force: true });
  }
});
