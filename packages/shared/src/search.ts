/**
 * Frozen 0.6.7 search contract (Issue #168, proposal section 6).
 *
 * Host owns `/api/search`, `/api/sessions/:id/find`,
 * `/api/sessions/:id/context`, and `/api/search/status`.
 * Settings and command hits stay in the Web static registry. This module
 * rejects those kinds instead of pretending the Host searched them.
 *
 * Ranges are UTF-16 offsets into the returned original search text, never
 * into a case-folded or NFKC string. Cursors bind the query, filters,
 * schema, and index revision; a stale cursor is `stale_cursor` (HTTP 409).
 * Over-long terms, pages, and context windows are rejected, not truncated.
 *
 * `SearchResult.id` and `FindMatch.document_id` are short Host document ids.
 * Context locates a hit with `document_id`. `message_id` is the full chat-ui
 * transcript identity used for rendering, not a 200-character Host id.
 *
 * Worktree hits use the existing inventory id (`ws:` / `wt:` / `ext:`), not a
 * session-only `worktree:` id. An `ext:` path is untrusted until the existing
 * working-tree resolver confirms current git worktree membership.
 */

import type { EventEnvelope } from './web.js';

// Bump when canonical projection/range semantics change, not only SQL shape.
export const SEARCH_SCHEMA_VERSION = 2;

export const SEARCH_QUERY_MAX_CODE_POINTS = 256;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_CONTEXT_BEFORE_MAX = 2;
export const SEARCH_CONTEXT_AFTER_MAX = 2;
export const SEARCH_CURSOR_MAX_CHARS = 4096;
export const SEARCH_CURSOR_RANK_MAX = 3;
/** Host resource ids and short document ids. Not the transcript identity or a working-tree id. */
export const SEARCH_ID_MAX_CHARS = 200;
/**
 * Whole `ws:` / `wt:` / `ext:` id. Longer than a Host id because `ext:`
 * carries base64url(absolute path). Rejected above this, never truncated.
 */
export const SEARCH_WORKING_TREE_ID_MAX_CHARS = 8192;
/**
 * UTF-8 budget for one transcript identity. Matches the proxy NDJSON line cap
 * (`MAX_NDJSON_LINE_BYTES`) without importing that package into shared.
 */
export const SEARCH_MESSAGE_IDENTITY_MAX_BYTES = 16 * 1024 * 1024;
export const SEARCH_TEXT_REVISION_PATTERN = /^[0-9a-f]{64}$/;

/** Context query keys. `document_id` locates; `message_id` is display identity. */
export const SEARCH_CONTEXT_QUERY = {
  turnId: 'turn_id',
  turn: 'turn',
  before: 'before',
  after: 'after',
  documentId: 'document_id',
  messageId: 'message_id',
  textRevision: 'text_revision',
} as const;

export const SEARCH_ROUTES = {
  search: '/api/search',
  status: '/api/search/status',
  find: '/api/sessions/:id/find',
  context: '/api/sessions/:id/context',
} as const;

export const SEARCH_BUSINESS_KINDS = [
  'session',
  'message',
  'workspace',
  'worktree',
  'task',
  'agent',
  'schedule',
  'inbox',
] as const;

export const SEARCH_UI_KINDS = ['setting', 'command'] as const;

export type SearchBusinessKind = (typeof SEARCH_BUSINESS_KINDS)[number];
export type SearchUiKind = (typeof SEARCH_UI_KINDS)[number];
export type SearchMessageKind = 'user' | 'assistant';
export type SearchCoverageState = 'ready' | 'building' | 'partial' | 'error';
export type SearchFtsMode = 'trigram' | 'unavailable';
export type SearchMatchStrategy = 'trigram' | 'substring';
export type SearchFailureCode =
  | 'invalid_argument'
  | 'stale_cursor'
  | 'not_found'
  | 'text_revision_mismatch';

export interface SearchTextRange {
  /** Inclusive UTF-16 offset into the returned original search text. */
  start: number;
  /** Exclusive UTF-16 offset into the returned original search text. */
  end: number;
}

export interface SearchCoverage {
  state: SearchCoverageState;
  /**
   * False while backfill, FTS rebuild, dirty work, cold history in this
   * response's visible scope, or this scan is incomplete.
   */
  complete: boolean;
  indexed: number;
  pending: number;
}

