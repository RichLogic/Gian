import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, closeSync, readSync, writeSync, ftruncateSync, rmSync, statSync } from 'node:fs';
import { open, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { MAX_NDJSON_LINE_BYTES } from '@gian/proxy-protocol';
import { findSession, type CodexFile, type NativeTurnIdentityStore, type ReplayEvent } from './native-history.js';

const CHUNK_BYTES = 64 * 1024;
const PAGE_BYTES = MAX_NDJSON_LINE_BYTES - 64 * 1024;
const INDEX_BYTES = 16;
const fallbackTime = new Date(0).toISOString();

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

interface Segment extends CodexFile { end: number; device: number; inode: number; mtime: number }
interface MessageRef { offset: number; length: number }
interface Message { id: string; timestamp: string; text: string }
interface Turn {
  id: string;
  timestamp: string;
  input: string;
  nativeTurnId?: string;
  completed?: boolean;
  messages: MessageRef[];
}

function header(file: CodexFile): { payload?: { history_base?: { thread_id?: unknown; end_byte_offset?: unknown } } } {
  const fd = openSync(file.path, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(10);
    if (newline < 0 && count === buffer.length) throw new Error('Codex history metadata record is too large.');
    return JSON.parse(buffer.subarray(0, newline < 0 ? count : newline).toString('utf8'));
  } finally { closeSync(fd); }
}

function segmentsFor(file: CodexFile, homeDir?: string, end?: number, seen = new Set<string>()): Segment[] {
  if (seen.has(file.id) || seen.size >= 32) throw new Error('Cyclic or excessively deep Codex history ancestry.');
  seen.add(file.id);
  const stat = statSync(file.path);
  const length = end ?? stat.size;
  if (!Number.isSafeInteger(length) || length < 0 || length > stat.size) {
    throw new Error('Codex history prefix is unavailable: its byte boundary is outside the file.');
  }
  if (end !== undefined && length > 0) {
    const fd = openSync(file.path, 'r');
    try {
      const byte = Buffer.alloc(1);
      if (readSync(fd, byte, 0, 1, length - 1) !== 1 || byte[0] !== 10) {
        throw new Error('Codex history prefix does not end at a record boundary.');
      }
    } finally { closeSync(fd); }
  }
  if (length === 0) return [];
  const segment = { ...file, end: length, device: stat.dev, inode: stat.ino, mtime: stat.mtimeMs };
  const base = header(file).payload?.history_base;
  if (!base) return [segment];
  if (typeof base.thread_id !== 'string' || !Number.isSafeInteger(base.end_byte_offset)) {
    throw new Error('Codex history ancestry is missing its exact prefix identity.');
  }
  const parent = findSession(base.thread_id, homeDir);
  if (!parent) throw new Error('Codex inherited history is unavailable in the selected Home.');
  return [...segmentsFor(parent, homeDir, base.end_byte_offset as number, seen), segment];
}

function anchorAt(path: string, end: number): string {
  const length = Math.min(CHUNK_BYTES, end);
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, bytes, read, length - read, end - length + read);
      if (!count) throw new Error('Codex history changed while reading.');
      read += count;
    }
    return createHash('sha256').update(bytes).digest('hex');
  } finally { closeSync(fd); }
}

class TurnFile {
  private references = 1;
  constructor(
    readonly sourceTurnId: string,
    readonly fingerprint: string,
    readonly path: string,
    readonly indexPath: string,
    readonly count: number,
    private readonly forget: () => void,
  ) {}
  retain(): this { this.references += 1; return this; }
  release(): void {
    this.references -= 1;
    if (this.references !== 0) return;
    rmSync(this.path, { force: true });
    rmSync(this.indexPath, { force: true });
    this.forget();
  }
}

