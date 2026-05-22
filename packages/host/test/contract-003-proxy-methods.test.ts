// Coverage for traceability row:
//   CONTRACT-003 — Shared `PROXY_METHODS` registry in
//                  `packages/shared/src/proxy.ts` must match the methods
//                  list returned by each proxy's `initialize` payload
//                  AND every method must be call-able from at least
//                  one host client (cc-proxy-client / codex-proxy-client).
//
// The `tty.*` family is live on both cc-proxy (claude CLI runtime) and
// codex-proxy (codex CLI runtime) but routes through separate
// per-executor managers (TtyManager / CodexTtyManager) rather than
// through the shared structured PROXY_METHODS registry. Keep them in
// `DEFERRED_PROXY_METHODS` so the registry stays focused on the
// structured RPC family while the whitelist documents the parallel
// channel.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROXY_METHODS } from '@gian/shared';

const CC_SERVICE = resolve('../proxies/cc-proxy/src/core/service.ts');
const CODEX_SERVICE = resolve('../proxies/codex-proxy/src/core/service.ts');
const CC_CLIENT = resolve('src/proxy/cc-proxy-client.ts');
const CODEX_CLIENT = resolve('src/proxy/codex-proxy-client.ts');
const CC_CLI = resolve('../proxies/cc-proxy/src/cli/spawn.ts');
const CODEX_CLI = resolve('../proxies/codex-proxy/src/cli/spawn.ts');

