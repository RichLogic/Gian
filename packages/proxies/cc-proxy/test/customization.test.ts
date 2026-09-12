import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  customizationListResultSchema,
  isCustomizationStableId,
} from '@gian/proxy-protocol';
import { ClaudeCustomizationScanner } from '../src/core/customization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'customization-inventory');
const CLAUDE_HOME = join(FIXTURES, 'claude-home');
const WS = join(FIXTURES, 'claude-ws');

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

test('Claude skills inventory covers user/project skills and legacy commands', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  try {
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('skill', WS);
    assert.equal(result.status, 'ok');
    assert.equal(customizationListResultSchema.safeParse(result).success, true);
    const names = result.items.map(item => `${item.scope.level}:${item.name}`);
    assert.ok(names.includes('user:plan-review'), names.join(','));
    assert.ok(names.includes('user:commit'), names.join(','));
    assert.ok(names.includes('workspace:code-review'), names.join(','));
    assert.ok(names.includes('workspace:fix'), names.join(','));
    const command = result.items.find(item => item.name === 'commit')!;
    assert.equal(command.origin.kind, 'user_file');
    if (command.kind === 'skill') {
      assert.equal(command.skill.format, 'legacy-command');
      assert.equal(command.skill.invocation, '/commit');
    }
    const planReview = result.items.find(item => item.name === 'plan-review')!;
    assert.equal(planReview.activation, 'unknown');
    assert.equal(planReview.discovery.method, 'filesystem_scan');
    const detail = await scanner.detail('skill', planReview.id, WS);
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('Plan Review'));
  } finally {
    restore();
  }
});

test('Claude MCP inventory reads ~/.claude.json by default, official .mcp.json + settings layers for projects, and strips every secret', async () => {
  // First run: CLAUDE_CONFIG_DIR points at the fixture claude-home; the user
  // MCP file must be read from CLAUDE_CONFIG_DIR/.claude.json.
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  try {
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('mcp', WS);
    assert.equal(result.status, 'ok');
    const names = result.items.map(item => `${item.scope.level}:${item.name}`);
    assert.ok(names.includes('user:github'), names.join(','));
    assert.ok(names.includes('user:remote'), names.join(','));
    assert.ok(names.includes('workspace:project-db'), names.join(','));
    const serialized = JSON.stringify(result);
    for (const canary of [
      'home-mcp-arg-canary',
      'home-mcp-env-canary',
      'home-mcp-url-canary',
      'home-mcp-header-canary',
      'ws-mcp-pass-canary',
      'ws-mcp-dbpw-canary',
      // Unrelated top-level .claude.json fields must never reach the wire.
      'canary-unrelated-aa',
      'canary-unrelated-bb',
      'canary-unrelated-cc',
    ]) {
      assert.equal(serialized.includes(canary), false, `${canary} leaked`);
    }
    const remote = result.items.find(item => item.name === 'remote')!;
    if (remote.kind === 'mcp') {
      assert.equal(remote.mcp.transport, 'http');
      assert.equal(remote.mcp.targetSummary, 'https://api.example.com/mcp');
    }
    const github = result.items.find(item => item.name === 'github')!;
    const detail = await scanner.detail('mcp', github.id, WS);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('home-mcp-env-canary'), false);
    assert.equal(detail.text.includes('home-mcp-arg-canary'), false);
    assert.ok(detail.text.includes('[REDACTED]'));
  } finally {
    restore();
  }
});

