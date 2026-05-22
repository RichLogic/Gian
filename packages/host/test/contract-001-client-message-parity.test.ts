// Coverage for traceability row:
//   CONTRACT-001 — Every ClientToServerMessage shape declared in
//                  `packages/shared/src/web.ts` must either have a handler
//                  branch in `packages/host/src/web/ws-handler.ts` or
//                  appear in the explicit "unimplemented by design"
//                  whitelist with a justification.
//
// The test is a runtime parse of both files: declared `type: '<name>'`
// literals from `web.ts`, vs `case '<name>':` arms in `ws-handler.ts`'s
// dispatch switch. Anything in only one of the two sets is a drift signal
// — either the handler stopped getting touched, or someone added a wire
// type without wiring its server side.
//
// The whitelist is the bridge for known-deferred messages; updating it
// requires the same review as updating the matrix row, which is why this
// test exists.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_TS = resolve('../shared/src/web.ts');
const WS_HANDLER_TS = resolve('src/web/ws-handler.ts');

// ---------------------------------------------------------------------------
// Whitelist — message types declared in shared but intentionally not yet
// wired in ws-handler. Update this together with the matrix.
// ---------------------------------------------------------------------------

const UNIMPLEMENTED_BY_DESIGN: ReadonlyArray<{ type: string; reason: string }> = [
  // `session:select` is a client-side UX hint; the host doesn't track per-
  // client selection and the wire frame is a no-op. Kept declared so the
  // client can still send it during navigation without warnings.
  { type: 'session:select', reason: 'client-side selection hint; host has no per-client cursor.' },
  // The next four are explicit GAPs in the CONTRACT-001 matrix row. They
  // have a wire shape because the original M2 plan included them; the
  // handler stubs were never written. They stay declared so the contract
  // test fails loud if someone implements them without updating the matrix.
  { type: 'session:reset', reason: 'M2 stub; not implemented in ws-handler.' },
  { type: 'session:takeover', reason: 'M3 IM router relic; not implemented in ws-handler.' },
  { type: 'slash:execute', reason: 'M2 slash plumbing stub; not implemented in ws-handler.' },
  { type: 'transcript:load_more', reason: 'M2 history paging stub; not implemented in ws-handler.' },
];

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Pull every `type: '<literal>'` line out of an interface block in web.ts.
 * The shared file is hand-written and uses single-quote literals for every
 * message type discriminator, e.g. `type: 'session:create';`.
 */
function declaredClientMessageTypes(): Set<string> {
  const text = readFileSync(WEB_TS, 'utf8');
  // Find the ClientToServerMessage union and reverse-engineer the member
  // names by walking each interface that appears in it.
  const unionMatch = text.match(/export type ClientToServerMessage[\s\S]*?;/);
  assert.ok(unionMatch, 'failed to locate ClientToServerMessage union in shared/src/web.ts');
  const unionBody = unionMatch![0];
  // Pull `| InterfaceName` entries.
  const memberNames = Array.from(unionBody.matchAll(/\|\s*(\w+Message)/g), (m) => m[1]!);
  assert.ok(memberNames.length > 0,
    'ClientToServerMessage union appears to have no members; parse pattern broken');

  // For each Interface name, find its declaration and pluck the `type: '<...>'` literal.
  const types = new Set<string>();
  for (const name of memberNames) {
    const ifaceMatch = text.match(
      new RegExp(`export interface ${name}\\s*\\{[\\s\\S]*?\\}`, 'm'),
    );
    if (!ifaceMatch) {
      assert.fail(`could not locate interface ${name} body in shared/src/web.ts`);
    }
    const typeLiteral = ifaceMatch![0].match(/type:\s*'([^']+)'/);
    if (!typeLiteral) {
      assert.fail(`interface ${name} has no \`type: '<literal>';\` discriminator`);
    }
    types.add(typeLiteral![1]!);
  }
  return types;
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
  return handled;
}

// ---------------------------------------------------------------------------
// The contract assertions
// ---------------------------------------------------------------------------

test('CONTRACT-001: ClientToServerMessage parser locates at least the well-known wire types', () => {
  const declared = declaredClientMessageTypes();
  // Smoke-check the parser itself before we lean on it — if the regex
  // breaks, every downstream assertion will silently pass.
  for (const must of ['auth', 'session:create', 'message:send', 'queue:add']) {
    assert.ok(declared.has(must), `parser missed expected wire type "${must}"`);
  }
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
