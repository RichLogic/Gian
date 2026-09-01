/** Test harness: spawn the compiled zcode-proxy CLI against the fake
 * app-server, speak gian.proxy/2.1 over its stdio, and collect every line. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface OutgoingLine {
  kind: 'result' | 'error' | 'notification';
  id?: string;
  method?: string;
  payload: Record<string, unknown>;
}

type Waiter = (line: OutgoingLine) => void;

export class Harness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly dir: string;
  readonly lines: OutgoingLine[] = [];
  lastStderr = '';
  private readonly waiters: Array<(line: OutgoingLine) => void> = [];
  private readonly resolvers: Waiter[] = [];
  private readonly logPath: string;

  constructor(scenario: Record<string, unknown>, interactionEnabled: boolean) {
    this.dir = mkdtempSync(join(tmpdir(), 'zcode-proxy-test-'));
    const scenarioPath = join(this.dir, 'scenario.json');
    this.logPath = join(this.dir, 'fake-log.jsonl');
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    mkdirSync('/tmp/zcode-ws', { recursive: true });
    mkdirSync('/tmp/zcode-ws-two', { recursive: true });
    const seed = scenario.seedOwnership as {
      sessionId?: string;
      nativeSessionId?: string;
      state?: string;
    } | undefined;
    if (seed?.sessionId && seed.nativeSessionId) {
      const runtimeId = createHash('sha256')
        .update('workspace:/tmp/zcode-ws')
        .digest('hex')
        .slice(0, 24);
      const ownershipDir = join(this.dir, 'workspaces', runtimeId);
      mkdirSync(ownershipDir, { recursive: true });
      writeFileSync(join(ownershipDir, 'zcode-ownership.json'), JSON.stringify({
        schemaVersion: 1,
        sessions: [{
          sessionId: seed.sessionId,
          nativeSessionId: seed.nativeSessionId,
          runtimeKey: 'persisted-runtime-key',
          state: seed.state ?? 'idle-owned',
          updatedAt: '2026-09-01T00:00:00.000Z',
        }],
      }));
    }

    this.child = spawn(process.execPath, [
      resolve('dist/src/cli/spawn.js'),
    ], {
      cwd: resolve('.'),
      env: {
        HOME: this.dir,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: tmpdir(),
        GIAN_RUNTIME_BIN: resolve('test/fixtures/fake-app-server.mjs'),
        GIAN_PLUGIN_DATA_DIR: this.dir,
        GIAN_PLUGIN_ID: 'com.zhipu.zcode',
        GIAN_ZCODE_DISABLE_INTERACTION: interactionEnabled ? '' : '1',
        FAKE_SCENARIO: scenarioPath,
        FAKE_LOG: this.logPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => this.acceptLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.lastStderr += chunk.toString();
    });
  }

  private acceptLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    let parsed: OutgoingLine;
    if (typeof envelope.method === 'string') {
      parsed = { kind: 'notification', method: envelope.method, payload: envelope };
    } else if (typeof envelope.id === 'string' && envelope.error !== undefined) {
      parsed = { kind: 'error', id: envelope.id, payload: envelope };
    } else {
      parsed = { kind: 'result', id: envelope.id as string, payload: envelope };
    }
    // Observers see every line without consuming it.
    for (const waiter of [...this.waiters]) waiter(parsed);
    // Queue-based delivery: a line is handed to exactly one consumer.
    this.lines.push(parsed);
    this.pump();
  }

  private pump(): void {
    while (this.resolvers.length > 0 && this.lines.length > 0) {
      const resolver = this.resolvers.shift()!;
      const line = this.lines.shift()!;
      resolver(line);
    }
  }

  next(): Promise<OutgoingLine> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolveNext) => this.resolvers.push(resolveNext));
  }

  request(
    method: string,
    params: Record<string, unknown>,
    id = `req-${Math.random().toString(36).slice(2, 8)}`,
  ): Promise<OutgoingLine & { id: string }> {
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        rejectRequest(new Error(`request ${method} (${id}) timed out`));
      }, 10_000);
      const waiter: Waiter = (line) => {
        if ((line.kind === 'result' || line.kind === 'error') && line.id === id) {
          clearTimeout(timer);
          // Responses are consumed exactly once: remove from the queue so a
          // later next() cannot hand the same line to another consumer.
          const index = this.lines.indexOf(line);
          if (index >= 0) this.lines.splice(index, 1);
          resolveRequest(line as OutgoingLine & { id: string });
        }
      };
      this.waiters.push(waiter);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Resolve with the first notification matching `predicate` (earlier
   *  notifications are returned in `before` for ordering assertions). */
  async waitNotificationFor(
    predicate: (line: OutgoingLine) => boolean,
    timeoutMs = 8_000,
    before: OutgoingLine[] = [],
  ): Promise<OutgoingLine> {
    for (;;) {
      const line = await Promise.race([
        this.next(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`timed out waiting for notification (after ${before.length} earlier)`)),
          timeoutMs,
        )),
      ]);
      if (predicate(line)) return line;
      before.push(line);
    }
  }

  async waitNotifications(count: number, timeoutMs = 8_000): Promise<OutgoingLine[]> {
    const collected: OutgoingLine[] = [];
    for (;;) {
      const remaining = count - collected.length;
      if (remaining <= 0) return collected;
      const line = await Promise.race([
        this.next(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`timed out waiting for notifications (${collected.length}/${count})`)),
          timeoutMs,
        )),
      ]);
      if (line.kind === 'notification') collected.push(line);
    }
  }

  fakeLog(): Array<Record<string, unknown>> {
    if (existsSync(this.logPath) === false) return [];
    return readFileSync(this.logPath, 'utf8')
      .trim()
      .split('\n')
      .filter((entry) => entry.length > 0)
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolveClose();
      }, 3_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}

export function startHarness(options: {
  scenario: Record<string, unknown>;
  interactionEnabled?: boolean;
}): Harness {
  return new Harness(options.scenario, options.interactionEnabled ?? true);
}
