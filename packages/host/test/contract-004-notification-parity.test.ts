// Coverage for traceability row:
//   CONTRACT-004 — `PROXY_NOTIFICATION_METHODS` must list every gian.proxy/2.0
//                  notification the v2 adapters emit, and Host projection must
//                  map or explicitly lifecycle-handle each registered method.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROXY_NOTIFICATION_METHODS } from '@gian/shared';

const CC_ADAPTER = resolve('../proxies/cc-proxy/src/protocol/v2-adapter.ts');
const CODEX_ADAPTER = resolve('../proxies/codex-proxy/src/protocol/v2-adapter.ts');
const KIMI_ADAPTER = resolve('../proxies/kimi-proxy/src/protocol/v2-adapter.ts');
const GROK_ADAPTER = resolve('../proxies/grok-proxy/src/protocol/v2-adapter.ts');
const PROJECTOR = resolve('src/event/project-protocol-v2.ts');
const PROJECT_NOTIFICATION = resolve('src/event/project-notification.ts');

const LIFECYCLE_ONLY = new Set([
  'session.updated',
  'catalog.changed',
  'history.changed',
  'usage.updated',
]);

function emittedMethods(adapterPath: string): Set<string> {
  const text = readFileSync(adapterPath, 'utf8');
  const methods = new Set<string>();
  for (const match of text.matchAll(/emit(?:Turn)?Event\(\s*'([^']+)'/g)) {
    methods.add(match[1]!);
  }
  return methods;
}

function projectedMethods(): Set<string> {
  const text = `${readFileSync(PROJECTOR, 'utf8')}\n${readFileSync(PROJECT_NOTIFICATION, 'utf8')}`;
  const methods = new Set<string>();
  for (const match of text.matchAll(/case\s+'([^']+)'\s*:/g)) {
    const name = match[1]!;
    if (name.includes('.') || name === 'debug') methods.add(name);
  }
  for (const match of text.matchAll(/\.method === '([^']+)'/g)) {
    methods.add(match[1]!);
  }
  return methods;
}

const sharedRegistry = new Set<string>(PROXY_NOTIFICATION_METHODS);

test('CONTRACT-004: parser locates well-known live notification names', () => {
  const cc = emittedMethods(CC_ADAPTER);
  const codex = emittedMethods(CODEX_ADAPTER);
  for (const must of ['turn.started', 'turn.completed', 'content.delta']) {
    assert.ok(cc.has(must), `cc v2 adapter parser missed ${must}`);
    assert.ok(codex.has(must), `codex v2 adapter parser missed ${must}`);
  }
});

test('CONTRACT-004: every v2 adapter emission is registered', () => {
  for (const [label, path] of [
    ['cc', CC_ADAPTER],
    ['codex', CODEX_ADAPTER],
    ['kimi', KIMI_ADAPTER],
    ['grok', GROK_ADAPTER],
  ] as const) {
    const missing = [...emittedMethods(path)].filter((method) => !sharedRegistry.has(method));
    assert.deepEqual(missing, [], `${label} emits unregistered notifications: ${missing.join(', ')}`);
  }
});

test('CONTRACT-004: every registered notification is projected or lifecycle-only', () => {
  const projected = projectedMethods();
  const missing = [...sharedRegistry].filter((method) => (
    !LIFECYCLE_ONLY.has(method) && !projected.has(method)
  ));
  assert.deepEqual(missing, [], `unprojected notifications: ${missing.join(', ')}`);
});

test('CONTRACT-004: projector arms correspond to registered methods', () => {
  const orphaned = [...projectedMethods()].filter((method) => (
    !sharedRegistry.has(method) && method !== 'debug'
  ));
  assert.deepEqual(orphaned, [], `projector references unregistered methods: ${orphaned.join(', ')}`);
});
