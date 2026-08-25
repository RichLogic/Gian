import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gianToolSocketPath } from '../dist/client.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function runCli(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolveRun({ code, stdout, stderr }));
  });
}

test('gianctl ping emits one JSON object on stdout and no diagnostics', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gianctl-cli-ping-test-'));
  const socketPath = gianToolSocketPath(dataDir);
  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((_request, response) => {
    const body = JSON.stringify({ ok: true, protocol: 'gian.tool', version: 1 });
    response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveListen);
  });
  try {
    const result = await runCli(['ping', '--data-dir', dataDir]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, protocol: 'gian.tool', version: 1 });
    assert.equal(result.stdout.trim().split('\n').length, 1);
  } finally {
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('gianctl reports usage errors as JSON and exits 1', async () => {
  const result = await runCli([
    'call',
    'task.create',
    '--json',
    '{"name":"Missing key"}',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, 'INVALID_ARGUMENT');
  assert.match(output.error.message, /idempotency-key/);
});
