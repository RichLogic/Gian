import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  customizationDetailParamsSchema,
  customizationDetailResultSchema,
  customizationItemSchema,
  customizationListParamsSchema,
  customizationListResultSchema,
  isCustomizationStableId,
  PROTOCOL_V2,
  PROTOCOL_V2_LEGACY,
  PROTOCOL_V22,
  PROTOCOL_V23,
  redactCredentialArgs,
  redactCustomizationTarget,
  redactCustomizationText,
  redactCustomizationValue,
  redactShellCommandText,
  stableCustomizationId,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/index.js';

function skillItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ci1_' + 'a'.repeat(32),
    kind: 'skill',
    name: 'review-diff',
    description: 'Reviews the staged diff',
    nativeType: 'codex.skill.repo',
    nativeStatus: 'enabled',
    activation: 'enabled',
    scope: { level: 'workspace', root: '/tmp/ws' },
    origin: { kind: 'project_file', path: '/tmp/ws/.codex/skills/review-diff/SKILL.md' },
    discovery: { method: 'provider_api' },
    skill: {
      format: 'agent-skill',
      entryPath: '/tmp/ws/.codex/skills/review-diff/SKILL.md',
      userInvocable: true,
      modelInvocable: true,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// List params / result invariants
// ---------------------------------------------------------------------------

test('customization.list params reject unknown fields, missing kind, and relative cwd', () => {
  assert.equal(customizationListParamsSchema.safeParse({ kind: 'skill' }).success, true);
  assert.equal(customizationListParamsSchema.safeParse({ kind: 'skill', cwd: '/tmp/ws' }).success, true);
  assert.equal(customizationListParamsSchema.safeParse({}).success, false);
  assert.equal(customizationListParamsSchema.safeParse({ kind: 'plugin' }).success, false);
  assert.equal(customizationListParamsSchema.safeParse({ kind: 'skill', cwd: 'relative/path' }).success, false);
  assert.equal(customizationListParamsSchema.safeParse({ kind: 'skill', extra: 1 }).success, false);
});

test('customization.detail params require a valid stable item id', () => {
  assert.equal(customizationDetailParamsSchema.safeParse({
    kind: 'rule',
    id: 'ci1_' + 'b'.repeat(32),
  }).success, true);
  assert.equal(customizationDetailParamsSchema.safeParse({
    kind: 'rule',
    id: 'ci1_' + 'B'.repeat(32),
  }).success, false);
  assert.equal(customizationDetailParamsSchema.safeParse({ kind: 'rule', id: 'not-an-id' }).success, false);
  assert.equal(customizationDetailParamsSchema.safeParse({ kind: 'rule', id: 'ci1_' + 'b'.repeat(31) }).success, false);
});

test('result invariants: non-ok statuses must be empty with completeness none', () => {
  const base = {
    status: 'provider_unsupported',
    completeness: 'none',
    observedAt: '2026-09-02T00:00:00.000Z',
    truncated: false,
    diagnostics: [],
  };
  assert.equal(customizationListResultSchema.safeParse({
    ...base,
    kind: 'skill',
    items: [],
  }).success, true);
  assert.equal(customizationListResultSchema.safeParse({
    ...base,
    kind: 'skill',
    items: [skillItem()],
  }).success, false);
});

test('result invariants: status ok must never claim completeness none', () => {
  // A missing config is an ok+configured vacuum; ok+none is forbidden.
  assert.equal(customizationListResultSchema.safeParse({
    status: 'ok',
    completeness: 'none',
    kind: 'skill',
    items: [],
    truncated: false,
    diagnostics: [],
    observedAt: '2026-09-02T00:00:00.000Z',
  }).success, false);
  assert.equal(customizationListResultSchema.safeParse({
    status: 'ok',
    completeness: 'configured',
    kind: 'skill',
    items: [],
    truncated: false,
    diagnostics: [],
    observedAt: '2026-09-02T00:00:00.000Z',
  }).success, true);
});

test('detail invariants: unavailable must carry empty text and no truncation', () => {
  const base = {
    kind: 'skill',
    id: 'ci1_' + 'a'.repeat(32),
    status: 'unavailable' as const,
    observedAt: '2026-09-02T00:00:00.000Z',
    diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED' as const, message: 'x' }],
  };
  assert.equal(customizationDetailResultSchema.safeParse({
    ...base,
    text: '',
    truncated: false,
  }).success, true);
  assert.equal(customizationDetailResultSchema.safeParse({
    ...base,
    text: 'content',
    truncated: false,
  }).success, false);
  assert.equal(customizationDetailResultSchema.safeParse({
    ...base,
    text: '',
    truncated: true,
  }).success, false);
});

test('result invariants: truncated requires status ok with completeness partial', () => {
  const result = {
    kind: 'skill',
    status: 'ok' as const,
    completeness: 'partial' as const,
    observedAt: '2026-09-02T00:00:00.000Z',
    truncated: true,
    diagnostics: [{ code: 'INVENTORY_TRUNCATED' as const, message: 'truncated' }],
    items: [skillItem()],
  };
  assert.equal(customizationListResultSchema.safeParse(result).success, true);
  assert.equal(customizationListResultSchema.safeParse({
    ...result,
    completeness: 'effective',
  }).success, false);
  assert.equal(customizationListResultSchema.safeParse({
    ...result,
    status: 'unavailable',
    completeness: 'none',
    items: [],
  }).success, false);
});

test('result invariants: item kind must match result kind and ids must be unique', () => {
  const items = [skillItem()];
  assert.equal(customizationListResultSchema.safeParse({
    kind: 'skill',
    status: 'ok',
    completeness: 'effective',
    observedAt: '2026-09-02T00:00:00.000Z',
    items,
    truncated: false,
    diagnostics: [],
  }).success, true);
  assert.equal(customizationListResultSchema.safeParse({
    kind: 'hook',
    status: 'ok',
    completeness: 'effective',
    observedAt: '2026-09-02T00:00:00.000Z',
    items,
    truncated: false,
    diagnostics: [],
  }).success, false);
  assert.equal(customizationListResultSchema.safeParse({
    kind: 'skill',
    status: 'ok',
    completeness: 'effective',
    observedAt: '2026-09-02T00:00:00.000Z',
    items: [items[0], items[0]],
    truncated: false,
    diagnostics: [],
  }).success, false);
});

test('result invariants: diagnostics codes come from the frozen registry only', () => {
  const result = {
    kind: 'skill',
    status: 'ok',
    completeness: 'partial',
    observedAt: '2026-09-02T00:00:00.000Z',
    items: [skillItem()],
    truncated: false,
    diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'x' }],
  };
  assert.equal(customizationListResultSchema.safeParse(result).success, true);
  assert.equal(customizationListResultSchema.safeParse({
    ...result,
    diagnostics: [{ code: 'PROVIDER_SPECIFIC_CODE', message: 'x' }],
  }).success, false);
});