test('Claude hook stable ids are metamorphic over secrets; detail views carry no canary', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-hookid-'));
  const claudeHome = join(tmpRoot, 'claude');
  mkdirSync(claudeHome, { recursive: true });
  const settingsPath = join(claudeHome, 'settings.json');
  const commandA = 'API_TOKEN=cc-canary-a ./guard.sh --token cc-flag-a';
  const commandB = 'API_TOKEN=cc-canary-b ./guard.sh --token cc-flag-b';
  const hookSettings = (command: string) => JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash(git *)', hooks: [{ type: 'command', command }] }],
    },
  });
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: claudeHome, HOME: tmpRoot });
  try {
    writeFileSync(settingsPath, hookSettings(commandA));
    const first = new ClaudeCustomizationScanner();
    const resultA = await first.list('hook', null);
    writeFileSync(settingsPath, hookSettings(commandB));
    const second = new ClaudeCustomizationScanner();
    const resultB = await second.list('hook', null);

    const idA = resultA.items.find(item => item.name === 'PreToolUse')!.id;
    const idB = resultB.items.find(item => item.name === 'PreToolUse')!.id;
    assert.equal(idB, idA, 'hook stable id rotated with a secret-only change');
    const serializedA = JSON.stringify(resultA);
    const serializedB = JSON.stringify(resultB);
    for (const canary of ['cc-canary-a', 'cc-canary-b', 'cc-flag-a', 'cc-flag-b']) {
      assert.equal(serializedA.includes(canary), false, `${canary} leaked in A`);
      assert.equal(serializedB.includes(canary), false, `${canary} leaked in B`);
    }
    // observedAt is wall-clock; the redacted shape itself must not rotate.
    const withoutClock = (json: string) => json.replace(/"observedAt":"[^"]*"/g, '"observedAt":"T"');
    assert.equal(withoutClock(serializedA), withoutClock(serializedB), 'redacted wire shape rotated with the secrets');
    const detail = await first.detail('hook', idA, null);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('cc-canary-a'), false);
    assert.equal(detail.text.includes('cc-flag-a'), false);
  } finally {
    restore();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Claude user MCP default path is ~/.claude.json (no CLAUDE_CONFIG_DIR)', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: undefined, HOME: FIXTURES });
  try {
    // The fixture FIXTURES/.claude.json does not exist; a tmp HOME with the
    // official default location must be honored even when CLAUDE_CONFIG_DIR
    // is unset.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-mcphome-'));
    try {
      writeFileSync(join(tmpRoot, '.claude.json'), JSON.stringify({
        mcpServers: {
          defaultHome: { type: 'stdio', command: 'npx', args: ['-y', 'server-default-home'] },
        },
      }));
      const innerRestore = replaceEnv({ HOME: tmpRoot, CLAUDE_CONFIG_DIR: undefined });
      try {
        const scanner = new ClaudeCustomizationScanner();
        const result = await scanner.list('mcp', null);
        const names = result.items.map(item => item.name);
        assert.ok(names.includes('defaultHome'), names.join(','));
        assert.equal(result.status, 'ok');
        assert.equal(result.completeness, 'configured');
        assert.deepEqual(result.diagnostics, []);
      } finally {
        innerRestore();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
});

test('Claude hooks inventory splits every handler into its own item with redacted targets', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  try {
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('hook', WS);
    assert.equal(result.status, 'ok');
    const serialized = JSON.stringify(result);
    for (const canary of ['home-canary-tok', 'home-url-canary', 'ws-canary-tok']) {
      assert.equal(serialized.includes(canary), false, `${canary} leaked`);
    }
    // Two command handlers under the same matcher become two items; the
    // http handler is a third; Stop is a fourth (user level), plus project
    // PostToolUse, UserPromptSubmit (prompt), and settings.local PreToolUse.
    assert.equal(result.items.length, 7, result.items.map(i => i.name).join(','));
    const guard = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook'
      && item.name === 'PreToolUse'
      && (item.origin.path?.endsWith('settings.json') ?? false)
      && item.hook.handler.targetSummary.includes('guard.sh')
    ))[0]!;
    assert.equal(guard.scope.level, 'user');
    const localGuard = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.hook.handler.targetSummary.includes('local-guard.sh')
    ))[0]!;
    assert.equal(localGuard.scope.level, 'workspace');
    const prompt = result.items.find(item => item.name === 'UserPromptSubmit')!;
    if (prompt.kind === 'hook') {
      // The full prompt must never reach the wire.
      assert.equal(prompt.hook.handler.targetSummary, 'prompt handler');
    }
    const detail = await scanner.detail('hook', guard.id, WS);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('home-canary-tok'), false);
    assert.ok(detail.text.includes('[REDACTED]'));
  } finally {
    restore();
  }
});

