/** Test harness: spawn the compiled kimi-proxy CLI against the fake Kimi
 *  local server (`test/fixtures/fake-kimi-server.mjs`), speak gian.proxy over
 *  its stdio, and collect every line. This exercises the full stack:
 *  supervisor → REST client → WS event socket → projector → adapter. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  constructor(scenario: Record<string, unknown>) {
    this.dir = mkdtempSync(join(tmpdir(), 'kimi-proxy-test-'));
    const scenarioPath = join(this.dir, 'scenario.json');
    this.logPath = join(this.dir, 'fake-log.jsonl');
    writeFileSync(scenarioPath, JSON.stringify(scenario));
    // Compiled tests live in dist/test; the fixture stays in test/fixtures.
    const testDir = dirname(fileURLToPath(import.meta.url));
    const fake = resolve(testDir, '..', '..', 'test', 'fixtures', 'fake-kimi-server.mjs');
    chmodSync(fake, 0o755);
    const workspace = join(this.dir, 'ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, '.keep'), '');
    (scenario as Record<string, unknown>).workspaceDir = workspace;
    writeFileSync(scenarioPath, JSON.stringify(scenario));

    this.child = spawn(process.execPath, [
      resolve('dist/src/cli/spawn.js'),
      '--kimi-bin', fake,
    ], {
      cwd: resolve('.'),
      env: {
        HOME: this.dir,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: tmpdir(),
        GIAN_PLUGIN_DATA_DIR: this.dir,
        GIAN_PLUGIN_ID: 'kimi',
        KIMI_CODE_HOME: join(this.dir, '.kimi-code'),
        FAKE_SCENARIO: scenarioPath,
        FAKE_LOG: this.logPath,
        FAKE_STATE: join(this.dir, 'fake-state.json'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const reader = createReader(this.child, (line) => this.acceptLine(line));
    void reader;
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
    for (const waiter of [...this.waiters]) waiter(parsed);
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
      }, 15_000);
      const waiter: Waiter = (line) => {
        if ((line.kind === 'result' || line.kind === 'error') && line.id === id) {
          clearTimeout(timer);
          const index = this.lines.indexOf(line);
          if (index >= 0) this.lines.splice(index, 1);
          resolveRequest(line as OutgoingLine & { id: string });
        }
      };
      this.waiters.push(waiter);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async waitNotificationFor(
    predicate: (line: OutgoingLine) => boolean,
    timeoutMs = 10_000,
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

  async waitNotifications(count: number, timeoutMs = 15_000): Promise<OutgoingLine[]> {
    const collected: OutgoingLine[] = [];
    for (;;) {
      if (collected.length >= count) return collected;
      const remaining = timeoutMs;
      const line = await Promise.race([
        this.next(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`timed out waiting for notifications (${collected.length}/${count})`)),
          remaining,
        )),
      ]);
      if (line.kind === 'notification') collected.push(line);
    }
  }

  fakeLog(): Array<Record<string, unknown>> {
    try {
      return readLogs(this.logPath);
    } catch {
      return [];
    }
  }

  /** The workspace directory created for this run (exists on disk). */
  get workspace(): string {
    return join(this.dir, 'ws');
  }

  get dataDir(): string {
    return this.dir;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolveClose();
      }, 5_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}

function createReader(child: ChildProcessWithoutNullStreams, onLine: (line: string) => void) {
  void import('node:readline').then(({ createInterface }) => {
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', onLine);
  });
  return true;
}

function readLogs(logPath: string): Array<Record<string, unknown>> {
  if (existsSync(logPath) === false) return [];
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((entry) => entry.length > 0)
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

export function startHarness(scenario: Record<string, unknown>): Harness {
  return new Harness(scenario);
}

export async function initialize(harness: Harness, versions: string[] = ['2.3', '2.2', '2.1']): Promise<Record<string, unknown>> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  if (response.kind !== 'result') {
    throw new Error(`initialize failed: ${JSON.stringify(response.payload)}`);
  }
  return (response.payload as { result: Record<string, unknown> }).result;
}

export async function createSession(harness: Harness, sessionId = 's_1'): Promise<string> {
  const created = await harness.request('session.create', {
    sessionId,
    workspace: { cwd: harness.workspace, roots: [harness.workspace] },
    config: {},
  });
  if (created.kind !== 'result') {
    throw new Error(`session.create failed: ${JSON.stringify(created.payload)}`);
  }
  const session = ((created.payload as { result: { session: Record<string, unknown> } }).result.session);
  return session.streamId as string;
}

export async function getStreamId(harness: Harness, sessionId = 's_1'): Promise<string> {
  const snapshot = await harness.request('session.get', { sessionId });
  if (snapshot.kind !== 'result') throw new Error('session.get failed');
  return ((snapshot.payload as { result: { session: { streamId: string } } }).result.session.streamId);
}
