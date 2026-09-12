#!/usr/bin/env node
// Fake gian.proxy/2.3 Proxy for Customization Inventory Host tests.
// Selects 2.3 when offered and advertises customization.list. Serves canned
// per-kind inventories that include Secret Canaries the Host second-layer
// redaction must strip. Never creates sessions, never runs anything.
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { appendFileSync, statSync } from 'node:fs';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const SPAWN_LOG = process.env.GIAN_FAKE_SPAWN_LOG;
if (SPAWN_LOG) {
  appendFileSync(SPAWN_LOG, `spawn ${process.pid}\n`);
  // The exact entry artifact this process was launched from — lets Host
  // tests prove exact artifact routing (Review Round 1/5, finding 2).
  appendFileSync(SPAWN_LOG, `entry ${process.argv[1]}\n`);
}

// Read per request so Host tests can flip failure modes on a live host.
// The child environment is snapshotted at spawn, so a marker FILE is the
// recovery switch for same-host tests (deleting it restores the kind).
const failKind = () => {
  const marker = process.env.GIAN_FAKE_FAIL_MARKER;
  if (marker) {
    try {
      statSync(marker);
      return process.env.GIAN_FAKE_FAIL_KIND ?? null;
    } catch {
      return null;
    }
  }
  return process.env.GIAN_FAKE_FAIL_KIND ?? null;
};
const failMode = () => process.env.GIAN_FAKE_FAIL_MODE ?? 'error';
const detailWrong = () => process.env.GIAN_FAKE_DETAIL_WRONG === '1';
const PROCESS_SCOPE = process.env.GIAN_FAKE_SCOPE ?? 'session';
const PLUGIN_VERSION = process.env.GIAN_FAKE_PLUGIN_VERSION ?? '1.0.0';
const EMITTED_AT = '2026-09-02T00:00:00.000Z';

function cwdParam(params) {
  return typeof params.cwd === 'string' && params.cwd ? params.cwd : null;
}