/** Immutable replay pages retain turn descriptors, not history message bodies. */
export class NativeReplaySnapshot {
  readonly eventCount: number;
  private closed = false;
  constructor(readonly streamId: string, readonly turns: readonly TurnFile[]) {
    this.eventCount = turns.reduce((sum, turn) => sum + turn.count, 0);
    for (const turn of turns) turn.retain();
  }
  select(included: ReadonlySet<string>, streamId = this.streamId): NativeReplaySnapshot {
    return new NativeReplaySnapshot(streamId, this.turns.filter(turn => included.has(turn.sourceTurnId)));
  }
  retain(): NativeReplaySnapshot { return new NativeReplaySnapshot(this.streamId, this.turns); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const turn of this.turns) turn.release();
  }
  async page(offset: number, limit: number): Promise<{ replayStreamId: string; events: ReplayEvent[]; nextCursor: string | null }> {
    if (this.closed) throw new Error('Codex replay snapshot is closed.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.eventCount
      || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid replay cursor or page limit.');
    const pinned = this.retain();
    try {
      const events: ReplayEvent[] = [];
      let skip = offset;
      let bytes = 0;
      for (const turn of this.turns) {
        if (skip >= turn.count) { skip -= turn.count; continue; }
        const data = await open(turn.path, 'r');
        const index = await open(turn.indexPath, 'r');
        try {
          for (let i = skip; i < turn.count && events.length < limit; i += 1) {
            const ref = Buffer.alloc(INDEX_BYTES);
            if ((await index.read(ref, 0, ref.length, i * INDEX_BYTES)).bytesRead !== ref.length) throw new Error('Codex replay index is unavailable.');
            const position = Number(ref.readBigUInt64LE(0));
            const length = Number(ref.readBigUInt64LE(8));
            if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || length > PAGE_BYTES) throw new Error('Codex replay event exceeds the protocol page limit.');
            if (bytes + length + 256 > PAGE_BYTES && events.length) return this.result(offset, events);
            const buffer = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
              const count = (await data.read(buffer, read, length - read, position + read)).bytesRead;
              if (!count) throw new Error('Codex replay data is unavailable.');
              read += count;
            }
            events.push({ ...JSON.parse(buffer.toString('utf8')), replayStreamId: this.streamId, sequence: offset + events.length + 1 });
            bytes += length + 256;
          }
        } finally { await data.close(); await index.close(); }
        skip = 0;
        if (events.length >= limit) break;
      }
      return this.result(offset, events);
    } finally { pinned.close(); }
  }
  private result(offset: number, events: ReplayEvent[]) {
    const next = offset + events.length;
    return { replayStreamId: this.streamId, events, nextCursor: next < this.eventCount ? String(next) : null };
  }
}

