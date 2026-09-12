import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  customizationListResultSchema,
  isCustomizationStableId,
} from '@gian/proxy-protocol';
import { CodexCustomizationScanner } from '../src/core/customization.js';
import type {
  CodexRuntime,
  HooksListResponse,
  SkillMetadata,
  SkillsListResponse,
} from '../src/runtime/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Fixture trees and the fake CLI live in src/test (they are not compiled
// into dist), so resolve them relative to the package root.
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'customization-inventory');
const ISOLATED_HOME = join(FIXTURES, 'isolated-home');
const FAKE_MCP_CLI = join(FIXTURES, 'fake-codex-mcp-cli.mjs');
const WS = join(ISOLATED_HOME, 'ws');
const CODEX_HOME = join(ISOLATED_HOME, 'codex');

class FakeRuntime implements CodexRuntime {
  skills: SkillMetadata[] = [];
  hooks: HooksListResponse['data'][number]['hooks'] = [];

  async listSkills(): Promise<SkillsListResponse> {
    return { data: [{ cwd: WS, errors: [], skills: this.skills }] };
  }

  async listHooks(): Promise<HooksListResponse> {
    return { data: [{ cwd: WS, hooks: this.hooks, warnings: [], errors: [] }] };
  }

  on(): void { /* no-op */ }
  async ensureStarted(): Promise<void> { /* no-op */ }
  async startThread(): Promise<never> { throw new Error('unused'); }
  async resumeThread(): Promise<never> { throw new Error('unused'); }
  async forkThread(): Promise<never> { throw new Error('unused'); }
  async injectThreadItems(): Promise<never> { throw new Error('unused'); }
  async readThread(): Promise<never> { throw new Error('unused'); }
  async compactThread(): Promise<never> { throw new Error('unused'); }
  async setThreadName(): Promise<never> { throw new Error('unused'); }
  async archiveThread(): Promise<never> { throw new Error('unused'); }
  async listNativeThreads(): Promise<never> { throw new Error('unused'); }
  async startTurn(): Promise<never> { throw new Error('unused'); }
  async interruptTurn(): Promise<never> { throw new Error('unused'); }
  async steerTurn(): Promise<never> { throw new Error('unused'); }
  async respond(): Promise<never> { throw new Error('unused'); }
  async listAllModels(): Promise<never> { throw new Error('unused'); }
  async unsubscribeThread(): Promise<never> { throw new Error('unused'); }
  async stop(): Promise<void> { /* no-op */ }
}

function makeScanner() {
  const runtime = new FakeRuntime();
  return { runtime, scanner: new CodexCustomizationScanner(runtime) };
}

function replaceEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const ISOLATE = () => replaceEnv({
  GIAN_RUNTIME_BIN: FAKE_MCP_CLI,
  CODEX_HOME,
  HOME: ISOLATED_HOME,
});

