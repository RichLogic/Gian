import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from '../storage/db.js';
import {
  hasEventStorageV3Schema,
  isEventStorageV3Active,
} from '../storage/event-storage-v3-schema.js';

export const EVENT_ARTIFACT_THRESHOLD_BYTES = 16 * 1024;
export const MAX_STORED_EVENT_BYTES = 128 * 1024;
export const EVENT_ARTIFACT_CHUNK_BYTES = 4 * 1024 * 1024;
export const LARGE_EVENT_ARTIFACT_BYTES = 20 * 1024 * 1024;

interface ArtifactRef {
  __gian_artifact: 1;
  id: string;
  format: 'text' | 'json' | 'data-url';
  byte_length: number;
  preview?: string;
}

interface PreparedArtifact {
  id: string;
  mimeType: string;
  format: ArtifactRef['format'];
  encoding: 'identity' | 'gzip';
  byteLength: number;
  stored: Buffer;
}

interface PreparedPayload {
  encoded: string;
  artifacts: Map<string, PreparedArtifact>;
  links: Array<{ artifactId: string; path: string }>;
}

export interface PersistEventInput {
  sessionId: string;
  turnId: string;
  callId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt?: string;
  replaceSnapshot?: boolean;
}

export interface PersistEventResult {
  eventId: string;
  inserted: boolean;
}

export interface EventStorageMetrics {
  externalizedValues: number;
  restoredArtifacts: number;
  largeArtifacts: number;
  payloadFallbacks: number;
  largestStoredEventBytes: number;
}

export interface EventStoreOptions {
  mode?: 'runtime' | 'migration';
}

const metrics: EventStorageMetrics = {
  externalizedValues: 0,
  restoredArtifacts: 0,
  largeArtifacts: 0,
  payloadFallbacks: 0,
  largestStoredEventBytes: 0,
};

export function eventStorageMetrics(): Readonly<EventStorageMetrics> {
  return { ...metrics };
}

export function resetEventStorageMetrics(): void {
  metrics.externalizedValues = 0;
  metrics.restoredArtifacts = 0;
  metrics.largeArtifacts = 0;
  metrics.payloadFallbacks = 0;
  metrics.largestStoredEventBytes = 0;
}

/** One lossless persistence path for live, replayed, and JSONL events. */
export class EventStore {
  readonly usesSequence: boolean;

  constructor(private db: Db, options: EventStoreOptions = {}) {
    this.usesSequence = options.mode === 'migration'
      ? hasEventStorageV3Schema(db)
      : isEventStorageV3Active(db);
  }