const DEFERRED_PROXY_METHODS: ReadonlyArray<{ method: string; reason: string }> = [
  // The TTY runtime is currently out-of-scope per the matrix prune (see
  // `docs/runtime-modes/`). cc-proxy still exposes the methods so a
  // future re-enable doesn't need an initialize-payload migration. The
  // shared registry intentionally omits them.
  { method: 'tty.start', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via structured PROXY_METHODS registry.' },
  { method: 'tty.input', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via structured PROXY_METHODS registry.' },
  { method: 'tty.resize', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via structured PROXY_METHODS registry.' },
  { method: 'tty.replay', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via structured PROXY_METHODS registry.' },
  { method: 'tty.kill', reason: 'TTY runtime — direct routing via TtyManager (claude) / CodexTtyManager (codex), not via structured PROXY_METHODS registry.' },
];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function methodsFromInitializePayload(servicePath: string): Set<string> {
  const text = readFileSync(servicePath, 'utf8');
  // Find the `methods: [ ... ]` block inside the initializePayload return.
  // Both service files use the same shape; the block ends at the matching
  // closing `]`.
  const match = text.match(/initializePayload\(\)[\s\S]*?methods:\s*\[([\s\S]*?)\]/);
  assert.ok(match, `failed to locate initializePayload methods array in ${servicePath}`);
  let block = match![1]!;
  // Strip line + block comments so quoted strings inside comments
  // (e.g. `runtime_mode === 'tty'` in a doc-comment) don't get parsed
  // as advertised methods.
  block = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const out = new Set<string>();
  // Method entries are `'<id>',` — anchor on the trailing comma so we
  // only capture array elements, never substrings from other contexts.
  for (const m of block.matchAll(/'([a-z][a-z0-9.]*)'\s*,/g)) {
    out.add(m[1]!);
  }
  return out;
}

/** Methods the host-side client actually wraps in a typed call. */
function methodsCalledByClient(clientPath: string): Set<string> {
  const text = readFileSync(clientPath, 'utf8');
  const out = new Set<string>();
  // Match patterns like `request('turn.start', …)` / `request<...>('turn.start')`
  // and the codex client's `sendRequest('turn.start')` / direct
  // `JsonRpcRequest({ method: 'turn.start' })`.
  for (const m of text.matchAll(/(?:request|sendRequest)\s*(?:<[^>]+>)?\(\s*'([^']+)'/g)) {
    out.add(m[1]!);
  }
  for (const m of text.matchAll(/method:\s*'([^']+)'/g)) {
    out.add(m[1]!);
  }
  return out;
}

/** Methods the CLI's switch dispatches on. */
function methodsHandledByCli(cliPath: string): Set<string> {
  const text = readFileSync(cliPath, 'utf8');
  const out = new Set<string>();
  for (const m of text.matchAll(/case\s+'([a-z][a-z0-9.]*)'\s*:/g)) {
    out.add(m[1]!);
  }
  return out;
}

const sharedRegistry = new Set<string>(PROXY_METHODS);
const deferred = new Set(DEFERRED_PROXY_METHODS.map(d => d.method));

// ---------------------------------------------------------------------------
// Smoke: parser locates the well-known methods so a regex break is loud
// ---------------------------------------------------------------------------

test('CONTRACT-003: parser locates the canonical methods in both proxies', () => {
  const cc = methodsFromInitializePayload(CC_SERVICE);
  const codex = methodsFromInitializePayload(CODEX_SERVICE);
  for (const must of ['initialize', 'session.create', 'turn.start', 'shutdown']) {
    assert.ok(cc.has(must), `cc-proxy initializePayload missing ${must} (parser break?)`);
    assert.ok(codex.has(must), `codex-proxy initializePayload missing ${must} (parser break?)`);
  }
});

// ---------------------------------------------------------------------------
// Shared registry parity (cc / codex / deferred whitelist)
// ---------------------------------------------------------------------------

test('CONTRACT-003: shared PROXY_METHODS contains the canonical structured-method set', () => {
  // The exact list of structured methods is the union of what both
  // proxies expose, minus the deferred TTY group. Pin the list so a
  // future "let's add foo.bar" in shared/proxy.ts must update the
  // service files too.
  const canonical = new Set([
    'initialize', 'capabilities.list', 'slash.list',
    'session.create', 'session.get',
    'turn.start', 'turn.interrupt',
    'approval.respond',
    'session.snapshot', 'session.close',
    'shutdown',
  ]);
  for (const m of canonical) {
    assert.ok(sharedRegistry.has(m), `shared PROXY_METHODS missing canonical method "${m}"`);
  }
  for (const m of sharedRegistry) {
    assert.ok(canonical.has(m), `shared PROXY_METHODS has unexpected method "${m}" — add it to the canonical set or remove it from shared`);
  }
});

test('CONTRACT-003: every method cc-proxy advertises is in shared PROXY_METHODS OR DEFERRED whitelist', () => {
  const cc = methodsFromInitializePayload(CC_SERVICE);
  const orphans: string[] = [];
  for (const m of cc) {
    if (sharedRegistry.has(m)) continue;
    if (deferred.has(m)) continue;
    orphans.push(m);
  }
  assert.deepEqual(orphans, [],
    `cc-proxy advertises methods absent from shared/proxy.ts AND DEFERRED_PROXY_METHODS: ${orphans.join(', ')}.\n` +
    `Add to PROXY_METHODS or DEFERRED_PROXY_METHODS — never let an undeclared method leak through initialize.`);
});

test('CONTRACT-003: every method codex-proxy advertises is in shared PROXY_METHODS OR DEFERRED whitelist', () => {
  const codex = methodsFromInitializePayload(CODEX_SERVICE);
  const orphans: string[] = [];
  for (const m of codex) {
    if (sharedRegistry.has(m)) continue;
    if (deferred.has(m)) continue;
    orphans.push(m);
  }
  assert.deepEqual(orphans, [],
    `codex-proxy advertises methods absent from shared/proxy.ts AND DEFERRED_PROXY_METHODS: ${orphans.join(', ')}.`);
});

test('CONTRACT-003: every shared method is supported by at least one proxy', () => {
  const cc = methodsFromInitializePayload(CC_SERVICE);
  const codex = methodsFromInitializePayload(CODEX_SERVICE);
  const orphans: string[] = [];
  for (const m of sharedRegistry) {
    if (cc.has(m) || codex.has(m)) continue;
    orphans.push(m);
  }
  assert.deepEqual(orphans, [],
    `shared PROXY_METHODS declares methods neither proxy supports: ${orphans.join(', ')}.`);
});

// ---------------------------------------------------------------------------
// CLI ↔ initialize parity per proxy
// ---------------------------------------------------------------------------

test('CONTRACT-003: cc-proxy CLI dispatch covers every method its own initializePayload advertises', () => {
  // A method advertised by initialize but missing from the CLI switch
  // would respond with METHOD_NOT_FOUND in production — the contract is
  // broken even though the call shape is technically valid.
  const cli = methodsHandledByCli(CC_CLI);
  const init = methodsFromInitializePayload(CC_SERVICE);
  const missing: string[] = [];
  for (const m of init) {
    if (cli.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `cc-proxy CLI is missing dispatch arms for advertised methods: ${missing.join(', ')}.`);
});

test('CONTRACT-003: codex-proxy CLI dispatch covers every method its own initializePayload advertises', () => {
  const cli = methodsHandledByCli(CODEX_CLI);
  const init = methodsFromInitializePayload(CODEX_SERVICE);
  const missing: string[] = [];
  for (const m of init) {
    if (cli.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `codex-proxy CLI is missing dispatch arms for advertised methods: ${missing.join(', ')}.`);
});

// ---------------------------------------------------------------------------
// DEFERRED whitelist hygiene
// ---------------------------------------------------------------------------

test('CONTRACT-003: deferred entries each carry a non-empty justification', () => {
  for (const entry of DEFERRED_PROXY_METHODS) {
    assert.ok(entry.reason.trim().length > 0,
      `DEFERRED_PROXY_METHODS entry for "${entry.method}" needs a non-empty reason.`);
  }
});

test('CONTRACT-003: every deferred method is currently advertised by at least one proxy (otherwise the whitelist is stale)', () => {
  const cc = methodsFromInitializePayload(CC_SERVICE);
  const codex = methodsFromInitializePayload(CODEX_SERVICE);
  const stale: string[] = [];
  for (const { method } of DEFERRED_PROXY_METHODS) {
    if (cc.has(method) || codex.has(method)) continue;
    stale.push(method);
  }
  assert.deepEqual(stale, [],
    `DEFERRED_PROXY_METHODS contains entries no proxy advertises anymore: ${stale.join(', ')}.\n` +
    `Drop them from the whitelist — keeping stale entries makes the deferred set untrustworthy.`);
});

// ---------------------------------------------------------------------------
// Client coverage — the host wraps these in typed calls
// ---------------------------------------------------------------------------

/** Methods that are part of the public proxy wire but the host clients
 *  intentionally don't wrap. Document each — a future client that gains
 *  a call site can drop the entry and the test will catch staleness. */
const CLIENT_OPTIONAL_METHODS: ReadonlyArray<{ method: string; reason: string }> = [
  // `initialize` is wrapped via the base RPC client; no specific call
  // literal in cc-proxy-client.ts. Same for `slash.list` via
  // `listSlashCommands`.
  { method: 'initialize', reason: 'wrapped in BaseRpcProxyClient — no literal in the per-proxy client.' },
  { method: 'slash.list', reason: 'wrapped via listSlashCommands — no literal in the per-proxy client.' },
  // `session.get` / `session.snapshot` are diagnostic introspection
  // methods. The host doesn't currently surface them in any UI flow,
  // but they remain advertised so an external tool (e.g. a debug
  // panel) can call them over the same JSON-RPC pipe. Removing them
  // would tighten the contract; keeping them documents the intent.
  { method: 'session.get', reason: 'diagnostic-only; advertised for external tools, host UI doesn\'t call it.' },
  { method: 'session.snapshot', reason: 'diagnostic-only; advertised for external tools, host UI doesn\'t call it.' },
];

test('CONTRACT-003: cc-proxy-client exercises every required method advertised by cc-proxy', () => {
  // A required method = advertised AND not in DEFERRED AND not in
  // CLIENT_OPTIONAL. If a required method has no client call site, the
  // structured wire is silently broken from the host side.
  const clientMethods = methodsCalledByClient(CC_CLIENT);
  const cc = methodsFromInitializePayload(CC_SERVICE);
  const clientOptional = new Set(CLIENT_OPTIONAL_METHODS.map(e => e.method));
  const missing: string[] = [];
  for (const m of cc) {
    if (deferred.has(m)) continue;
    if (clientOptional.has(m)) continue;
    if (clientMethods.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `cc-proxy advertises required methods cc-proxy-client never calls: ${missing.join(', ')}.\n` +
    `Either wire the call site in cc-proxy-client.ts, mark the method as DEFERRED, or add it to CLIENT_OPTIONAL_METHODS with a justification.`);
});

test('CONTRACT-003: codex-proxy-client exercises every required method advertised by codex-proxy', () => {
  const clientMethods = methodsCalledByClient(CODEX_CLIENT);
  const codex = methodsFromInitializePayload(CODEX_SERVICE);
  const clientOptional = new Set(CLIENT_OPTIONAL_METHODS.map(e => e.method));
  const missing: string[] = [];
  for (const m of codex) {
    if (deferred.has(m)) continue;
    if (clientOptional.has(m)) continue;
    if (clientMethods.has(m)) continue;
    missing.push(m);
  }
  assert.deepEqual(missing, [],
    `codex-proxy advertises required methods codex-proxy-client never calls: ${missing.join(', ')}.`);
});

test('CONTRACT-003: every CLIENT_OPTIONAL entry is actually advertised somewhere (no stale entries)', () => {
  const cc = methodsFromInitializePayload(CC_SERVICE);
  const codex = methodsFromInitializePayload(CODEX_SERVICE);
  const stale: string[] = [];
  for (const { method } of CLIENT_OPTIONAL_METHODS) {
    if (cc.has(method) || codex.has(method)) continue;
    stale.push(method);
  }
  assert.deepEqual(stale, [],
    `CLIENT_OPTIONAL_METHODS contains entries no proxy advertises: ${stale.join(', ')}.`);
});