/**
 * Message hits use `type: 'session'` plus the turn anchor.
 * `message_id`, when present, is the chat-ui transcript identity
 * `${turn}:${message_kind}:${itemId}` (`data-transcript-source-id`).
 * It is rendering data. Pass `SearchResult.id` as context `document_id`.
 */
export interface SearchSessionTarget {
  type: 'session';
  session_id: string;
  turn_id?: string;
  turn?: number;
  /** Full transcript identity. Not capped at `SEARCH_ID_MAX_CHARS`. */
  message_id?: string;
  message_kind?: SearchMessageKind;
  text_revision?: string;
  archived: boolean;
}

export interface SearchMessageTarget {
  type: 'session';
  session_id: string;
  turn_id: string;
  turn: number;
  /**
   * Full transcript identity `${turn}:${message_kind}:${itemId}`.
   * `itemId` is opaque provider text and is not a Host UUID or a 200-character
   * id. Highlight and React keys use this value. Context lookup uses
   * `document_id`.
   */
  message_id: string;
  message_kind: SearchMessageKind;
  text_revision: string;
  archived: boolean;
}

export interface SearchWorkspaceTarget {
  type: 'workspace';
  workspace_id: string;
}

/**
 * One row from the existing working-tree inventory (`WorkingTreeListItem`).
 * Navigation passes `working_tree_id` to that resolver. Do not open `ext:`
 * by decoding its path; membership is rechecked on each resolve.
 */
export interface SearchWorktreeTarget {
  type: 'worktree';
  /**
   * `ws:<workspace_id>`, `wt:<session_id>`, or
   * `ext:<workspace_id>:<base64url(absolute path)>`.
   */
  working_tree_id: string;
  workspace_id: string;
  /** Set for `wt:` only. `ws:` and external `ext:` rows have no session. */
  session_id: string | null;
  /** Session archive flag for `wt:`. Always false for `ws:` and `ext:`. */
  archived: boolean;
}

export type ParsedWorkingTreeId =
  | { kind: 'workspace'; workingTreeId: string; workspaceId: string; sessionId: null }
  | { kind: 'session'; workingTreeId: string; sessionId: string }
  | { kind: 'external'; workingTreeId: string; workspaceId: string; sessionId: null };

export interface SearchTaskTarget {
  type: 'task';
  task_id: string;
}

export interface SearchAgentTarget {
  type: 'agent';
  agent_id: string;
}

export interface SearchScheduleTarget {
  type: 'schedule';
  schedule_id: string;
  archived: boolean;
}

export interface SearchInboxTarget {
  type: 'inbox';
  inbox_id: string;
  generation: number;
}

export type SearchTarget =
  | SearchSessionTarget
  | SearchMessageTarget
  | SearchWorkspaceTarget
  | SearchWorktreeTarget
  | SearchTaskTarget
  | SearchAgentTarget
  | SearchScheduleTarget
  | SearchInboxTarget;

export interface SearchResult {
  /**
   * Short document id, at most `SEARCH_ID_MAX_CHARS`.
   * Context queries pass this value as `document_id`. It is not `message_id`.
   */
  id: string;
  kind: SearchBusinessKind;
  title: string;
  subtitle?: string;
  /** Window of the original projected search text. Ranges index this string. */
  snippet?: string;
  ranges: SearchTextRange[];
  target: SearchTarget;
  updated_at: string;
  archived: boolean;
}

export interface SearchPage {
  results: SearchResult[];
  next_cursor: string | null;
  index_revision: string;
  coverage: SearchCoverage;
}

export interface FindMatch {
  /** Short occurrence id. Distinguishes ranges inside one message. */
  id: string;
  /** Same short document id as `SearchResult.id`. Context `document_id`. */
  document_id: string;
  target: SearchMessageTarget;
  /**
   * UTF-16 offsets into the message's full projected search text.
   * `snippet` is only a display window; do not highlight the snippet with
   * this range.
   */
  range: SearchTextRange;
  snippet: string;
}

export interface FindPage {
  matches: FindMatch[];
  next_cursor: string | null;
  query_revision: string;
  /** Exact only when `total_complete` is true. */
  total: number;
  total_complete: boolean;
  coverage: SearchCoverage;
}

