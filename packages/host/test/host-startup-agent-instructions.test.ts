import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { agentInstructionTargets, buildManagedBlock } from '../src/onboarding/agent-instructions.js';
import { openDatabase } from '../src/storage/db.js';
import { saveConfig } from '../src/storage/config.js';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForListening(child: ChildProcessWithoutNullStreams): Promise<string> {
  let output = '';
  const collect = (chunk: Buffer | string) => { output += chunk.toString(); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return new Promise<string>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`host did not start:\n${output}`)), 15_000);
    const inspect = () => {
      if (!output.includes('[gian] listening on')) return;
      clearTimeout(timeout);
      resolveReady(output);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => {
      if (!output.includes('[gian] listening on')) {
        clearTimeout(timeout);
        reject(new Error(`host exited ${code}:\n${output}`));
      }
    });
  });
}

test('real Host startup removes only the legacy Gian instruction block', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-host-startup-wt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'projects');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(dataDir, { recursive: true }), mkdir(projectRoot, { recursive: true })]);
  const targets = agentInstructionTargets(home);
  const codex = targets.find(target => target.agent === 'codex')!;
  await mkdir(dirname(codex.path), { recursive: true });
  await writeFile(codex.path, `# user before\n${buildManagedBlock(projectRoot)}\n# user after\n`);

  const db = openDatabase(dataDir);
  saveConfig(db, {
    host: '127.0.0.1',
    port: await availablePort(),
    workspace_root: projectRoot,
  });
  db.close();

  const hostRoot = resolve(import.meta.dirname, '..');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: hostRoot,
    env: {
      ...process.env,
      HOME: home,
      GIAN_DATA_DIR: dataDir,
      GIAN_SKIP_PROXY_WARMUP: '1',
      GIAN_PARENT_MANAGED: '1',
      GIAN_MANAGED_PLUGINS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
  });

  await waitForListening(child);
  assert.equal(await readFile(codex.path, 'utf8'), '# user before\n\n# user after\n');
  for (const target of targets.filter(target => target.agent !== 'codex')) {
    await assert.rejects(readFile(target.path, 'utf8'), /ENOENT/);
  }

  const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit));
  child.stdin.end();
  const exitCode = await exited;
  assert.equal(exitCode, 0);
});
