// Coverage for traceability row:
//   CONTRACT-002 — Every `ServerToClientMessage` shape declared in
//                  `packages/shared/src/web.ts` must be consumed by at
//                  least one client switch arm (App.tsx, Terminal.tsx,
//                  SpacesView.tsx, …) OR appear in the explicit
//                  "intentionally not displayed" whitelist with a reason.
//
// Mirrors `contract-001-client-message-parity.test.ts`: parse the
// declared union members across web.ts and attention.ts, then scan Web
// case/comparison arms and Desktop's typed attention-channel guards.
// Anything declared-but-unconsumed must be on the whitelist; any
// arm referencing a wire type the shared file doesn't list is also a
// contract violation.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { guardedWireMessageTypes, readWireMessageTypes } from './helpers/wire-message-types.js';

const WEB_TS = resolve('../shared/src/web.ts');
const ATTENTION_TS = resolve('../shared/src/attention.ts');
const WEB_SRC_ROOT = resolve('../web/src');
const DESKTOP_ATTENTION_TS = resolve('../desktop/src/attention-client.ts');

// ---------------------------------------------------------------------------
// Every declared server message has a consumer.
// ---------------------------------------------------------------------------

const NOT_DISPLAYED_BY_DESIGN: ReadonlyArray<{ type: string; reason: string }> = [];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function declaredServerMessageTypes(): Set<string> {
  return readWireMessageTypes('ServerToClientMessage', [WEB_TS, ATTENTION_TS]);
}

function declaredClientMessageTypes(): Set<string> {
  return readWireMessageTypes('ClientToServerMessage', [WEB_TS, ATTENTION_TS]);
}

/**
 * Walk every `.ts` / `.tsx` file under `packages/web/src/` and collect
 * every server-message type literal that appears in either:
 *   • a switch case (`case '<type>':`)
 *   • a direct equality/inequality test (`msg.type === '<type>'` or
 *     `msg.type !== '<type>'`)
 *
 * Doesn't double-count; the set deduplicates automatically.
 */
function consumedServerMessageTypes(): Set<string> {
  const consumed = new Set<string>();
  const filenames: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(full);
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        filenames.push(full);
      }
    }
  }
  walk(WEB_SRC_ROOT);
  for (const file of filenames) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/case\s+'([a-z][a-z0-9:_-]*)'\s*:/g)) {
      consumed.add(m[1]!);
    }
    for (const m of text.matchAll(/\b\w+\.type\s*(?:===|!==)\s*'([a-z][a-z0-9:_-]*)'/g)) {
      consumed.add(m[1]!);
    }
  }
  // Native withdrawal control is consumed by Desktop's dedicated attention
  // socket, not the full Web reducer. Resolve its real shared type predicates.
  for (const type of guardedWireMessageTypes(readFileSync(DESKTOP_ATTENTION_TS, 'utf8'), new Map([
    [WEB_TS, readFileSync(WEB_TS, 'utf8')],
    [ATTENTION_TS, readFileSync(ATTENTION_TS, 'utf8')],
  ]))) consumed.add(type);
  return consumed;
}

// ---------------------------------------------------------------------------
// Contract assertions
// ---------------------------------------------------------------------------

test('CONTRACT-002: ServerToClientMessage parser locates at least the well-known wire types', () => {
  const declared = declaredServerMessageTypes();
  for (const must of ['state_sync', 'event', 'session:created', 'queue:updated', 'error',
    'attention', 'attention:control', 'inbox:changed', 'inbox:invalidated']) {
    assert.ok(declared.has(must),
      `parser missed expected ServerToClientMessage type "${must}"`);
  }
});

test('CONTRACT-002: Inbox and attention control have real consumers, not design exceptions', () => {
  const consumed = consumedServerMessageTypes();
  for (const type of ['inbox:changed', 'inbox:invalidated', 'attention:control']) {
    assert.ok(consumed.has(type), `missing actual consumer for ${type}`);
    assert.ok(!NOT_DISPLAYED_BY_DESIGN.some(entry => entry.type === type));
  }
});