test('Claude rules inventory reports effective/imported/subtree/inactive and agent rules', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  try {
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('rule', WS);
    assert.equal(result.status, 'ok');
    const byName = (name: string, level: string) => result.items.find(item => (
      item.name === name && item.scope.level === level
    ))!;
    const userClaude = byName('CLAUDE.md', 'user');
    if (userClaude.kind === 'rule') assert.equal(userClaude.rule.status, 'effective');
    // CLAUDE.local.md is a real Provider-documented memory file.
    const userLocal = byName('CLAUDE.local.md', 'user');
    if (userLocal.kind === 'rule') assert.equal(userLocal.rule.status, 'effective');
    // Two workspace-level CLAUDE.md files are intentionally present: the
    // workspace root and `.claude/CLAUDE.md`. Select the root by locator
    // instead of whichever stable-id hash sorts first for this worktree path.
    const wsClaude = result.items.find(item => (
      item.name === 'CLAUDE.md'
      && item.scope.level === 'workspace'
      && item.origin.path === join(WS, 'CLAUDE.md')
    ))!;
    if (wsClaude.kind === 'rule') assert.equal(wsClaude.rule.status, 'effective');
    const wsLocal = byName('CLAUDE.local.md', 'workspace');
    if (wsLocal.kind === 'rule') assert.equal(wsLocal.rule.status, 'effective');
    // cwd/.claude/CLAUDE.md is a documented memory location.
    const dotClaude = result.items.find(item => item.name === 'CLAUDE.md' && item.origin.path?.includes(join('.claude', 'CLAUDE.md')))!;
    if (dotClaude.kind === 'rule') assert.equal(dotClaude.rule.status, 'effective');
    const wsAgents = byName('AGENTS.md', 'workspace');
    // CLAUDE.md really @imports AGENTS.md in the fixture → imported.
    if (wsAgents.kind === 'rule') assert.equal(wsAgents.rule.status, 'imported');
    const subtree = result.items.find(item => (
      item.kind === 'rule' && item.rule.appliesTo === join('sub', 'CLAUDE.md')
    ))!;
    if (subtree.kind === 'rule') assert.equal(subtree.rule.status, 'subtree');
    const userRules = result.items.find(item => item.scope.level === 'user' && item.name === 'security.md')!;
    if (userRules.kind === 'rule') assert.equal(userRules.rule.status, 'effective');
    const projectRules = result.items.find(item => item.name === 'guard-rules.md')!;
    if (projectRules.kind === 'rule') assert.equal(projectRules.rule.status, 'effective');
    // Path-scoped rules apply under their declared paths only — never
    // broadly effective.
    const pathScoped = result.items.find(item => item.name === 'path-scoped.md')!;
    assert.ok(pathScoped, 'path-scoped fixture rule missing');
    if (pathScoped.kind === 'rule') {
      assert.notEqual(pathScoped.rule.status, 'effective');
      assert.equal(pathScoped.rule.status, 'subtree');
      assert.equal(pathScoped.rule.appliesTo, 'lib/');
    }
    const detail = await scanner.detail('rule', wsClaude.id, WS);
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('Claude entry'));
  } finally {
    restore();
  }
});

