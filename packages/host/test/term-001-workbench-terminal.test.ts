// Coverage for traceability row:
//   TERM-001 — Workbench-terminal manager owns a pool of plain shell PTYs
//              keyed by client-minted `term_id`, with replay-on-reconnect,
//              resize, input forwarding, exit propagation, and clean
//              shutdown. The PTY layer is injectable so we can drive it
//              without spawning real shells.
//
// We swap in a fake PtyFactory that returns deterministic IPty-shaped
// objects. Every WS-bound side effect goes through the broadcaster, so
// asserting on the captured messages closes the contract end-to-end.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import type { ServerToClientMessage } from '@gian/shared';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import {
  WorkbenchTerminalManager,
  type PtyFactory,
} from '../src/term/manager.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakePtyHandle {
  proc: IPty;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  writes: string[];
  resizes: Array<{ cols: number; rows: number }>;
  killed: string | null;
  pushOutput: (s: string) => void;
  fireExit: (exitCode: number, signal?: number | null) => void;
}

class FakePty extends EventEmitter {
  pid = Math.floor(Math.random() * 10000);
  cols: number;
  rows: number;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed: string | null = null;
  process = 'fake';

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

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {} send() {}
  broadcast(msg: ServerToClientMessage): void { this.messages.push(msg); }
  get size() { return 0; }
}

interface Ctx {
  mgr: WorkbenchTerminalManager;
  broadcaster: CapturingBroadcaster;
  handles: Map<string, FakePtyHandle>;
  spawnCalls: Array<{ shell: string; cwd: string; cols: number; rows: number }>;
}

function setup(): Ctx {
  const broadcaster = new CapturingBroadcaster();
  const handles = new Map<string, FakePtyHandle>();
  const spawnCalls: Ctx['spawnCalls'] = [];

  const factory: PtyFactory = {
    spawn(shell, _args, opts) {
      spawnCalls.push({ shell, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
      const fake = new FakePty({ cols: opts.cols, rows: opts.rows });
      const handle: FakePtyHandle = {
        proc: fake as unknown as IPty,
        shell, cwd: opts.cwd, cols: opts.cols, rows: opts.rows,
        get writes() { return fake.writes; },
        get resizes() { return fake.resizes; },
        get killed() { return fake.killed; },
        pushOutput: (s) => fake.pushOutput(s),
        fireExit: (c, s) => fake.fireExit(c, s ?? null),
      };
      handles.set(`pid:${fake.pid}`, handle);
      // Also expose under a key the test can reach via spawnCalls index
      handles.set(`idx:${spawnCalls.length - 1}`, handle);
      return fake as unknown as IPty;
    },
  };

  const mgr = new WorkbenchTerminalManager(
    broadcaster as unknown as WsBroadcaster,
    async () => factory,
  );

  return { mgr, broadcaster, handles, spawnCalls };
}

function tick() { return new Promise(r => setImmediate(r)); }

// Look up the FakePtyHandle for the i-th spawn in this manager.
function handleFor(ctx: Ctx, idx: number): FakePtyHandle {
  const h = ctx.handles.get(`idx:${idx}`);
  if (!h) throw new Error(`no fake pty for spawn index ${idx}`);
  return h;
}

// ---------------------------------------------------------------------------
// TERM-001 — spawn / output / exit
// ---------------------------------------------------------------------------

test('TERM-001: spawn() creates a PTY, returns empty replay + alive=true', async () => {
  const ctx = setup();
  const res = await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  assert.deepEqual(res, { replay: [], alive: true });
  assert.equal(ctx.mgr.size(), 1);
  assert.equal(ctx.spawnCalls.length, 1);
  assert.equal(ctx.spawnCalls[0]!.cols, 80);
  assert.equal(ctx.spawnCalls[0]!.rows, 24);
});

test('TERM-001: PTY output broadcasts term:output with base64-encoded chunks', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);
  ctx.broadcaster.messages.length = 0;

  pty.pushOutput('hello world\n');
  await tick();

  const out = ctx.broadcaster.messages.find(
    m => m.type === 'term:output',
  ) as { type: 'term:output'; term_id: string; data: string } | undefined;
  assert.ok(out, 'output chunk must be broadcast as term:output');
  assert.equal(out!.term_id, 't1');
  assert.equal(Buffer.from(out!.data, 'base64').toString('utf8'), 'hello world\n');
});