export interface SearchContextSession {
  id: string;
  name: string | null;
  archived: 0 | 1;
  /** Archived sessions open read-only. The API does not unarchive them. */
  read_only: boolean;
  workspace_id: string | null;
  task_id: string | null;
  /**
   * Search projection only. This is not a Session: executor, type, model,
   * approval mode, and status are absent. Do not cast it to Session.
   */
  projection: 'search-context';
}

export interface SearchContextWindow {
  turn_id: string;
  turn: number;
  before: number;
  after: number;
  from_turn: number;
  to_turn: number;
}

export interface SearchContextPage {
  session: SearchContextSession;
  /** Canonical history envelopes for the bounded turn window only. */
  events: EventEnvelope[];
  /**
   * False when cold history for this session is still incomplete.
   * `search_state` backfill completion does not set this.
   */
  history_complete: boolean;
  window: SearchContextWindow;
}

export interface SearchStatus {
  schema_version: number;
  index_revision: string;
  fts: SearchFtsMode;
  coverage: SearchCoverage;
  backfill_complete: boolean;
}

export class SearchContractError extends Error {
  readonly code: SearchFailureCode;

  constructor(code: SearchFailureCode, message: string) {
    super(message);
    this.name = 'SearchContractError';
    this.code = code;
  }
}

export function searchFailureStatus(code: SearchFailureCode): 400 | 404 | 409 {
  if (code === 'not_found') return 404;
  if (code === 'stale_cursor' || code === 'text_revision_mismatch') return 409;
  return 400;
}

export type QueryInput = Record<string, string | undefined>;

export interface SearchCursorClaims {
  endpoint: 'search' | 'find';
  schema: number;
  indexRevision: string;
  queryRevision: string;
  q: string;
  types: SearchBusinessKind[];
  workspaceId: string | null;
  includeArchived: boolean;
  sessionId: string | null;
}

export interface SearchCursor extends SearchCursorClaims {
  v: 1;
  phase: 'name' | 'body';
  rank: number;
  updatedAt: string | null;
  id: string | null;
  scanAfterId: string | null;
  scanMode: SearchMatchStrategy | null;
  counted: number;
}

export interface ParsedSearchQuery {
  q: string;
  types: SearchBusinessKind[];
  workspaceId: string | null;
  includeArchived: boolean;
  limit: number;
  cursor: SearchCursor | null;
  queryRevision: string;
}

export interface ParsedFindQuery {
  sessionId: string;
  q: string;
  limit: number;
  cursor: SearchCursor | null;
  queryRevision: string;
}

export interface ParsedContextQuery {
  sessionId: string;
  turnId: string | null;
  /** Non-negative safe integer. Never Infinity or a rounded huge digit string. */
  turn: number | null;
  before: number;
  after: number;
  /** Short document id from `SearchResult.id` or `FindMatch.document_id`. */
  documentId: string | null;
  /** Full transcript identity. Null when the client locates by `documentId`. */
  messageId: string | null;
  textRevision: string | null;
}

const BUSINESS_KIND_SET = new Set<string>(SEARCH_BUSINESS_KINDS);
const UI_KIND_SET = new Set<string>(SEARCH_UI_KINDS);

/**
 * Trigram is only a candidate accelerator for queries of at least three
 * Unicode code points. Shorter queries, including Chinese 1-2 character
 * terms, always use literal substring matching.
 */
export function searchMatchStrategy(
  query: string,
  fts: SearchFtsMode,
): SearchMatchStrategy {
  const points = Array.from(query.normalize('NFKC').toLowerCase()).length;
  if (fts === 'trigram' && points >= 3) return 'trigram';
  return 'substring';
}

/** Bound FTS5 phrase. The caller passes the result as a SQL parameter. */
export function ftsTrigramLiteral(normalizedQuery: string): string {
  return `"${normalizedQuery.replaceAll('"', '""')}"`;
}