test('Codex skills list is provider-effective, keeps disabled/scope/path, and is stable', async () => {
  const restore = ISOLATE();
  try {
    chmodSync(FAKE_MCP_CLI, 0o755);
    const { runtime, scanner } = makeScanner();
    runtime.skills = [
      {
        name: 'review-diff',
        description: 'Reviews the staged diff against team conventions',
        enabled: true,
        path: `${WS}/.codex/skills/review-diff/SKILL.md`,
        scope: 'repo',
        shortDescription: null,
        interface: null,
      },
      {
        name: 'legacy-fix',
        description: 'Fixes lint errors',
        enabled: false,
        path: `${WS}/.codex/skills/legacy-fix/SKILL.md`,
        scope: 'repo',
        shortDescription: null,
        interface: null,
      },
      {
        name: 'imagegen',
        description: 'Generate images',
        enabled: true,
        path: `${CODEX_HOME}/skills/.system/imagegen/SKILL.md`,
        scope: 'system',
        shortDescription: null,
        interface: null,
      },
    ];
    const result = await scanner.list('skill', WS);
    assert.equal(result.status, 'ok');
    assert.equal(result.completeness, 'effective');
    assert.equal(result.items.length, 3);
    const review = result.items.find(item => item.name === 'review-diff')!;
    assert.equal(review.activation, 'enabled');
    assert.equal(review.scope.level, 'workspace');
    assert.equal(review.origin.kind, 'project_file');
    assert.equal(review.discovery.method, 'provider_api');
    const disabled = result.items.find(item => item.name === 'legacy-fix')!;
    assert.equal(disabled.activation, 'disabled');
    const builtin = result.items.find(item => item.name === 'imagegen')!;
    assert.equal(builtin.scope.level, 'system');
    assert.equal(builtin.origin.kind, 'builtin');
    if (builtin.kind === 'skill') assert.equal(builtin.skill.format, 'provider-builtin');
    for (const item of result.items) assert.equal(isCustomizationStableId(item.id), true);

    const again = await scanner.list('skill', WS);
    assert.deepEqual(again.items.map(item => item.id), result.items.map(item => item.id));

    const detail = await scanner.detail('skill', review.id, WS);
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('Review Diff'));
    assert.equal(detail.truncated, false);
  } finally {
    restore();
  }
});

test('Codex hooks list is provider-effective and redacts command credentials', async () => {
  const restore = ISOLATE();
  try {
    const { runtime, scanner } = makeScanner();
    runtime.hooks = [
      {
        key: 'hook-pre-git',
        eventName: 'preToolUse',
        matcher: 'Bash(git *)',
        handlerType: 'command',
        command: './scripts/guard.sh --token guard-secret-321',
        sourcePath: `${WS}/.codex/hooks.json`,
        source: 'project',
        enabled: true,
        timeoutSec: 10,
        trustStatus: 'trusted',
      },
      {
        key: 'hook-untrusted',
        eventName: 'stop',
        handlerType: 'prompt',
        sourcePath: `${WS}/.codex/hooks.json`,
        source: 'project',
        enabled: true,
        timeoutSec: 5,
        trustStatus: 'untrusted',
      },
      {
        key: 'hook-disabled',
        eventName: 'permissionRequest',
        handlerType: 'agent',
        pluginId: 'some-plugin',
        sourcePath: '/Users/fixture/.codex/hooks.json',
        source: 'plugin',
        enabled: false,
        trustStatus: 'managed',
      },
    ];
    const result = await scanner.list('hook', WS);
    assert.equal(result.status, 'ok');
    assert.equal(result.completeness, 'effective');
    assert.equal(result.items.length, 3);
    const command = result.items.find(item => item.name === 'preToolUse')!;
    assert.equal(command.activation, 'enabled');
    if (command.kind === 'hook') {
      assert.equal(command.hook.handler.targetSummary.includes('guard-secret-321'), false);
      assert.equal(command.hook.handler.nativeType, 'command');
      assert.equal(command.hook.nativeEvent, 'preToolUse');
      assert.equal(command.hook.matcher, 'Bash(git *)');
      assert.equal(command.hook.timeoutMs, 10_000);
    }
    assert.equal(command.scope.level, 'workspace');
    const untrusted = result.items.find(item => item.name === 'stop')!;
    assert.equal(untrusted.activation, 'pending_trust');
    const disabled = result.items.find(item => item.name === 'permissionRequest')!;
    assert.equal(disabled.activation, 'disabled');
    assert.equal(disabled.origin.kind, 'plugin');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('guard-secret-321'), false);
    assert.equal(customizationListResultSchema.safeParse(result).success, true);
  } finally {
    restore();
  }
});