test('TERM-001: exit broadcasts term:exited and marks the record exited', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);
  ctx.broadcaster.messages.length = 0;

  pty.fireExit(137);
  await tick();

  const exited = ctx.broadcaster.messages.find(
    m => m.type === 'term:exited',
  ) as { type: 'term:exited'; term_id: string; code: number | null; signal: string | null } | undefined;
  assert.ok(exited, 'exit must broadcast a term:exited message');
  assert.equal(exited!.term_id, 't1');
  assert.equal(exited!.code, 137);

  // After exit, the replay still works but reports alive=false.
  const replay = ctx.mgr.replay('t1');
  assert.equal(replay.alive, false,
    'replay() must report alive=false after the PTY exits');
});

test('TERM-001: spawn() with same termId kills the previous PTY (idempotent)', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const first = handleFor(ctx, 0);

  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 100, rows: 30 });
  assert.equal(first.killed, 'SIGTERM',
    'a second spawn for the same termId must SIGTERM the existing PTY');
  assert.equal(ctx.mgr.size(), 1,
    'idempotent spawn must leave exactly one record for the termId');
});

// ---------------------------------------------------------------------------
// TERM-001 — input + resize forwarding
// ---------------------------------------------------------------------------

test('TERM-001: input() decodes base64 and forwards utf8 to the PTY', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);

  const b64 = Buffer.from('ls -la\n', 'utf8').toString('base64');
  ctx.mgr.input('t1', b64);
  assert.deepEqual(pty.writes, ['ls -la\n']);
});

test('TERM-001: input() to an unknown termId is a silent no-op', () => {
  const ctx = setup();
  const b64 = Buffer.from('boom', 'utf8').toString('base64');
  // Must not throw.
  ctx.mgr.input('ghost', b64);
});

test('TERM-001: input() to a dead PTY is a silent no-op (no rec.pty.write)', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);
  pty.fireExit(0);
  await tick();

  ctx.mgr.input('t1', Buffer.from('x', 'utf8').toString('base64'));
  assert.deepEqual(pty.writes, [],
    'input after exit must not be forwarded — the record is marked exited');
});

test('TERM-001: resize() forwards integer cols/rows to the PTY', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);

  ctx.mgr.resize('t1', 120, 40);
  assert.deepEqual(pty.resizes, [{ cols: 120, rows: 40 }]);
});

test('TERM-001: resize() rejects nonsense values silently', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);

  ctx.mgr.resize('t1', 0, 40);
  ctx.mgr.resize('t1', Number.NaN, 40);
  ctx.mgr.resize('t1', 120, -1);
  ctx.mgr.resize('t1', Infinity, 40);
  assert.deepEqual(pty.resizes, [],
    'cols<1, rows<1, NaN, or Infinity must NOT reach pty.resize()');
});

// ---------------------------------------------------------------------------
// TERM-001 — ring buffer + replay-on-reconnect
// ---------------------------------------------------------------------------

test('TERM-001: replay() returns the ring buffer chunks for live reconnect', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);

  pty.pushOutput('line one\n');
  pty.pushOutput('line two\n');
  await tick();

  const replay = ctx.mgr.replay('t1');
  assert.equal(replay.alive, true);
  // Each onData call → one chunk in the ring → one base64 chunk in replay.
  assert.equal(replay.chunks.length, 2);
  assert.equal(Buffer.from(replay.chunks[0]!, 'base64').toString('utf8'), 'line one\n');
  assert.equal(Buffer.from(replay.chunks[1]!, 'base64').toString('utf8'), 'line two\n');
});