test('Claude AGENTS.md is inactive unless a loaded doc really imports it', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-import-'));
  try {
    // Workspace with CLAUDE.md but no @import → AGENTS.md not loaded.
    const noImportWs = join(tmpRoot, 'no-import');
    mkdirSync(noImportWs, { recursive: true });
    writeFileSync(join(noImportWs, 'CLAUDE.md'), '# No import\n');
    writeFileSync(join(noImportWs, 'AGENTS.md'), '# agents\n');
    // Workspace with only CLAUDE.local.md importing AGENTS.md → imported.
    const localImportWs = join(tmpRoot, 'local-import');
    mkdirSync(localImportWs, { recursive: true });
    writeFileSync(join(localImportWs, 'CLAUDE.local.md'), '# local\n\n@AGENTS.md\n');
    writeFileSync(join(localImportWs, 'AGENTS.md'), '# agents\n');
    const scanner = new ClaudeCustomizationScanner();

    const noImport = await scanner.list('rule', noImportWs);
    const noImportAgents = noImport.items.find(item => item.name === 'AGENTS.md' && item.scope.level === 'workspace')!;
    if (noImportAgents.kind === 'rule') assert.equal(noImportAgents.rule.status, 'inactive');

    const localImport = await scanner.list('rule', localImportWs);
    const localAgents = localImport.items.find(item => item.name === 'AGENTS.md' && item.scope.level === 'workspace')!;
    if (localAgents.kind === 'rule') assert.equal(localAgents.rule.status, 'imported');
    const localDoc = localImport.items.find(item => item.name === 'CLAUDE.local.md' && item.scope.level === 'workspace')!;
    if (localDoc.kind === 'rule') assert.equal(localDoc.rule.status, 'effective');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Claude scanners never touch plugin-owned sources without declaring partial', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  try {
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('skill', WS);
    // No plugin dirs in the fixture → completeness stays configured.
    assert.equal(result.completeness, 'configured');
    assert.equal(result.diagnostics.length, 0);
  } finally {
    restore();
  }
});

test('rule items carry truncated and unreadable facts; details stay bounded', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-rules-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(ws, { recursive: true });
    const huge = join(ws, 'CLAUDE.md');
    writeFileSync(huge, 'x'.repeat(1024 * 1024 + 64));
    const locked = join(ws, 'AGENTS.md');
    writeFileSync(locked, '# locked\n');
    chmodSync(locked, 0o000);
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('rule', ws);
    const hugeItem = result.items.find(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace')!;
    if (hugeItem.kind === 'rule') {
      assert.equal(hugeItem.rule.truncated, true);
      assert.equal(hugeItem.rule.status, 'effective');
    }
    const lockedItem = result.items.find(item => item.name === 'AGENTS.md' && item.scope.level === 'workspace')!;
    assert.equal(lockedItem.warnings?.some(w => w.code === 'SOURCE_UNREADABLE'), true);
    if (lockedItem.kind === 'rule') assert.equal(lockedItem.rule.status, 'unreadable');
    // Detail of the oversized file returns the bounded head with truncated=true.
    const detail = await scanner.detail('rule', hugeItem.id, ws);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.truncated, true);
    assert.ok(detail.text.length <= 1024 * 1024);
  } finally {
    chmodSync(join(tmpRoot, 'ws', 'AGENTS.md'), 0o600);
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('stability: ids do not depend on unrelated config or handler order', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  try {
    const scanner = new ClaudeCustomizationScanner();
    const first = await scanner.list('hook', WS);
    const ids = first.items.map(item => item.id);
    for (const id of ids) assert.equal(isCustomizationStableId(id), true);
    const second = await scanner.list('hook', WS);
    assert.deepEqual(second.items.map(item => item.id), ids);
  } finally {
    restore();
  }
});