test('Codex MCP list is configured-only and redacts env, headers, args, and URL queries', async () => {
  const restore = ISOLATE();
  try {
    chmodSync(FAKE_MCP_CLI, 0o755);
    const { scanner } = makeScanner();
    const result = await scanner.list('mcp', WS);
    assert.equal(result.status, 'ok');
    assert.equal(result.completeness, 'configured');
    assert.equal(result.items.length, 3);
    const github = result.items.find(item => item.name === 'github')!;
    assert.equal(github.activation, 'enabled');
    if (github.kind === 'mcp') assert.equal(github.mcp.transport, 'stdio');
    const remote = result.items.find(item => item.name === 'remote-api')!;
    if (remote.kind === 'mcp') {
      assert.equal(remote.mcp.transport, 'http');
      assert.equal(remote.mcp.targetSummary, 'https://api.example.com/mcp');
    }
    const disabled = result.items.find(item => item.name === 'disabled-qa')!;
    assert.equal(disabled.activation, 'disabled');
    const serialized = JSON.stringify(result);
    for (const canary of [
      'mcp-canary-token-123',
      'ghp_mcp_env_canary_456',
      'mcp-query-canary-789',
      'mcp-header-canary-000',
    ]) {
      assert.equal(serialized.includes(canary), false, `${canary} leaked`);
    }
    const detail = await scanner.detail('mcp', remote.id, WS);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('mcp-header-canary-000'), false);
    assert.equal(detail.text.includes('mcp-query-canary-789'), false);
    assert.equal(detail.text.includes('mcp-canary-token-123'), false);
    assert.ok(detail.text.includes('[REDACTED]'));
  } finally {
    restore();
  }
});

test('Codex rules scan reports user/project/subtree/inactive facts with stable ids', async () => {
  const restore = ISOLATE();
  try {
    const { scanner } = makeScanner();
    const result = await scanner.list('rule', WS);
    assert.equal(result.status, 'ok');
    assert.equal(customizationListResultSchema.safeParse(result).success, true);
    const byName = (name: string, level?: string) => result.items.find(item => (
      item.name === name && (level === undefined || item.scope.level === level)
    ))!;
    const userAgents = byName('AGENTS.md', 'user');
    if (userAgents.kind === 'rule') assert.equal(userAgents.rule.status, 'effective');
    assert.equal(userAgents.origin.kind, 'user_file');
    const wsAgents = byName('AGENTS.md', 'workspace');
    if (wsAgents.kind === 'rule') assert.equal(wsAgents.rule.status, 'effective');
    assert.equal(wsAgents.scope.root, WS);
    const claude = byName('CLAUDE.md');
    if (claude.kind === 'rule') assert.equal(claude.rule.status, 'inactive');
    assert.equal(claude.activation, 'disabled');
    const subtree = result.items.find(item => item.kind === 'rule' && item.rule.appliesTo === 'sub')!;
    if (subtree.kind === 'rule') assert.equal(subtree.rule.status, 'subtree');
    assert.equal(subtree.scope.level, 'directory');
    // ~/.codex/rules/*.rules are exec policies, not instructions: they must
    // never appear in the Custom Rules inventory.
    assert.equal(result.items.some(item => item.nativeType === 'codex.rules'), false);
    // Rule detail reads the file content.
    const detail = await scanner.detail('rule', wsAgents.id, WS);
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('Canonical agent notes'));
  } finally {
    restore();
  }
});

