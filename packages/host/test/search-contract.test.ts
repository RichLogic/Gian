import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  SEARCH_QUERY_MAX_CODE_POINTS,
  SEARCH_SCHEMA_VERSION,
  SearchContractError,
  assertCursorFresh,
  encodeSearchCursor,
  ftsTrigramLiteral,
  parseContextQuery,
  parseFindQuery,
  parseGlobalSearchQuery,
  parseMessageIdentity,
  parseWorkingTreeId,
  searchFailureStatus,
  searchMatchStrategy,
  type SearchCursor,
} from '../../shared/src/search.js';

function cursor(overrides: Partial<SearchCursor> = {}): SearchCursor {
  return {
    v: 1,
    endpoint: 'search',
    schema: SEARCH_SCHEMA_VERSION,
    indexRevision: '1',
    queryRevision: 'rev',
    q: 'hello',
    types: ['session'],
    workspaceId: null,
    includeArchived: false,
    sessionId: null,
    phase: 'name',
    rank: 0,
    updatedAt: null,
    id: null,
    scanAfterId: null,
    scanMode: null,
    counted: 0,
    ...overrides,
  };
}

test('search rejects an over-long query instead of truncating it', () => {
  const q = '你'.repeat(SEARCH_QUERY_MAX_CODE_POINTS + 1);
  assert.throws(
    () => parseGlobalSearchQuery({ q }),
    (error: unknown) => error instanceof SearchContractError
      && error.code === 'invalid_argument'
      && !error.message.includes(q.slice(0, 8)),
  );
});

test('search keeps a maximum-length query intact', () => {
  const q = 'a'.repeat(SEARCH_QUERY_MAX_CODE_POINTS);
  const parsed = parseGlobalSearchQuery({ q });
  assert.equal(parsed.q, q);
  assert.equal(parsed.limit, 20);
});

test('Chinese terms shorter than three code points never select trigram', () => {
  assert.equal(searchMatchStrategy('你', 'trigram'), 'substring');
  assert.equal(searchMatchStrategy('你好', 'trigram'), 'substring');
  assert.equal(searchMatchStrategy('你好世', 'trigram'), 'trigram');
  assert.equal(searchMatchStrategy('你好世界', 'unavailable'), 'substring');
});