  persist(input: PersistEventInput): PersistEventResult {
    if (!this.usesSequence) return this.persistLegacy(input);
    return this.db.transaction(() => {
      const existing = input.replaceSnapshot
        ? this.db.prepare(
          `SELECT id
           FROM events
           WHERE session_id = ? AND turn_id = ? AND call_id = ? AND type = ?
           ORDER BY sequence DESC
           LIMIT 1`,
        ).get(input.sessionId, input.turnId, input.callId, input.type) as { id: string } | undefined
        : undefined;
      const eventId = existing?.id ?? randomUUID();
      const prepared = preparePayload(input.data);

      if (existing) {
        if (input.createdAt) {
          this.db.prepare('UPDATE events SET data = ?, created_at = ? WHERE id = ?')
            .run(prepared.encoded, input.createdAt, eventId);
        } else {
          this.db.prepare('UPDATE events SET data = ? WHERE id = ?')
            .run(prepared.encoded, eventId);
        }
      } else {
        this.db.prepare(
          `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
        ).run(
          eventId,
          input.sessionId,
          input.turnId,
          input.callId,
          input.type,
          prepared.encoded,
          input.createdAt ?? null,
        );
      }

      this.syncArtifacts(eventId, prepared);
      return { eventId, inserted: !existing };
    })();
  }

  replaceData(eventId: string, data: Record<string, unknown>): void {
    if (!this.usesSequence) {
      this.db.prepare('UPDATE events SET data = ? WHERE id = ?')
        .run(JSON.stringify(data), eventId);
      return;
    }
    this.db.transaction(() => {
      const prepared = preparePayload(data);
      this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(prepared.encoded, eventId);
      this.syncArtifacts(eventId, prepared);
    })();
  }

  decode(
    encoded: string,
    options: { skipPaths?: ReadonlySet<string> } = {},
  ): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded) as unknown;
    } catch {
      return {};
    }
    if (!this.usesSequence) return isRecord(parsed) ? parsed : {};
    if (
      isRecord(parsed)
      && parsed.__gian_event === 3
      && isArtifactRef(parsed.payload)
    ) {
      const payload = this.restoreValue(parsed.payload, new Map(), '', options.skipPaths);
      return isRecord(payload) ? payload : {};
    }
    const restored = this.restoreValue(parsed, new Map(), '', options.skipPaths);
    return isRecord(restored) ? restored : {};
  }

  private persistLegacy(input: PersistEventInput): PersistEventResult {
    const encoded = JSON.stringify(input.data);
    if (input.replaceSnapshot) {
      const existing = this.db.prepare(
        `SELECT id FROM events
         WHERE session_id = ? AND turn_id = ? AND call_id = ? AND type = ?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(input.sessionId, input.turnId, input.callId, input.type) as { id: string } | undefined;
      if (existing) {
        const sql = input.createdAt
          ? 'UPDATE events SET data = ?, created_at = ? WHERE id = ?'
          : 'UPDATE events SET data = ? WHERE id = ?';
        if (input.createdAt) this.db.prepare(sql).run(encoded, input.createdAt, existing.id);
        else this.db.prepare(sql).run(encoded, existing.id);
        return { eventId: existing.id, inserted: false };
      }
    }
    const eventId = randomUUID();
    this.db.prepare(
      `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    ).run(
      eventId,
      input.sessionId,
      input.turnId,
      input.callId,
      input.type,
      encoded,
      input.createdAt ?? null,
    );
    return { eventId, inserted: true };
  }

  private syncArtifacts(eventId: string, prepared: PreparedPayload): void {
    this.db.prepare('DELETE FROM event_artifact_links WHERE event_id = ?').run(eventId);
    const insertArtifact = this.db.prepare(
      `INSERT OR IGNORE INTO event_artifacts
        (id, mime_type, format, encoding, byte_length, stored_size, chunk_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChunk = this.db.prepare(
      `INSERT OR IGNORE INTO event_artifact_chunks (artifact_id, chunk_index, data)
       VALUES (?, ?, ?)`,
    );
    for (const artifact of prepared.artifacts.values()) {
      const chunkCount = Math.max(1, Math.ceil(artifact.stored.byteLength / EVENT_ARTIFACT_CHUNK_BYTES));
      insertArtifact.run(
        artifact.id,
        artifact.mimeType,
        artifact.format,
        artifact.encoding,
        artifact.byteLength,
        artifact.stored.byteLength,
        chunkCount,
      );
      for (let index = 0; index < chunkCount; index++) {
        const start = index * EVENT_ARTIFACT_CHUNK_BYTES;
        insertChunk.run(
          artifact.id,
          index,
          artifact.stored.subarray(start, start + EVENT_ARTIFACT_CHUNK_BYTES),
        );
      }
    }
    const insertLink = this.db.prepare(
      `INSERT INTO event_artifact_links (event_id, artifact_id, path)
       VALUES (?, ?, ?)`,
    );
    for (const link of prepared.links) {
      insertLink.run(eventId, link.artifactId, link.path);
    }
  }

  private restoreValue(
    value: unknown,
    cache: Map<string, unknown>,
    path: string,
    skipPaths?: ReadonlySet<string>,
  ): unknown {
    if (skipPaths?.has(path)) return value;
    if (isArtifactRef(value)) {
      if (cache.has(value.id)) return cache.get(value.id);
      const row = this.db.prepare(
        `SELECT mime_type, format, encoding
         FROM event_artifacts WHERE id = ?`,
      ).get(value.id) as {
        mime_type: string;
        format: ArtifactRef['format'];
        encoding: 'identity' | 'gzip';
      } | undefined;
      if (!row) return value.preview ?? null;
      const chunks = this.db.prepare(
        `SELECT data FROM event_artifact_chunks
         WHERE artifact_id = ? ORDER BY chunk_index`,
      ).all(value.id) as Array<{ data: Buffer }>;
      const stored = Buffer.concat(chunks.map(chunk => chunk.data));
      metrics.restoredArtifacts += 1;
      const bytes = row.encoding === 'gzip' ? gunzipSync(stored) : stored;
      let restored: unknown;
      if (row.format === 'json') {
        restored = JSON.parse(bytes.toString('utf8')) as unknown;
      } else if (row.format === 'data-url') {
        restored = `data:${row.mime_type};base64,${bytes.toString('base64')}`;
      } else {
        restored = bytes.toString('utf8');
      }
      cache.set(value.id, restored);
      return this.restoreValue(restored, cache, path, skipPaths);
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => this.restoreValue(
        item,
        cache,
        `${path}[${index}]`,
        skipPaths,
      ));
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const childPath = path ? `${path}.${key}` : key;
        return [key, this.restoreValue(item, cache, childPath, skipPaths)];
      }),
    );
  }
}

function preparePayload(data: Record<string, unknown>): PreparedPayload {
  const artifacts = new Map<string, PreparedArtifact>();
  const links: PreparedPayload['links'] = [];
  const transformed = externalizeValue(data, '', true, artifacts, links, new WeakSet());
  let encoded = JSON.stringify(transformed);

  if (Buffer.byteLength(encoded) > MAX_STORED_EVENT_BYTES) {
    artifacts.clear();
    links.length = 0;
    const ref = createArtifactRef(data, '$payload', artifacts, links, 'json');
    encoded = JSON.stringify({ __gian_event: 3, payload: ref });
    metrics.payloadFallbacks += 1;
    console.warn(JSON.stringify({
      event: 'event_payload_externalized',
      original_bytes: ref.byte_length,
      stored_bytes: Buffer.byteLength(encoded),
    }));
  }

  const storedBytes = Buffer.byteLength(encoded);
  metrics.largestStoredEventBytes = Math.max(metrics.largestStoredEventBytes, storedBytes);
  if (storedBytes > MAX_STORED_EVENT_BYTES) {
    throw new Error(`stored event payload exceeds ${MAX_STORED_EVENT_BYTES} bytes`);
  }
  return { encoded, artifacts, links };
}

function externalizeValue(
  value: unknown,
  path: string,
  structural: boolean,
  artifacts: Map<string, PreparedArtifact>,
  links: PreparedPayload['links'],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) < EVENT_ARTIFACT_THRESHOLD_BYTES) return value;
    return createArtifactRef(value, path, artifacts, links, detectDataUrl(value) ? 'data-url' : 'text');
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const transformed = Array.isArray(value)
    ? value.map((item, index) => externalizeValue(
      item,
      `${path}[${index}]`,
      false,
      artifacts,
      links,
      seen,
    ))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      externalizeValue(
        item,
        path ? `${path}.${key}` : key,
        path === '' || path === 'display',
        artifacts,
        links,
        seen,
      ),
    ]));
  seen.delete(value);

  if (structural) return transformed;
  if (Buffer.byteLength(JSON.stringify(transformed)) < EVENT_ARTIFACT_THRESHOLD_BYTES) {
    return transformed;
  }
  return createArtifactRef(transformed, path, artifacts, links, 'json');
}