test('result limits: 500 items max, 50 diagnostics max, 20 warnings max', () => {
  const tooMany = Array.from({ length: 501 }, (_, index) => skillItem({
    id: 'ci1_' + index.toString(16).padStart(32, '0'),
  }));
  const result = {
    kind: 'skill',
    status: 'ok',
    completeness: 'partial',
    observedAt: '2026-09-02T00:00:00.000Z',
    items: tooMany,
    truncated: true,
    diagnostics: [],
  };
  assert.equal(customizationListResultSchema.safeParse(result).success, false);
  const manyDiagnostics = Array.from({ length: 51 }, () => ({ code: 'FIELD_REDACTED' as const, message: 'x' }));
  assert.equal(customizationListResultSchema.safeParse({
    kind: 'skill',
    status: 'ok',
    completeness: 'partial',
    observedAt: '2026-09-02T00:00:00.000Z',
    items: [],
    truncated: false,
    diagnostics: manyDiagnostics,
  }).success, false);
  const manyWarnings = Array.from({ length: 21 }, () => ({ code: 'FIELD_REDACTED' as const, message: 'x' }));
  assert.equal(customizationItemSchema.safeParse(skillItem({ warnings: manyWarnings })).success, false);
});

test('field limits: utf-8 byte bounds for id, name, description, path', () => {
  assert.equal(customizationItemSchema.safeParse(skillItem({
    id: 'ci1_' + 'a'.repeat(40),
  })).success, false);
  assert.equal(customizationItemSchema.safeParse(skillItem({
    name: 'x'.repeat(300),
  })).success, false);
  assert.equal(customizationItemSchema.safeParse(skillItem({
    description: 'x'.repeat(5000),
  })).success, false);
  // Multi-byte characters count as bytes, not code points.
  assert.equal(customizationItemSchema.safeParse(skillItem({
    name: '名'.repeat(300),
  })).success, false);
  assert.equal(customizationItemSchema.safeParse(skillItem({
    name: '名'.repeat(80),
  })).success, true);
});

test('mcp items only carry the normalized sanitized view fields', () => {
  const item = {
    id: 'ci1_' + 'c'.repeat(32),
    kind: 'mcp',
    name: 'github',
    nativeType: 'codex.mcp',
    activation: 'enabled',
    scope: { level: 'unknown' },
    origin: { kind: 'unknown' },
    discovery: { method: 'provider_cli' },
    mcp: { transport: 'stdio', targetSummary: 'npx' },
  };
  assert.equal(customizationItemSchema.safeParse(item).success, true);
  assert.equal(customizationItemSchema.safeParse({
    ...item,
    mcp: { transport: 'stdio', env: { AWS_SECRET: 'x' } },
  }).success, false);
});

