import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { REST_MUTATION_TO_OPERATION, runChecks } from './check-ui-operations.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const gatePath = join(rootDir, 'scripts', 'check-ui-operations.mjs');

/** Every operation name the REST map references, as an OPERATION_POLICIES literal. */
const ALL_MAP_OPERATIONS = [...new Set(Object.values(REST_MUTATION_TO_OPERATION).flat())]
  .map(name => `'${name}': 'pending'`)
  .join(', ');
/** api.ts stub exporting the full REST mutation surface. */
const FULL_API_STUB = Object.keys(REST_MUTATION_TO_OPERATION)
  .map(name => `export async function ${name}(): Promise<void> {}`)
  .join('\n');

/**
 * Build a minimal fixture repo: a one-type mutating WS protocol, a matching
 * operations/types.ts, an api.ts stubbing the full REST mutation surface,
 * plus whatever extra web files / api.ts lines the test plants.
 */
async function makeFixtureRoot(t, { webFiles = {}, policyKeys = ["'session:rename': 'optimistic'"], extraApiSource = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gian-ui-ops-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, 'packages/shared/src'), { recursive: true });
  await writeFile(join(root, 'packages/shared/src/web.ts'), `
export interface SessionRenameMessage { type: 'session:rename'; session_id: string }
export interface AuthMessage { type: 'auth'; token: string }
export type ClientToServerMessage = SessionRenameMessage | AuthMessage;
`);

  await mkdir(join(root, 'packages/web/src/operations'), { recursive: true });
  await writeFile(join(root, 'packages/web/src/operations/types.ts'), `
export const OPERATION_POLICIES = { 'session.rename': 'optimistic', ${ALL_MAP_OPERATIONS} };
export const WS_TYPE_POLICIES = { ${policyKeys.join(', ')} };
`);
  await writeFile(join(root, 'packages/web/src/api.ts'), `${FULL_API_STUB}\n${extraApiSource}`);

  for (const [relPath, content] of Object.entries(webFiles)) {
    const full = join(root, 'packages/web/src', relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test('flags a planted ws.send in a view file and a planted direct fetch', async t => {
  const root = await makeFixtureRoot(t, {
    webFiles: {
      'views/Bypass.tsx': [
        'export function bypass(ws: { send(m: unknown): void }) {',
        "  ws.send({ type: 'session:rename' });",
        "  return fetch('/api/sessions');",
        '}',
      ].join('\n'),
    },
  });

  const { violations } = runChecks(root);
  const rules = violations.map(v => v.rule);
  assert.ok(rules.includes('ws-send'), `expected ws-send violation, got ${JSON.stringify(violations)}`);
  assert.ok(rules.includes('direct-fetch'), `expected direct-fetch violation, got ${JSON.stringify(violations)}`);

  const wsSend = violations.find(v => v.rule === 'ws-send');
  assert.equal(wsSend.file, 'packages/web/src/views/Bypass.tsx');
  assert.equal(wsSend.line, 2);
  const fetchViolation = violations.find(v => v.rule === 'direct-fetch');
  assert.equal(fetchViolation.line, 3);
});

test('flags a mutation API import in a component but not a query import', async t => {
  const root = await makeFixtureRoot(t, {
    extraApiSource: 'export async function loadSettings(): Promise<void> {}',
    webFiles: {
      'components/Panel.tsx': [
        "import { saveSettings, loadSettings } from '../api.js';",
        'export function panel() { return [saveSettings, loadSettings]; }',
      ].join('\n'),
    },
  });

  const { violations } = runChecks(root);
  const imports = violations.filter(v => v.rule === 'mutation-import');
  assert.equal(imports.length, 1);
  assert.match(imports[0].message, /saveSettings/);
  assert.equal(imports[0].file, 'packages/web/src/components/Panel.tsx');
});

test('flags a mutating WS type missing from WS_TYPE_POLICIES', async t => {
  const root = await makeFixtureRoot(t, { policyKeys: [] });

  const { violations } = runChecks(root);
  const coverage = violations.filter(v => v.rule === 'ws-policy-coverage');
  assert.equal(coverage.length, 1);
  assert.match(coverage[0].message, /session:rename.*missing from WS_TYPE_POLICIES/);
});

test('flags an exported api.ts mutation missing from the REST→operation map', async t => {
  const root = await makeFixtureRoot(t, {
    extraApiSource:
      "export async function nukeEverything(): Promise<void> { await fetch('/api/nuke', { method: 'POST' }); }",
  });

  const { violations } = runChecks(root);
  const rest = violations.filter(v => v.rule === 'rest-policy-map');
  assert.equal(rest.length, 1);
  assert.match(rest[0].message, /nukeEverything.*missing from the REST→operation map/);
  assert.equal(rest[0].file, 'packages/web/src/api.ts');
});

test('ws.send inside operations/** and fetch inside api.ts are transport-private', async t => {
  const root = await makeFixtureRoot(t, {
    webFiles: {
      'operations/adapter.ts': [
        'export function send(ws: { send(m: unknown): void }) {',
        "  ws.send({ type: 'session:rename' });",
        "  return fetch('/api/x', { method: 'POST' });",
        '}',
      ].join('\n'),
    },
  });

  const { violations } = runChecks(root);
  assert.deepEqual(violations, []);
});

test('flags mutating bridge calls in a view, not getState or operations/**', async t => {
  const root = await makeFixtureRoot(t, {
    webFiles: {
      'views/Bypass.tsx': [
        "import { desktopBridge } from '../desktop-bridge.js';",
        'export function bypass(githubAuth: { start(): void; getState(): void }) {',
        '  void desktopBridge()?.restartApp?.();',
        '  githubAuth.start();',
        '  githubAuth.getState(); // bootstrap query — exempt',
        '}',
      ].join('\n'),
      'operations/adapter.ts': [
        "import { desktopBridge } from '../desktop-bridge.js';",
        'export function allowed(githubAuth: { signOut(): void }) {',
        '  void desktopBridge()?.restartApp?.();',
        '  githubAuth.signOut();',
        '}',
      ].join('\n'),
    },
  });

  const { violations } = runChecks(root);
  const bridge = violations.filter(v => v.rule === 'bridge-call');
  assert.equal(bridge.length, 2, JSON.stringify(violations));
  assert.ok(bridge.every(v => v.file === 'packages/web/src/views/Bypass.tsx'));
  assert.deepEqual(bridge.map(v => v.line), [3, 4]);
});

test('flags dead bridge surface calls even inside operations/**', async t => {
  const root = await makeFixtureRoot(t, {
    webFiles: {
      'operations/adapter.ts': [
        "import { desktopBridge } from '../desktop-bridge.js';",
        'export function dead() { return desktopBridge()?.retryConnection?.(); }',
      ].join('\n'),
    },
  });

  const { violations } = runChecks(root);
  const bridge = violations.filter(v => v.rule === 'bridge-call');
  assert.equal(bridge.length, 1, JSON.stringify(violations));
  assert.match(bridge[0].message, /dead bridge surface/);
});

test('the current tree has no unallowlisted violations in warn mode', () => {
  const { violations, suppressed } = runChecks(rootDir);
  assert.deepEqual(violations, []);
  assert.ok(suppressed.length > 0, 'current migration bypasses must be allowlisted with reasons');

  const result = spawnSync(process.execPath, [gatePath], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /no violations/);

  const strict = spawnSync(process.execPath, [gatePath, '--strict'], { cwd: rootDir, encoding: 'utf8' });
  assert.equal(strict.status, 0, strict.stderr || strict.stdout);
  assert.match(strict.stdout, /no violations/);
});

test('--strict exits 1 given a violation fixture', async t => {
  const root = await makeFixtureRoot(t, {
    webFiles: {
      'views/Bypass.tsx': "export const go = (ws: { send(m: unknown): void }) => ws.send({ type: 'session:rename' });\n",
    },
  });

  const strict = spawnSync(process.execPath, [gatePath, '--strict', '--root', root], { encoding: 'utf8' });
  assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  assert.match(strict.stdout, /\[ws-send\]/);

  const warn = spawnSync(process.execPath, [gatePath, '--root', root], { encoding: 'utf8' });
  assert.equal(warn.status, 0, warn.stderr || warn.stdout);
  assert.match(warn.stdout, /warn mode/);
});
