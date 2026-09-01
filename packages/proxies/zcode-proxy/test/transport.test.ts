/** §15.1 transport hardening: framing, malformed lines, oversized lines,
 * unknown reverse methods, timeouts, late responses, and crash fanout —
 * driven directly against a scripted stub child. Every test always stops the
 * transport so no stub child outlives the assertion. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZCodeTransport } from '../src/inner/transport.js';

function stubServer(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'zc-transport-'));
  const file = join(dir, 'stub.mjs');
  writeFileSync(file, body);
  return file;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

const RL = "const { createInterface } = await import('node:readline');\n    const rl = createInterface({ input: process.stdin });";

test('coalesced and fragmented NDJSON frames are both handled', async (t) => {
  const stub = stubServer(`
    ${RL};
    rl.on('line', (line) => {
      const req = JSON.parse(line);
      // reply split mid-JSON across two writes, coalesced tail on the next line
      process.stdout.write(JSON.stringify({ id: req.id, result: { n: 1 } }) + '\\n{"id":"x","res');
      setTimeout(() => process.stdout.write('ult":{"n":2}}\\n'), 20);
    });
  `);
  const transport = new ZCodeTransport({ runtimeBin: stub, cwd: tmpdir() });
  t.after(() => transport.stop());
  transport.start();
  const a = await withTimeout(transport.request('ping', {}), 3_000, 'first');
  assert.deepEqual(a, { n: 1 });
  const late = await new Promise<null>((resolve) => setTimeout(() => resolve(null), 120));
  assert.equal(late, null);
});

test('malformed lines become bounded diagnostics, never crashes', async (t) => {
  const stub = stubServer(`
    ${RL};
    rl.on('line', (line) => {
      process.stdout.write('not-json\\n');
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\\n');
    });
  `);
  const transport = new ZCodeTransport({ runtimeBin: stub, cwd: tmpdir() });
  t.after(() => transport.stop());
  const diagnostics: unknown[] = [];
  transport.on('diagnostic', (info) => diagnostics.push(info));
  transport.start();
  const result = await withTimeout(transport.request('ping', {}), 3_000, 'diagnostic');
  assert.deepEqual(result, { ok: true });
  assert.ok(diagnostics.some((entry) => (entry as { kind?: string }).kind === 'unparseable-line'));
});

test('unknown reverse requests get an explicit method-not-supported answer', async (t) => {
  const stub = stubServer(`
    ${RL};
    let reverseSent = false;
    rl.on('line', (line) => {
      const req = JSON.parse(line);
      // Answer ordinary requests; emit the unknown reverse request EXACTLY
      // once. (Answering our own reverse request would loop it forever.)
      if (String(req.id).startsWith('server-')) return;
      if (reverseSent === false) {
        reverseSent = true;
        process.stdout.write(JSON.stringify({ id: 'server-1', method: 'interaction/requestUserInput', params: {} }) + '\\n');
      }
      process.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\\n');
    });
  `);
  const transport = new ZCodeTransport({ runtimeBin: stub, cwd: tmpdir() });
  t.after(() => transport.stop());
  const answers: Array<Record<string, unknown>> = [];
  const originalWrite = transport['write'].bind(transport);
  transport['write'] = (envelope: Record<string, unknown>) => {
    if (typeof envelope.id === 'string' && String(envelope.id).startsWith('server-')) {
      answers.push(envelope);
    }
    originalWrite(envelope);
  };
  transport.start();
  const result = await withTimeout(transport.request('ping', {}), 3_000, 'unknown reverse');
  assert.deepEqual(result, { ok: true });
  assert.equal(answers.length, 1);
  assert.equal((answers[0]!.error as { code: number }).code, -32601);
});

test('request timeout tombstones the pending entry; late responses never resolve', async (t) => {
  const stub = stubServer(`
    ${RL};
    let first = true;
    rl.on('line', (line) => {
      const req = JSON.parse(line);
      if (first) {
        first = false;
        setTimeout(() => process.stdout.write(JSON.stringify({ id: req.id, result: { late: true } }) + '\\n'), 300);
      } else {
        process.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\\n');
      }
    });
  `);
  const transport = new ZCodeTransport({ runtimeBin: stub, cwd: tmpdir(), requestTimeoutMs: 120 });
  t.after(() => transport.stop());
  transport.start();
  await assert.rejects(transport.request('slow', {}), /timed out/);
  const next = await withTimeout(transport.request('fast', {}), 3_000, 'after timeout');
  assert.deepEqual(next, { ok: true });
});

test('child crash rejects every pending request exactly once', async (t) => {
  const stub = stubServer(`
    ${RL};
    rl.on('line', () => { process.kill(process.pid, 'SIGKILL'); });
  `);
  const transport = new ZCodeTransport({ runtimeBin: stub, cwd: tmpdir() });
  t.after(() => transport.stop());
  const exits: Array<unknown> = [];
  transport.on('exit', (code) => exits.push(code));
  transport.start();
  const failures = Promise.allSettled([
    transport.request('a', {}),
    transport.request('b', {}),
  ]);
  const [a, b] = await withTimeout(failures, 3_000, 'crash fanout');
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  assert.match(String((a as PromiseRejectedResult).reason.message ?? ''), /exited/);
  assert.equal(exits.length, 1);
});

test('stderr output is redacted before reaching the diagnostics sink', async (t) => {
  const stub = stubServer(`
    process.stderr.write("failed auth api_key=sk-supersecretvalue token=abcdefghijklmnop set-cookie': 'acw_tc=sensitive-cookie\\n");
    ${RL};
    rl.on('line', (line) => {
      const req = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: req.id, result: { ok: true } }) + '\\n');
    });
  `);
  const transport = new ZCodeTransport({ runtimeBin: stub, cwd: tmpdir() });
  t.after(() => transport.stop());
  const stderrLines: string[] = [];
  transport.on('stderr', (line) => stderrLines.push(String(line)));
  transport.start();
  await withTimeout(transport.request('ping', {}), 3_000, 'stderr');
  assert.ok(stderrLines.length > 0);
  const joined = stderrLines.join('\n');
  assert.match(joined, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(joined, /supersecretvalue/);
  assert.doesNotMatch(joined, /sensitive-cookie/);
});