test('Codex instruction selection: AGENTS.override.md wins; fallbacks follow project_doc_fallback_filenames', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-rules-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), '# agents\n');
    writeFileSync(join(ws, 'CLAUDE.md'), '# claude\n');
    const { scanner } = makeScanner();

    // Without an override, AGENTS.md is the selected project doc.
    const plain = await scanner.list('rule', ws);
    const wsAgents = plain.items.find(item => item.name === 'AGENTS.md' && item.scope.level === 'workspace')!;
    if (wsAgents.kind === 'rule') assert.equal(wsAgents.rule.status, 'effective');
    const plainClaude = plain.items.find(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace')!;
    if (plainClaude.kind === 'rule') assert.equal(plainClaude.rule.status, 'inactive');

    // AGENTS.override.md wins over AGENTS.md — AGENTS.md must NOT be
    // guessed effective.
    writeFileSync(join(ws, 'AGENTS.override.md'), '# override\n');
    const withOverride = await scanner.list('rule', ws);
    const override = withOverride.items.find(item => item.name === 'AGENTS.override.md' && item.scope.level === 'workspace')!;
    assert.ok(override, 'override missing');
    if (override.kind === 'rule') assert.equal(override.rule.status, 'effective');
    const shadowed = withOverride.items.find(item => item.name === 'AGENTS.md' && item.scope.level === 'workspace')!;
    if (shadowed.kind === 'rule') assert.equal(shadowed.rule.status, 'inactive');

    // Fallback only: no AGENTS.md/AGENTS.override.md → CLAUDE.md is the
    // documented default fallback.
    rmSync(join(ws, 'AGENTS.md'));
    rmSync(join(ws, 'AGENTS.override.md'));
    const fallback = await scanner.list('rule', ws);
    const fallbackClaude = fallback.items.find(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace')!;
    if (fallbackClaude.kind === 'rule') assert.equal(fallbackClaude.rule.status, 'effective');

    // project_doc_fallback_filenames from config.toml redefines the order.
    mkdirSync(join(CODEX_HOME, '..', 'codex'), { recursive: true });
    writeFileSync(join(CODEX_HOME, 'config.toml'), 'project_doc_fallback_filenames = ["NOTES.md"]\n');
    rmSync(join(ws, 'CLAUDE.md'));
    writeFileSync(join(ws, 'NOTES.md'), '# notes\n');
    writeFileSync(join(ws, 'CLAUDE.md'), '# claude again\n');
    const customFallback = await scanner.list('rule', ws);
    const notes = customFallback.items.find(item => item.name === 'NOTES.md' && item.scope.level === 'workspace')!;
    if (notes.kind === 'rule') assert.equal(notes.rule.status, 'effective');
    // CLAUDE.md is outside the declared fallback list: it is either absent
    // or inactive — never effective.
    const claudeItem = customFallback.items.find(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace');
    assert.equal(claudeItem === undefined || claudeItem.kind !== 'rule' || claudeItem.rule.status === 'inactive', true);
  } finally {
    rmSync(join(CODEX_HOME, 'config.toml'), { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Codex global instructions honor AGENTS.override.md: override effective, AGENTS.md inactive', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-global-override-'));
  try {
    const home = join(tmpRoot, 'codex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'AGENTS.md'), '# global agents\n');
    writeFileSync(join(home, 'AGENTS.override.md'), '# global override\n');
    const restoreHome = replaceEnv({ CODEX_HOME: home });
    try {
      const { scanner } = makeScanner();
      const result = await scanner.list('rule', null);
      const override = result.items.find(item => (
        item.name === 'AGENTS.override.md' && item.scope.level === 'user'
      ))!;
      assert.ok(override, 'global override missing');
      if (override.kind === 'rule') {
        assert.equal(override.rule.status, 'effective');
        assert.equal(override.activation, 'enabled');
        // Neutral descriptor vocabulary: the wire never invents
        // override/fallback wording (the user's own file name may of course
        // contain the word).
        assert.equal(override.nativeType, 'agents.md');
      }
      const agents = result.items.find(item => (
        item.name === 'AGENTS.md' && item.scope.level === 'user'
      ))!;
      if (agents.kind === 'rule') {
        assert.equal(agents.rule.status, 'inactive');
        assert.equal(agents.activation, 'disabled');
      }
      const json = JSON.stringify(result);
      assert.equal(json.includes('fallback'), false);
      for (const item of result.items) {
        if (item.kind === 'rule' && item.name !== 'AGENTS.override.md') {
          assert.equal((item.nativeType ?? '').includes('override'), false);
        }
      }
    } finally {
      restoreHome();
    }
    // Without the override file AGENTS.md is the selected global doc again.
    rmSync(join(home, 'AGENTS.override.md'));
    const restoreHome2 = replaceEnv({ CODEX_HOME: home });
    try {
      const { scanner } = makeScanner();
      const result = await scanner.list('rule', null);
      const agents = result.items.find(item => (
        item.name === 'AGENTS.md' && item.scope.level === 'user'
      ))!;
      if (agents.kind === 'rule') assert.equal(agents.rule.status, 'effective');
    } finally {
      restoreHome2();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Codex fallback candidates are plain file names and never escape the scanned directory', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-fallback-'));
  try {
    const home = join(tmpRoot, 'codex');
    mkdirSync(home, { recursive: true });
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    // Attack candidates: parent traversal, absolute path, embedded
    // separator, dot paths. Only NOTES.md is a usable plain file name, and
    // it must only ever be probed in the scanned directory itself.
    writeFileSync(join(home, 'config.toml'),
      'project_doc_fallback_filenames = ["../outside.md", "/etc/passwd.md", "a/b.md", ".", "..", "NOTES.md"]\n');
    writeFileSync(join(tmpRoot, 'outside.md'), '# outside the scan root\n');
    writeFileSync(join(ws, 'NOTES.md'), '# notes\n');
    const restoreHome = replaceEnv({ CODEX_HOME: home });
    try {
      const { scanner } = makeScanner();
      const result = await scanner.list('rule', ws);
      const notes = result.items.find(item => (
        item.name === 'NOTES.md' && item.scope.level === 'workspace'
      ))!;
      assert.ok(notes, 'the plain configured candidate must be found');
      if (notes.kind === 'rule') assert.equal(notes.rule.status, 'effective');
      // Nothing outside the workspace may be inventoried: parent-traversal
      // and absolute candidates are refused as file names.
      assert.equal(result.items.some(item => item.name === 'outside.md'), false);
      assert.equal(
        result.items.some(item => item.kind === 'rule' && item.origin.path === join(tmpRoot, 'outside.md')),
        false,
      );
      const canonicalWs = realpathSync(ws);
      for (const item of result.items) {
        if (item.kind !== 'rule') continue;
        if (item.scope.level === 'user') continue; // global docs live elsewhere
        assert.ok(
          item.origin.path === join(canonicalWs, item.name),
          `candidate escaped the scanned directory: ${item.origin.path}`,
        );
      }
    } finally {
      restoreHome();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Codex deep AGENTS.md is enumerated; directory caps yield partial + SOURCE_NOT_ENUMERABLE', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-deep-'));
  try {
    const ws = join(tmpRoot, 'ws');
    const deep = join(ws, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), '# root\n');
    writeFileSync(join(deep, 'AGENTS.md'), '# deep\n');
    const { scanner } = makeScanner();
    const result = await scanner.list('rule', ws);
    const deepItem = result.items.find(item => (
      item.kind === 'rule' && item.rule.appliesTo === join('a', 'b', 'c', 'd', 'e')
    ))!;
    assert.ok(deepItem, 'deep AGENTS.md missing');
    if (deepItem.kind === 'rule') assert.equal(deepItem.rule.status, 'subtree');
    assert.equal(result.completeness, 'configured');

    const cappedScanner = new CodexCustomizationScanner(makeScanner().runtime, { limits: { maxDirectories: 2 } });
    const capped = await cappedScanner.list('rule', ws);
    assert.equal(capped.completeness, 'partial');
    assert.equal(capped.diagnostics.some(d => d.code === 'SOURCE_NOT_ENUMERABLE'), true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Codex scans never follow symlinks out of a scan root', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-symlink-'));
  try {
    const outside = join(tmpRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'AGENTS.md'), '# outside\n');
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    symlinkSync(join(outside, 'AGENTS.md'), join(ws, 'AGENTS.md'));
    const { scanner } = makeScanner();
    const result = await scanner.list('rule', ws);
    assert.equal(
      result.items.some(item => item.name === 'AGENTS.md' && item.scope.level === 'workspace'),
      false,
      'symlinked AGENTS.md must not be inventoried',
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Codex hook detail serves exactly the selected hook of a shared source file', async () => {
  const restore = ISOLATE();
  try {
    const { runtime, scanner } = makeScanner();
    runtime.hooks = [
      {
        key: 'hook-a',
        eventName: 'preToolUse',
        handlerType: 'command',
        command: './scripts/a.sh --token aaa-secret',
        sourcePath: `${WS}/.codex/hooks.json`,
        source: 'project',
        enabled: true,
        trustStatus: 'trusted',
      },
      {
        key: 'hook-b',
        eventName: 'preToolUse',
        handlerType: 'command',
        command: './scripts/b.sh',
        sourcePath: `${WS}/.codex/hooks.json`,
        source: 'project',
        enabled: true,
        trustStatus: 'trusted',
        timeoutSec: 0,
      },
    ];
    const result = await scanner.list('hook', WS);
    assert.equal(result.items.length, 2);
    const a = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.hook.handler.targetSummary.includes('a.sh')
    ))[0]!;
    const b = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.hook.handler.targetSummary.includes('b.sh')
    ))[0]!;
    // timeoutSec 0 is not a positive timeout → omitted.
    assert.equal(b.hook.timeoutMs === undefined, true);
    const detailA = await scanner.detail('hook', a.id, WS);
    assert.equal(detailA.status, 'ok');
    const parsedA = JSON.parse(detailA.text) as { event: string; command: string };
    assert.equal(parsedA.command.includes('a.sh'), true);
    assert.equal(parsedA.command.includes('aaa-secret'), false);
    const detailB = await scanner.detail('hook', b.id, WS);
    assert.equal(detailB.status, 'ok');
    assert.equal((JSON.parse(detailB.text) as { command: string }).command.includes('b.sh'), true);
  } finally {
    restore();
  }
});