class ReplayTurnParser {
  current: Turn | null = null;
  turnIndex = 0;
  lineIndex = 0;
  private readonly journal: number;
  private position = 0;
  private revision = 0;
  private projectedRevision = -1;
  private projected: TurnFile | null = null;
  constructor(
    private readonly owner: NativeHistoryIndex,
    readonly journalPath: string,
    private readonly completed: (turn: TurnFile) => void,
    existing = false,
  ) { this.journal = openSync(journalPath, existing ? 'r+' : 'w+', 0o600); }
  close(): void {
    this.projected?.release(); this.projected = null;
    closeSync(this.journal); rmSync(this.journalPath, { force: true });
  }
  async clone(journalPath: string, completed: (turn: TurnFile) => void): Promise<ReplayTurnParser> {
    await copyFile(this.journalPath, journalPath);
    const clone = new ReplayTurnParser(this.owner, journalPath, completed, true);
    clone.position = this.position;
    clone.current = this.current ? { ...this.current, messages: [...this.current.messages] } : null;
    clone.turnIndex = this.turnIndex;
    clone.lineIndex = this.lineIndex;
    clone.revision = this.revision;
    clone.projectedRevision = this.projectedRevision;
    clone.projected = this.projected?.retain() ?? null;
    return clone;
  }
  async consume(line: string): Promise<void> {
    const lineIndex = this.lineIndex++;
    if (!line) return;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { throw new Error(`Malformed Codex history record at line ${lineIndex + 1}.`); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Malformed Codex history record.');
    const payload = record.payload as Record<string, unknown> | undefined;
    const timestamp = typeof record.timestamp === 'string' && !Number.isNaN(Date.parse(record.timestamp))
      ? new Date(Date.parse(record.timestamp)).toISOString() : fallbackTime;
    const id = stableId('codex-line', { nativeSessionId: this.owner.nativeSessionId, lineIndex, line });
    if (record.type === 'event_msg' && payload?.type === 'task_started' && typeof payload.turn_id === 'string') {
      await this.finish();
      this.current = { id, timestamp, nativeTurnId: payload.turn_id, input: '', messages: [], completed: false };
      this.revision += 1;
      return;
    }
    const turn = this.current;
    if (record.type === 'event_msg' && payload?.type === 'task_complete' && turn?.nativeTurnId) {
      if (payload.turn_id === turn.nativeTurnId) { turn.completed = true; this.revision += 1; }
      return;
    }
    if (record.type === 'response_item' && payload?.type === 'message' && turn?.nativeTurnId) {
      const metadata = payload.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined;
      if (typeof metadata?.turn_id === 'string' && metadata.turn_id !== turn.nativeTurnId) return;
      const kinds = metadata?.content_item_kinds;
      if (payload.role === 'user' && Array.isArray(kinds) && kinds.length > 0
        && !kinds.some(kind => typeof kind === 'string' && kind.startsWith('user.'))) return;
      const text = Array.isArray(payload.content) ? payload.content.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const block = item as Record<string, unknown>;
        return typeof block.text === 'string' ? [block.text] : [];
      }).join('') : '';
      if (payload.role === 'user') {
        if (Buffer.byteLength(turn.input) + Buffer.byteLength(text) > PAGE_BYTES) throw new Error('Codex replay input exceeds the protocol event limit.');
        turn.input += text;
        this.revision += 1;
      } else if (payload.role === 'assistant' && text) this.message({ id, timestamp, text });
      return;
    }
    if (record.type !== 'event_msg') return;
    if (payload?.type === 'user_message' && typeof payload.message === 'string') {
      if (turn?.nativeTurnId) { turn.input = payload.message; this.revision += 1; return; }
      await this.finish();
      this.current = { id, timestamp, input: payload.message, messages: [] };
      this.revision += 1;
    } else if (payload?.type === 'agent_message' && typeof payload.message === 'string' && turn) {
      if (turn.nativeTurnId && turn.messages.length > 0) return;
      this.message({ id, timestamp, text: payload.message });
    }
  }
  async pending(): Promise<TurnFile | null> {
    if (!this.current) return null;
    if (this.projectedRevision !== this.revision || !this.projected) {
      const next = await this.owner.writeTurn(this.current, this.turnIndex, ref => this.readMessage(ref));
      this.projected?.release(); this.projected = next;
      this.projectedRevision = this.revision;
    }
    return this.projected.retain();
  }
  private message(value: Message): void {
    const bytes = Buffer.from(JSON.stringify(value));
    let written = 0;
    while (written < bytes.length) written += writeSync(this.journal, bytes, written, bytes.length - written, this.position + written);
    this.current!.messages.push({ offset: this.position, length: bytes.length });
    this.position += bytes.length;
    this.revision += 1;
  }
  private readMessage(ref: MessageRef): Message {
    const bytes = Buffer.alloc(ref.length);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(this.journal, bytes, read, bytes.length - read, ref.offset + read);
      if (!count) throw new Error('Codex replay message cache is unavailable.');
      read += count;
    }
    return JSON.parse(bytes.toString('utf8'));
  }
  private async finish(): Promise<void> {
    if (!this.current) return;
    this.completed((await this.pending())!);
    this.turnIndex += 1;
    this.projected?.release(); this.projected = null;
    this.current = null;
    ftruncateSync(this.journal, 0); this.position = 0;
  }
}