test('CONTRACT-002: every declared ServerToClientMessage type is consumed somewhere OR whitelisted', () => {
  const declared = declaredServerMessageTypes();
  const consumed = consumedServerMessageTypes();
  const whitelisted = new Set(NOT_DISPLAYED_BY_DESIGN.map(e => e.type));

  const orphans: string[] = [];
  for (const t of declared) {
    if (consumed.has(t)) continue;
    if (whitelisted.has(t)) continue;
    orphans.push(t);
  }
  assert.deepEqual(orphans, [],
    `Found declared ServerToClientMessage types with no Web/attention consumer and no whitelist entry: ${orphans.join(', ')}.\n` +
    `Either consume the message in the appropriate component OR add an entry to NOT_DISPLAYED_BY_DESIGN with a justification.`);
});

test('CONTRACT-002: every whitelisted "not displayed" type really IS unconsumed', () => {
  // Drift the other way: if someone wires up a consumer for a deferred
  // type but forgets to remove the whitelist entry, the test must catch
  // it so the matrix row can move forward.
  const consumed = consumedServerMessageTypes();
  const stale: string[] = [];
  for (const { type } of NOT_DISPLAYED_BY_DESIGN) {
    if (consumed.has(type)) stale.push(type);
  }
  assert.deepEqual(stale, [],
    `These server message types are now consumed in packages/web/src but still listed as NOT_DISPLAYED_BY_DESIGN: ${stale.join(', ')}.\n` +
    `Remove them from the whitelist and update the CONTRACT-002 matrix row.`);
});

test('CONTRACT-002: every wire-shaped consumer arm matches a declared ServerToClientMessage type', () => {
  // Catch the case where a refactor renames a wire shape but leaves a
  // dangling consumer arm. We narrow the candidate set to "looks like a
  // wire message type":
  //   • contains ':' (e.g. `session:created`, `term:output`)
  //   • OR is one of the bare-name wire shapes (`state_sync`, `auth_ok`,
  //     `event`, `error`)
  // This filters out the long tail of UI-local literals — file
  // extensions (md/html/htm/svg), event-type discriminators
  // (assistant_text/reasoning/…), status enums (idle/running/error),
  // executor names (claude/codex), etc. Those don't ride
  // ServerToClientMessage.
  const declared = declaredServerMessageTypes();
  const clientDeclared = declaredClientMessageTypes();
  const consumed = consumedServerMessageTypes();
  const whitelisted = new Set(NOT_DISPLAYED_BY_DESIGN.map(e => e.type));

  const BARE_NAME_WIRE_SHAPES = new Set(['state_sync', 'auth_ok', 'event', 'error']);
  function looksLikeWireShape(t: string): boolean {
    return t.includes(':') || BARE_NAME_WIRE_SHAPES.has(t);
  }

  const undeclared: string[] = [];
  for (const t of consumed) {
    if (!looksLikeWireShape(t)) continue;
    if (declared.has(t)) continue;
    // The source scan intentionally sees both inbound reducers and outbound
    // helpers (for example GianWs replay classification). A discriminator
    // declared in ClientToServerMessage is valid, but is not a server arm.
    if (clientDeclared.has(t)) continue;
    if (whitelisted.has(t)) continue;
    undeclared.push(t);
  }
  assert.deepEqual(undeclared, [],
    `Web consumers reference wire-shaped types not declared in shared/web.ts: ${undeclared.join(', ')}.\n` +
    `Either add the matching interface to ServerToClientMessage, fix the consumer typo, or add an entry to NOT_DISPLAYED_BY_DESIGN.`);
});

test('CONTRACT-002: whitelist entries each carry a non-empty justification', () => {
  for (const entry of NOT_DISPLAYED_BY_DESIGN) {
    assert.ok(entry.reason.trim().length > 0,
      `NOT_DISPLAYED_BY_DESIGN entry for "${entry.type}" needs a non-empty reason.`);
  }
});
