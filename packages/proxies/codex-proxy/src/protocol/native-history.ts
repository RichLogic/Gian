import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  proxyNotificationSchema,
  type ProxyNotification,
} from '@gian/proxy-protocol';

export interface NativeReplay {
  streamId: string;
  events: ProxyNotification[];
}

export class CodexNativeHistoryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private signature: string | null = null;
  private filePath: string | null = null;

  constructor(
    private nativeSessionId: string,
    private readonly onChange: () => void,
    private readonly intervalMs = 1_000,
    private readonly homeDir = homedir(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.signature = this.readSignature();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.signature = this.readSignature();
    this.paused = false;
  }

  retarget(nativeSessionId: string): void {
    this.nativeSessionId = nativeSessionId;
    this.filePath = null;
    this.resume();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (this.paused) return;
    const next = this.readSignature();
    if (next === this.signature) return;
    this.signature = next;
    this.onChange();
  }

  private readSignature(): string | null {
    if (!this.filePath) {
      this.filePath = findSession(this.nativeSessionId, this.homeDir)?.path ?? null;
    }
    if (!this.filePath) return null;
    try {
      const stat = statSync(this.filePath);
      return `${this.filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      this.filePath = null;
      return null;
    }
  }
}

interface CodexFile {
  path: string;
  id: string;
  cwd: string;
  updatedAt: string;
  displayName?: string;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function collectRollouts(homeDir = homedir()): string[] {
  const root = join(homeDir, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (stat.isFile() && entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
        files.push(path);
      }
    }
  };
  walk(root, 0);
  return files;
}

function preview(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function describe(path: string): CodexFile | null {
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    const first = lines[0];
    if (!first) return null;
    const metadata = JSON.parse(first) as Record<string, unknown>;
    if (metadata.type !== 'session_meta') return null;
    const payload = metadata.payload as Record<string, unknown> | undefined;
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
    if (!id || !cwd) return null;
    let displayName = '';
    for (const line of lines.slice(1)) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (record.type !== 'event_msg') continue;
      const event = record.payload as Record<string, unknown> | undefined;
      if (event?.type === 'user_message' && typeof event.message === 'string') {
        displayName = preview(event.message);
        break;
      }
    }
    return {
      path,
      id,
      cwd,
      updatedAt: statSync(path).mtime.toISOString(),
      ...(displayName ? { displayName } : {}),
    };
  } catch {
    return null;
  }
}

export function listCodexNativeSessions(
  cwd: string | undefined,
  homeDir = homedir(),
): Array<{ id: string; displayName?: string; cwd?: string; updatedAt?: string }> {
  return collectRollouts(homeDir)
    .flatMap(path => {
      const file = describe(path);
      return file && (!cwd || file.cwd === cwd) ? [file] : [];
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(file => ({
      id: file.id,
      ...(file.displayName ? { displayName: file.displayName } : {}),
      cwd: file.cwd,
      updatedAt: file.updatedAt,
    }));
}

function findSession(nativeSessionId: string, homeDir = homedir()): CodexFile | null {
  const matches = collectRollouts(homeDir).flatMap(path => {
    if (!path.endsWith(`-${nativeSessionId}.jsonl`)) return [];
    const file = describe(path);
    return file?.id === nativeSessionId ? [file] : [];
  });
  matches.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return matches[0] ?? null;
}

export function replayCodexNativeSession(
  hostSessionId: string,
  nativeSessionId: string,
  homeDir = homedir(),
): NativeReplay {
  const file = findSession(nativeSessionId, homeDir);
  if (!file) return { streamId: stableId('replay', { nativeSessionId, empty: true }), events: [] };
  const content = readFileSync(file.path, 'utf8');
  const fallback = new Date(0).toISOString();
  const turns: Array<{
    id: string;
    timestamp: string;
    input: string;
    messages: Array<{ id: string; timestamp: string; text: string }>;
  }> = [];
  let turn: (typeof turns)[number] | null = null;
  for (const [lineIndex, line] of content.split('\n').entries()) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (record.type !== 'event_msg') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    const timestamp = typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp))
      ? new Date(Date.parse(record.timestamp)).toISOString()
      : fallback;
    const lineId = stableId('codex-line', { nativeSessionId, lineIndex, line });
    if (payload?.type === 'user_message' && typeof payload.message === 'string') {
      turn = { id: lineId, timestamp, input: payload.message, messages: [] };
      turns.push(turn);
    } else if (
      payload?.type === 'agent_message'
      && typeof payload.message === 'string'
      && turn
    ) {
      turn.messages.push({ id: lineId, timestamp, text: payload.message });
    }
  }

  const streamId = stableId('replay', { nativeSessionId });
  let sequence = 0;
  const events: ProxyNotification[] = [];
  const append = (
    turnId: string,
    emittedAt: string,
    eventId: string,
    method: ProxyNotification['method'],
    data: Record<string, unknown>,
  ) => {
    sequence += 1;
    events.push(proxyNotificationSchema.parse({
      method,
      params: {
        eventId,
        streamId,
        sequence,
        sessionId: hostSessionId,
        turnId,
        emittedAt,
        data,
      },
    }));
  };
  for (const [index, item] of turns.entries()) {
    const turnId = stableId('replay-turn', { nativeSessionId, inputId: item.id, index });
    append(turnId, item.timestamp, stableId('turn-started', turnId), 'turn.started', {});
    append(turnId, item.timestamp, stableId('input', item.id), 'input.recorded', {
      inputId: item.id,
      input: [{ type: 'text', text: item.input }],
    });
    for (const message of item.messages) {
      append(turnId, message.timestamp, stableId('message', message.id), 'content.completed', {
        contentId: message.id,
        kind: 'text',
        content: message.text,
      });
    }
    const completedAt = item.messages.at(-1)?.timestamp ?? item.timestamp;
    append(
      turnId,
      completedAt,
      stableId('turn-completed', {
        turnId,
        completedAt,
        lastEventId: item.messages.at(-1)?.id ?? item.id,
      }),
      'turn.completed',
      { stopReason: 'completed' },
    );
  }
  return { streamId, events };
}