export function parseGlobalSearchQuery(input: QueryInput): ParsedSearchQuery {
  const q = parseQueryText(input.q);
  const types = parseTypes(input.types);
  const workspaceId = parseOptionalId(input.workspace_id, 'workspace_id');
  const includeArchived = parseFlag(input.include_archived, 'include_archived');
  const limit = parseLimit(input.limit);
  const queryRevision = searchQueryRevision({
    endpoint: 'search',
    q,
    types,
    workspaceId,
    includeArchived,
    sessionId: null,
  });
  const cursor = parseCursor(input.cursor, {
    endpoint: 'search',
    schema: SEARCH_SCHEMA_VERSION,
    queryRevision,
    q,
    types,
    workspaceId,
    includeArchived,
    sessionId: null,
  });
  return { q, types, workspaceId, includeArchived, limit, cursor, queryRevision };
}

export function parseFindQuery(sessionId: string, input: QueryInput): ParsedFindQuery {
  const id = parseRequiredId(sessionId, 'session id');
  const q = parseQueryText(input.q);
  const limit = parseLimit(input.limit);
  const types: SearchBusinessKind[] = ['message'];
  const queryRevision = searchQueryRevision({
    endpoint: 'find',
    q,
    types,
    workspaceId: null,
    includeArchived: true,
    sessionId: id,
  });
  const cursor = parseCursor(input.cursor, {
    endpoint: 'find',
    schema: SEARCH_SCHEMA_VERSION,
    queryRevision,
    q,
    types,
    workspaceId: null,
    includeArchived: true,
    sessionId: id,
  });
  return { sessionId: id, q, limit, cursor, queryRevision };
}

export function parseContextQuery(sessionId: string, input: QueryInput): ParsedContextQuery {
  const id = parseRequiredId(sessionId, 'session id');
  const turnId = parseOptionalId(input.turn_id, 'turn_id');
  const turn = parseOptionalTurn(input.turn);
  if (!turnId && turn === null) {
    throw new SearchContractError('invalid_argument', 'turn_id or turn is required');
  }
  const before = parseWindow(input.before, 'before', SEARCH_CONTEXT_BEFORE_MAX);
  const after = parseWindow(input.after, 'after', SEARCH_CONTEXT_AFTER_MAX);
  const documentId = parseOptionalId(input.document_id, 'document_id');
  const messageId = parseOptionalMessageIdentity(input.message_id);
  const textRevision = parseOptionalRevision(input.text_revision);
  if (textRevision && !documentId && !messageId) {
    throw new SearchContractError(
      'invalid_argument',
      'document_id or message_id is required with text_revision',
    );
  }
  return {
    sessionId: id,
    turnId,
    turn,
    before,
    after,
    documentId,
    messageId,
    textRevision,
  };
}

/**
 * Shape check for an inventory working-tree id. This does not decode an
 * `ext:` path and does not prove the path is a git worktree.
 */
export function parseWorkingTreeId(raw: string): ParsedWorkingTreeId {
  if (
    raw.length === 0
    || raw.length > SEARCH_WORKING_TREE_ID_MAX_CHARS
    || raw.includes('\0')
    || raw !== raw.trim()
  ) {
    throw new SearchContractError('invalid_argument', 'working_tree_id is invalid');
  }
  if (raw.startsWith('ws:')) {
    const workspaceId = parseRequiredId(raw.slice(3), 'working_tree_id');
    return { kind: 'workspace', workingTreeId: raw, workspaceId, sessionId: null };
  }
  if (raw.startsWith('wt:')) {
    const sessionId = parseRequiredId(raw.slice(3), 'working_tree_id');
    return { kind: 'session', workingTreeId: raw, sessionId };
  }
  if (raw.startsWith('ext:')) {
    const rest = raw.slice(4);
    const sep = rest.indexOf(':');
    if (sep <= 0) {
      throw new SearchContractError('invalid_argument', 'working_tree_id is invalid');
    }
    const workspaceId = parseRequiredId(rest.slice(0, sep), 'working_tree_id');
    const encoded = rest.slice(sep + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new SearchContractError('invalid_argument', 'working_tree_id is invalid');
    }
    return { kind: 'external', workingTreeId: raw, workspaceId, sessionId: null };
  }
  throw new SearchContractError('invalid_argument', 'working_tree_id is invalid');
}

/**
 * `${turn}:${user|assistant}:${itemId}`. `itemId` keeps colons, spaces, and
 * non-ASCII text. The value is not trimmed and is not limited to
 * `SEARCH_ID_MAX_CHARS`. NUL and identities above the event-line byte budget
 * are rejected.
 */