test('identical hooks inside one source get distinct stable ids; unrelated insertions never shift them', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-hookids-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.claude'), { recursive: true });
    const settings = join(ws, '.claude', 'settings.json');
    const duplicateEntry = (command: string) => (
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash(git *)', hooks: [{ type: 'command', command }] },
            { matcher: 'Bash(git *)', hooks: [{ type: 'command', command }] },
          ],
        },
      }, null, 2)
    );
    writeFileSync(settings, duplicateEntry('./scripts/guard.sh'));
    const scanner = new ClaudeCustomizationScanner();
    const first = await scanner.list('hook', ws);
    const wsFirst = first.items.filter(item => item.origin.path?.startsWith(ws));
    assert.equal(wsFirst.length, 2, JSON.stringify(first.items.map(i => i.origin.path)));
    assert.equal(wsFirst[0]!.id === wsFirst[1]!.id, false, 'duplicate hooks must not share an id');
    const ids = wsFirst.map(item => item.id).sort();

    // An unrelated handler inserted before the duplicates must not shift them.
    writeFileSync(settings, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        PreToolUse: [
          { matcher: 'Bash(git *)', hooks: [{ type: 'command', command: './scripts/guard.sh' }] },
          { matcher: 'Bash(git *)', hooks: [{ type: 'command', command: './scripts/guard.sh' }] },
        ],
      },
    }, null, 2));
    const second = await scanner.list('hook', ws);
    assert.deepEqual(second.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook'
      && (item.origin.path?.startsWith(ws) ?? false)
      && item.hook.handler.targetSummary.includes('guard.sh')
    )).map(item => item.id).sort(), ids);

    // Per-item detail serves exactly the selected duplicate's entry.
    const firstGuard = first.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook'
      && (item.origin.path?.startsWith(ws) ?? false)
      && item.hook.handler.targetSummary.includes('guard.sh')
    ))[0]!;
    const detail = await scanner.detail('hook', firstGuard.id, ws);
    assert.equal(detail.status, 'ok');
    const parsed = JSON.parse(detail.text) as { event: string; hooks: Array<{ command: string }> };
    assert.equal(parsed.event, 'PreToolUse');
    assert.equal(parsed.hooks.length, 1);
    assert.equal(parsed.hooks[0]!.command.includes('guard.sh'), true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('hook timeoutMs is positive-only; a zero timeout is omitted', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-timeout-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.claude'), { recursive: true });
    writeFileSync(join(ws, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [
            { type: 'command', command: './scripts/a.sh', timeout: 0 },
            { type: 'command', command: './scripts/b.sh', timeout: 7 },
          ],
        }],
      },
    }));
    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('hook', ws);
    const zero = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.hook.handler.targetSummary.includes('a.sh')
    ))[0]!;
    assert.equal(zero.hook.timeoutMs === undefined, true);
    const seven = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.hook.handler.targetSummary.includes('b.sh')
    ))[0]!;
    assert.equal(seven.hook.timeoutMs, 7);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('deep instructions are found at any depth; directory caps yield partial + SOURCE_NOT_ENUMERABLE', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-deep-'));
  try {
    const ws = join(tmpRoot, 'ws');
    const deep = join(ws, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(ws, 'CLAUDE.md'), '# root\n@AGENTS.md\n');
    writeFileSync(join(ws, 'AGENTS.md'), '# agents\n');
    writeFileSync(join(deep, 'CLAUDE.md'), '# deep\n');

    const scanner = new ClaudeCustomizationScanner();
    const result = await scanner.list('rule', ws);
    // Depth 5 (a/b/c/d/e) is beyond any fixed depth — complete traversal
    // must still enumerate it instead of silently dropping it.
    const deepItem = result.items.find(item => (
      item.kind === 'rule' && item.rule.appliesTo === join('a', 'b', 'c', 'd', 'e', 'CLAUDE.md')
    ))!;
    assert.ok(deepItem, `deep CLAUDE.md missing: ${result.items.map(i => i.kind === 'rule' ? i.rule.appliesTo : '').join(',')}`);
    if (deepItem.kind === 'rule') assert.equal(deepItem.rule.status, 'subtree');
    assert.equal(result.completeness, 'configured', 'no cap hit, no diagnostics');

    // A tiny entry bound must flip the scan to partial with
    // SOURCE_NOT_ENUMERABLE instead of silently returning configured.
    const capped = new ClaudeCustomizationScanner({ limits: { maxScanEntries: 3 } });
    const cappedResult = await capped.list('rule', ws);
    assert.equal(cappedResult.completeness, 'partial');
    assert.equal(cappedResult.diagnostics.some(d => d.code === 'SOURCE_NOT_ENUMERABLE'), true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('symlinked files and directories are never followed into (or out of) a scan root', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-symlink-'));
  try {
    const outside = join(tmpRoot, 'outside');
    mkdirSync(join(outside, 'nested'), { recursive: true });
    writeFileSync(join(outside, 'CLAUDE.md'), '# outside\n');
    writeFileSync(join(outside, 'nested', 'CLAUDE.md'), '# outside nested\n');

    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.claude', 'skills'), { recursive: true });
    // A file symlink pretending to be a rule at the workspace root.
    symlinkSync(join(outside, 'CLAUDE.md'), join(ws, 'CLAUDE.md'));
    // A directory symlink pretending to be a nested skills dir.
    symlinkSync(join(outside, 'nested'), join(ws, '.claude', 'skills', 'evil'));
    // A symlinked skill directory whose SKILL.md lives outside the root.
    mkdirSync(join(outside, 'evil-skill'), { recursive: true });
    writeFileSync(join(outside, 'evil-skill', 'SKILL.md'), '---\nname: evil-skill\n---\n# evil\n');
    symlinkSync(join(outside, 'evil-skill'), join(ws, '.claude', 'skills', 'evil-skill-link'));

    const scanner = new ClaudeCustomizationScanner();
    const rules = await scanner.list('rule', ws);
    assert.equal(rules.items.some(item => item.name === 'CLAUDE.md' && item.scope.level === 'workspace'), false, 'symlinked CLAUDE.md must not be inventoried');
    const skills = await scanner.list('skill', ws);
    assert.equal(skills.items.some(item => item.name === 'evil' || item.name === 'evil-skill'), false, 'skill scan escaped through a symlink');
    assert.equal(skills.items.some(item => item.name === 'evil-skill-link'), false, 'SKILL.md behind a symlinked dir must not be read');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('missing configs are an ok+configured vacuum; oversized and malformed configs are partial', async () => {
  const restore = replaceEnv({ CLAUDE_CONFIG_DIR: CLAUDE_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-cc-states-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.claude'), { recursive: true });

    // Missing mcp.json and settings layers → ok+configured, no diagnostics
    // (the user-level fixture config is a separate declared scope).
    const emptyScanner = new ClaudeCustomizationScanner();
    const empty = await emptyScanner.list('mcp', ws);
    assert.equal(empty.status, 'ok');
    assert.equal(empty.completeness, 'configured');
    assert.deepEqual(empty.diagnostics, []);
    assert.equal(empty.items.some(item => item.origin.path?.startsWith(ws)), false);

    // Malformed settings.json → SOURCE_MALFORMED + partial.
    writeFileSync(join(ws, '.claude', 'settings.json'), '{ not json');
    const malformed = await emptyScanner.list('hook', ws);
    assert.equal(malformed.status, 'ok');
    assert.equal(malformed.completeness, 'partial');
    assert.equal(malformed.diagnostics.some(d => d.code === 'SOURCE_MALFORMED'), true);

    // Oversized .mcp.json → SOURCE_UNREADABLE + partial (read within bound
    // is impossible, so it is a partial fact, never a silent vacuum).
    writeFileSync(join(ws, '.mcp.json'), `{"mcpServers":{"x":{"command":"npx","args":["${'a'.repeat(17 * 1024 * 1024)}"]}}}`);
    const oversized = await emptyScanner.list('mcp', ws);
    assert.equal(oversized.status, 'ok');
    assert.equal(oversized.completeness, 'partial');
    assert.equal(oversized.diagnostics.some(d => d.code === 'SOURCE_UNREADABLE'), true);
    assert.equal(oversized.items.some(item => item.name === 'x'), false, 'oversized config must not yield items');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});
