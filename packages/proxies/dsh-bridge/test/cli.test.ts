import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the fake CLI reports the pinned DSH runtime with format 4', async () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env };
  delete env.DSH_FAKE_VERSION;
  delete env.GIAN_HOST_BINDING_KEY;
  const child = spawn(process.execPath, [cli], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`fake CLI produced no initialize result: ${Buffer.concat(stderr).toString('utf8')}`));
    }, 5000);
    const settle = () => {
      if (!Buffer.concat(stdout).toString('utf8').includes('\n')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', settle);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (Buffer.concat(stdout).toString('utf8').includes('\n')) resolve();
      else reject(new Error(`fake CLI exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: { protocol: { versions: ['1.0'] } },
  })}\n`);
  await finished;
  child.kill();
  const line = Buffer.concat(stdout).toString('utf8').split('\n').find(entry => entry.trim().length > 0);
  const message = JSON.parse(line ?? '') as {
    result?: { runtime?: { version?: string; sessionFormatVersion?: number } };
    error?: { message?: string };
  };
  assert.equal(message.error, undefined, message.error?.message);
  assert.equal(message.result?.runtime?.version, '0.2.0-rc.2');
  assert.equal(message.result?.runtime?.sessionFormatVersion, 4);
});
