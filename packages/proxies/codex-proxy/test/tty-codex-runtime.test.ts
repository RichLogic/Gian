// Coverage for traceability row:
//   CODEX-TTY-001 — Codex CLI runtime owns a pool of `codex resume <uuid>`
//                   PTYs keyed by gianSessionId, with ring-buffer replay,
//                   resize, input forwarding, exit propagation, and clean
//                   shutdown. The PTY layer is injectable so we can drive
//                   it without spawning real `codex`.
//
// We swap in a fake PtyFactory that returns deterministic IPty-shaped
// objects. The runtime's `output` / `exited` events carry both
// gianSessionId and proxySessionId — the service layer routes on these,
// so we assert both ids reach listeners verbatim.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';

import {
  TtyCodexRuntime,
  type PtyFactory,
  type SpawnCodexPtyOptions,
} from '../src/runtime/tty-codex-runtime.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakePtyHandle {
  proc: IPty;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: string | null;
  pushOutput: (s: string) => void;
  fireExit: (exitCode: number, signal?: number | null) => void;
}

class FakePty extends EventEmitter {
  pid = Math.floor(Math.random() * 100000);
  cols: number;
  rows: number;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed: string | null = null;
  process = 'fake-codex';

  private dataHandlers: Array<(d: string) => void> = [];
  private exitHandlers: Array<(e: { exitCode: number; signal?: number | null }) => void> = [];

  constructor(opts: { cols: number; rows: number }) {
    super();
    this.cols = opts.cols;
    this.rows = opts.rows;
  }

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler);
    return { dispose: () => { this.dataHandlers = this.dataHandlers.filter(h => h !== handler); } };
  }
  onExit(handler: (e: { exitCode: number; signal?: number | null }) => void) {
    this.exitHandlers.push(handler);
    return { dispose: () => { this.exitHandlers = this.exitHandlers.filter(h => h !== handler); } };
  }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) {
    this.cols = cols; this.rows = rows;
    this.resizes.push({ cols, rows });
  }
  kill(sig?: string) { this.killed = sig ?? 'SIGTERM'; }
  pause() {}
  resume() {}
  clear() {}

  pushOutput(s: string) { for (const h of this.dataHandlers) h(s); }
  fireExit(exitCode: number, signal: number | null = null) {
    for (const h of this.exitHandlers) h({ exitCode, signal });
  }
}

interface Ctx {
  runtime: TtyCodexRuntime;
  handles: Map<string, FakePtyHandle>;
  spawnCalls: Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }>;
  outputs: Array<{ gianSessionId: string; proxySessionId: string; chunk: Buffer }>;
  exits: Array<{ gianSessionId: string; proxySessionId: string; code: number | null; signal: string | null }>;
}

function setup(ringBufferBytes?: number): Ctx {
  const handles = new Map<string, FakePtyHandle>();
  const spawnCalls: Ctx['spawnCalls'] = [];

  const factory: PtyFactory = {
    spawn(bin, args, opts) {
      spawnCalls.push({ bin, args, cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows });
      const fake = new FakePty({ cols: opts.cols, rows: opts.rows });
      const handle: FakePtyHandle = {
        proc: fake as unknown as IPty,
        bin, args, cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows,
        get writes() { return fake.writes; },
        get resizes() { return fake.resizes; },
        get killed() { return fake.killed; },
        pushOutput: (s) => fake.pushOutput(s),
        fireExit: (c, s) => fake.fireExit(c, s ?? null),
      };
      handles.set(`pid:${fake.pid}`, handle);
      handles.set(`idx:${spawnCalls.length - 1}`, handle);
      return fake as unknown as IPty;
    },
  };

  const runtime = new TtyCodexRuntime({
    ptyFactory: async () => factory,
    ...(ringBufferBytes !== undefined ? { ringBufferBytes } : {}),
  });

  const outputs: Ctx['outputs'] = [];
  const exits: Ctx['exits'] = [];
  runtime.on('output', (gianSessionId, proxySessionId, chunk) => {
    outputs.push({ gianSessionId, proxySessionId, chunk });
  });
  runtime.on('exited', (gianSessionId, proxySessionId, code, signal) => {
    exits.push({ gianSessionId, proxySessionId, code, signal });
  });

  return { runtime, handles, spawnCalls, outputs, exits };
}