function createArtifactRef(
  value: unknown,
  path: string,
  artifacts: Map<string, PreparedArtifact>,
  links: PreparedPayload['links'],
  requestedFormat: ArtifactRef['format'],
): ArtifactRef {
  const dataUrl = requestedFormat === 'data-url' && typeof value === 'string'
    ? detectDataUrl(value)
    : null;
  const format = dataUrl ? 'data-url' : requestedFormat === 'data-url' ? 'text' : requestedFormat;
  const mimeType = dataUrl?.mime ?? (format === 'json' ? 'application/json' : 'text/plain; charset=utf-8');
  const source = dataUrl
    ? Buffer.from(dataUrl.base64, 'base64')
    : Buffer.from(format === 'json' ? JSON.stringify(value) : String(value), 'utf8');
  const hash = createHash('sha256')
    .update(format)
    .update('\0')
    .update(mimeType)
    .update('\0')
    .update(source)
    .digest('hex');
  const id = `sha256:${hash}`;
  let stored = source;
  let encoding: PreparedArtifact['encoding'] = 'identity';
  const compressed = gzipSync(source, { level: 1 });
  if (compressed.byteLength + 64 < source.byteLength) {
    stored = compressed;
    encoding = 'gzip';
  }
  if (!artifacts.has(id)) {
    artifacts.set(id, {
      id,
      mimeType,
      format,
      encoding,
      byteLength: source.byteLength,
      stored,
    });
    metrics.externalizedValues += 1;
    if (source.byteLength > LARGE_EVENT_ARTIFACT_BYTES) {
      metrics.largeArtifacts += 1;
      console.warn(JSON.stringify({
        event: 'large_event_artifact',
        path,
        bytes: source.byteLength,
        chunks: Math.ceil(stored.byteLength / EVENT_ARTIFACT_CHUNK_BYTES),
      }));
    }
  }
  links.push({ artifactId: id, path: path || '$' });
  return {
    __gian_artifact: 1,
    id,
    format,
    byte_length: source.byteLength,
    ...(typeof value === 'string' ? { preview: value.slice(0, 256) } : {}),
  };
}

function detectDataUrl(value: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  return match?.[1] && match[2] ? { mime: match[1], base64: match[2] } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return isRecord(value)
    && value.__gian_artifact === 1
    && typeof value.id === 'string'
    && (value.format === 'text' || value.format === 'json' || value.format === 'data-url');
}