test('TERM-001: replay() for an unknown termId returns empty + alive=false', () => {
  const ctx = setup();
  assert.deepEqual(ctx.mgr.replay('ghost'), { chunks: [], alive: false });
});

test('TERM-001: ring buffer caps memory — oldest chunks drop when ~1 MiB cap is exceeded', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);

  // Push 3 MiB of distinguishable chunks (~256 KiB each, 12 chunks).
  const CHUNK = 256 * 1024;
  for (let i = 0; i < 12; i++) {
    pty.pushOutput(String.fromCharCode(65 + i).repeat(CHUNK));
  }
  await tick();

  const { chunks } = ctx.mgr.replay('t1');
  // Sum of bytes after base64 decode must be ≤ 1 MiB + one chunk (the ring
  // keeps at least one chunk regardless, and only trims once size>cap AND
  // length>1).
  const totalBytes = chunks.reduce((acc, c) => acc + Buffer.from(c, 'base64').length, 0);
  assert.ok(totalBytes <= 1024 * 1024 + CHUNK,
    `ring buffer must cap retained bytes near 1 MiB; got ${totalBytes}`);
  // And the earliest output ('A...') must have been dropped.
  const decoded = chunks.map(c => Buffer.from(c, 'base64').toString('utf8'));
  assert.ok(!decoded.some(s => s[0] === 'A'),
    'oldest chunk should be evicted from the ring once we exceed the cap');
});

// ---------------------------------------------------------------------------
// TERM-001 — multi-tab pool isolation
// ---------------------------------------------------------------------------

test('TERM-001: multiple termIds run independently (output routed to the right tab)', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 'a', cwd: '/tmp', cols: 80, rows: 24 });
  await ctx.mgr.spawn({ termId: 'b', cwd: '/tmp', cols: 80, rows: 24 });

  ctx.broadcaster.messages.length = 0;
  handleFor(ctx, 0).pushOutput('from-a');
  handleFor(ctx, 1).pushOutput('from-b');
  await tick();

  const outs = ctx.broadcaster.messages.filter(
    m => m.type === 'term:output',
  ) as Array<{ term_id: string; data: string }>;
  assert.equal(outs.length, 2);
  const byTerm = new Map(outs.map(o => [o.term_id, Buffer.from(o.data, 'base64').toString('utf8')]));
  assert.equal(byTerm.get('a'), 'from-a');
  assert.equal(byTerm.get('b'), 'from-b');
});

test('TERM-001: kill() removes the record and SIGTERMs the underlying PTY', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);
  assert.equal(ctx.mgr.size(), 1);

  await ctx.mgr.kill('t1');
  assert.equal(pty.killed, 'SIGTERM');
  assert.equal(ctx.mgr.size(), 0);
});

test('TERM-001: kill() of an already-exited PTY only drops the record (does not double-kill)', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 't1', cwd: '/tmp', cols: 80, rows: 24 });
  const pty = handleFor(ctx, 0);
  pty.fireExit(0);
  await tick();

  await ctx.mgr.kill('t1');
  // The PTY object's `killed` field stays null because the record was
  // already exited — manager skips the SIGTERM call.
  assert.equal(pty.killed, null,
    'kill() on an exited record must skip the kill() syscall — only the record is dropped');
  assert.equal(ctx.mgr.size(), 0);
});

test('TERM-001: closeAll() drains every tab', async () => {
  const ctx = setup();
  await ctx.mgr.spawn({ termId: 'a', cwd: '/tmp', cols: 80, rows: 24 });
  await ctx.mgr.spawn({ termId: 'b', cwd: '/tmp', cols: 80, rows: 24 });
  await ctx.mgr.spawn({ termId: 'c', cwd: '/tmp', cols: 80, rows: 24 });
  assert.equal(ctx.mgr.size(), 3);

  await ctx.mgr.closeAll();
  assert.equal(ctx.mgr.size(), 0);
});
