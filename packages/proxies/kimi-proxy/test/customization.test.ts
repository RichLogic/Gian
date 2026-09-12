import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { customizationListResultSchema } from '@gian/proxy-protocol';
import {
  expandExtraSkillDir,
  KimiCustomizationScanner,
  parseKimiConfigToml,
} from '../src/core/customization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'customization-inventory');
const KIMI_HOME = join(FIXTURES, 'kimi-home');
const WS = join(FIXTURES, 'kimi-ws');

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

test('parseKimiConfigToml extracts only extra_skill_dirs and [[hooks]]', async () => {
  const config = await parseKimiConfigToml(join(KIMI_HOME, 'config.toml'));
  assert.equal(config.malformed, false);
  assert.deepEqual(config.extraSkillDirs, ['~/kimi-team-skills', 'team-skills']);
  assert.equal(config.hooks.length, 2);
  assert.equal(config.hooks[0]!.event, 'PreToolUse');
  assert.equal(config.hooks[0]!.matcher, 'Bash(git *)');
  assert.equal(config.hooks[0]!.command, './scripts/guard.sh --token kimi-hook-canary');
  assert.equal(config.hooks[0]!.timeout, 10);
  assert.equal(config.hooks[1]!.event, 'Notification');
  assert.equal(config.hooks[1]!.timeout, undefined);
});

test('malformed hook tables fail closed with malformed=true', async () => {
  const dir = join(FIXTURES, 'broken-home');
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'config.toml'), '[[hooks]]\nevent = "X"\n');
    const config = await parseKimiConfigToml(join(dir, 'config.toml'));
    assert.equal(config.malformed, true);
    assert.deepEqual(config.hooks, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandExtraSkillDir never corrupts absolute paths and expands only ~', () => {
  assert.equal(expandExtraSkillDir('/home/me/skills'), '/home/me/skills');
  assert.equal(expandExtraSkillDir('~/team'), join(process.env.HOME ?? '', 'team'));
  assert.equal(expandExtraSkillDir('~'), process.env.HOME ?? '');
  assert.equal(expandExtraSkillDir('relative/dir'), 'relative/dir');
});

test('Kimi skills cover user/extra/project/generic dirs with flow and model-invocation facts', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  try {
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('skill', WS);
    assert.equal(result.status, 'ok');
    assert.equal(customizationListResultSchema.safeParse(result).success, true);
    const names = result.items.map(item => `${item.scope.level}:${item.name}`);
    assert.ok(names.includes('user:flow-skill'), names.join(','));
    assert.ok(names.includes('user:auto-skill'), names.join(','));
    // The user config declares team-skills (relative → resolved against
    // KIMI_CODE_HOME) and ~/kimi-team-skills; both are user scope because
    // the DECLARING layer is the user config.
    assert.ok(names.includes('user:home-team-skill'), names.join(','));
    // The project config declares ./team-skills → workspace scope.
    assert.ok(names.includes('workspace:team-skill'), names.join(','));
    assert.ok(names.includes('workspace:proj-skill'), names.join(','));
    assert.ok(names.includes('workspace:agents-skill'), names.join(','));
    const flow = result.items.find(item => item.name === 'flow-skill')!;
    if (flow.kind === 'skill') {
      assert.equal(flow.skill.modelInvocable, false);
      assert.equal(flow.skill.userInvocable, true);
    }
    const auto = result.items.find(item => item.name === 'auto-skill')!;
    if (auto.kind === 'skill') assert.equal(auto.skill.modelInvocable, true);
    // Plugin dir exists → partial + SOURCE_NOT_ENUMERABLE.
    assert.equal(result.completeness, 'partial');
    assert.ok(result.diagnostics.some(d => d.code === 'SOURCE_NOT_ENUMERABLE'));
    const detail = await scanner.detail('skill', flow.id, WS);
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('Manual-only flow skill'));
  } finally {
    restore();
  }
});

