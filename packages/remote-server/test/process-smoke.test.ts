import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { writeStaticArtifact } from './fixture.js';

const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(root, '..');

test('built remote server CLI includes migrations, listens, and shuts down on SIGTERM', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-remote-cli-'));
  const staticDir = writeStaticArtifact('cli-smoke');
  const build = spawnSync('pnpm', ['run', 'build'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `remote server build failed:\n${build.stdout}\n${build.stderr}`);
  const child = spawn(process.execPath, [join(packageRoot, 'dist', 'src', 'cli.js')], {
    cwd: packageRoot,
    env: {
      ...process.env,
      GIAN_REMOTE_DATA_DIR: dataDir,
      GIAN_REMOTE_PUBLIC_ORIGIN: 'http://127.0.0.1',
      GIAN_REMOTE_ADMIN_TOKEN: 'cli-smoke-admin',
      GIAN_REMOTE_STATIC_DIR: staticDir,
      GIAN_REMOTE_HOST: '127.0.0.1',
      GIAN_REMOTE_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cli start timeout: ${stdout}\n${stderr}`)), 8_000);
      const onData = () => {
        const match = stdout.match(/listening (http:\/\/127\.0\.0\.1:\d+)/);
        if (match?.[1]) {
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          resolve(match[1]);
        }
      };
      child.stdout?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`cli exited ${code}: ${stdout}\n${stderr}`));
      });
    });
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const body = await health.json() as { ok?: boolean };
    assert.equal(body.ok, true);
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /remote/);
    const closed = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
    child.kill('SIGTERM');
    const code = await Promise.race([
      closed,
      new Promise<number | null>((_, reject) => {
        setTimeout(() => reject(new Error('cli did not exit after SIGTERM')), 5_000);
      }),
    ]);
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});