test('Host search rejects setting and command kinds', () => {
  assert.throws(
    () => parseGlobalSearchQuery({ q: 'theme', types: 'setting,command' }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
});

test('limit and context window bounds fail closed', () => {
  assert.throws(
    () => parseGlobalSearchQuery({ q: 'alpha', limit: '51' }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => parseContextQuery('session-1', { turn: '3', before: '3' }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  const context = parseContextQuery('session-1', { turn_id: 'turn-1', after: '2' });
  assert.equal(context.before, 0);
  assert.equal(context.after, 2);
});

test('a cursor for a different query or index revision is stale', () => {
  const parsed = parseGlobalSearchQuery({ q: 'hello', types: 'session' });
  const encoded = encodeSearchCursor(cursor({
    queryRevision: parsed.queryRevision,
    q: 'hello',
    types: ['session'],
    indexRevision: '4',
  }));
  const withCursor = parseGlobalSearchQuery({ q: 'hello', types: 'session', cursor: encoded });
  assert.equal(withCursor.cursor?.indexRevision, '4');
  assert.throws(
    () => assertCursorFresh(withCursor.cursor!, {
      endpoint: 'search',
      schema: SEARCH_SCHEMA_VERSION,
      indexRevision: '5',
      queryRevision: parsed.queryRevision,
      q: 'hello',
      types: ['session'],
      workspaceId: null,
      includeArchived: false,
      sessionId: null,
    }),
    (error: unknown) => error instanceof SearchContractError
      && error.code === 'stale_cursor'
      && searchFailureStatus(error.code) === 409,
  );
  assert.throws(
    () => parseGlobalSearchQuery({ q: 'other', types: 'session', cursor: encoded }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'stale_cursor',
  );
});

test('a malformed cursor is rejected and FTS text stays a quoted literal', () => {
  assert.throws(
    () => parseFindQuery('session-1', { q: 'hello', cursor: 'not a cursor' }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  assert.equal(ftsTrigramLiteral('say "hello"'), '"say ""hello"""');
});

test('a cursor from the previous projection schema is stale for search and find', () => {
  const global = parseGlobalSearchQuery({ q: 'hello', types: 'session' });
  assert.throws(
    () => parseGlobalSearchQuery({
      q: 'hello', types: 'session',
      cursor: encodeSearchCursor(cursor({ schema: SEARCH_SCHEMA_VERSION - 1, queryRevision: global.queryRevision })),
    }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'stale_cursor',
  );
  const find = parseFindQuery('session-1', { q: 'hello' });
  assert.throws(
    () => parseFindQuery('session-1', {
      q: 'hello',
      cursor: encodeSearchCursor(cursor({
        endpoint: 'find', schema: SEARCH_SCHEMA_VERSION - 1, queryRevision: find.queryRevision,
        types: ['message'], includeArchived: true, sessionId: 'session-1',
      })),
    }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'stale_cursor',
  );
});

test('context keeps a long opaque transcript identity and a short document id', () => {
  const itemId = `${'x'.repeat(240)} /路径:a "q"  `;
  const messageId = `12:assistant:${itemId}`;
  const parsed = parseContextQuery('session-1', {
    turn: '12',
    document_id: 'doc-1',
    message_id: messageId,
  });
  assert.equal(parsed.documentId, 'doc-1');
  assert.equal(parsed.messageId, messageId);
  assert.equal(parseMessageIdentity(messageId), messageId);
  assert.equal(parsed.turn, 12);
});

test('context rejects unsafe turns and a text revision with no locator', () => {
  assert.throws(
    () => parseContextQuery('session-1', { turn: `1${'0'.repeat(400)}` }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => parseContextQuery('session-1', { turn: '-1' }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => parseContextQuery('session-1', { turn: '1e400' }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => parseContextQuery('session-1', { turn: '3', text_revision: 'a'.repeat(64) }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
});

test('cursors reject non-finite rank, count, and schema', () => {
  const parsed = parseGlobalSearchQuery({ q: 'hello', types: 'session' });
  const base = cursor({
    queryRevision: parsed.queryRevision,
    q: 'hello',
    types: ['session'],
  });
  assert.throws(
    () => encodeSearchCursor({ ...base, counted: Number.NaN }),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  const baseJson = JSON.stringify(base);
  const nonFiniteSchema = baseJson.replace(`"schema":${SEARCH_SCHEMA_VERSION}`, '"schema":1e400');
  assert.notEqual(nonFiniteSchema, baseJson, 'non-finite schema fixture must replace the current schema');
  assert.equal(JSON.parse(nonFiniteSchema).schema, Number.POSITIVE_INFINITY);
  const rawCursors = [
    JSON.stringify({ ...base, counted: -1 }),
    JSON.stringify({ ...base, rank: 1.5 }),
    JSON.stringify({ ...base, schema: -1 }),
    JSON.stringify(base).replace('"counted":0', '"counted":1e400'),
    nonFiniteSchema,
  ];
  for (const raw of rawCursors) {
    assert.throws(
      () => parseGlobalSearchQuery({ q: 'hello', types: 'session', cursor: encodeLoose(raw) }),
      (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
    );
  }
});

test('working-tree ids follow the inventory and allow a null session', () => {
  assert.deepEqual(parseWorkingTreeId('ws:workspace-1'), {
    kind: 'workspace',
    workingTreeId: 'ws:workspace-1',
    workspaceId: 'workspace-1',
    sessionId: null,
  });
  assert.deepEqual(parseWorkingTreeId('wt:session-1'), {
    kind: 'session',
    workingTreeId: 'wt:session-1',
    sessionId: 'session-1',
  });
  const encoded = 'A'.repeat(300);
  const external = parseWorkingTreeId(`ext:workspace-1:${encoded}`);
  assert.equal(external.kind, 'external');
  assert.equal(external.sessionId, null);
  if (external.kind === 'external') assert.equal(external.workspaceId, 'workspace-1');
  assert.throws(
    () => parseWorkingTreeId('worktree:session-1'),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
  assert.throws(
    () => parseWorkingTreeId('ext:workspace-1:../not-base64'),
    (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
  );
});

function encodeLoose(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(json, 'utf8').toString('base64url');
}
