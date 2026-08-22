import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { resolveClaudeSettingsPath } from '../runtime/claude-mcp-runtime.js';

export interface ReplayEvent {
  method: string;
  eventId: string;
  sessionId: string;
  replayStreamId: string;
  sequence: number;
  sourceTurnId: string;
  emittedAt: string;
  data: Record<string, unknown>;
}

interface ReplayTurn {
  inputId: string;
  input: string;
  timestamp: string;
  events: Array<{
    id: string;
    timestamp: string;
    method: string;
    data: Record<string, unknown>;
  }>;
}

export interface NativeReplay {
  streamId: string;
  events: ReplayEvent[];
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

/** Canonical prompt identity used by both live turns and native replay. */
export function normalizeNativePrompt(text: string): string {
  return stripSystemTags(text);
}

/** Deterministic sourceTurnId for a Claude native user turn.
 *
 *  Live turn.start and replayClaudeNativeSession both call this with the
 *  same `(nativeSessionId, normalizedPrompt, zero-based turn index)`, so
 *  the Provider-side turn identity is stable across live and replay without
 *  depending on the Host-assigned turnId. */
export function nativeTurnSourceId(
  nativeSessionId: string,
  normalizedPrompt: string,
  index: number,
): string {
  return stableId('claude-turn', { nativeSessionId, input: normalizedPrompt, index });
}

/** Deterministic replay-safe event ids shared by the live adapter. */
export function turnStartedEventId(sourceTurnId: string): string {
  return stableId('turn-started', sourceTurnId);
}

export function turnCompletedEventId(sourceTurnId: string): string {
  return stableId('turn-completed', sourceTurnId);
}

export function turnFailedEventId(sourceTurnId: string): string {
  return stableId('turn-failed', sourceTurnId);
}

export function inputRecordedEventId(sourceTurnId: string): string {
  return stableId('input-recorded', sourceTurnId);
}

export function contentCompletedEventId(sourceTurnId: string, contentId: string): string {
  return stableId('content-completed', { sourceTurnId, contentId });
}

export function activityEventId(
  sourceTurnId: string,
  activityId: string,
  status: string,
): string {
  return stableId('activity', { sourceTurnId, activityId, status });
}

export function claudeHistoryProjectDir(
  cwd: string,
  homeDir = homedir(),
  settingsPath = homeDir === homedir() ? resolveClaudeSettingsPath() : null,
): string {
  const configDir = settingsPath ? dirname(settingsPath) : join(homeDir, '.claude');
  let canonicalCwd = cwd;
  try {
    canonicalCwd = realpathSync.native(cwd);
  } catch {
    // Native history can still be inspected after the original cwd disappeared.
  }
  return join(configDir, 'projects', canonicalCwd.replace(/[^A-Za-z0-9-]/g, '-'));
}

function projectDir(cwd: string, homeDir = homedir()): string {
  return claudeHistoryProjectDir(cwd, homeDir);
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

function toolActivity(
  activityId: string,
  name: string,
  status: 'running' | 'succeeded' | 'failed',
  extra?: { input?: unknown; output?: unknown },
): Record<string, unknown> {
  return {
    activityId,
    kind: 'tool',
    title: name,
    status,
    presentation: {
      type: 'tool',
      data: {
        name,
        ...(extra?.input !== undefined ? { input: extra.input } : {}),
        ...(extra?.output !== undefined ? { output: extra.output } : {}),
      },
    },
  };
}

/** Number of replayable user turns currently on disk. Live turn.start uses
 *  this before spawning Claude so the next prompt receives the next index. */
export function countReplayableNativeTurns(
  nativeSessionId: string,
  cwd: string,
  homeDir = homedir(),
): number {
  const path = sessionPath(nativeSessionId, cwd, homeDir);
  if (!existsSync(path)) return 0;
  try {
    let count = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (record.type !== 'user') continue;
      const message = record.message as { content?: unknown } | undefined;
      if (typeof message?.content === 'string' && !systemNoise(message.content)) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
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
        const open = openTools.get(value.tool_use_id);
        if (!open) continue;
        openTools.delete(value.tool_use_id);
        turn.events.push({
          id: stableId('claude-tool-result', { lineId, toolCallId: value.tool_use_id }),
          timestamp,
          method: 'activity.updated',
          data: toolActivity(
            value.tool_use_id,
            open.title,
            value.is_error === true ? 'failed' : 'succeeded',
            value.content !== undefined ? { output: value.content } : undefined,
          ),
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
          data: { contentId: blockId, kind: 'text', format: 'plain', content: value.text },
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
          method: 'activity.updated',
          data: toolActivity(
            blockId,
            value.name,
            'running',
            value.input !== undefined ? { input: value.input } : undefined,
          ),
        });
      }
    }
  }

  const streamId = stableId('replay', { nativeSessionId });
  let sequence = 0;
  const events: ReplayEvent[] = [];
  const append = (
    sourceTurnId: string,
    emittedAt: string,
    eventId: string,
    method: string,
    data: Record<string, unknown>,
  ) => {
    sequence += 1;
    events.push({
      method,
      eventId,
      sessionId: hostSessionId,
      replayStreamId: streamId,
      sequence,
      sourceTurnId,
      emittedAt,
      data,
    });
  };