function tick() { return new Promise(r => setImmediate(r)); }

function handleFor(ctx: Ctx, idx: number): FakePtyHandle {
  const h = ctx.handles.get(`idx:${idx}`);
  if (!h) throw new Error(`no fake pty for spawn index ${idx}`);
  return h;
}

function baseOpts(over: Partial<SpawnCodexPtyOptions> = {}): SpawnCodexPtyOptions {
  return {
    gianSessionId: 'gsess-1',
    proxySessionId: 'psess-1',
    codexThreadId: '019e4541-7ce7-7aa1-9a09-3e626bb4479f',
    cwd: '/tmp/workspace',
    cols: 120,
    rows: 30,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — spawn arg construction
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: spawnSession invokes `codex resume <uuid> -C <cwd> --add-dir <cwd>`', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  assert.equal(ctx.spawnCalls.length, 1);
  const call = ctx.spawnCalls[0]!;
  assert.deepEqual(call.args, [
    'resume', '019e4541-7ce7-7aa1-9a09-3e626bb4479f',
    '-C', '/tmp/workspace',
    '--add-dir', '/tmp/workspace',
  ]);
  assert.equal(call.cwd, '/tmp/workspace');
  assert.equal(call.cols, 120);
  assert.equal(call.rows, 30);
});

test('CODEX-TTY-001: spawnSession appends `-m <model>` when model is provided', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts({ model: 'gpt-5' }));
  assert.deepEqual(ctx.spawnCalls[0]!.args.slice(-2), ['-m', 'gpt-5']);
});

test('CODEX-TTY-001: spawnSession does NOT add `-m` when model is null/empty', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts({ model: null }));
  assert.ok(!ctx.spawnCalls[0]!.args.includes('-m'),
    'null model must not produce a `-m` flag');
});

test('CODEX-TTY-001: spawnSession honors the `codexBin` constructor override (mirrors --codex-bin)', async () => {
  // Without the override, structured Codex could be told to use a specific
  // `--codex-bin` while CLI mode silently spawns a different `codex` from
  // PATH. The constructor value flows from spawn.ts → TtyCodexService →
  // TtyCodexRuntime → factory.spawn(bin, ...).
  const handles = new Map<string, FakePtyHandle>();
  const spawnCalls: Array<{ bin: string; args: string[]; cwd: string; cols: number; rows: number }> = [];
  const factory: PtyFactory = {
    spawn(bin, args, opts) {
      spawnCalls.push({ bin, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
      const fake = new FakePty({ cols: opts.cols, rows: opts.rows });
      const handle: FakePtyHandle = {
        proc: fake as unknown as IPty,
        bin, args, cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows,
        get writes() { return fake.writes; },
        get resizes() { return fake.resizes; },
        get killed() { return fake.killed; },
        pushOutput: (s) => fake.pushOutput(s),
        fireExit: (c, s) => fake.fireExit(c, s ?? null),
      };
      handles.set(`idx:${spawnCalls.length - 1}`, handle);
      return fake as unknown as IPty;
    },
  };
  const runtime = new TtyCodexRuntime({
    ptyFactory: async () => factory,
    codexBin: '/opt/custom/codex',
  });
  await runtime.spawnSession(baseOpts());
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]!.bin, '/opt/custom/codex',
    'TtyCodexRuntime must spawn the codexBin override, not the env / hardcoded fallback');
});

