// Coverage for traceability row:
//   CONTRACT-001 — Every ClientToServerMessage shape declared in
//                  `packages/shared/src/web.ts` must either have a handler
//                  branch in `packages/host/src/web/ws-handler.ts` or
//                  appear in the explicit "unimplemented by design"
//                  whitelist with a justification.
//
// The test resolves web.ts wire unions plus imported attention declarations,
// then compares dispatch cases and the dedicated attention-channel guards.
// Anything in only one of the two sets is a drift signal
// — either the handler stopped getting touched, or someone added a wire
// type without wiring its server side.
//
// There are no deferred client messages: every declared shape is handled.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { declaredWireMessageTypes, guardedWireMessageTypes, readWireMessageTypes } from './helpers/wire-message-types.js';

const WEB_TS = resolve('../shared/src/web.ts');
const ATTENTION_TS = resolve('../shared/src/attention.ts');
const WS_HANDLER_TS = resolve('src/web/ws-handler.ts');

// ---------------------------------------------------------------------------
// Keep the empty whitelist machinery so any future exception is explicit.
// ---------------------------------------------------------------------------

const UNIMPLEMENTED_BY_DESIGN: ReadonlyArray<{ type: string; reason: string }> = [];

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function declaredClientMessageTypes(): Set<string> {
  return readWireMessageTypes('ClientToServerMessage', [WEB_TS, ATTENTION_TS]);
}

/**
 * Pull every `case '<literal>':` arm out of the dispatch switch in
 * ws-handler.ts. We scope to the `dispatch` function body so unrelated
 * switches in the same file (none currently, but defensive) don't pollute.
 */
function handledMessageTypes(): Set<string> {
  const text = readFileSync(WS_HANDLER_TS, 'utf8');
  const dispatchMatch = text.match(/async function dispatch[\s\S]*?\n\}\s*\n/);
  assert.ok(dispatchMatch, 'failed to locate dispatch function in ws-handler.ts');
  const body = dispatchMatch![0];
  const handled = new Set<string>();
  for (const m of body.matchAll(/case\s+'([^']+)'\s*:/g)) {
    handled.add(m[1]!);
  }
  // Attention reconciliation is validated and handled before full-session dispatch.
  for (const type of guardedWireMessageTypes(text, new Map([
    [WEB_TS, readFileSync(WEB_TS, 'utf8')],
    [ATTENTION_TS, readFileSync(ATTENTION_TS, 'utf8')],
  ]))) handled.add(type);
  return handled;
}

// ---------------------------------------------------------------------------
// The contract assertions
// ---------------------------------------------------------------------------

test('CONTRACT-001: ClientToServerMessage parser locates at least the well-known wire types', () => {
  const declared = declaredClientMessageTypes();
  // Smoke-check the parser itself before we lean on it — if discovery
  // breaks, every downstream assertion will silently pass.
  for (const must of ['auth', 'session:create', 'message:send', 'queue:add', 'attention:lookup']) {
    assert.ok(declared.has(must), `parser missed expected wire type "${must}"`);
  }
});

test('CONTRACT-001: declaration discovery follows cross-file unions and inherited discriminators', () => {
  const sources = new Map([
    ['web.ts', `export type Wire = LookupMessage | AttentionMessage;`],
    ['attention.ts', `
      export interface LookupMessage { type: 'attention:lookup'; refs: string[] }
      interface Fields { type: 'attention'; id: string }
      export interface SessionMessage extends Fields { turn: number }
      export interface ConfirmationMessage extends Fields { confirmationId: string }
      export type AttentionMessage = SessionMessage | ConfirmationMessage;
    `],
  ]);
  assert.deepEqual([...declaredWireMessageTypes('Wire', sources)].sort(), ['attention', 'attention:lookup']);
});

test('CONTRACT-001: missing and nonliteral declarations cannot silently shrink coverage', () => {
  assert.throws(() => declaredWireMessageTypes('Wire', new Map([
    ['web.ts', `export type Wire = MissingMessage;`],
  ])), /could not locate wire declaration MissingMessage/);
  assert.throws(() => declaredWireMessageTypes('Wire', new Map([
    ['web.ts', `export type Wire = OpenMessage; interface OpenMessage { type: string }`],
  ])), /only string literals/);
});

test('CONTRACT-001: attention guard discovery resolves declared predicates rather than trusting guard names', () => {
  const sources = new Map([['attention.ts', `
    interface Lookup { type: 'attention:lookup' }
    export function validate(value: unknown): value is Lookup { return true }
  `]]);
  assert.deepEqual([...guardedWireMessageTypes('if (!validate(frame)) return;', sources)], ['attention:lookup']);
  assert.deepEqual([...guardedWireMessageTypes('if (unrelated(frame)) return;', sources)], []);
});

test('CONTRACT-001: every declared ClientToServerMessage type is either handled or whitelisted', () => {
  const declared = declaredClientMessageTypes();
  const handled = handledMessageTypes();
  const whitelisted = new Set(UNIMPLEMENTED_BY_DESIGN.map((e) => e.type));

  const orphans: string[] = [];
  for (const t of declared) {
    if (handled.has(t)) continue;
    if (whitelisted.has(t)) continue;
    orphans.push(t);
  }
  assert.deepEqual(orphans, [],
    `Found declared ClientToServerMessage types with no dispatch arm and no whitelist entry: ${orphans.join(', ')}.\n` +
    `Either implement the handler in ws-handler.ts or add an entry to UNIMPLEMENTED_BY_DESIGN with a justification.`);
});

test('CONTRACT-001: every whitelisted "unimplemented" type really IS missing a dispatch arm', () => {
  // Drift the other way: if someone implemented one of the deferred messages
  // but forgot to drop the whitelist entry, the test must catch it so the
  // matrix row can move to COVERED.
  const handled = handledMessageTypes();
  const stale: string[] = [];
  for (const { type } of UNIMPLEMENTED_BY_DESIGN) {
    if (handled.has(type)) stale.push(type);
  }
  assert.deepEqual(stale, [],
    `These message types are now handled in ws-handler.ts but still listed as UNIMPLEMENTED_BY_DESIGN: ${stale.join(', ')}.\n` +
    `Remove them from the whitelist and update the CONTRACT-001 matrix row accordingly.`);
});

test('CONTRACT-001: every dispatch arm corresponds to a declared ClientToServerMessage type', () => {
  const declared = declaredClientMessageTypes();
  const handled = handledMessageTypes();
  const undeclared: string[] = [];
  for (const t of handled) {
    if (!declared.has(t)) undeclared.push(t);
  }
  assert.deepEqual(undeclared, [],
    `ws-handler dispatch has cases for message types not declared in shared/web.ts: ${undeclared.join(', ')}.\n` +
    `Add the matching interface to ClientToServerMessage or rename the arm.`);
});

test('CONTRACT-001: whitelist entries each carry a non-empty justification', () => {
  // The whitelist is read by humans during review; an empty reason field
  // defeats the point. Keep this assertion lightweight but non-bypassable.
  for (const entry of UNIMPLEMENTED_BY_DESIGN) {
    assert.ok(entry.reason.trim().length > 0,
      `UNIMPLEMENTED_BY_DESIGN entry for "${entry.type}" has an empty reason — explain why it is deferred.`);
  }
});
