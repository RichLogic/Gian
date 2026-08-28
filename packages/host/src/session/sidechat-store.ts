import { randomUUID } from 'node:crypto';
import {
  redactSensitiveProtocolText,
  redactSensitiveProtocolValue,
} from '@gian/proxy-protocol';
import type {
  ConfigOption,
  ConfigValue,
  ComposerDocument,
  MessageContextItem,
  SideChatAnchor,
  SideChatPublicSnapshot,
  SideChatStatus,
} from '@gian/shared';
import type { Db } from '../storage/db.js';

const MAX_TRANSIENT_EVENTS = 200;
const MAX_COMPACTED_CONTENT_CHARS = 1024 * 1024;
const REPLACEABLE_EVENT_METHODS = new Set([
  'content.completed',
  'activity.updated',
  'plan.updated',
  'diff.updated',
]);
const NON_DISPLAY_EVENT_METHODS = new Set([
  'catalog.changed',
  'history.changed',
  'request.updated',
  'session.updated',
  'step.updated',
  'usage.updated',
]);

export interface SidechatStoredUserInput {
  turnId: string;
  input: unknown;
  createdAt: string;
  contextItems?: MessageContextItem[];
  composerDocument?: ComposerDocument;
}

export interface SidechatRecord {
  sidechatId: string;
  parentSessionId: string;
  ordinal: number;
  name: string | null;
  parentStreamId: string | null;
  streamId: string | null;
  streamGeneration: number;
  resumeRefId: string;
  status: SideChatStatus;
  publicState: SideChatPublicSnapshot['state'];
  anchor: SideChatAnchor;
  sessionConfig: Record<string, ConfigValue>;
  turnConfig: Record<string, ConfigValue>;
  turnConfigOptions: ConfigOption[];
  turnConfigRevision: string | null;
  events: unknown[];
  userInputs: SidechatStoredUserInput[];
  lastError: string | null;
  uncertainTurnId: string | null;
  closeResult: { ok: true; sidechatId: string; providerDataDeleted: boolean } | null;
  createFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SidechatRow {
  sidechat_id: string;
  parent_session_id: string;
  ordinal: number | null;
  name: string | null;
  parent_stream_id: string | null;
  stream_id: string | null;
  stream_generation: number;
  resume_ref_id: string;
  status: SideChatStatus;
  public_state: string | null;
  anchor_json: string;
  session_config_json: string;
  turn_config_json: string;
  turn_config_options_json: string;
  turn_config_revision: string | null;
  events_json: string;
  user_input_json: string | null;
  idempotency_json: string | null;
  last_error: string | null;
  uncertain_turn_id: string | null;
  close_result_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isStoredUserInput(value: unknown): value is SidechatStoredUserInput {
  return !!value
    && typeof value === 'object'
    && typeof (value as SidechatStoredUserInput).turnId === 'string'
    && 'input' in (value as SidechatStoredUserInput)
    && typeof (value as SidechatStoredUserInput).createdAt === 'string';
}

const PUBLIC_STATES = new Set<SideChatPublicSnapshot['state']>([
  'idle',
  'running',
  'waiting_interaction',
  'stale',
  'closed',
  'error',
]);

function hydratePublicState(row: SidechatRow): SideChatPublicSnapshot['state'] {
  if (typeof row.public_state === 'string' && PUBLIC_STATES.has(row.public_state as SideChatPublicSnapshot['state'])) {
    return row.public_state as SideChatPublicSnapshot['state'];
  }
  if (row.status === 'closing') return 'stale';
  if (row.status === 'unavailable') return 'error';
  return 'idle';
}

function hydrateUserInputs(raw: unknown): SidechatStoredUserInput[] {
  if (raw == null) return [];
  if (Array.isArray(raw) && raw.every(isStoredUserInput)) return raw;
  if (isStoredUserInput(raw)) return [raw];
  return [{ turnId: '', input: raw, createdAt: '' }];
}

function eventMethod(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const method = (event as { method?: unknown }).method;
  return typeof method === 'string' ? method : null;
}

function eventRecord(event: unknown): Record<string, unknown> {
  return event && typeof event === 'object' && !Array.isArray(event)
    ? event as Record<string, unknown>
    : {};
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventIdentity(event: unknown): string | null {
  const record = eventRecord(event);
  const method = typeof record.method === 'string' ? record.method : null;
  if (!method) return null;
  const params = nestedRecord(record.params);
  const data = nestedRecord(params.data);
  const turnId = typeof params.turnId === 'string' ? params.turnId : '';
  const identity = method === 'content.delta' || method === 'content.completed'
    ? data.contentId
    : method === 'activity.updated'
      ? data.activityId
      : method === 'interaction.requested' || method === 'interaction.resolved'
        ? data.interactionId
        : method === 'plan.updated'
          ? data.planId
          : method === 'diff.updated'
            ? data.diffId
            : method === 'step.updated'
              ? data.stepId
              : method === 'request.updated'
                ? data.requestId
                : null;
  return typeof identity === 'string' && identity
    ? `${turnId}\u0000${identity}`
    : null;
}

function mergeContentDelta(previous: unknown, incoming: unknown): unknown {
  const previousRecord = eventRecord(previous);
  const previousParams = nestedRecord(previousRecord.params);
  const previousData = nestedRecord(previousParams.data);
  const incomingRecord = eventRecord(incoming);
  const incomingParams = nestedRecord(incomingRecord.params);
  const incomingData = nestedRecord(incomingParams.data);
  const combined = `${String(previousData.delta ?? '')}${String(incomingData.delta ?? '')}`;
  return {
    ...incomingRecord,
    params: {
      ...incomingParams,
      ...(previousParams.emittedAt !== undefined
        ? { emittedAt: previousParams.emittedAt }
        : {}),
      data: {
        ...incomingData,
        delta: combined.length <= MAX_COMPACTED_CONTENT_CHARS
          ? combined
          : combined.slice(0, MAX_COMPACTED_CONTENT_CHARS),
      },
    },
  };
}

function appendCompactedEvent(events: unknown[], incoming: unknown): unknown[] {
  const method = eventMethod(incoming);
  const identity = eventIdentity(incoming);
  if (!method || !identity) return [...events, incoming].slice(-MAX_TRANSIENT_EVENTS);

  if (method === 'content.delta') {
    const completed = events.some((event) => (
      eventMethod(event) === 'content.completed' && eventIdentity(event) === identity
    ));
    if (completed) return events;
    let previousIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (eventMethod(event) === 'content.delta' && eventIdentity(event) === identity) {
        previousIndex = index;
        break;
      }
    }
    if (previousIndex >= 0) {
      const next = events.slice();
      next[previousIndex] = mergeContentDelta(events[previousIndex], incoming);
      return next.slice(-MAX_TRANSIENT_EVENTS);
    }
  }

  if (REPLACEABLE_EVENT_METHODS.has(method)) {
    const next = events.filter((event) => {
      if (eventIdentity(event) !== identity) return true;
      const existingMethod = eventMethod(event);
      return method === 'content.completed'
        ? existingMethod !== 'content.delta' && existingMethod !== 'content.completed'
        : existingMethod !== method;
    });
    return [...next, incoming].slice(-MAX_TRANSIENT_EVENTS);
  }

  return [...events, incoming].slice(-MAX_TRANSIENT_EVENTS);
}

function eventState(event: unknown): SideChatPublicSnapshot['state'] | null {
  if (!event || typeof event !== 'object') return null;
  const params = (event as { params?: { data?: { state?: unknown } } }).params;
  const state = params?.data?.state;
  return typeof state === 'string' && PUBLIC_STATES.has(state as SideChatPublicSnapshot['state'])
    ? state as SideChatPublicSnapshot['state']
    : null;
}

export function nextPersistedSidechatState(
  current: SideChatPublicSnapshot['state'],
  event: unknown,
): SideChatPublicSnapshot['state'] {
  const reported = eventState(event);
  if (reported) return reported;
  const method = eventMethod(event);
  if (method === 'turn.started') return 'running';
  if (method === 'interaction.requested') return 'waiting_interaction';
  if (method === 'interaction.resolved') {
    return current === 'running' || current === 'waiting_interaction' ? 'running' : 'idle';
  }
  if (method === 'turn.completed') return 'idle';
  if (method === 'turn.failed') return 'error';
  return current;
}

export function publicSidechatState(record: SidechatRecord): SideChatPublicSnapshot['state'] {
  if (record.status === 'unavailable') return 'error';
  if (record.status === 'closing') return 'stale';
  return record.publicState;
}

export function toPublicSidechat(record: SidechatRecord): SideChatPublicSnapshot {
  return {
    id: record.sidechatId,
    parent_session_id: record.parentSessionId,
    ordinal: record.ordinal,
    name: record.name,
    stream_id: record.streamId,
    state: publicSidechatState(record),
    status: record.status,
    anchor: record.anchor,
    session_config: record.sessionConfig,
    turn_config: record.turnConfig,
    turn_config_options: record.turnConfigOptions,
    turn_config_revision: record.turnConfigRevision,
    last_error: record.lastError,
    uncertain_turn_id: record.uncertainTurnId,
    events: record.events,
    user_inputs: record.userInputs.map((entry) => ({
      turn_id: entry.turnId,
      input: entry.input,
      created_at: entry.createdAt,
      ...(entry.contextItems ? { context_items: entry.contextItems } : {}),
      ...(entry.composerDocument ? { composer_document: entry.composerDocument } : {}),
    })),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function mintSidechatId(): string {
  return `sc_${randomUUID()}`;
}

export class SidechatTransientStore {
  constructor(private db: Db) {}

  get(sidechatId: string): SidechatRecord | null {
    const row = this.db.prepare('SELECT * FROM sidechat_transients WHERE sidechat_id = ?')
      .get(sidechatId) as SidechatRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  listOpenOrClosing(): SidechatRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM sidechat_transients
       WHERE status IN ('open', 'closing', 'unavailable')
       ORDER BY created_at`,
    ).all() as SidechatRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listByParent(parentSessionId: string): SidechatRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM sidechat_transients
       WHERE parent_session_id = ?
       ORDER BY created_at`,
    ).all(parentSessionId) as SidechatRow[];
    return rows.map((row) => this.hydrate(row));
  }

  nextOrdinal(parentSessionId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
       FROM sidechat_transients
       WHERE parent_session_id = ?`,
    ).get(parentSessionId) as { ordinal: number };
    return row.ordinal;
  }

  findByResumeRef(resumeRefId: string): SidechatRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM sidechat_transients WHERE resume_ref_id = ?',
    ).get(resumeRefId) as SidechatRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  upsert(record: SidechatRecord): void {
    this.db.prepare(
      `INSERT INTO sidechat_transients (
         sidechat_id, parent_session_id, ordinal, name,
         parent_stream_id, stream_id, stream_generation,
         resume_ref_id, status, public_state, anchor_json, session_config_json,
         turn_config_json, turn_config_options_json, turn_config_revision, events_json,
         user_input_json, idempotency_json, last_error, uncertain_turn_id,
         close_result_json, created_at, updated_at
       ) VALUES (
         @sidechat_id, @parent_session_id, @ordinal, @name,
         @parent_stream_id, @stream_id, @stream_generation,
         @resume_ref_id, @status, @public_state, @anchor_json, @session_config_json,
         @turn_config_json, @turn_config_options_json, @turn_config_revision, @events_json,
         @user_input_json, @idempotency_json, @last_error, @uncertain_turn_id,
         @close_result_json, @created_at, @updated_at
       )
       ON CONFLICT(sidechat_id) DO UPDATE SET
         ordinal = excluded.ordinal,
         name = excluded.name,
         parent_stream_id = excluded.parent_stream_id,
         stream_id = excluded.stream_id,
         stream_generation = excluded.stream_generation,
         resume_ref_id = excluded.resume_ref_id,
         status = excluded.status,
         public_state = excluded.public_state,
         anchor_json = excluded.anchor_json,
         session_config_json = excluded.session_config_json,
         turn_config_json = excluded.turn_config_json,
         turn_config_options_json = excluded.turn_config_options_json,
         turn_config_revision = excluded.turn_config_revision,
         events_json = excluded.events_json,
         user_input_json = excluded.user_input_json,
         idempotency_json = excluded.idempotency_json,
         last_error = excluded.last_error,
         uncertain_turn_id = excluded.uncertain_turn_id,
         close_result_json = excluded.close_result_json,
         updated_at = excluded.updated_at`,
    ).run({
      sidechat_id: record.sidechatId,
      parent_session_id: record.parentSessionId,
      ordinal: record.ordinal,
      name: record.name,
      parent_stream_id: record.parentStreamId,
      stream_id: record.streamId,
      stream_generation: record.streamGeneration,
      resume_ref_id: record.resumeRefId,
      status: record.status,
      public_state: record.publicState,
      anchor_json: JSON.stringify(record.anchor),
      session_config_json: JSON.stringify(record.sessionConfig),
      turn_config_json: JSON.stringify(record.turnConfig),
      turn_config_options_json: JSON.stringify(record.turnConfigOptions),
      turn_config_revision: record.turnConfigRevision,
      events_json: JSON.stringify(redactSensitiveProtocolValue(record.events)),
      user_input_json: record.userInputs.length === 0
        ? null
        : JSON.stringify(redactSensitiveProtocolValue(record.userInputs)),
      idempotency_json: record.createFingerprint == null
        ? null
        : JSON.stringify({ createFingerprint: record.createFingerprint }),
      last_error: record.lastError == null ? null : redactSensitiveProtocolText(record.lastError),
      uncertain_turn_id: record.uncertainTurnId,
      close_result_json: record.closeResult == null ? null : JSON.stringify(record.closeResult),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
  }

  appendEvent(sidechatId: string, event: unknown): void {
    const record = this.get(sidechatId);
    if (!record) return;
    const sanitized = redactSensitiveProtocolValue(event);
    record.publicState = nextPersistedSidechatState(record.publicState, sanitized);
    if (!NON_DISPLAY_EVENT_METHODS.has(eventMethod(sanitized) ?? '')) {
      record.events = appendCompactedEvent(record.events, sanitized);
    }
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
  }

  appendUserInput(
    sidechatId: string,
    turnId: string,
    input: unknown,
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ): void {
    const record = this.get(sidechatId);
    if (!record) return;
    record.userInputs = [
      ...record.userInputs,
      {
        turnId,
        input: redactSensitiveProtocolValue(input),
        createdAt: new Date().toISOString(),
        ...(contextItems && contextItems.length > 0 ? { contextItems } : {}),
        ...(composerDocument ? { composerDocument } : {}),
      },
    ].slice(-MAX_TRANSIENT_EVENTS);
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
  }

  setTurnConfig(sidechatId: string, turnConfig: Record<string, ConfigValue>): SidechatRecord | null {
    const record = this.get(sidechatId);
    if (!record) return null;
    record.turnConfig = turnConfig;
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
    return record;
  }

  setTurnConfigCatalog(
    sidechatId: string,
    turnConfig: Record<string, ConfigValue>,
    options: ConfigOption[],
    revision: string | null,
  ): SidechatRecord | null {
    const record = this.get(sidechatId);
    if (!record) return null;
    record.turnConfig = turnConfig;
    record.turnConfigOptions = options;
    record.turnConfigRevision = revision;
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
    return record;
  }

  setNameIfUnset(sidechatId: string, name: string): SidechatRecord | null {
    const updatedAt = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE sidechat_transients
       SET name = ?, updated_at = ?
       WHERE sidechat_id = ? AND name IS NULL`,
    ).run(name, updatedAt, sidechatId);
    return result.changes > 0 ? this.get(sidechatId) : null;
  }

  persistCloseResult(
    sidechatId: string,
    result: { ok: true; sidechatId: string; providerDataDeleted: boolean },
  ): void {
    const record = this.get(sidechatId);
    if (!record) return;
    record.closeResult = result;
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
  }

  markClosing(sidechatId: string): SidechatRecord | null {
    const record = this.get(sidechatId);
    if (!record) return null;
    record.status = 'closing';
    record.publicState = 'stale';
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
    return record;
  }

  markUnavailable(sidechatId: string, lastError: string): void {
    const record = this.get(sidechatId);
    if (!record) return;
    record.status = 'unavailable';
    record.publicState = 'error';
    record.lastError = lastError;
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
  }

  markUncertainTurn(sidechatId: string, turnId: string): void {
    const record = this.get(sidechatId);
    if (!record) return;
    record.uncertainTurnId = turnId;
    record.updatedAt = new Date().toISOString();
    this.upsert(record);
  }

  delete(sidechatId: string): void {
    this.db.prepare('DELETE FROM sidechat_transients WHERE sidechat_id = ?').run(sidechatId);
  }

  private hydrate(row: SidechatRow): SidechatRecord {
    const idempotency = parseJson<{ createFingerprint?: string }>(row.idempotency_json, {});
    return {
      sidechatId: row.sidechat_id,
      parentSessionId: row.parent_session_id,
      ordinal: row.ordinal ?? 1,
      name: row.name,
      parentStreamId: row.parent_stream_id,
      streamId: row.stream_id,
      streamGeneration: row.stream_generation,
      resumeRefId: row.resume_ref_id,
      status: row.status,
      publicState: hydratePublicState(row),
      anchor: parseJson<SideChatAnchor>(row.anchor_json, { type: 'empty' }),
      sessionConfig: parseJson<Record<string, ConfigValue>>(row.session_config_json, {}),
      turnConfig: parseJson<Record<string, ConfigValue>>(row.turn_config_json, {}),
      turnConfigOptions: parseJson<ConfigOption[]>(row.turn_config_options_json, []),
      turnConfigRevision: row.turn_config_revision,
      events: parseJson<unknown[]>(row.events_json, []),
      userInputs: hydrateUserInputs(parseJson<unknown>(row.user_input_json, null)),
      lastError: row.last_error,
      uncertainTurnId: row.uncertain_turn_id,
      closeResult: parseJson(row.close_result_json, null),
      createFingerprint: idempotency.createFingerprint ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