/** Per-attachment derived cache; restart rebuilds it from untouched rollouts. */
export class NativeHistoryIndex {
  private readonly directory: string;
  private readonly files = new Map<string, TurnFile>();
  private readonly completed: TurnFile[] = [];
  private parser: ReplayTurnParser;
  private segments: Segment[] = [];
  private position = 0;
  private anchor = '';
  private generation = 0;
  private closed = false;
  private pending = Promise.resolve();
  private snapshot: NativeReplaySnapshot | null = null;
  readonly metrics = { bytesRead: 0, recordsRead: 0, rebuilds: 0 };
  sourceAvailable = false;
  constructor(
    readonly hostSessionId: string,
    readonly nativeSessionId: string,
    private readonly homeDir?: string,
    private readonly identities?: NativeTurnIdentityStore,
    dataDir = process.env.GIAN_PLUGIN_DATA_DIR,
  ) {
    const root = dataDir ? join(dataDir, 'codex-replay-cache') : tmpdir();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(root, 'replay-'));
    this.parser = this.newParser();
  }
  refresh(): Promise<NativeReplaySnapshot> {
    const result = this.pending.then(() => this.update());
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async close(): Promise<void> {
    if (this.closed) return this.pending;
    this.closed = true;
    await this.pending;
    this.snapshot?.close(); this.snapshot = null;
    this.parser.close();
    for (const turn of this.completed.splice(0)) turn.release();
    if (this.files.size === 0) rmSync(this.directory, { recursive: true, force: true });
  }
  async writeTurn(turn: Turn, index: number, message: (ref: MessageRef) => Message): Promise<TurnFile> {
    const sourceTurnId = turn.nativeTurnId ?? this.identities?.resolveReplay(
      this.nativeSessionId, turn.id, [{ type: 'text', text: turn.input }],
      stableId('replay-turn', { nativeSessionId: this.nativeSessionId, inputId: turn.id, index }),
    ) ?? stableId('replay-turn', { nativeSessionId: this.nativeSessionId, inputId: turn.id, index });
    const stem = join(this.directory, `turn-${this.generation++}`);
    const data = await open(stem, 'wx', 0o600);
    const offsets = await open(`${stem}.index`, 'wx', 0o600);
    const fingerprint = createHash('sha256').update('[');
    let count = 0;
    let position = 0;
    const append = async (method: string, emittedAt: string, eventId: string, payload: Record<string, unknown>) => {
      const event = { method, emittedAt, eventId, sessionId: this.hostSessionId, sourceTurnId,
        replayStreamId: stableId('replay', { nativeSessionId: this.nativeSessionId }), sequence: 0, data: payload };
      const bytes = Buffer.from(JSON.stringify(event));
      if (bytes.length > PAGE_BYTES) throw new Error('Codex replay event exceeds the protocol page limit.');
      if (count) fingerprint.update(',');
      fingerprint.update(JSON.stringify({ method, sourceTurnId, data: payload }));
      const ref = Buffer.alloc(INDEX_BYTES);
      ref.writeBigUInt64LE(BigInt(position), 0); ref.writeBigUInt64LE(BigInt(bytes.length), 8);
      await data.writeFile(bytes); await offsets.writeFile(ref);
      position += bytes.length; count += 1;
    };
    try {
      const eventId = (method: string, identity: string) => stableId('provider-event', { nativeSessionId: this.nativeSessionId, sourceTurnId, method, identity });
      await append('turn.started', turn.timestamp, eventId('turn.started', 'lifecycle'), {});
      await append('input.recorded', turn.timestamp, stableId('input', turn.id), { input: [{ type: 'text', text: turn.input }] });
      let last = turn.timestamp;
      for (const [i, ref] of turn.messages.entries()) {
        const item = message(ref);
        last = item.timestamp;
        const contentId = `text:${i + 1}`;
        await append('content.completed', item.timestamp, eventId('content.completed', contentId), { contentId, kind: 'text', content: item.text });
      }
      if (turn.completed !== false) await append('turn.completed', last, eventId('turn.completed', 'lifecycle'), { stopReason: 'completed' });
    } catch (error) {
      await data.close(); await offsets.close();
      rmSync(stem, { force: true }); rmSync(`${stem}.index`, { force: true });
      throw error;
    }
    await data.close(); await offsets.close();
    const digest = fingerprint.update(']').digest('hex');
    const key = `${sourceTurnId}:${digest}`;
    const existing = this.files.get(key);
    if (existing) {
      rmSync(stem, { force: true }); rmSync(`${stem}.index`, { force: true });
      return existing.retain();
    }
    const file = new TurnFile(sourceTurnId, digest, stem, `${stem}.index`, count, () => {
      this.files.delete(key);
      if (this.closed && this.files.size === 0) rmSync(this.directory, { recursive: true, force: true });
    });
    this.files.set(key, file);
    return file;
  }
  private newParser(): ReplayTurnParser {
    return new ReplayTurnParser(this, join(this.directory, `messages-${this.generation++}`), turn => this.completed.push(turn));
  }
  private async update(): Promise<NativeReplaySnapshot> {
    if (this.closed) throw new Error('Codex history reader is closed.');
    const file = findSession(this.nativeSessionId, this.homeDir);
    this.sourceAvailable = file !== null;
    const next = file ? segmentsFor(file, this.homeDir) : [];
    const previousLeaf = this.segments.at(-1);
    const leaf = next.at(-1);
    if (!leaf && !previousLeaf && this.snapshot?.eventCount === 0) return this.snapshot.retain();
    const same = next.length === this.segments.length && next.every((item, index) => {
      const previous = this.segments[index]!;
      return item.path === previous.path && item.device === previous.device && item.inode === previous.inode
        && (index === next.length - 1 ? item.end >= previous.end : item.end === previous.end && item.mtime === previous.mtime);
    });
    if (same && leaf && previousLeaf && leaf.end === previousLeaf.end && leaf.mtime === previousLeaf.mtime && this.snapshot) return this.snapshot.retain();
    const appendOnly = same && leaf && previousLeaf && leaf.end > previousLeaf.end
      && anchorAt(leaf.path, this.position) === this.anchor;
    if (!appendOnly) {
      this.metrics.rebuilds += 1;
      this.parser.close();
      for (const turn of this.completed.splice(0)) turn.release();
      this.parser = this.newParser();
      this.position = 0;
    }
    const temporary: TurnFile[] = [];
    let clone: ReplayTurnParser | null = null;
    try {
      const start = appendOnly ? next.length - 1 : 0;
      for (let i = start; i < next.length; i += 1) {
        const scan = await this.scan(next[i]!, appendOnly ? this.position : 0);
        this.position = scan.position;
        if (scan.tail !== null) {
          // A valid final record without a newline is visible in this snapshot,
          // but not committed until its terminating newline arrives.
          try { JSON.parse(scan.tail); } catch { continue; }
          clone = await this.parser.clone(join(this.directory, `tail-${this.generation++}`), turn => temporary.push(turn));
          await clone.consume(scan.tail);
        }
      }
      const active = await (clone ?? this.parser).pending();
      if (active) temporary.push(active);
      if (this.closed) throw new Error('Codex history reader was closed during refresh.');
      const snapshot = new NativeReplaySnapshot(stableId('replay', { nativeSessionId: this.nativeSessionId }), [...this.completed, ...temporary]);
      this.snapshot?.close(); this.snapshot = snapshot;
      this.segments = next;
      this.anchor = leaf ? anchorAt(leaf.path, this.position) : '';
      return snapshot.retain();
    } catch (error) {
      this.segments = [];
      throw error;
    } finally {
      clone?.close();
      for (const turn of temporary) turn.release();
    }
  }
  private async scan(segment: Segment, start: number): Promise<{ position: number; tail: string | null }> {
    const file = await open(segment.path, 'r');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const parts: Buffer[] = [];
    let partialBytes = 0;
    let position = start;
    let committed = start;
    try {
      const opened = await file.stat();
      if (opened.dev !== segment.device || opened.ino !== segment.inode || opened.size < segment.end) {
        throw new Error('Codex history file was replaced or truncated while reading.');
      }
      while (position < segment.end) {
        const count = (await file.read(buffer, 0, Math.min(buffer.length, segment.end - position), position)).bytesRead;
        if (!count) throw new Error('Codex history changed while reading its prefix.');
        this.metrics.bytesRead += count;
        const chunk = buffer.subarray(0, count);
        let offset = 0;
        while (offset < count) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? count : newline;
          const part = Buffer.from(chunk.subarray(offset, end));
          parts.push(part); partialBytes += part.length;
          if (partialBytes > MAX_NDJSON_LINE_BYTES) throw new Error('Codex history record exceeds the per-record read limit.');
          if (newline < 0) break;
          await this.parser.consume(Buffer.concat(parts, partialBytes).toString('utf8'));
          this.metrics.recordsRead += 1;
          parts.length = 0; partialBytes = 0;
          committed = position + newline + 1;
          offset = newline + 1;
        }
        position += count;
        await yieldImmediate();
      }
      return { position: committed, tail: partialBytes ? Buffer.concat(parts, partialBytes).toString('utf8') : null };
    } finally { await file.close(); }
  }
}

