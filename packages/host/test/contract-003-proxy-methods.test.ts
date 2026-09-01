// Coverage for traceability row:
//   CONTRACT-003 — Shared `PROXY_METHODS` must match gian.proxy/2.0 core +
//                  optional methods, each Proxy v2 adapter's handle() switch,
//                  and the Host ProtocolV2 client call sites.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORE_METHODS, OPTIONAL_METHOD_CAPABILITIES } from '@gian/proxy-protocol';
import { PROXY_METHODS } from '@gian/shared';

const CC_ADAPTER = resolve('../proxies/cc-proxy/src/protocol/v2-adapter.ts');
const CODEX_ADAPTER = resolve('../proxies/codex-proxy/src/protocol/v2-adapter.ts');
const KIMI_ADAPTER = resolve('../proxies/kimi-proxy/src/protocol/v2-adapter.ts');
const GROK_ADAPTER = resolve('../proxies/grok-proxy/src/protocol/v2-adapter.ts');
const ZCODE_ADAPTER = resolve('../proxies/zcode-proxy/src/adapter.ts');

/** Registry-keyed v2 adapter table: registering a new executor's adapter in
 * the shared executor registry adds exactly one entry here. */
const V2_ADAPTERS: ReadonlyArray<[label: string, path: string]> = [
  ['cc', CC_ADAPTER],
  ['codex', CODEX_ADAPTER],
  ['kimi', KIMI_ADAPTER],
  ['grok', GROK_ADAPTER],
  ['zcode', ZCODE_ADAPTER],
];
const HOST_CLIENT = resolve('src/proxy/protocol-v2-client.ts');
const HOST_SESSION = resolve('src/proxy/protocol-v2-session-client.ts');

const CANONICAL = new Set<string>([
  ...CORE_METHODS,
  ...Object.keys(OPTIONAL_METHOD_CAPABILITIES),
]);

function extractSwitchCases(source: string, marker: string): Set<string> {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `failed to locate ${marker}`);
  const switchStart = source.indexOf('switch (request.method)', start);
  assert.ok(switchStart >= 0, `failed to locate request.method switch after ${marker}`);
  const braceStart = source.indexOf('{', switchStart);
  let depth = 0;
  let end = braceStart;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const block = source.slice(braceStart, end + 1);
  const out = new Set<string>();
  for (const match of block.matchAll(/case\s+'([a-z][A-Za-z0-9.]*)'\s*:/g)) {
    out.add(match[1]!);
  }
  return out;
}

function methodsFromAdapter(path: string): Set<string> {
  return extractSwitchCases(readFileSync(path, 'utf8'), 'async handle(');
}

function methodsCalledByHost(): Set<string> {
  const text = `${readFileSync(HOST_CLIENT, 'utf8')}\n${readFileSync(HOST_SESSION, 'utf8')}`;
  const out = new Set<string>();
  for (const match of text.matchAll(/(?:request|sendRequest)\s*(?:<[^>]+>)?\(\s*'([^']+)'/g)) {
    out.add(match[1]!);
  }
  return out;
}

const sharedRegistry = new Set<string>(PROXY_METHODS);

test('CONTRACT-003: shared PROXY_METHODS matches the gian.proxy/2 method set', () => {
  for (const method of CANONICAL) {
    assert.ok(sharedRegistry.has(method), `shared PROXY_METHODS missing "${method}"`);
  }
  for (const method of sharedRegistry) {
    assert.ok(CANONICAL.has(method), `shared PROXY_METHODS has unexpected "${method}"`);
  }
});

test('CONTRACT-003: parser locates the canonical methods in every v2 adapter', () => {
  for (const [label, path] of V2_ADAPTERS) {
    const methods = methodsFromAdapter(path);
    for (const must of CORE_METHODS) {
      assert.ok(methods.has(must), `${label} v2 adapter handle() missing ${must}`);
    }
  }
});

test('CONTRACT-003: every adapter-handled method is in shared PROXY_METHODS', () => {
  for (const [label, path] of V2_ADAPTERS) {
    const orphans: string[] = [];
    for (const method of methodsFromAdapter(path)) {
      if (!sharedRegistry.has(method)) orphans.push(method);
    }
    assert.deepEqual(orphans, [], `${label} adapter handles undeclared methods: ${orphans.join(', ')}`);
  }
});

test('CONTRACT-003: every shared method is handled by at least one adapter', () => {
  const union = new Set<string>(
    V2_ADAPTERS.flatMap(([, path]) => [...methodsFromAdapter(path)]),
  );
  const orphans = [...sharedRegistry].filter((method) => (
    !union.has(method) && !PROVIDER_DEFERRED_METHODS.has(method)
  ));
  assert.deepEqual(orphans, [], `shared methods no adapter handles: ${orphans.join(', ')}`);
});

const PROVIDER_DEFERRED_METHODS = new Set<string>();

const CLIENT_OPTIONAL_METHODS = new Set([
  'session.get',
  'catalog.resolve',
]);

test('CONTRACT-003: Host ProtocolV2 client calls every required method', () => {
  const called = methodsCalledByHost();
  const missing = [...sharedRegistry].filter((method) => (
    !CLIENT_OPTIONAL_METHODS.has(method) && !called.has(method)
  ));
  assert.deepEqual(missing, [], `Host never calls required methods: ${missing.join(', ')}`);
});