function stableId(provider, kind, scopeKey, locator, nativeIdentity) {
  const payload = [provider, kind, scopeKey, locator, nativeIdentity].join('\u0000');
  return 'ci1_' + createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function skillItems(cwd) {
  const base = cwd ? { level: 'workspace', root: cwd } : { level: 'user' };
  const originPath = cwd
    ? `${cwd}/.codex/skills/review-diff/SKILL.md`
    : '/Users/fixture/.codex/skills/code-review/SKILL.md';
  const scopeKey = cwd ? `workspace:${cwd}` : 'user';
  return [{
    id: stableId('codex', 'skill', scopeKey, originPath, 'review-diff'),
    kind: 'skill',
    name: cwd ? 'review-diff' : 'code-review',
    description: cwd
      ? 'Reviews the staged diff'
      : 'Credential canary: Authorization: Bearer sk-ant-fixture-secret123',
    nativeType: 'codex.skill.repo',
    nativeStatus: 'enabled',
    activation: 'enabled',
    scope: base,
    origin: { kind: cwd ? 'project_file' : 'user_file', path: originPath },
    discovery: { method: 'provider_api' },
    skill: {
      format: 'agent-skill',
      entryPath: originPath,
      userInvocable: true,
      modelInvocable: true,
    },
  }];
}

function mcpItems(cwd) {
  void cwd;
  return [{
    id: stableId('codex', 'mcp', 'unknown', 'mcp:github', 'github'),
    kind: 'mcp',
    name: 'github',
    nativeType: 'codex.mcp',
    nativeStatus: 'configured',
    activation: 'enabled',
    scope: { level: 'unknown' },
    origin: { kind: 'unknown' },
    discovery: { method: 'provider_cli' },
    mcp: {
      transport: 'stdio',
      targetSummary: 'npx https://mcp.example.com/mcp?api_key=canary-query',
    },
  }];
}

function hookItems(cwd) {
  const scopeKey = cwd ? `workspace:${cwd}` : 'user';
  const settingsPath = cwd ? `${cwd}/.claude/settings.json` : '/Users/fixture/.claude/settings.json';
  return [{
    id: stableId('claude', 'hook', scopeKey, settingsPath, 'PreToolUse\u0000Bash(git *)\u0000command'),
    kind: 'hook',
    name: 'PreToolUse',
    nativeType: 'claude.hook.command',
    nativeStatus: 'enabled',
    activation: 'enabled',
    scope: cwd ? { level: 'workspace', root: cwd } : { level: 'user' },
    origin: { kind: cwd ? 'project_file' : 'user_file', path: settingsPath },
    discovery: { method: 'config_parse' },
    hook: {
      nativeEvent: 'PreToolUse',
      matcher: 'Bash(git *)',
      handler: { nativeType: 'command', targetSummary: './scripts/check.sh --token=canary-arg' },
      timeoutMs: 3000,
    },
  }];
}

function ruleItems(cwd) {
  if (!cwd) return [{
    id: stableId('codex', 'rule', 'user', '/Users/fixture/.codex/AGENTS.md', 'agents.md'),
    kind: 'rule',
    name: 'AGENTS.md',
    nativeType: 'agents.md',
    activation: 'enabled',
    scope: { level: 'user' },
    origin: { kind: 'user_file', path: '/Users/fixture/.codex/AGENTS.md' },
    discovery: { method: 'filesystem_scan' },
    rule: { status: 'effective', truncated: false },
  }];
  return [{
    id: stableId('codex', 'rule', `workspace:${cwd}`, `${cwd}/AGENTS.md`, 'agents.md'),
    kind: 'rule',
    name: 'AGENTS.md',
    nativeType: 'agents.md',
    activation: 'enabled',
    scope: { level: 'workspace', root: cwd },
    origin: { kind: 'project_file', path: `${cwd}/AGENTS.md` },
    discovery: { method: 'filesystem_scan' },
    rule: { status: 'effective', truncated: false },
  }];
}

function listResult(kind, cwd) {
  const items = kind === 'skill' ? skillItems(cwd)
    : kind === 'mcp' ? mcpItems(cwd)
      : kind === 'hook' ? hookItems(cwd)
        : ruleItems(cwd);
  return {
    kind,
    status: 'ok',
    completeness: kind === 'mcp' ? 'configured' : 'effective',
    observedAt: EMITTED_AT,
    items,
    truncated: false,
    diagnostics: kind === 'mcp' ? [{ code: 'EFFECTIVE_STATE_UNRESOLVED', message: 'configured only' }] : [],
  };
}

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    continue;
  }
  const error = (id, code, message) => write({
    jsonrpc: '2.0',
    id,
    error: { code, message, data: { domainCode: code, retryable: false, details: {} } },
  });
  switch (req.method) {
    case 'initialize': {
      const offered = Array.isArray(req.params?.protocol?.versions) ? req.params.protocol.versions : [];
      const version = offered.includes('2.3') ? '2.3' : offered.includes('2.1') ? '2.1' : '2.0';
      write({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocol: { name: 'gian.proxy', version },
          plugin: { id: process.env.GIAN_PLUGIN_ID ?? 'codex', name: 'Fake', version: PLUGIN_VERSION },
          process: { scope: PROCESS_SCOPE },
          capabilities: version === '2.3'
            ? { 'customization.list': 1, 'session.replay': 1 }
            : { 'session.replay': 1 },
        },
      });
      break;
    }
    case 'customization.list':
      if (SPAWN_LOG) appendFileSync(SPAWN_LOG, `list ${req.params?.kind ?? '?'}\n`);
      if (failKind() === req.params?.kind) {
        if (failMode() === 'invalid-result') {
          write({ jsonrpc: '2.0', id: req.id, result: { kind: req.params.kind, status: 'unavailable' } });
          break;
        }
        error(req.id, -32000, 'forced failure');
        break;
      }
      write({ jsonrpc: '2.0', id: req.id, result: listResult(req.params?.kind, cwdParam(req.params)) });
      break;
    case 'session.create':
      if (SPAWN_LOG) appendFileSync(SPAWN_LOG, 'SESSION_CREATE_VIOLATION\n');
      error(req.id, -32601, 'session.create is not part of the inspection surface');
      break;
    case 'customization.detail': {
      const kind = req.params?.kind;
      const wrongKind = detailWrong() ? (kind === 'skill' ? 'mcp' : 'skill') : kind;
      const wrongId = detailWrong() ? `ci1_${'f'.repeat(32)}` : req.params?.id;
      write({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          kind: wrongKind,
          id: wrongId,
          status: 'ok',
          observedAt: EMITTED_AT,
          text: kind === 'skill' || kind === 'rule'
            ? '# Fixture entry\nCanary: Authorization: Bearer sk-ant-fixture-secret123\n'
            : kind === 'mcp'
              ? JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_fixture_secret' } } } }, null, 2)
              : JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash(git *)', hooks: [{ type: 'command', command: './scripts/check.sh --token=canary-arg' }] }] } }, null, 2),
          truncated: false,
        },
      });
      break;
    }
    case 'shutdown':
      write({ jsonrpc: '2.0', id: req.id, result: { ok: true } });
      process.exit(0);
      break;
    default:
      error(req.id, -32601, `Unknown method ${req.method}`);
  }
}