test('CODEX-TTY-001: spawnSession idempotent — second spawn same gianSessionId SIGTERMs the first', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const first = handleFor(ctx, 0);
  await ctx.runtime.spawnSession(baseOpts({ cols: 80, rows: 24 }));
  assert.equal(first.killed, 'SIGTERM',
    'second spawn for the same gianSessionId must SIGTERM the existing PTY');
  assert.equal(ctx.spawnCalls.length, 2);
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — output / exit event routing (dual-id payload)
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: output event carries gianSessionId + proxySessionId + bytes', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gA', proxySessionId: 'pA' }));
  handleFor(ctx, 0).pushOutput('hello codex\n');
  await tick();
  assert.equal(ctx.outputs.length, 1);
  assert.equal(ctx.outputs[0]!.gianSessionId, 'gA');
  assert.equal(ctx.outputs[0]!.proxySessionId, 'pA');
  assert.equal(ctx.outputs[0]!.chunk.toString('utf8'), 'hello codex\n');
});

test('CODEX-TTY-001: exited event carries both ids + exit code + signal', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gA', proxySessionId: 'pA' }));
  handleFor(ctx, 0).fireExit(137);
  await tick();
  assert.equal(ctx.exits.length, 1);
  assert.equal(ctx.exits[0]!.gianSessionId, 'gA');
  assert.equal(ctx.exits[0]!.proxySessionId, 'pA');
  assert.equal(ctx.exits[0]!.code, 137);
});

test('CODEX-TTY-001: after exit the session is reported NOT alive but replay still works', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  handleFor(ctx, 0).pushOutput('final frame');
  handleFor(ctx, 0).fireExit(0);
  await tick();
  assert.equal(ctx.runtime.isSessionAlive('gsess-1'), false);
  const replay = ctx.runtime.snapshotBase64('gsess-1');
  assert.equal(replay.length, 1);
  assert.equal(Buffer.from(replay[0]!, 'base64').toString('utf8'), 'final frame');
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — input / resize forwarding
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: writeBytes decodes base64 and writes utf8 to the PTY', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  const b64 = Buffer.from('hello\n', 'utf8').toString('base64');
  ctx.runtime.writeBytes('gsess-1', b64);
  assert.deepEqual(pty.writes, ['hello\n']);
});

test('CODEX-TTY-001: writeBytes to unknown gianSessionId is a silent no-op', () => {
  const ctx = setup();
  ctx.runtime.writeBytes('ghost', Buffer.from('boom').toString('base64'));
});

test('CODEX-TTY-001: writeBytes to a dead session is a silent no-op', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  pty.fireExit(0);
  await tick();
  ctx.runtime.writeBytes('gsess-1', Buffer.from('x').toString('base64'));
  assert.deepEqual(pty.writes, []);
});

test('CODEX-TTY-001: pasteMessage wraps in bracketed-paste markers + trailing CR', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  ctx.runtime.pasteMessage('gsess-1', 'multi\nline\r\nmessage');
  assert.equal(pty.writes.length, 1);
  // \r\n is normalized to \n before wrapping.
  assert.equal(pty.writes[0]!, '\x1b[200~multi\nline\nmessage\x1b[201~\r');
});

test('CODEX-TTY-001: resize forwards integer cols/rows to the PTY', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  ctx.runtime.resize('gsess-1', 200, 50);
  assert.deepEqual(pty.resizes, [{ cols: 200, rows: 50 }]);
});

test('CODEX-TTY-001: resize rejects 0 / NaN / Infinity / negative values silently', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  ctx.runtime.resize('gsess-1', 0, 50);
  ctx.runtime.resize('gsess-1', 200, 0);
  ctx.runtime.resize('gsess-1', Number.NaN, 50);
  ctx.runtime.resize('gsess-1', 200, Number.NaN);
  ctx.runtime.resize('gsess-1', Infinity, 50);
  ctx.runtime.resize('gsess-1', -10, 50);
  assert.deepEqual(pty.resizes, [],
    'cols<1, rows<1, NaN, Infinity, negatives must NOT reach pty.resize()');
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — ring buffer + replay
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: snapshotBase64 returns ring buffer chunks', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  pty.pushOutput('alpha');
  pty.pushOutput('beta');
  await tick();
  const snap = ctx.runtime.snapshotBase64('gsess-1');
  assert.equal(snap.length, 2);
  assert.equal(Buffer.from(snap[0]!, 'base64').toString('utf8'), 'alpha');
  assert.equal(Buffer.from(snap[1]!, 'base64').toString('utf8'), 'beta');
});