test('stable hook ids are metamorphic over secrets: only the secret changes, the id and redacted shape stay identical', async () => {
  const restore = ISOLATE();
  try {
    const makeHook = (command: string) => ({
      key: 'hook-env',
      eventName: 'preToolUse',
      matcher: 'Bash(git *)',
      handlerType: 'command' as const,
      command,
      sourcePath: `${WS}/.codex/hooks.json`,
      source: 'project' as const,
      enabled: true,
      trustStatus: 'trusted' as const,
    });
    const first = makeScanner();
    first.runtime.hooks = [makeHook('API_TOKEN=canary-secret-a ./guard.sh --token flag-secret-a')];
    const resultA = await first.scanner.list('hook', WS);
    const second = makeScanner();
    second.runtime.hooks = [makeHook('API_TOKEN=canary-secret-b ./guard.sh --token flag-secret-b')];
    const resultB = await second.scanner.list('hook', WS);

    // The id must not change when only credential material changed…
    assert.equal(resultB.items[0]!.id, resultA.items[0]!.id,
      'hook stable id rotated with a secret-only change');
    // …and neither the wire view nor the detail view carries any canary.
    const serializedA = JSON.stringify(resultA);
    const serializedB = JSON.stringify(resultB);
    for (const canary of ['canary-secret-a', 'canary-secret-b', 'flag-secret-a', 'flag-secret-b']) {
      assert.equal(serializedA.includes(canary), false, `${canary} leaked in A`);
      assert.equal(serializedB.includes(canary), false, `${canary} leaked in B`);
    }
    // observedAt is wall-clock; the redacted shape itself must not rotate.
    const withoutClock = (json: string) => json.replace(/"observedAt":"[^"]*"/g, '"observedAt":"T"');
    assert.equal(withoutClock(serializedA), withoutClock(serializedB), 'redacted wire shape rotated with the secrets');

    const manifest = { id: resultA.items[0]!.id, kind: 'hook' as const };
    const detail = await first.scanner.detail('hook', manifest.id, WS);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('canary-secret-a'), false);
    assert.equal(detail.text.includes('flag-secret-a'), false);
  } finally {
    restore();
  }
});

