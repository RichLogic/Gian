// Coverage for traceability row:
//   CONTRACT-004 — `PROXY_NOTIFICATION_METHODS` in `shared/src/proxy.ts`
//                  must list every notification method either cc-proxy or
//                  codex-proxy emits, AND every normalizer in
//                  `host/src/event/normalize-{cc,codex}.ts` must either
//                  map or explicitly drop each listed method.
//
// Drift in this triangle (proxy emits / shared registers / host
// normalizes) historically went unnoticed for the reasoning + plan event
// chain. The test makes future drift loud.
//
// The TTY family (`tty.output`, `tty.exited`) is live on cc-proxy
// (claude CLI) and codex-proxy (codex CLI) but routes through the
// per-executor TtyManager / CodexTtyManager directly, bypassing the
// shared normalizer pipeline. It stays in
// `DEFERRED_NOTIFICATION_METHODS` so the normalizer-coverage matrix
// remains focused on the structured event family. `protocol.error` is a
// CLI-level transport notification (CLI emits it for malformed JSON),
// not a session-scoped event, so it is also deferred and not part of
// the proxy→normalizer pipeline.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROXY_NOTIFICATION_METHODS } from '@gian/shared';

const CC_SERVICE = resolve('../proxies/cc-proxy/src/core/service.ts');
const CODEX_SERVICE = resolve('../proxies/codex-proxy/src/core/service.ts');
const NORMALIZE_CC = resolve('src/event/normalize-cc.ts');
const NORMALIZE_CODEX = resolve('src/event/normalize-codex.ts');

// ---------------------------------------------------------------------------
// Out-of-scope notifications. Document why each one is excluded so future
// reviewers don't grow the whitelist casually.
// ---------------------------------------------------------------------------