test('Kimi MCP inventory merges user and project mcp.json with full redaction; detail serves one server only', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  try {
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('mcp', WS);
    assert.equal(result.status, 'ok');
    const names = result.items.map(item => `${item.scope.level}:${item.name}`);
    assert.ok(names.includes('user:github'), names.join(','));
    assert.ok(names.includes('user:remote'), names.join(','));
    assert.ok(names.includes('workspace:project-db'), names.join(','));
    const serialized = JSON.stringify(result);
    for (const canary of [
      'kimi-mcp-arg-canary',
      'kimi-mcp-env-canary',
      'kimi-mcp-url-canary',
      'kimi-mcp-header-canary',
      'kimi-ws-pass-canary',
      'kimi-ws-pw-canary',
    ]) {
      assert.equal(serialized.includes(canary), false, `${canary} leaked`);
    }
    const remote = result.items.find(item => item.name === 'remote')!;
    assert.equal(remote.activation, 'disabled');
    if (remote.kind === 'mcp') {
      assert.equal(remote.mcp.transport, 'http');
      assert.equal(remote.mcp.targetSummary, 'https://api.example.com/mcp');
    }
    const github = result.items.find(item => item.name === 'github')!;
    const detail = await scanner.detail('mcp', github.id, WS);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('kimi-mcp-env-canary'), false);
    assert.equal(detail.text.includes('kimi-mcp-arg-canary'), false);
    assert.ok(detail.text.includes('[REDACTED]'));
    // The detail view contains ONLY the selected server.
    const parsed = JSON.parse(detail.text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ['command', 'args', 'env']);
  } finally {
    restore();
  }
});

test('Kimi hooks map one rule per item, redact credentials, and detail serves one hook only', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  try {
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('hook', WS);
    assert.equal(result.status, 'ok');
    assert.equal(result.items.length, 3, result.items.map(i => i.name).join(','));
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('kimi-hook-canary'), false);
    const guard = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.name === 'PreToolUse'
    ))[0]!;
    assert.equal(guard.scope.level, 'user');
    assert.equal(guard.hook.matcher, 'Bash(git *)');
    assert.equal(guard.hook.timeoutMs, 10);
    assert.equal(guard.hook.handler.targetSummary.includes('kimi-hook-canary'), false);
    const submit = result.items.find(item => item.name === 'UserPromptSubmit')!;
    assert.equal(submit.scope.level, 'workspace');
    const detail = await scanner.detail('hook', guard.id, WS);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('kimi-hook-canary'), false);
    const parsed = JSON.parse(detail.text) as { event: string };
    assert.equal(parsed.event, 'PreToolUse');
  } finally {
    restore();
  }
});