/** Only turn IDs and fingerprints are retained in memory. */
export class IncrementalReplayTracker {
  private observed = new Map<string, string>();
  private included = new Set<string>();
  private latest: NativeReplaySnapshot | null = null;
  private streamId = 'replay-empty';
  attach(snapshot: NativeReplaySnapshot, includeHistory: boolean): void {
    this.latest?.close(); this.latest = snapshot;
    this.observed = new Map(snapshot.turns.map(turn => [turn.sourceTurnId, turn.fingerprint]));
    this.included = includeHistory ? new Set(this.observed.keys()) : new Set();
    this.streamId = snapshot.streamId;
  }
  observe(snapshot: NativeReplaySnapshot): boolean {
    const next = new Map(snapshot.turns.map(turn => [turn.sourceTurnId, turn.fingerprint]));
    const order = new Map([...next.keys()].map((id, i) => [id, i]));
    let lastPrevious = -1;
    for (const id of this.included) lastPrevious = Math.max(lastPrevious, order.get(id) ?? -1);
    let changed = false;
    let rewritten = snapshot.streamId !== this.latest?.streamId;
    for (const [id, fingerprint] of next) {
      const before = this.observed.get(id);
      if (before === fingerprint) continue;
      changed = true;
      if (before !== undefined || order.get(id)! < lastPrevious) rewritten = true;
      this.included.add(id);
    }
    for (const id of this.included) if (!next.has(id)) { this.included.delete(id); changed = true; rewritten = true; }
    this.latest?.close(); this.latest = snapshot; this.observed = next;
    if (rewritten) this.streamId = `${snapshot.streamId}-revision-${createHash('sha256').update(JSON.stringify([...next])).digest('hex').slice(0, 24)}`;
    return changed;
  }
  rebase(snapshot: NativeReplaySnapshot): void {
    this.latest?.close(); this.latest = snapshot;
    this.observed = new Map(snapshot.turns.map(turn => [turn.sourceTurnId, turn.fingerprint]));
    this.included = new Set([...this.included].filter(id => this.observed.has(id)));
  }
  replay(): NativeReplaySnapshot {
    return this.latest?.select(this.included, this.streamId) ?? new NativeReplaySnapshot(this.streamId, []);
  }
  close(): void { this.latest?.close(); this.latest = null; }
}