const DEFERRED_NOTIFICATION_METHODS: ReadonlyArray<{ method: string; reason: string }> = [
  // TTY runtime switching is explicitly out of current scope per
  // `docs/runtime-modes/` and the user-scope pruning in 2026-05-17 STATE.md.
  // The TtyManager routes these directly without going through the
  // shared registry → normalizer pipeline.
  { method: 'tty.output', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via normalizer.' },
  { method: 'tty.exited', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via normalizer.' },
  // CLI transport-level error; not session-scoped. cc-proxy and codex-proxy
  // both emit it when stdin parsing fails. It exits via the host's child
  // process handler, not the normalizer pipeline.
  { method: 'protocol.error', reason: 'CLI transport error, not a session notification.' },
];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function emittedMethods(servicePath: string): Set<string> {
  const text = readFileSync(servicePath, 'utf8');
  const methods = new Set<string>();
  for (const m of text.matchAll(/emitEvent\(\s*'([^']+)'/g)) {
    methods.add(m[1]!);
  }
  return methods;
}

function normalizedMethods(normalizerPath: string): Set<string> {
  // Capture every `case '<m>':` arm in the normalizer. We discard nested
  // tool-name sub-cases (`Bash`, `Read`, `WebSearch`, …) because they are
  // not wire methods — proxies announce their methods in lowercase.dot
  // form, while tool-use sub-switches use PascalCase tool names. We also
  // accept bare lowercase identifiers like `debug` so the explicit drop
  // arm at the bottom of each normalizer counts as coverage.
  const text = readFileSync(normalizerPath, 'utf8');
  const methods = new Set<string>();
  for (const m of text.matchAll(/case\s+'([^']+)'\s*:/g)) {
    const name = m[1]!;
    // Skip PascalCase tool-name cases — they don't represent wire methods.
    if (/^[A-Z]/.test(name)) continue;
    methods.add(name);
  }
  return methods;
}

// ---------------------------------------------------------------------------
// The three-way contract
// ---------------------------------------------------------------------------

const sharedRegistry = new Set<string>(PROXY_NOTIFICATION_METHODS);
const deferred = new Set(DEFERRED_NOTIFICATION_METHODS.map((d) => d.method));

test('CONTRACT-004: parser locates at least the well-known notification names', () => {
  const cc = emittedMethods(CC_SERVICE);
  const codex = emittedMethods(CODEX_SERVICE);
  // Smoke-test that the regex actually pulls method names out, not e.g.
  // returns an empty set silently.
  for (const must of ['turn.started', 'turn.completed', 'approval.requested']) {
    assert.ok(cc.has(must), `cc-proxy parser missed ${must}`);
    assert.ok(codex.has(must), `codex-proxy parser missed ${must}`);
  }
});

test('CONTRACT-004: every notification cc-proxy emits is registered in shared/proxy.ts (or deferred)', () => {
  const emitted = emittedMethods(CC_SERVICE);
  const missing: string[] = [];
  for (const m of emitted) {
    if (sharedRegistry.has(m)) continue;
    if (deferred.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `cc-proxy emits notifications absent from PROXY_NOTIFICATION_METHODS: ${missing.join(', ')}.\n` +
    `Add them to shared/src/proxy.ts OR document the exclusion in DEFERRED_NOTIFICATION_METHODS.`);
});

test('CONTRACT-004: every notification codex-proxy emits is registered in shared/proxy.ts (or deferred)', () => {
  const emitted = emittedMethods(CODEX_SERVICE);
  const missing: string[] = [];
  for (const m of emitted) {
    if (sharedRegistry.has(m)) continue;
    if (deferred.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `codex-proxy emits notifications absent from PROXY_NOTIFICATION_METHODS: ${missing.join(', ')}.\n` +
    `Add them to shared/src/proxy.ts OR document the exclusion in DEFERRED_NOTIFICATION_METHODS.`);
});

test('CONTRACT-004: every registered notification has at least one normalizer arm or is debug/lifecycle', () => {
  // `session.rotated` is consumed by SessionManager.handleLifecycle before
  // it reaches the normalizer; same for `turn.started` (only Codex
  // normalizer maps it, cc-side just drives pending state). Test that
  // every other registered method has a case in at least one of the two
  // normalizers.
  const ccCases = normalizedMethods(NORMALIZE_CC);
  const codexCases = normalizedMethods(NORMALIZE_CODEX);
  const handledByLifecycle = new Set(['session.rotated']);

  const missing: string[] = [];
  for (const m of sharedRegistry) {
    if (handledByLifecycle.has(m)) continue;
    if (ccCases.has(m) || codexCases.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `Registered notifications missing from both normalize-cc and normalize-codex: ${missing.join(', ')}.\n` +
    `Either add a mapping case (or an explicit drop case) or remove the entry from PROXY_NOTIFICATION_METHODS.`);
});

test('CONTRACT-004: every normalizer arm corresponds to a registered notification method', () => {
  // Drift the other way: a normalizer arm with no registry entry means
  // shared types claim the method doesn't exist while the host quietly
  // depends on it.
  const ccCases = normalizedMethods(NORMALIZE_CC);
  const codexCases = normalizedMethods(NORMALIZE_CODEX);
  const allCases = new Set<string>([...ccCases, ...codexCases]);

  const orphaned: string[] = [];
  for (const m of allCases) {
    if (sharedRegistry.has(m)) continue;
    if (deferred.has(m)) continue;
    orphaned.push(m);
  }
  assert.deepEqual(orphaned, [],
    `Normalizer arms reference notification methods not in PROXY_NOTIFICATION_METHODS: ${orphaned.join(', ')}.`);
});

test('CONTRACT-004: cc reasoning/plan events are absent from cc-proxy emissions (codex-only family)', () => {
  // Sanity check — the reasoning + plan stream is codex-exclusive. If
  // cc-proxy starts emitting these, the normalize-cc.ts side will need
  // its own mapping cases, not piggy-back on the codex registry.
  const cc = emittedMethods(CC_SERVICE);
  for (const m of ['output.reasoning.delta', 'output.plan.delta', 'output.plan.final']) {
    assert.equal(cc.has(m), false,
      `cc-proxy now emits ${m} but normalize-cc has no mapping; route through the cc normalizer first.`);
  }
});

test('CONTRACT-004: deferred entries each carry a non-empty justification', () => {
  for (const entry of DEFERRED_NOTIFICATION_METHODS) {
    assert.ok(entry.reason.trim().length > 0,
      `DEFERRED_NOTIFICATION_METHODS entry for "${entry.method}" needs a reason.`);
  }
});