test('identical Kimi hooks in one source get distinct stable ids; unrelated insertions never shift them', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-kimi-hookids-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.kimi-code'), { recursive: true });
    const configPath = join(ws, '.kimi-code', 'config.toml');
    const writeConfig = (extraHooks = '') => writeFileSync(configPath, [
      '[[hooks]]',
      'event = "PreToolUse"',
      'matcher = "Bash(git *)"',
      'command = "./scripts/guard.sh"',
      '[[hooks]]',
      'event = "PreToolUse"',
      'matcher = "Bash(git *)"',
      'command = "./scripts/guard.sh"',
      extraHooks,
    ].filter(Boolean).join('\n') + '\n');
    writeConfig();
    const scanner = new KimiCustomizationScanner();
    const first = await scanner.list('hook', ws);
    const wsFirst = first.items.filter(item => item.origin.path?.startsWith(ws));
    assert.equal(wsFirst.length, 2);
    assert.equal(wsFirst[0]!.id === wsFirst[1]!.id, false, 'duplicate hooks must not share an id');
    const ids = wsFirst.map(item => item.id).sort();

    // An unrelated hook inserted before the duplicates must not shift them.
    writeConfig('[[hooks]]\nevent = "Stop"\ncommand = "say done"');
    const second = await scanner.list('hook', ws);
    assert.deepEqual(second.items.filter(item => (
      item.kind === 'hook' && item.origin.path?.startsWith(ws) && item.name === 'PreToolUse'
    )).map(item => item.id).sort(), ids);

    // Per-item detail serves exactly the selected hook entry.
    const firstGuard = first.items.filter(item => item.kind === 'hook' && item.origin.path?.startsWith(ws))[0]!;
    const detail = await scanner.detail('hook', firstGuard.id, ws);
    assert.equal(detail.status, 'ok');
    assert.equal((JSON.parse(detail.text) as { event: string }).event, 'PreToolUse');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Kimi hook timeoutMs is positive-only; a zero timeout is omitted', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-kimi-timeout-'));
  try {
    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.kimi-code'), { recursive: true });
    writeFileSync(join(ws, '.kimi-code', 'config.toml'), [
      '[[hooks]]',
      'event = "A"',
      'command = "./scripts/a.sh"',
      'timeout = 0',
      '[[hooks]]',
      'event = "B"',
      'command = "./scripts/b.sh"',
      'timeout = 7',
    ].join('\n') + '\n');
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('hook', ws);
    const a = result.items.filter((item): item is Extract<typeof item, { kind: 'hook' }> => (
      item.kind === 'hook' && item.name === 'A'
    ))[0]!;
    assert.equal(a.hook.timeoutMs === undefined, true);
    const b = result.items.find(item => item.name === 'B')!;
    assert.equal(b.kind === 'hook' && b.hook.timeoutMs, 7);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Kimi hook stable ids are metamorphic over secrets; detail views carry no canary', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-kimi-hookid-'));
  const kimiHome = join(tmpRoot, 'home');
  mkdirSync(kimiHome, { recursive: true });
  const toml = (command: string) => `[[hooks]]
event = "PreToolUse"
matcher = "Bash(git *)"
command = "${command}"
`;
  const restore = replaceEnv({ KIMI_CODE_HOME: kimiHome, HOME: tmpRoot });
  try {
    const configPath = join(kimiHome, 'config.toml');
    writeFileSync(configPath, toml('API_TOKEN=kimi-canary-a ./guard.sh --token kimi-flag-a'));
    const first = new KimiCustomizationScanner();
    const resultA = await first.list('hook', null);
    const idA = resultA.items.find(item => item.name === 'PreToolUse')!.id;

    writeFileSync(configPath, toml('API_TOKEN=kimi-canary-b ./guard.sh --token kimi-flag-b'));
    const second = new KimiCustomizationScanner();
    const resultB = await second.list('hook', null);
    const idB = resultB.items.find(item => item.name === 'PreToolUse')!.id;
    assert.equal(idB, idA, 'hook stable id rotated with a secret-only change');
    const serializedA = JSON.stringify(resultA);
    const serializedB = JSON.stringify(resultB);
    for (const canary of ['kimi-canary-a', 'kimi-canary-b', 'kimi-flag-a', 'kimi-flag-b']) {
      assert.equal(serializedA.includes(canary), false, `${canary} leaked in A`);
      assert.equal(serializedB.includes(canary), false, `${canary} leaked in B`);
    }
    // observedAt is wall-clock; the redacted shape itself must not rotate.
    const withoutClock = (json: string) => json.replace(/"observedAt":"[^"]*"/g, '"observedAt":"T"');
    assert.equal(withoutClock(serializedA), withoutClock(serializedB), 'redacted wire shape rotated with the secrets');
    const detail = await first.detail('hook', idA, null);
    assert.equal(detail.status, 'ok');
    assert.equal(detail.text.includes('kimi-canary-a'), false);
    assert.equal(detail.text.includes('kimi-flag-a'), false);
  } finally {
    restore();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Kimi rules report global/project/legacy/nested instruction facts; deep and capped walks stay honest', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  try {
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('rule', WS);
    assert.equal(result.status, 'ok');
    assert.equal(result.completeness, 'configured');
    const byKey = (nativeType: string, level: string) => result.items.find(item => (
      item.nativeType === nativeType && item.scope.level === level
    ))!;
    const global = byKey('kimi.agents', 'user');
    assert.ok(global, 'global kimi AGENTS.md missing');
    if (global.kind === 'rule') assert.equal(global.rule.status, 'effective');
    const legacy = byKey('kimi.agents.legacy', 'workspace');
    assert.ok(legacy, 'legacy .kimi/AGENTS.md missing');
    if (legacy.kind === 'rule') assert.equal(legacy.rule.status, 'imported');
    const project = byKey('agents.md', 'workspace');
    if (project.kind === 'rule') assert.equal(project.rule.status, 'effective');
    const nested = result.items.find(item => (
      item.scope.level === 'directory' && item.name === 'AGENTS.md'
    ))!;
    assert.ok(nested, 'nested rule missing');
    if (nested.kind === 'rule') {
      assert.equal(nested.rule.status, 'subtree');
      assert.equal(nested.rule.appliesTo, 'nested');
    }
    const detail = await scanner.detail('rule', global.id, WS);
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('Kimi global instructions'));
  } finally {
    restore();
  }
});