test('hook items carry only native facts; handler requires targetSummary', () => {
  const item = {
    id: 'ci1_' + 'd'.repeat(32),
    kind: 'hook',
    name: 'PreToolUse',
    activation: 'enabled',
    scope: { level: 'workspace', root: '/tmp/ws' },
    origin: { kind: 'project_file', path: '/tmp/ws/.claude/settings.json' },
    discovery: { method: 'config_parse' },
    hook: {
      nativeEvent: 'PreToolUse',
      matcher: 'Bash(git *)',
      handler: { nativeType: 'command', targetSummary: './scripts/check.sh' },
      timeoutMs: 3000,
    },
  };
  assert.equal(customizationItemSchema.safeParse(item).success, true);
  assert.equal(customizationItemSchema.safeParse({
    ...item,
    hook: { nativeEvent: 'PreToolUse', handler: { nativeType: 'command' } },
  }).success, false);
});

test('rule items carry facts, never override/fallback wording', () => {
  const item = {
    id: 'ci1_' + 'e'.repeat(32),
    kind: 'rule',
    name: 'AGENTS.md',
    nativeType: 'agents.md',
    activation: 'enabled',
    scope: { level: 'workspace', root: '/tmp/ws' },
    origin: { kind: 'project_file', path: '/tmp/ws/AGENTS.md' },
    discovery: { method: 'filesystem_scan' },
    rule: { status: 'effective', truncated: false, lineCount: 42 },
  };
  assert.equal(customizationItemSchema.safeParse(item).success, true);
  assert.equal(customizationItemSchema.safeParse({
    ...item,
    rule: { status: 'overrides', truncated: false },
  }).success, false);
  // A declared-but-unproven rule candidate is factually `configured`.
  assert.equal(customizationItemSchema.safeParse({
    ...item,
    rule: { status: 'configured', truncated: false },
  }).success, true);
});

test('the Host offer list composes 2.3 Customization with the 2.2 Runtime baseline', () => {
  assert.deepEqual(
    [...SUPPORTED_PROTOCOL_VERSIONS],
    [PROTOCOL_V23, PROTOCOL_V22, PROTOCOL_V2, PROTOCOL_V2_LEGACY],
  );
});

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

test('stableCustomizationId is deterministic and prefixed ci1_ with 32 hex chars', () => {
  const input = {
    provider: 'codex',
    kind: 'skill' as const,
    scopeKey: 'workspace:/tmp/ws',
    canonicalSourceLocator: '/tmp/ws/.codex/skills/review-diff/SKILL.md',
    nativeIdentity: 'review-diff',
  };
  const a = stableCustomizationId(input);
  const b = stableCustomizationId(input);
  assert.equal(a, b);
  assert.equal(isCustomizationStableId(a), true);
  assert.match(a, /^ci1_[a-f0-9]{32}$/);
});

test('stable ids survive handler reordering and unrelated insertions', () => {
  const baseHook = (command: string) => ({
    provider: 'codex',
    kind: 'hook' as const,
    scopeKey: 'workspace:/tmp/ws',
    canonicalSourceLocator: '/tmp/ws/.codex/hooks.json',
    nativeIdentity: `PreToolUse\u0000Bash(git *)\u0000command\u0000${command}`,
  });
  const before = stableCustomizationId(baseHook('./scripts/check.sh'));
  // An unrelated handler inserted first must not shift this id.
  const after = stableCustomizationId(baseHook('./scripts/check.sh'));
  assert.equal(before, after);
  // A content change may legitimately change the id.
  const changed = stableCustomizationId(baseHook('./scripts/other.sh'));
  assert.notEqual(before, changed);
});

// A hash can never PROVE that a secret did not participate in an id (the
// hash is not invertible), so the "secret never reaches the id" guarantee is
// owned by adapter-level metamorphic tests: the adapters redact secrets
// BEFORE hashing, and the tests assert the id does not change when only the
// secret changes (codex/claude/kimi customization scanner suites). This file
// only pins the id shape and determinism above.

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('redactCredentialArgs redacts credential flags, their values, and key=value pairs', () => {
  assert.deepEqual(
    redactCredentialArgs(['npx', '-y', '@modelcontextprotocol/server-github', '--token', 'sk-abc', '--api-key=xyz', 'GH_TOKEN=secret', '--model', 'gpt-5']),
    ['npx', '-y', '@modelcontextprotocol/server-github', '--token', '[REDACTED]', '--api-key=[REDACTED]', 'GH_TOKEN=[REDACTED]', '--model', 'gpt-5'],
  );
  assert.deepEqual(
    redactCredentialArgs(['--token']),
    ['--token'],
  );
});

