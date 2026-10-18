#!/usr/bin/env node
// Deterministic agy double for CLI model-catalog tests.
// The shell wrapper execs this file with an absolute process.execPath.
// It records the query shape and does not read credential files.
import { spawn } from 'node:child_process';
import { appendFileSync, readSync, writeFileSync, writeSync } from 'node:fs';

const env = process.env;

const DESCENDANT = [
  'process.on("SIGHUP",()=>{});',
  'process.on("SIGTERM",()=>{});',
  'process.on("SIGINT",()=>{});',
  'setInterval(()=>{},1000);',
].join('');

// Writes the JSON tail after the leader has exited. Stays in the leader group.
const LATE_STDOUT = [
  'const fs=require("node:fs");',
  'const delay=Number(process.env.FAKE_AGY_CLI_LATE_DELAY_MS||"40");',
  'setTimeout(()=>{',
  'fs.writeSync(1, process.env.FAKE_AGY_CLI_STDOUT_SUFFIX||"");',
  'process.exit(0);',
  '}, Number.isFinite(delay)&&delay>=0?delay:40);',
].join('');

// Holds the inherited stdout pipe open after the leader exits.
// SIGKILL still reaps it; the ignored signals must not close the pipe early.
const HOLD_STDOUT = [
  'process.on("SIGHUP",()=>{});',
  'process.on("SIGTERM",()=>{});',
  'process.on("SIGINT",()=>{});',
  'setInterval(()=>{},1000);',
].join('');

function spawnGroupedWriter(script) {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  child.on('error', () => undefined);
  if (child.pid !== undefined) writeReport('FAKE_AGY_CLI_DESCENDANT_PID', String(child.pid));
}

function writeReport(name, value) {
  const path = env[name];
  if (typeof path === 'string' && path !== '') writeFileSync(path, value);
}

/** Byte count from an already-closed or /dev/null stdin. A stuck pipe fails the test. */
function stdinByteCount() {
  const chunk = Buffer.alloc(256);
  let total = 0;
  try {
    for (;;) {
      const count = readSync(0, chunk);
      if (count <= 0) return total;
      total += count;
      if (total > 4096) return total;
    }
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'EBADF' || code === 'EOF') return total;
    throw error;
  }
}

process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);

async function writeStream(stream, count, byte) {
  const chunk = Buffer.alloc(16 * 1024, byte);
  let left = count;
  while (left > 0) {
    const slice = chunk.subarray(0, Math.min(chunk.length, left));
    if (!stream.write(slice)) {
      await new Promise((resolve) => stream.once('drain', resolve));
    }
    left -= slice.length;
  }
}

async function main() {
  const stdinBytes = stdinByteCount();
  if (typeof env.FAKE_AGY_CLI_COUNT === 'string' && env.FAKE_AGY_CLI_COUNT !== '') {
    appendFileSync(env.FAKE_AGY_CLI_COUNT, '1\n');
  }
  writeReport('FAKE_AGY_CLI_PID', String(process.pid));
  writeReport('FAKE_AGY_CLI_REPORT', JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    pwd: Object.hasOwn(env, 'PWD') ? env.PWD : null,
    stdinBytes,
    geminiHome: Object.hasOwn(env, 'GEMINI_HOME') ? env.GEMINI_HOME : null,
    gianAgentHome: Object.hasOwn(env, 'GIAN_AGENT_HOME') ? env.GIAN_AGENT_HOME : null,
    home: Object.hasOwn(env, 'HOME') ? env.HOME : null,
    harness: Object.hasOwn(env, 'ANTIGRAVITY_HARNESS_PATH'),
    hasToken: Object.hasOwn(env, 'AGY_TOKEN'),
    marker: env.FAKE_AGY_CLI_MARKER ?? null,
  }));

  if (env.FAKE_AGY_CLI_LATE_STDOUT === '1' || env.FAKE_AGY_CLI_HOLD_STDOUT === '1') {
    writeSync(1, env.FAKE_AGY_CLI_STDOUT_PREFIX ?? '');
    spawnGroupedWriter(env.FAKE_AGY_CLI_HOLD_STDOUT === '1' ? HOLD_STDOUT : LATE_STDOUT);
    process.exit(0);
  }

  if (env.FAKE_AGY_CLI_HOLD === '1') {
    process.on('SIGTERM', () => undefined);
    process.on('SIGHUP', () => undefined);
    process.on('SIGINT', () => undefined);
    const child = spawn(process.execPath, ['-e', DESCENDANT], { stdio: 'ignore' });
    if (child.pid !== undefined) writeReport('FAKE_AGY_CLI_DESCENDANT_PID', String(child.pid));
    setInterval(() => undefined, 1000);
    return;
  }

  const delay = Number(env.FAKE_AGY_CLI_DELAY_MS ?? '0');
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  if (typeof env.FAKE_AGY_CLI_STDERR === 'string') process.stderr.write(env.FAKE_AGY_CLI_STDERR);
  const stderrBytes = Number(env.FAKE_AGY_CLI_STDERR_BYTES ?? '0');
  if (Number.isSafeInteger(stderrBytes) && stderrBytes > 0) {
    await writeStream(process.stderr, stderrBytes, 0x73);
  }
  const byteCount = Number(env.FAKE_AGY_CLI_BYTES ?? '0');
  if (Number.isSafeInteger(byteCount) && byteCount > 0) {
    await writeStream(process.stdout, byteCount, 0x61);
  } else if (env.FAKE_AGY_CLI_STDOUT !== undefined) {
    process.stdout.write(env.FAKE_AGY_CLI_STDOUT);
  }
  const exitCode = Number(env.FAKE_AGY_CLI_EXIT ?? '0');
  process.exit(Number.isInteger(exitCode) ? exitCode : 0);
}

main().catch(() => process.exit(1));