  for (const [index, replayTurn] of turns.entries()) {
    const sourceTurnId = nativeTurnSourceId(nativeSessionId, replayTurn.input, index);
    append(sourceTurnId, replayTurn.timestamp, turnStartedEventId(sourceTurnId), 'turn.started', {});
    append(sourceTurnId, replayTurn.timestamp, inputRecordedEventId(sourceTurnId), 'input.recorded', {
      input: [{ type: 'text', text: replayTurn.input }],
    });
    const turnTools = new Set<string>();
    for (const event of replayTurn.events) {
      if (event.method === 'activity.updated' && event.data.status === 'running') {
        turnTools.add(String(event.data.activityId));
      }
      if (event.method === 'activity.updated' && event.data.status !== 'running') {
        turnTools.delete(String(event.data.activityId));
      }
      let eventId = event.id;
      if (event.method === 'content.completed') {
        const contentId = typeof event.data.contentId === 'string'
          ? event.data.contentId
          : event.id;
        eventId = contentCompletedEventId(sourceTurnId, contentId);
      } else if (event.method === 'activity.updated') {
        const activityId = typeof event.data.activityId === 'string'
          ? event.data.activityId
          : event.id;
        const status = typeof event.data.status === 'string'
          ? event.data.status
          : 'running';
        eventId = activityEventId(sourceTurnId, activityId, status);
      }
      append(sourceTurnId, event.timestamp, eventId, event.method, event.data);
    }
    for (const activityId of turnTools) {
      append(
        sourceTurnId,
        fallback,
        activityEventId(sourceTurnId, activityId, 'succeeded'),
        'activity.updated',
        toolActivity(activityId, 'Tool', 'succeeded'),
      );
    }
    const completedAt = replayTurn.events.at(-1)?.timestamp ?? replayTurn.timestamp;
    append(
      sourceTurnId,
      completedAt,
      turnCompletedEventId(sourceTurnId),
      'turn.completed',
      { stopReason: 'completed' },
    );
  }
  return { streamId, events };
}

function turnGroups(snapshot: NativeReplay): Map<string, ReplayEvent[]> {
  const groups = new Map<string, ReplayEvent[]>();
  for (const event of snapshot.events) {
    const events = groups.get(event.sourceTurnId) ?? [];
    events.push(event);
    groups.set(event.sourceTurnId, events);
  }
  return groups;
}

function groupFingerprint(events: ReplayEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    method: event.method,
    sourceTurnId: event.sourceTurnId,
    data: event.data,
  })));
}

function revisionStreamId(
  snapshot: NativeReplay,
  fingerprints: Map<string, string>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([...fingerprints]))
    .digest('hex')
    .slice(0, 24);
  return `${snapshot.streamId}-revision-${digest}`;
}

/** Tracks complete replay turns instead of raw file bytes. A changed turn is
 * replayed as one lifecycle-complete unit, while turns already observed from
 * Gian's own runtime writes stay out of external-history refreshes. */
export class IncrementalReplayTracker {
  private observed = new Map<string, string>();
  private includedTurns = new Set<string>();
  private latest: NativeReplay = { streamId: 'replay-empty', events: [] };
  private replayStreamId = 'replay-empty';

  attach(snapshot: NativeReplay, includeHistory: boolean): void {
    this.latest = snapshot;
    const groups = turnGroups(snapshot);
    this.observed = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    this.includedTurns = includeHistory ? new Set(groups.keys()) : new Set();
    this.replayStreamId = snapshot.streamId;
  }

  observe(snapshot: NativeReplay): boolean {
    const groups = turnGroups(snapshot);
    const nextFingerprints = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    const currentOrder = [...groups.keys()];
    const previousIncluded = [...this.includedTurns];
    const lastPreviousIndex = previousIncluded.reduce(
      (last, turnId) => Math.max(last, currentOrder.indexOf(turnId)),
      -1,
    );
    let changed = false;
    let rewritten = snapshot.streamId !== this.latest.streamId;

    for (const [turnId, events] of groups) {
      const fingerprint = groupFingerprint(events);
      const previous = this.observed.get(turnId);
      if (previous === fingerprint) continue;
      changed = true;
      if (previous !== undefined || currentOrder.indexOf(turnId) < lastPreviousIndex) {
        rewritten = true;
      }
      this.includedTurns.add(turnId);
    }
    for (const turnId of previousIncluded) {
      if (groups.has(turnId)) continue;
      this.includedTurns.delete(turnId);
      changed = true;
      rewritten = true;
    }
    this.observed = nextFingerprints;
    this.latest = snapshot;
    if (rewritten) this.replayStreamId = revisionStreamId(snapshot, nextFingerprints);
    return changed;
  }

  rebase(snapshot: NativeReplay): void {
    const included = new Set(this.includedTurns);
    this.latest = snapshot;
    const groups = turnGroups(snapshot);
    this.observed = new Map(
      [...groups].map(([turnId, events]) => [turnId, groupFingerprint(events)]),
    );
    this.includedTurns = new Set([...included].filter((turnId) => groups.has(turnId)));
  }

  replay(): NativeReplay {
    const selected = this.latest.events.filter((event) => (
      this.includedTurns.has(event.sourceTurnId)
    ));
    return {
      streamId: this.replayStreamId,
      events: selected.map((event, index) => ({
        ...event,
        replayStreamId: this.replayStreamId,
        sequence: index + 1,
      })),
    };
  }

  acknowledge(): void {
    // Acknowledgement ends the current paging pass. Published turns stay in
    // the replay snapshot so later append-only refreshes preserve their
    // sequence numbers and Host can deduplicate them by stable eventId.
  }
}