test('redactShellCommandText redacts credential tokens and Bearer values', () => {
  const redacted = redactShellCommandText(
    'curl -H "Authorization: Bearer tok123" https://api.example.com --token=abc --secret "s3cr3t"',
  );
  assert.equal(redacted.includes('tok123'), false);
  assert.equal(redacted.includes('abc'), false);
  assert.equal(redacted.includes('s3cr3t'), false);
  assert.equal(redacted.includes('Bearer [REDACTED]'), true);
  assert.equal(redacted.includes('[REDACTED]'), true);
});

test('redactShellCommandText redacts sensitive environment assignments, not ordinary ones', () => {
  const redacted = redactShellCommandText(
    'API_TOKEN=secret123 ./guard.sh --flag x',
  );
  assert.equal(redacted.includes('secret123'), false);
  assert.equal(redacted, 'API_TOKEN=[REDACTED] ./guard.sh --flag x');
  assert.equal(
    redactShellCommandText('export GH_TOKEN=ghp_abc ./run'),
    'export GH_TOKEN=[REDACTED] ./run',
  );
  assert.equal(
    redactShellCommandText('PATH=/usr/bin HOME=/root ./run'),
    'PATH=/usr/bin HOME=/root ./run',
  );
  const withSecret = redactShellCommandText('API_TOKEN=alpha ./x');
  const withOtherSecret = redactShellCommandText('API_TOKEN=bravo ./x');
  assert.equal(withSecret, withOtherSecret, 'a secret change must never alter the redacted shape');
});

test('redactCustomizationTarget strips URL query and fragment but keeps origin/path', () => {
  const out = redactCustomizationTarget('https://mcp.example.com/mcp?token=secret#frag');
  assert.equal(out, 'https://mcp.example.com/mcp');
  assert.equal(out.includes('secret'), false);
});

test('redactCustomizationTarget strips URL userinfo as credential material', () => {
  const out = redactCustomizationTarget('https://user:pass@mcp.example.com/mcp?token=secret#frag');
  assert.equal(out, 'https://[REDACTED]@mcp.example.com/mcp');
  assert.equal(out.includes('user'), false);
  assert.equal(out.includes('pass'), false);
  assert.equal(out.includes('secret'), false);
});

test('redactCustomizationTarget handles every scheme with an authority, not just http(s)', () => {
  assert.equal(
    redactCustomizationTarget('wss://mcp.example.com/ws?token=abc#frag'),
    'wss://mcp.example.com/ws',
  );
  assert.equal(
    redactCustomizationTarget('ws://mcp.example.com:9001/ws?api_key=xyz'),
    'ws://mcp.example.com:9001/ws',
  );
  // A userinfo-bearing non-http URL is credentials too.
  const wss = redactCustomizationTarget('wss://user:pass@mcp.example.com/ws?token=abc');
  assert.equal(wss, 'wss://[REDACTED]@mcp.example.com/ws');
  assert.equal(wss.includes('pass'), false);
  // Bare prose without an authority is untouched.
  assert.equal(redactCustomizationTarget('see host:9001 for details'), 'see host:9001 for details');
});

test('redactCustomizationTarget conservatively falls back on malformed URLs', () => {
  const out = redactCustomizationTarget('https://user:pass@[broken/mcp?token=secret');
  assert.equal(out.includes('user'), false);
  assert.equal(out.includes('pass'), false);
  assert.equal(out.includes('secret'), false);
  assert.ok(out.includes('[REDACTED]'));
  assert.equal(
    redactCustomizationTarget('not-an-url https://host/path?t=1'),
    'not-an-url https://host/path',
  );
});

test('redactCustomizationValue recursively redacts sensitive keys and URL fragments', () => {
  const input = {
    name: 'github',
    env: { GITHUB_TOKEN: 'ghp_secret' },
    headers: { Authorization: 'Bearer abc' },
    url: 'https://x.example/sse?t=1',
    nested: { password: 'hunter2', kept: 'value' },
  };
  const out = redactCustomizationValue(input) as Record<string, unknown>;
  // Sensitive KEY NAMES redact their values; ordinary keys keep their shape.
  assert.deepEqual(out.env, { GITHUB_TOKEN: '[REDACTED]' });
  assert.deepEqual(out.headers, { Authorization: '[REDACTED]' });
  assert.equal((out.nested as Record<string, unknown>).password, '[REDACTED]');
  assert.equal((out.nested as Record<string, unknown>).kept, 'value');
  const json = JSON.stringify(out);
  assert.equal(json.includes('ghp_secret'), false);
  assert.equal(json.includes('abc'), false);
  assert.equal(json.includes('hunter2'), false);
  assert.equal(json.includes('t=1'), false);
});

test('redactCustomizationText leaves ordinary text intact', () => {
  assert.equal(redactCustomizationText('Reviews the staged diff'), 'Reviews the staged diff');
  assert.equal(redactCustomizationText('git log --oneline'), 'git log --oneline');
});
