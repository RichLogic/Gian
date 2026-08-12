import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  proxyNotificationSchema,
  type ProxyNotification,
} from '@gian/proxy-protocol';

interface ReplayTurn {
  inputId: string;
  input: string;
  timestamp: string;
  events: Array<{
    id: string;
    timestamp: string;
    method: ProxyNotification['method'];
    data: Record<string, unknown>;
  }>;
}

export interface NativeReplay {
  streamId: string;
  events: ProxyNotification[];
}

export class ClaudeNativeHistoryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private signature: string | null = null;

  constructor(
    private nativeSessionId: string,
    private cwd: string,
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

  retarget(nativeSessionId: string, cwd = this.cwd): void {
    this.nativeSessionId = nativeSessionId;
    this.cwd = cwd;
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
    const path = sessionPath(this.nativeSessionId, this.cwd, this.homeDir);
    if (!existsSync(path)) return null;
    try {
      const stat = statSync(path);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function systemNoise(text: string): boolean {
  const value = text.trimStart();
  return value.startsWith('<system-reminder>')
    || value.startsWith('Caveat: The messages below')
    || value.startsWith('<command-name>')
    || /^<local-command-(caveat|stdout|stderr)>/.test(value);
}

function stripSystemTags(text: string): string {
  return text
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

function projectDir(cwd: string, homeDir = homedir()): string {
  return join(homeDir, '.claude', 'projects', cwd.replaceAll('/', '-'));
}

function sessionPath(nativeSessionId: string, cwd: string, homeDir = homedir()): string {
  return join(projectDir(cwd, homeDir), `${nativeSessionId}.jsonl`);
}

export function renameClaudeNativeSession(
  nativeSessionId: string,
  cwd: string,
  name: string,
  homeDir = homedir(),
): boolean {
  const path = sessionPath(nativeSessionId, cwd, homeDir);
  if (!existsSync(path)) return false;
  // eslint-disable-next-line no-control-regex
  const clean = [...name.replace(/[\x00-\x1F\x7F]/g, ' ').trim()]
    .slice(0, 200)
    .join('');
  if (!clean) return false;
  let prefix = '';
  const size = statSync(path).size;
  if (size > 0) {
    const descriptor = openSync(path, 'r');
    try {
      const tail = Buffer.allocUnsafe(1);
      if (readSync(descriptor, tail, 0, 1, size - 1) === 1 && tail[0] !== 0x0a) {
        prefix = '\n';
      }
    } finally {
      closeSync(descriptor);
    }
  }
  appendFileSync(path, `${prefix}${JSON.stringify({
    type: 'custom-title',
    customTitle: clean,
    sessionId: nativeSessionId,
  })}\n`, 'utf8');
  return true;
}

function preview(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

export function listClaudeNativeSessions(
  cwd: string | undefined,
  homeDir = homedir(),
): Array<{ id: string; displayName?: string; cwd?: string; updatedAt?: string }> {
  if (!cwd) return [];
  const directory = projectDir(cwd, homeDir);
  if (!existsSync(directory)) return [];
  const sessions = readdirSync(directory).flatMap((entry) => {
    if (!entry.endsWith('.jsonl')) return [];
    const path = join(directory, entry);
    let stat;
    try { stat = statSync(path); } catch { return []; }
    if (!stat.isFile()) return [];
    let first = '';
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line) continue;
        let record: Record<string, unknown>;
        try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (record.type !== 'user') continue;
        const message = record.message as { content?: unknown } | undefined;
        if (typeof message?.content !== 'string' || systemNoise(message.content)) continue;
        first = preview(stripSystemTags(message.content));
        break;
      }
    } catch { /* unreadable sessions are omitted below only when metadata is unavailable */ }
    return [{
      id: basename(entry, '.jsonl'),
      ...(first ? { displayName: first } : {}),
      cwd,
      updatedAt: stat.mtime.toISOString(),
    }];
  });
  return sessions.sort((left, right) => (
    Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? '')
  ));
}

export function replayClaudeNativeSession(
  hostSessionId: string,
  nativeSessionId: string,
  cwd: string,
  homeDir = homedir(),
): NativeReplay {
  const path = sessionPath(nativeSessionId, cwd, homeDir);
  if (!existsSync(path)) return { streamId: stableId('replay', { nativeSessionId, empty: true }), events: [] };
  const content = readFileSync(path, 'utf8');
  const fallback = new Date(0).toISOString();
  const turns: ReplayTurn[] = [];
  let turn: ReplayTurn | null = null;
  const openTools = new Map<string, { title: string }>();

  for (const [lineIndex, line] of content.split('\n').entries()) {
    if (!line) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const timestamp = isoTimestamp(record.timestamp, fallback);
    const lineId = typeof record.uuid === 'string'
      ? record.uuid
      : stableId('claude-line', { nativeSessionId, lineIndex, line });
    if (record.type === 'user') {
      const message = record.message as { content?: unknown } | undefined;
      if (typeof message?.content === 'string') {
        if (systemNoise(message.content)) continue;
        turn = {
          inputId: lineId,
          input: stripSystemTags(message.content),
          timestamp,
          events: [],
        };
        turns.push(turn);
        openTools.clear();
        continue;
      }
      if (!turn || !Array.isArray(message?.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue;
        const value = block as Record<string, unknown>;
        if (value.type !== 'tool_result' || typeof value.tool_use_id !== 'string') continue;
        if (!openTools.delete(value.tool_use_id)) continue;
        turn.events.push({
          id: stableId('claude-tool-result', { lineId, toolCallId: value.tool_use_id }),
          timestamp,
          method: 'tool.completed',
          data: {
            toolCallId: value.tool_use_id,
            status: value.is_error === true ? 'failed' : 'succeeded',
            ...(value.content !== undefined ? { output: value.content } : {}),
          },
        });
      }
      continue;
    }
    if (record.type !== 'assistant' || !turn) continue;
    const message = record.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) continue;
    for (const [blockIndex, block] of message.content.entries()) {
      if (!block || typeof block !== 'object') continue;
      const value = block as Record<string, unknown>;
      const blockId = typeof value.id === 'string'
        ? value.id
        : stableId('claude-block', { lineId, blockIndex, value });
      if (value.type === 'text' && typeof value.text === 'string' && value.text) {
        turn.events.push({
          id: blockId,
          timestamp,
          method: 'content.completed',
          data: { contentId: blockId, kind: 'text', content: value.text },
        });
      } else if (
        (value.type === 'thinking' || value.type === 'reasoning')
        && typeof (value.thinking ?? value.text) === 'string'
      ) {
        turn.events.push({
          id: blockId,
          timestamp,
          method: 'content.completed',
          data: {
            contentId: blockId,
            kind: 'reasoning',
            content: String(value.thinking ?? value.text),
          },
        });
      } else if (value.type === 'tool_use' && typeof value.name === 'string') {
        openTools.set(blockId, { title: value.name });
        turn.events.push({
          id: blockId,
          timestamp,
          method: 'tool.started',
          data: {
            toolCallId: blockId,
            name: value.name,
            title: value.name,
            ...(value.input !== undefined ? { input: value.input } : {}),
          },
        });
      }
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

  for (const [index, replayTurn] of turns.entries()) {
    const turnId = stableId('replay-turn', { nativeSessionId, inputId: replayTurn.inputId, index });
    append(turnId, replayTurn.timestamp, stableId('turn-started', turnId), 'turn.started', {});
    append(turnId, replayTurn.timestamp, stableId('input', replayTurn.inputId), 'input.recorded', {
      inputId: replayTurn.inputId,
      input: [{ type: 'text', text: replayTurn.input }],
    });
    const turnTools = new Set<string>();
    for (const event of replayTurn.events) {
      if (event.method === 'tool.started') turnTools.add(String(event.data.toolCallId));
      if (event.method === 'tool.completed') turnTools.delete(String(event.data.toolCallId));
      append(turnId, event.timestamp, stableId('event', event.id), event.method, event.data);
    }
    for (const toolCallId of turnTools) {
      append(
        turnId,
        fallback,
        stableId('tool-completed', { turnId, toolCallId }),
        'tool.completed',
        { toolCallId, status: 'succeeded' },
      );
    }
    const completedAt = replayTurn.events.at(-1)?.timestamp ?? replayTurn.timestamp;
    append(
      turnId,
      completedAt,
      stableId('turn-completed', {
        turnId,
        completedAt,
        lastEventId: replayTurn.events.at(-1)?.id ?? replayTurn.inputId,
      }),
      'turn.completed',
      { stopReason: 'completed' },
    );
  }
  return { streamId, events };
}