test('CODEX-TTY-001: snapshotBase64 for unknown gianSessionId returns []', () => {
  const ctx = setup();
  assert.deepEqual(ctx.runtime.snapshotBase64('ghost'), []);
});

test('CODEX-TTY-001: ring buffer caps memory near 1 MiB — oldest chunks drop', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  const CHUNK = 256 * 1024;
  for (let i = 0; i < 12; i++) {
    pty.pushOutput(String.fromCharCode(65 + i).repeat(CHUNK));
  }
  await tick();
  const snap = ctx.runtime.snapshotBase64('gsess-1');
  const totalBytes = snap.reduce((acc, c) => acc + Buffer.from(c, 'base64').length, 0);
  assert.ok(totalBytes <= 1024 * 1024 + CHUNK,
    `ring buffer must cap retained bytes near 1 MiB; got ${totalBytes}`);
  const decoded = snap.map(c => Buffer.from(c, 'base64').toString('utf8'));
  assert.ok(!decoded.some(s => s[0] === 'A'),
    'oldest chunk should be evicted from the ring once we exceed the cap');
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — multi-session isolation + shutdown
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: multiple gianSessionIds run independently — output routed to the right session', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gA', proxySessionId: 'pA' }));
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gB', proxySessionId: 'pB' }));
  handleFor(ctx, 0).pushOutput('from-A');
  handleFor(ctx, 1).pushOutput('from-B');
  await tick();
  const aOuts = ctx.outputs.filter(o => o.gianSessionId === 'gA');
  const bOuts = ctx.outputs.filter(o => o.gianSessionId === 'gB');
  assert.equal(aOuts.length, 1);
  assert.equal(bOuts.length, 1);
  assert.equal(aOuts[0]!.chunk.toString('utf8'), 'from-A');
  assert.equal(bOuts[0]!.chunk.toString('utf8'), 'from-B');
  assert.equal(aOuts[0]!.proxySessionId, 'pA');
  assert.equal(bOuts[0]!.proxySessionId, 'pB');
});

test('CODEX-TTY-001: killSession SIGTERMs the PTY but keeps the ring buffer', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  const pty = handleFor(ctx, 0);
  pty.pushOutput('keep me');
  await tick();
  await ctx.runtime.killSession('gsess-1');
  assert.equal(pty.killed, 'SIGTERM');
  // Ring buffer survives kill — record stays so a reconnect can replay.
  const snap = ctx.runtime.snapshotBase64('gsess-1');
  assert.equal(snap.length, 1);
});

test('CODEX-TTY-001: removeSession kills + forgets the ring buffer', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts());
  handleFor(ctx, 0).pushOutput('drop me');
  await tick();
  await ctx.runtime.removeSession('gsess-1');
  assert.deepEqual(ctx.runtime.snapshotBase64('gsess-1'), []);
});

test('CODEX-TTY-001: stop() drains every session', async () => {
  const ctx = setup();
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gA', proxySessionId: 'pA' }));
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gB', proxySessionId: 'pB' }));
  await ctx.runtime.spawnSession(baseOpts({ gianSessionId: 'gC', proxySessionId: 'pC' }));
  await ctx.runtime.stop();
  assert.deepEqual(ctx.runtime.snapshotBase64('gA'), []);
  assert.deepEqual(ctx.runtime.snapshotBase64('gB'), []);
  assert.deepEqual(ctx.runtime.snapshotBase64('gC'), []);
});