test('Kimi deep nested AGENTS.md is found; entry caps yield partial + SOURCE_NOT_ENUMERABLE', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-kimi-deep-'));
  try {
    const ws = join(tmpRoot, 'ws');
    const deep = join(ws, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(ws, 'AGENTS.md'), '# root\n');
    writeFileSync(join(deep, 'AGENTS.md'), '# deep\n');
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('rule', ws);
    const deepItem = result.items.find(item => (
      item.kind === 'rule' && item.rule.appliesTo === join('a', 'b', 'c', 'd', 'e')
    ))!;
    assert.ok(deepItem, 'deep AGENTS.md missing');
    if (deepItem.kind === 'rule') assert.equal(deepItem.rule.status, 'subtree');
    assert.equal(result.completeness, 'configured', 'no cap hit, no diagnostics');

    const capped = new KimiCustomizationScanner({ limits: { maxScanEntries: 2 } });
    const cappedResult = await capped.list('rule', ws);
    assert.equal(cappedResult.completeness, 'partial');
    assert.equal(cappedResult.diagnostics.some(d => d.code === 'SOURCE_NOT_ENUMERABLE'), true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Kimi scanners never follow symlinks out of a scan root', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-kimi-symlink-'));
  try {
    const outside = join(tmpRoot, 'outside');
    mkdirSync(join(outside, 'skills'), { recursive: true });
    writeFileSync(join(outside, 'skills', 'evil.md'), '---\nname: evil\n---\n# evil\n');
    writeFileSync(join(outside, 'AGENTS.md'), '# outside\n');

    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.kimi-code', 'skills'), { recursive: true });
    symlinkSync(join(outside, 'skills'), join(ws, '.kimi-code', 'skills', 'linked'));
    symlinkSync(join(outside, 'AGENTS.md'), join(ws, 'AGENTS.md'));
    writeFileSync(join(ws, '.kimi-code', 'AGENTS.md'), '# real\n');

    const scanner = new KimiCustomizationScanner();
    const skills = await scanner.list('skill', ws);
    assert.equal(skills.items.some(item => item.name === 'evil'), false, 'skill scan escaped through a symlink');
    const rules = await scanner.list('rule', ws);
    const realWs = realpathSync(ws);
    assert.equal(
      rules.items.some(item => item.name === 'AGENTS.md' && item.origin.path === join(realWs, 'AGENTS.md')),
      false,
      'symlinked AGENTS.md must not be inventoried',
    );
    assert.ok(rules.items.some(item => item.name === 'AGENTS.md' && item.origin.path === join(realWs, '.kimi-code', 'AGENTS.md')));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});

test('Kimi extra dirs: absolute paths resolve verbatim and scope follows the declaring config layer', async () => {
  const restore = replaceEnv({ KIMI_CODE_HOME: KIMI_HOME, HOME: FIXTURES });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'gian-kimi-extra-'));
  try {
    const absSkills = join(tmpRoot, 'abs-skills');
    mkdirSync(absSkills, { recursive: true });
    writeFileSync(join(absSkills, 'abs-skill.md'), '---\nname: abs-skill\n---\n# abs\n');
    const ws = join(tmpRoot, 'ws');
    mkdirSync(join(ws, '.kimi-code'), { recursive: true });
    writeFileSync(join(ws, '.kimi-code', 'config.toml'),
      `extra_skill_dirs = ["${absSkills}"]\n`);
    const scanner = new KimiCustomizationScanner();
    const result = await scanner.list('skill', ws);
    const abs = result.items.find(item => item.name === 'abs-skill')!;
    assert.ok(abs, 'absolute extra_skill_dir was not scanned');
    // Declared by the PROJECT config → workspace scope, never corrupted by
    // a `dir.slice(2)`-style expansion.
    assert.equal(abs.scope.level, 'workspace');
    assert.equal(abs.origin.path, join(realpathSync(absSkills), 'abs-skill.md'));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    restore();
  }
});