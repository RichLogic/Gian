import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runLoggedCommand } from './run-logged-command.mjs';

function collected(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => { value += chunk; });
  return () => value;
}

test('quality command output is streamed live and retained in the detailed log', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-quality-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'quality.log');
  await writeFile(logPath, 'header\n');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutText = collected(stdout);
  const stderrText = collected(stderr);

  const result = await runLoggedCommand(process.execPath, [
    '-e',
    `process.stdout.write('visible stdout\\n'); process.stderr.write('visible stderr\\n')`,
  ], { cwd: root, env: process.env, logPath, stdout, stderr });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(stdoutText(), 'visible stdout\n');
  assert.equal(stderrText(), 'visible stderr\n');
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /visible stdout/);
  assert.match(log, /visible stderr/);
});

test('quality command reports a non-zero child status without hiding its output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-quality-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'quality.log');
  await writeFile(logPath, '');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stderrText = collected(stderr);

  const result = await runLoggedCommand(process.execPath, [
    '-e',
    `process.stderr.write('failed live\\n'); process.exit(7)`,
  ], { cwd: root, env: process.env, logPath, stdout, stderr });

  assert.equal(result.status, 7);
  assert.equal(stderrText(), 'failed live\n');
  assert.equal(await readFile(logPath, 'utf8'), 'failed live\n');
});