export function parseMessageIdentity(raw: string): string {
  if (raw.includes('\0')) {
    throw new SearchContractError('invalid_argument', 'message_id is invalid');
  }
  const match = /^(0|[1-9]\d*):(user|assistant):([\s\S]+)$/.exec(raw);
  const turn = match?.[1];
  if (!match || turn === undefined) {
    throw new SearchContractError('invalid_argument', 'message_id is invalid');
  }
  if (!isSafeDigitInteger(turn)) {
    throw new SearchContractError('invalid_argument', 'message_id is invalid');
  }
  if (utf8Bytes(raw) > SEARCH_MESSAGE_IDENTITY_MAX_BYTES) {
    throw new SearchContractError('invalid_argument', 'message_id is invalid');
  }
  return raw;
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  if (!isCursor(cursor)) {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  const encoded = base64UrlEncode(JSON.stringify(cursor));
  if (encoded.length > SEARCH_CURSOR_MAX_CHARS) {
    throw new SearchContractError('invalid_argument', 'cursor is too long');
  }
  return encoded;
}

export function assertCursorFresh(
  cursor: SearchCursor,
  expected: SearchCursorClaims,
): void {
  if (
    cursor.endpoint !== expected.endpoint
    || cursor.schema !== expected.schema
    || cursor.indexRevision !== expected.indexRevision
    || cursor.queryRevision !== expected.queryRevision
    || cursor.q !== expected.q
    || cursor.workspaceId !== expected.workspaceId
    || cursor.includeArchived !== expected.includeArchived
    || cursor.sessionId !== expected.sessionId
    || cursor.types.join('\0') !== expected.types.join('\0')
  ) {
    throw new SearchContractError('stale_cursor', 'cursor does not match this query');
  }
}

export function searchQueryRevision(input: Omit<SearchCursorClaims, 'schema' | 'indexRevision' | 'queryRevision'>): string {
  return base64UrlEncode(JSON.stringify({
    endpoint: input.endpoint,
    q: input.q,
    types: input.types,
    workspaceId: input.workspaceId,
    includeArchived: input.includeArchived,
    sessionId: input.sessionId,
    schema: SEARCH_SCHEMA_VERSION,
  }));
}

function parseCursor(
  raw: string | undefined,
  expected: Omit<SearchCursorClaims, 'indexRevision'>,
): SearchCursor | null {
  if (raw === undefined) return null;
  if (raw.length === 0 || raw.length > SEARCH_CURSOR_MAX_CHARS) {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw));
  } catch {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  if (!isCursor(parsed)) {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  assertCursorFresh(parsed, {
    ...expected,
    indexRevision: parsed.indexRevision,
  });
  if (parsed.schema !== SEARCH_SCHEMA_VERSION) {
    throw new SearchContractError('stale_cursor', 'cursor schema is stale');
  }
  return parsed;
}

function isCursor(value: unknown): value is SearchCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Partial<SearchCursor>;
  return cursor.v === 1
    && (cursor.endpoint === 'search' || cursor.endpoint === 'find')
    && isSafeNonNegative(cursor.schema)
    && isShortId(cursor.indexRevision)
    && typeof cursor.queryRevision === 'string'
    && cursor.queryRevision.length > 0
    && cursor.queryRevision.length <= SEARCH_CURSOR_MAX_CHARS
    && !cursor.queryRevision.includes('\0')
    && typeof cursor.q === 'string'
    && !cursor.q.includes('\0')
    && Array.from(cursor.q).length <= SEARCH_QUERY_MAX_CODE_POINTS
    && Array.isArray(cursor.types)
    && cursor.types.every(kind => typeof kind === 'string' && BUSINESS_KIND_SET.has(kind))
    && (cursor.workspaceId === null || isShortId(cursor.workspaceId))
    && typeof cursor.includeArchived === 'boolean'
    && (cursor.sessionId === null || isShortId(cursor.sessionId))
    && (cursor.phase === 'name' || cursor.phase === 'body')
    && isSafeNonNegative(cursor.rank)
    && cursor.rank <= SEARCH_CURSOR_RANK_MAX
    && isCursorStamp(cursor.updatedAt)
    && (cursor.id === null || isShortId(cursor.id))
    && (cursor.scanAfterId === null || isShortId(cursor.scanAfterId))
    && (cursor.scanMode === null || cursor.scanMode === 'trigram' || cursor.scanMode === 'substring')
    && isSafeNonNegative(cursor.counted);
}