test('Provider-native error and warning text never reaches the wire diagnostics', async () => {
  const restore = ISOLATE();
  try {
    // FakeRuntime.listSkills returns one entry; override it to report a
    // Provider-native error message containing a canary.
    const canaryError = 'skill source failed: /Users/fixture/.codex/config canary-err-xyz';
    const runtimeA = new FakeRuntime();
    runtimeA.listSkills = async () => ({
      data: [{ cwd: WS, errors: [{ message: canaryError, path: WS }], skills: [] }],
    });
    const scannerA = new CodexCustomizationScanner(runtimeA);
    const skills = await scannerA.list('skill', WS);
    const skillJson = JSON.stringify(skills);
    assert.equal(skillJson.includes(canaryError), false, 'raw skill error text leaked');
    assert.equal(skillJson.includes('canary-err-xyz'), false);
    assert.equal(
      skills.diagnostics.some(d => d.code === 'SOURCE_UNREADABLE' && d.message.includes('canary-err-xyz')),
      false,
      'diagnostic must be the stable generalized message',
    );

    const canaryWarning = 'hook config block malformed near line 42 canary-warn-987';
    const runtimeB = new FakeRuntime();
    runtimeB.listHooks = async () => ({
      data: [{ cwd: WS, hooks: [], warnings: [canaryWarning], errors: [{ message: 'hook source canary-err-abc', path: WS }] }],
    });
    const scannerB = new CodexCustomizationScanner(runtimeB);
    const hooks = await scannerB.list('hook', WS);
    const hookJson = JSON.stringify(hooks);
    assert.equal(hookJson.includes(canaryWarning), false, 'raw hook warning text leaked');
    assert.equal(hookJson.includes('canary-warn-987'), false);
    assert.equal(hookJson.includes('canary-err-abc'), false);
    assert.equal(hooks.diagnostics.some(d => d.code === 'SOURCE_UNREADABLE'), true);
    assert.equal(hooks.diagnostics.some(d => d.code === 'SOURCE_MALFORMED'), true);
  } finally {
    restore();
  }
});