function parseQueryText(raw: string | undefined): string {
  if (raw === undefined) {
    throw new SearchContractError('invalid_argument', 'q is required');
  }
  const q = raw.trim();
  if (!q) throw new SearchContractError('invalid_argument', 'q is required');
  if (q.includes('\0')) throw new SearchContractError('invalid_argument', 'q is invalid');
  const points = Array.from(q).length;
  if (points > SEARCH_QUERY_MAX_CODE_POINTS) {
    throw new SearchContractError(
      'invalid_argument',
      `q must be at most ${SEARCH_QUERY_MAX_CODE_POINTS} characters`,
    );
  }
  return q;
}

function parseTypes(raw: string | undefined): SearchBusinessKind[] {
  if (raw === undefined || raw.trim() === '') return [...SEARCH_BUSINESS_KINDS];
  const kinds = raw.split(',').map(part => part.trim()).filter(part => part.length > 0);
  if (kinds.length === 0) {
    throw new SearchContractError('invalid_argument', 'types is invalid');
  }
  const seen = new Set<SearchBusinessKind>();
  for (const kind of kinds) {
    if (UI_KIND_SET.has(kind)) {
      throw new SearchContractError(
        'invalid_argument',
        `${kind} is matched by the client registry, not Host search`,
      );
    }
    if (!BUSINESS_KIND_SET.has(kind)) {
      throw new SearchContractError('invalid_argument', 'types is invalid');
    }
    seen.add(kind as SearchBusinessKind);
  }
  return SEARCH_BUSINESS_KINDS.filter(kind => seen.has(kind));
}

function parseLimit(raw: string | undefined): number {
  return parseBoundedInteger(raw, 'limit', 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
}

function parseFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw === '') return false;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new SearchContractError('invalid_argument', `${name} is invalid`);
}

function parseWindow(raw: string | undefined, name: string, max: number): number {
  return parseBoundedInteger(raw, name, 0, max, 0);
}

function parseOptionalTurn(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  return parseSafeNonNegativeInteger(raw, 'turn');
}

function parseOptionalMessageIdentity(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  return parseMessageIdentity(raw);
}

function parseBoundedInteger(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!isSafeDigitInteger(raw)) {
    throw new SearchContractError(
      'invalid_argument',
      `${name} must be an integer from ${min} to ${max}`,
    );
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new SearchContractError(
      'invalid_argument',
      `${name} must be an integer from ${min} to ${max}`,
    );
  }
  return value;
}

/** Finite integer in `0..Number.MAX_SAFE_INTEGER`. Rejects `1e400`, negatives, and fractions. */
function parseSafeNonNegativeInteger(raw: string, name: string): number {
  if (!isSafeDigitInteger(raw)) {
    throw new SearchContractError('invalid_argument', `${name} must be a non-negative integer`);
  }
  return Number(raw);
}

function isSafeDigitInteger(raw: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(raw) || raw.length > 16) return false;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isShortId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SEARCH_ID_MAX_CHARS
    && !value.includes('\0')
    && value === value.trim();
}

function isCursorStamp(value: unknown): boolean {
  return value === null
    || (typeof value === 'string'
      && value.length > 0
      && value.length <= SEARCH_ID_MAX_CHARS
      && !value.includes('\0'));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function parseOptionalId(raw: string | undefined, name: string): string | null {
  if (raw === undefined || raw === '') return null;
  return parseRequiredId(raw, name);
}

function parseRequiredId(raw: string, name: string): string {
  if (!raw || raw.length > SEARCH_ID_MAX_CHARS || raw.includes('\0') || raw !== raw.trim()) {
    throw new SearchContractError('invalid_argument', `${name} is invalid`);
  }
  return raw;
}

function parseOptionalRevision(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!SEARCH_TEXT_REVISION_PATTERN.test(raw)) {
    throw new SearchContractError('invalid_argument', 'text_revision is invalid');
  }
  return raw;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