test('unknown detail ids rebuild the list map then fail gracefully', async () => {
  const restore = ISOLATE();
  try {
    const { scanner } = makeScanner();
    const detail = await scanner.detail('rule', 'ci1_' + 'a'.repeat(32), WS);
    assert.equal(detail.status, 'unavailable');
  } finally {
    restore();
  }
});

test('hundreds of items truncate stably at 500 with INVENTORY_TRUNCATED', async () => {
  const restore = ISOLATE();
  try {
    const { runtime, scanner } = makeScanner();
    runtime.skills = Array.from({ length: 550 }, (_, index) => ({
      name: `skill-${String(index).padStart(3, '0')}`,
      description: 'x',
      enabled: true,
      path: `${WS}/.codex/skills/skill-${index}/SKILL.md`,
      scope: 'repo' as const,
      shortDescription: null,
      interface: null,
    }));
    const result = await scanner.list('skill', WS);
    assert.equal(result.items.length, 500);
    assert.equal(result.truncated, true);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.diagnostics.some(d => d.code === 'INVENTORY_TRUNCATED'), true);
    assert.equal(result.items[0]!.name, 'skill-000');
  } finally {
    restore();
  }
});

test('project_doc_fallback_filenames are probed EXACTLY: extensionless and non-md names are never rewritten', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-fallback-exact-'));
  try {
    const home = join(tmpRoot, 'codex');
    mkdirSync(home, { recursive: true });
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    // The configured selection declares an extensionless name and a non-md
    // name. Decoy *.md twins and a default CLAUDE.md also exist: the scan
    // must probe the configured names exactly and never rewrite them, and
    // never let a default masquerade as the selection.
    writeFileSync(join(home, 'config.toml'),
      'project_doc_fallback_filenames = ["WORKLOG", "NOTES.txt"]\n');
    writeFileSync(join(ws, 'WORKLOG'), '# work log\n');
    writeFileSync(join(ws, 'WORKLOG.md'), '# decoy md\n');
    writeFileSync(join(ws, 'NOTES.txt'), '# notes\n');
    writeFileSync(join(ws, 'NOTES.txt.md'), '# decoy md 2\n');
    writeFileSync(join(ws, 'CLAUDE.md'), '# claude\n');
    const restoreHome = replaceEnv({ CODEX_HOME: home });
    try {
      const { scanner } = makeScanner();
      const result = await scanner.list('rule', ws);
      const worklog = result.items.find(item => item.name === 'WORKLOG' && item.scope.level === 'workspace')!;
      assert.ok(worklog, 'the exact configured extensionless name must be probed');
      if (worklog.kind === 'rule') assert.equal(worklog.rule.status, 'effective');
      const notes = result.items.find(item => item.name === 'NOTES.txt' && item.scope.level === 'workspace')!;
      assert.ok(notes, 'the exact configured non-md name must be probed');
      if (notes.kind === 'rule') assert.equal(notes.rule.status, 'inactive');
      // No rewritten file is ever invented, and CLAUDE.md stays outside the
      // declared selection (absent or inactive, never effective).
      assert.equal(result.items.some(item => item.name === 'WORKLOG.md'), false,
        'extensionless names must not be rewritten to .md');
      assert.equal(result.items.some(item => item.name === 'NOTES.txt.md'), false,
        'non-md names must not gain a .md suffix');
      const claude = result.items.find(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace');
      assert.equal(claude === undefined || claude.kind !== 'rule' || claude.rule.status === 'inactive', true);
    } finally {
      restoreHome();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('a declared fallback list whose every entry fails the safety check is an honest partial, never a default CLAUDE.md masquerade', async () => {
  const restore = ISOLATE();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-codex-fallback-invalid-'));
  try {
    const home = join(tmpRoot, 'codex');
    mkdirSync(home, { recursive: true });
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    // Every configured candidate violates the plain-file-name rule; a plain
    // CLAUDE.md also exists on disk to prove the scan refuses to fall back.
    writeFileSync(join(home, 'config.toml'),
      'project_doc_fallback_filenames = ["../escape.md", "/etc/passwd.md", "a/b.md", ".", ".."]\n');
    writeFileSync(join(ws, 'CLAUDE.md'), '# claude\n');
    const restoreHome = replaceEnv({ CODEX_HOME: home });
    try {
      const { scanner } = makeScanner();
      const result = await scanner.list('rule', ws);
      assert.equal(result.status, 'ok');
      assert.equal(result.completeness, 'partial',
        'an unresolvable declared selection must be reported partial, never clean');
      const claude = result.items.find(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace');
      assert.equal(claude, undefined,
        'the default CLAUDE.md must not masquerade as effective when the declared list was rejected');
      const diagnostic = result.diagnostics.find(d => d.code === 'EFFECTIVE_STATE_UNRESOLVED');
      assert.ok(diagnostic, 'missing EFFECTIVE_STATE_UNRESOLVED diagnostic');
      // Frozen diagnostic: the exact same code+message across scans.
      const again = await scanner.list('rule', ws);
      assert.deepEqual(
        again.diagnostics.filter(d => d.code === 'EFFECTIVE_STATE_UNRESOLVED'),
        [diagnostic],
        'the diagnostic must be frozen across scans',
      );
      // Rejected attack candidates never escape into the inventory.
      assert.equal(result.items.some(item => item.name === 'escape.md'), false);
      assert.equal(result.items.some(item => item.name === 'passwd.md'), false);
    } finally {
      restoreHome();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});