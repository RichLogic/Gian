/**
 * Claude Code runtime backed by per-turn process spawning.
 *
 * Instead of maintaining long-lived processes with MCP channel communication,
 * this runtime spawns a new `claude -p` process for each turn and parses the
 * stream-json output.
 *
 * Session continuity is handled by Claude Code's built-in `--session-id` /
 * `--resume` flags, which preserve conversation history across invocations.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { TokenUsageUpdate } from '@gian/shared';
import { ApprovalServer, APPROVAL_PROMPT_TOOL } from '../mcp/approval-server.js';
import type { EffortLevel, ModelCapabilities, PermissionMode } from '../core/types.js';
import type { ClaudeRuntime, ClaudeRuntimeEvents } from './types.js';

const NO_SESSION_PERSISTENCE_FLAG = '--no-session-persistence';
const CLAUDE_DEFAULT_MODEL_ID = 'claude-default';
const GATEWAY_MODELS_CACHE_MAX_BYTES = 1024 * 1024;
const GATEWAY_MODELS_MAX_ENTRIES = 1000;
const GATEWAY_MODEL_TEXT_MAX_LENGTH = 512;

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export interface ClaudeAssistantUsageSample {
  context: { used: number };
  model: string | null;
}

export function isClaudeCompactBoundary(event: Record<string, unknown>): boolean {
  return event.type === 'system' && event.subtype === 'compact_boundary';
}

const HANDLED_EVENT_TYPES = new Set(['assistant', 'user', 'result']);
const HANDLED_SYSTEM_SUBTYPES = new Set([
  'init',
  'task_started',
  'task_notification',
  'compact_boundary',
]);
/** High-frequency Claude Code 2.1.237+ progress pulses. Each would otherwise
 *  become a unique transcript activity and freeze the page. */
const IGNORED_EVENT_TYPES = new Set(['tool_progress']);
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'task_progress',
  'task_updated',
  'background_tasks_changed',
  'vcs_state_changed',
]);

export type ClaudeStreamEventClass = 'handled' | 'ignored' | 'unknown';

/** Classify a Claude stream-json frame for transcript surfacing.
 *  `handled` already has a dedicated runtime emitter; `ignored` is known
 *  progress noise; `unknown` may surface once per (type, subtype) per turn. */
export function classifyClaudeStreamEvent(event: Record<string, unknown>): ClaudeStreamEventClass {
  const eventType = typeof event.type === 'string' ? event.type : '';
  if (!eventType) return 'ignored';
  if (HANDLED_EVENT_TYPES.has(eventType)) return 'handled';
  if (IGNORED_EVENT_TYPES.has(eventType)) return 'ignored';
  if (eventType === 'system') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    if (HANDLED_SYSTEM_SUBTYPES.has(subtype)) return 'handled';
    if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) return 'ignored';
    return 'unknown';
  }
  return 'unknown';
}

export function unknownClaudeEventKey(event: Record<string, unknown>): string {
  const eventType = typeof event.type === 'string' && event.type ? event.type : 'unknown';
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  return subtype ? `${eventType}:${subtype}` : eventType;
}

/** A top-level assistant event is the only stream-json sample that describes
 * the prompt currently occupying Claude's context. `result.usage` is an
 * aggregate across API calls and must never be used as this numerator. */
export function parseClaudeAssistantUsage(
  event: Record<string, unknown>,
): ClaudeAssistantUsageSample | null {
  if (event.type !== 'assistant' || !event.message || typeof event.message !== 'object') {
    return null;
  }
  const message = event.message as Record<string, unknown>;
  if (!message.usage || typeof message.usage !== 'object') return null;
  const usage = message.usage as Record<string, unknown>;
  const input = optionalNonNegativeInteger(usage.input_tokens);
  if (input === null) return null;
  const rawCacheRead = usage.cache_read_input_tokens;
  const rawCacheCreation = usage.cache_creation_input_tokens;
  const cacheRead = optionalNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreation = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
  if (
    (rawCacheRead !== undefined && rawCacheRead !== null && cacheRead === null)
    || (rawCacheCreation !== undefined && rawCacheCreation !== null && cacheCreation === null)
  ) return null;
  const used = input + (cacheRead ?? 0) + (cacheCreation ?? 0);
  return {
    context: { used },
    model: typeof message.model === 'string' ? message.model : null,
  };
}

export function parseClaudeResultUsage(
  event: Record<string, unknown>,
  currentContext: { used: number } | null,
  currentModel: string | null,
): TokenUsageUpdate | null {
  if (event.type !== 'result') return null;

  let contextWindow: number | undefined;
  if (event.modelUsage && typeof event.modelUsage === 'object') {
    const entries = Object.entries(event.modelUsage as Record<string, unknown>);
    const selected = entries.find(([model]) => model === currentModel)?.[1]
      ?? (entries.length === 1 ? entries[0]?.[1] : undefined);
    if (selected && typeof selected === 'object') {
      const rawWindow = (selected as Record<string, unknown>).contextWindow
        ?? (selected as Record<string, unknown>).context_window;
      const parsedWindow = nonNegativeInteger(rawWindow);
      if (parsedWindow > 0) contextWindow = parsedWindow;
    }
  }

  let conversation: TokenUsageUpdate['conversation'];
  let sawModelTokenFields = false;
  if (event.modelUsage && typeof event.modelUsage === 'object') {
    let sawTokenUsage = false;
    let invalidModelUsage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    for (const value of Object.values(event.modelUsage as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const usage = value as Record<string, unknown>;
      const hasTokenFields = [
        'inputTokens',
        'input_tokens',
        'outputTokens',
        'output_tokens',
        'cacheReadInputTokens',
        'cache_read_input_tokens',
        'cacheCreationInputTokens',
        'cache_creation_input_tokens',
      ].some(field => Object.hasOwn(usage, field));
      // Newer Claude emits context-only modelUsage entries alongside the
      // legacy top-level aggregate. Those contain no token fields and may
      // fall through. Once a model advertises any token counter, however,
      // it participates in the whole-tree snapshot and must be complete.
      if (!hasTokenFields) continue;
      sawModelTokenFields = true;
      const input = optionalNonNegativeInteger(usage.inputTokens ?? usage.input_tokens);
      const output = optionalNonNegativeInteger(usage.outputTokens ?? usage.output_tokens);
      const rawCacheRead = usage.cacheReadInputTokens ?? usage.cache_read_input_tokens;
      const rawCacheCreation = usage.cacheCreationInputTokens
        ?? usage.cache_creation_input_tokens;
      const cacheRead = optionalNonNegativeInteger(
        rawCacheRead,
      );
      const cacheCreation = optionalNonNegativeInteger(
        rawCacheCreation,
      );
      // The stream-json v1 modelUsage counters are a complete snapshot.
      // Context-only entries are valid (and handled above), but a partial or
      // malformed counter set must not become a zero-filled conversation.
      if (
        input === null
        || output === null
        || (rawCacheRead !== undefined && rawCacheRead !== null && cacheRead === null)
        || (rawCacheCreation !== undefined && rawCacheCreation !== null && cacheCreation === null)
      ) {
        invalidModelUsage = true;
        break;
      }
      sawTokenUsage = true;
      const cached = (cacheRead ?? 0) + (cacheCreation ?? 0);
      inputTokens += (input ?? 0) + cached;
      outputTokens += output ?? 0;
      cachedInputTokens += cached;
    }
    if (sawTokenUsage && !invalidModelUsage) {
      conversation = {
        mode: 'delta',
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  // Older Claude CLI builds may expose only the top-level query aggregate.
  // It excludes subagents but remains a valid per-invocation fallback.
  if (!conversation && !sawModelTokenFields && event.usage && typeof event.usage === 'object') {
    const usage = event.usage as Record<string, unknown>;
    const input = optionalNonNegativeInteger(usage.input_tokens);
    const output = optionalNonNegativeInteger(usage.output_tokens);
    const rawCacheRead = usage.cache_read_input_tokens;
    const rawCacheCreation = usage.cache_creation_input_tokens;
    const cacheRead = optionalNonNegativeInteger(usage.cache_read_input_tokens);
    const cacheCreation = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
    if (
      input !== null
      && output !== null
      && !(rawCacheRead !== undefined && rawCacheRead !== null && cacheRead === null)
      && !(rawCacheCreation !== undefined && rawCacheCreation !== null && cacheCreation === null)
    ) {
      const cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
      const inputTokens = input + cachedInputTokens;
      const outputTokens = output;
      conversation = {
        mode: 'delta',
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  if (!currentContext && !conversation) return null;
  return {
    ...(currentContext
      ? {
          context: {
            used: currentContext.used,
            ...(contextWindow === undefined ? {} : { window: contextWindow }),
          },
        }
      : {}),
    ...(conversation ? { conversation } : {}),
  };
}

function allowClaudePrintProbe(): boolean {
  return process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE === '1';
}

export function shouldRetryWithoutNoSessionPersistence(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes(NO_SESSION_PERSISTENCE_FLAG)
    && (s.includes('unknown option') || s.includes('unknown argument') || s.includes('not recognized'));
}

/**
 * Ask Claude Code what model it would use by spawning a throwaway print-mode
 * process and reading the `system init` event. The process is killed as soon
 * as init arrives, before a real assistant turn is needed.
 */
function probeCurrentModel(): Promise<string | null> {
  const run = (includeNoSessionPersistence: boolean): Promise<{ model: string | null; retry: boolean }> => new Promise((resolve) => {
    const args = [
      '-p', 'x',
      '--output-format', 'stream-json',
      '--verbose',
      ...(includeNoSessionPersistence ? [NO_SESSION_PERSISTENCE_FLAG] : []),
      '--dangerously-skip-permissions',
    ];
    const proc = spawn(claudeExecutable(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end();

    let resolved = false;
    // Capture stderr so a spawn-time CLI rejection (unknown flag, wrong
    // binary version) surfaces in cc-proxy stderr instead of looking like
    // a silent null — discovery used to swallow this and the UI just sat
    // on an empty model list forever.
    let stderrBuf = '';
    const finish = (model: string | null, retry = false) => {
      if (resolved) return;
      resolved = true;
      resolve({ model, retry });
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    proc.stderr!.on('data', d => { stderrBuf += d.toString(); });
    const lines = createInterface({ input: proc.stdout! });
    lines.on('line', (line) => {
      if (resolved) return;
      try {
        const event = JSON.parse(line.trim()) as Record<string, unknown>;
        if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
          finish(event.model);
        }
      } catch { /* ignore */ }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        if (includeNoSessionPersistence && shouldRetryWithoutNoSessionPersistence(stderrBuf)) {
          finish(null, true);
          return;
        }
        if (code !== 0 && stderrBuf.trim()) {
          console.error(`[cc-proxy:probe model] claude exited ${code}: ${stderrBuf.trim().split('\n')[0]}`);
        }
        finish(null);
      }
    });

    // Survive a missing `claude` binary without crashing the proxy process.
    proc.on('error', (err) => {
      if (!resolved) {
        console.error(`[cc-proxy:probe model] spawn error: ${err.message}`);
        finish(null);
      }
    });

    // Timeout after 30s.
    setTimeout(() => finish(null), 30_000);
  });

  return new Promise((resolve) => {
    void run(true).then(first => {
      if (!first.retry) {
        resolve(first.model);
        return;
      }
      void run(false).then(second => resolve(second.model));
    });
  });
}

export function parseEffortLevelsFromHelp(helpText: string): EffortLevel[] {
  const effortSection = helpText.match(/--effort\s+<level>[\s\S]*?\(([^)]*)\)/);
  if (!effortSection?.[1]) return [];
  const seen = new Set<string>();
  const levels: EffortLevel[] = [];
  for (const raw of effortSection[1].split(',')) {
    const level = raw.trim();
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

/** Parse the exact native `--permission-mode` choices out of `claude --help`.
 *  The catalog uses this list so it can never advertise a mode the configured
 *  Runtime does not actually accept. */
export function parseClaudePermissionModesFromHelp(helpText: string): string[] {
  const section = helpText.match(/--permission-mode\s+<mode>[\s\S]*?\(choices:\s*([^)]*)\)/);
  if (!section?.[1]) return [];
  const seen = new Set<string>();
  const modes: string[] = [];
  for (const match of section[1].matchAll(/"([^"]+)"/g)) {
    const mode = match[1]?.trim();
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    modes.push(mode);
  }
  return modes;
}

function probeClaudeHelp(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(claudeExecutable(), ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(output);
    };
    proc.stdout?.on('data', d => { output += d.toString(); });
    proc.stderr?.on('data', d => { output += d.toString(); });
    proc.on('error', () => finish());
    proc.on('exit', () => finish());
    setTimeout(() => {
      finish();
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }, 10_000);
  });
}


const SCRIPT_PROBE_BYTES = 16 * 1024;

/** Expand a leading `~` against the given home directory. */
function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

/**
 * Extract the value assigned to CLAUDE_CONFIG_DIR in a wrapper script,
 * resolving only the expansions we understand: `$HOME`, a leading `~`, and
 * `${VAR:-default}` / `${VAR-default}` (the default wins, which matches how
 * the wrapper behaves when the outer variable is unset). Returns null when
 * there is no assignment or the value still contains expansions we can't
 * resolve locally.
 */
export function extractClaudeConfigDirFromScript(scriptText: string, home: string = homedir()): string | null {
  const match = scriptText.match(/CLAUDE_CONFIG_DIR\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s;]+)/);
  if (!match?.[1]) return null;
  let value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, '$1');
  value = expandHome(value.replace(/\$HOME/g, home), home);
  if (!value || value.includes('$') || !isAbsolute(value)) return null;
  return value;
}

/** Read the first `maxBytes` of a file, or null when unreadable. */
function readFileHead(path: string, maxBytes: number): Buffer | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Locate the Claude settings.json the configured CLI actually reads, trying
 * in order:
 *   a. `$CLAUDE_CONFIG_DIR/settings.json` (when the env var is set),
 *   b. a CLAUDE_CONFIG_DIR assignment inside the configured CLI when that CLI
 *      is a text wrapper script (binary executables are skipped),
 *   c. `~/.claude/settings.json`.
 * The first candidate that exists and parses as JSON wins; anything failing
 * silently falls through so discovery can never crash the proxy. Returns
 * null when no usable settings file is found.
 */
export function resolveClaudeSettingsPath(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  executable?: string;
}): string | null {
  const env = options?.env ?? process.env;
  const home = options?.home ?? homedir();
  const executable = options?.executable ?? claudeExecutable();

  const candidates: string[] = [];

  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) {
    const expanded = expandHome(fromEnv, home);
    if (isAbsolute(expanded)) candidates.push(join(expanded, 'settings.json'));
  }

  const head = readFileHead(executable, SCRIPT_PROBE_BYTES);
  // A NUL byte means we're looking at a real binary, not a wrapper script.
  if (head && !head.includes(0)) {
    const dir = extractClaudeConfigDirFromScript(head.toString('utf8'), home);
    if (dir) candidates.push(join(dir, 'settings.json'));
  }

  candidates.push(join(home, '.claude', 'settings.json'));

  for (const candidate of candidates) {
    try {
      JSON.parse(readFileSync(candidate, 'utf8'));
      return candidate;
    } catch {
      // Missing file / unreadable / invalid JSON — try the next candidate.
    }
  }
  return null;
}

/** Pull the `availableModels` string list out of a parsed Claude settings
 *  object. Returns [] for anything that isn't a usable non-empty list. */
export function parseAvailableModels(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return [];
  const raw = (settings as Record<string, unknown>).availableModels;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === 'string' && m.length > 0);
}

interface ClaudeGatewayModel {
  id: string;
  displayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeGatewayText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= GATEWAY_MODEL_TEXT_MAX_LENGTH
    && value.trim().length > 0
    // Model ids and display names are rendered in the UI and included in
    // debug output. Reject control characters from the local cache rather
    // than letting a corrupt cache inject terminal/UI control sequences.
    // eslint-disable-next-line no-control-regex
    && !/[\x00-\x1F\x7F]/.test(value);
}

function isGatewayModelDiscoveryEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/** Validate Claude Code's gateway-model discovery cache against the settings
 * profile that owns it. A cache is usable only when its base URL exactly
 * matches settings.env.ANTHROPIC_BASE_URL and every model entry has the
 * expected id/display_name shape. Invalid caches fail closed to []. */
function parseGatewayModelsCache(
  settings: unknown,
  cache: unknown,
): ClaudeGatewayModel[] {
  if (!isRecord(settings) || !isRecord(settings.env) || !isRecord(cache)) return [];
  if (!isGatewayModelDiscoveryEnabled(
    settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,
  )) return [];
  const rawExpectedBaseUrl = settings.env.ANTHROPIC_BASE_URL;
  const rawCacheBaseUrl = cache.baseUrl;
  if (typeof rawExpectedBaseUrl !== 'string' || typeof rawCacheBaseUrl !== 'string') return [];
  const expectedBaseUrl = rawExpectedBaseUrl.trim();
  const cacheBaseUrl = rawCacheBaseUrl.trim();
  if (!expectedBaseUrl || !cacheBaseUrl || cacheBaseUrl !== expectedBaseUrl) return [];
  if (!Array.isArray(cache.models)
    || cache.models.length === 0
    || cache.models.length > GATEWAY_MODELS_MAX_ENTRIES) return [];

  const seen = new Set<string>();
  const models: ClaudeGatewayModel[] = [];
  for (const rawModel of cache.models) {
    if (!isRecord(rawModel)
      || !isSafeGatewayText(rawModel.id)
      || !isSafeGatewayText(rawModel.display_name)) return [];
    if (seen.has(rawModel.id)) continue;
    seen.add(rawModel.id);
    models.push({ id: rawModel.id, displayName: rawModel.display_name });
  }
  return models;
}

/** Read only the bounded gateway cache owned by the resolved settings
 * profile. Missing, oversized, unreadable, malformed, or mismatched caches
 * are deliberately indistinguishable and return []. */
function readGatewayModelsCache(
  settingsPath: string,
  settings: unknown,
): ClaudeGatewayModel[] {
  const cachePath = join(dirname(settingsPath), 'cache', 'gateway-models.json');
  const raw = readFileHead(cachePath, GATEWAY_MODELS_CACHE_MAX_BYTES + 1);
  if (!raw || raw.byteLength > GATEWAY_MODELS_CACHE_MAX_BYTES) return [];
  try {
    return parseGatewayModelsCache(settings, JSON.parse(raw.toString('utf8')));
  } catch {
    return [];
  }
}

/** Stable slug for building capability ids out of arbitrary model strings. */
function slugifyModelId(model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'model';
}

interface ManagedSession {
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  model: string | null;
  /** Last model id reported by claude CLI's `system init` event. Claude can
   *  auto-promote (e.g. opus → opus[1m]) based on user config, so the alias
   *  we asked for isn't necessarily what's running. Used for context-window
   *  inference so the bar reflects the actual variant. */
  detectedModelId: string | null;
  activeProcess: ChildProcess | null;
  hasHadFirstTurn: boolean;
  /** Absolute path to the per-session mcp-config json passed to `claude
   *  --mcp-config`. Written before each spawn that goes through the approval
   *  bridge; cleaned up on session close. */
  mcpConfigPath: string | null;
  /** Pending approval callIds → toolName, indexed by MCP CallTool id. Used so
   *  respondPermission can locate the right ApprovalServer entry. */
  pendingCallIds: Set<string>;
}

function claudeExecutable() {
  // Honor an explicit override first (escape hatch for launchd contexts where
  // PATH is sparse). Otherwise lean on the inherited PATH — Claude Code can
  // live in /opt/homebrew/bin, ~/.local/bin, /usr/local/bin, or a custom
  // location, so hardcoding any one path is strictly worse than PATH lookup.
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  return 'claude';
}

/**
 * Normalize a session display name for the Claude CLI `--name` flag
 * (SESSION-NAME-001). Strips control characters (incl. CR/LF) and caps the
 * length so a pasted multi-line name can't smuggle extra argv content or blow
 * up the terminal-title. Returns null for empty/whitespace-only input so the
 * caller omits the flag entirely.
 */
export function sanitizeDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = [...raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim()]
    .slice(0, 200)
    .join('');
  return cleaned.length > 0 ? cleaned : null;
}

export class ClaudeMcpRuntime extends EventEmitter<ClaudeRuntimeEvents> implements ClaudeRuntime {
  private readonly sessions = new Map<string, ManagedSession>();
  private discoveredModels: ModelCapabilities[] = [];
  private discoveredPermissionModes: string[] = [];
  private modelDiscoveryPromise: Promise<void> | null = null;
  private readonly approvalServer: ApprovalServer;
  private approvalPort = 0;

  constructor() {
    super();
    this.approvalServer = new ApprovalServer({
      onPermissionRequest: (sessionId, callId, toolName, input) => {
        const session = this.sessions.get(sessionId);
        if (session) session.pendingCallIds.add(callId);
        // Pass the full input through. host's normalize-cc.ts uses JSON.parse
        // to extract per-tool fields; truncating here breaks JSON syntax for
        // Edit/Write tools whose old_string / new_string easily exceed any
        // small cap, leaving the host's parser with malformed input and the
        // UI showing the raw broken JSON instead of a clean file path.
        const inputPreview = (() => {
          try { return JSON.stringify(input); }
          catch { return ''; }
        })();
        // Log toolName up front so host.out shows the canonical name the
        // CLI is using — needed for diagnosing things like AskUserQuestion
        // getting renamed/namespaced across SDK versions.
        this.emit('debug', `[runtime] permissionRequest sessionId=${sessionId} toolName=${toolName} inputKeys=${Object.keys(input ?? {}).join(',')}`);
        const description = `Tool ${toolName} requires permission.`;
        this.emit('permissionRequest', sessionId, callId, toolName, description, inputPreview);
      },
      onConnected: (sessionId) => this.emit('debug', `[runtime] approval MCP connected for ${sessionId}`),
      onDisconnected: (sessionId) => this.emit('debug', `[runtime] approval MCP disconnected for ${sessionId}`),
      onDebug: (msg) => this.emit('debug', msg),
    });
  }

  async start(): Promise<number> {
    this.approvalPort = await this.approvalServer.start();
    this.emit('debug', `[runtime] Approval MCP listening on 127.0.0.1:${this.approvalPort}`);
    // Kick off billing-safe capability discovery in the background. This
    // deliberately does not use `claude -p`: after Anthropic split print
    // mode into Agent SDK credit, model/slash warmup must not spend credit
    // behind the user's back. We only read local CLI help by default.
    this.modelDiscoveryPromise = this.discoverModels().catch((err) => {
      this.emit('debug', `[runtime] Model discovery failed: ${err}`);
    });
    return 0;
  }

  getModels(): ModelCapabilities[] {
    return this.discoveredModels;
  }

  getPermissionModes(): string[] {
    return this.discoveredPermissionModes;
  }

  /** Block until initial capability discovery finishes. Used by
   *  capabilities.list so it doesn't return an empty models array on a
   *  freshly-spawned proxy. */
  async awaitModelDiscovery(): Promise<void> {
    if (this.modelDiscoveryPromise) await this.modelDiscoveryPromise;
  }

  private async discoverModels(): Promise<void> {
    this.emit('debug', '[runtime] Discovering Claude capabilities (billing-safe)...');
    const [probedDefaultModel, helpText] = await Promise.all([
      allowClaudePrintProbe() ? probeCurrentModel() : Promise.resolve(null),
      probeClaudeHelp(),
    ]);
    const supportedEfforts = parseEffortLevelsFromHelp(helpText);
    this.discoveredPermissionModes = parseClaudePermissionModesFromHelp(helpText);
    // Model menu sources, in priority order:
    //  1. The `availableModels` list from the Claude settings.json the
    //     configured CLI actually reads (see resolveClaudeSettingsPath).
    //  2. Claude Code's gateway discovery cache from that same profile, but
    //     only when its baseUrl matches settings.env.ANTHROPIC_BASE_URL.
    //     Both custom sources are local file reads and spend no Agent SDK
    //     credit.
    //  3. The static alias menu (opus / sonnet / haiku + "no --model" = the
    //     configured default) as fallback. Aliases are stable (always the
    //     latest of that family), so this list never goes stale. The
    //     interactive `/model` picker shows exactly this set, so scraping its
    //     TUI would discover nothing extra.
    // `probeCurrentModel` (gated off by default) only enriches the Default
    // entry's label with the resolved concrete name; it never changes which
    // models are offered.
    let settingsModels: string[] = [];
    let gatewayModels: ClaudeGatewayModel[] = [];
    try {
      const settingsPath = resolveClaudeSettingsPath();
      if (settingsPath) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
        settingsModels = parseAvailableModels(settings);
        if (settingsModels.length > 0) {
          this.emit('debug', `[runtime] Model menu from ${settingsPath} availableModels (${settingsModels.length} entries)`);
        } else {
          gatewayModels = readGatewayModelsCache(settingsPath, settings);
          if (gatewayModels.length > 0) {
            this.emit('debug', `[runtime] Model menu from ${dirname(settingsPath)} gateway cache (${gatewayModels.length} entries)`);
          }
        }
      }
    } catch (err) {
      this.emit('debug', `[runtime] Claude settings discovery failed, using static aliases: ${err}`);
    }
    const alias = (
      id: string,
      model: string,
      displayName: string,
      description: string,
      isDefault = false,
    ): ModelCapabilities => ({
      id, model, displayName, description,
      hidden: false, isDefault, defaultEffort: null, supportedEfforts,
    });
    // Empty model means "do not pass --model"; Claude Code picks the
    // configured default. Resolving the concrete name requires `claude -p`,
    // so it is only attempted behind GIAN_ALLOW_CLAUDE_PRINT_PROBE.
    const defaultEntry = alias(
      CLAUDE_DEFAULT_MODEL_ID,
      '',
      probedDefaultModel ? `Default · ${probedDefaultModel}` : 'Default',
      "Uses Claude Code's configured default model.",
      true,
    );
    if (settingsModels.length > 0 || gatewayModels.length > 0) {
      const usedIds = new Set<string>();
      const configuredModels = settingsModels.length > 0
        ? settingsModels.map((model) => ({
            idPrefix: 'claude-settings',
            model,
            displayName: model,
            description: 'From Claude settings availableModels.',
          }))
        : gatewayModels.map((model) => ({
            idPrefix: 'claude-gateway',
            model: model.id,
            displayName: model.displayName,
            description: 'From Claude gateway model discovery cache.',
          }));
      this.discoveredModels = [
        defaultEntry,
        ...configuredModels.map((entry) => {
          const slug = slugifyModelId(entry.model);
          let id = `${entry.idPrefix}-${slug}`;
          for (let n = 2; usedIds.has(id); n++) id = `${entry.idPrefix}-${slug}-${n}`;
          usedIds.add(id);
          return alias(id, entry.model, entry.displayName, entry.description);
        }),
      ];
    } else {
      this.discoveredModels = [
        defaultEntry,
        alias('claude-alias-opus', 'opus', 'Opus', 'Most capable for complex work.'),
        alias('claude-alias-sonnet', 'sonnet', 'Sonnet', 'Best for everyday tasks.'),
        alias('claude-alias-haiku', 'haiku', 'Haiku', 'Fastest for quick answers.'),
      ];
    }
    this.emit('debug', `[runtime] Discovered ${this.discoveredModels.length} models: ${this.discoveredModels.map((m) => m.model || '(default)').join(', ')}`);
  }

  async spawnSession(options: {
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
  }): Promise<void> {
    // Kill any existing process for this session.
    this.killSession(options.sessionId);

    // Record session metadata — no process spawned yet.
    this.sessions.set(options.sessionId, {
      sessionId: options.sessionId,
      claudeSessionId: options.claudeSessionId,
      cwd: options.cwd,
      model: options.model ?? null,
      detectedModelId: null,
      activeProcess: null,
      hasHadFirstTurn: options.isResume,
      mcpConfigPath: null,
      pendingCallIds: new Set(),
    });

    this.emit('debug', `[runtime] Session registered: ${options.sessionId} (claude: ${options.claudeSessionId})`);
  }

  setSessionModel(sessionId: string, model: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session found for ${sessionId}`);
    session.model = model;
    // The last init event belongs to the previous model selection. Do not let
    // it influence usage/context inference for the next per-turn process.
    session.detectedModelId = null;
  }

  /**
   * Rotate the Claude Code session ID for an existing Gian session. Used by
   * the `/clear` intercept: cc-proxy generates a fresh UUID, the next turn
   * spawns `claude -p --session-id <new>` (not `--resume`), so Claude starts
   * with empty conversation history. The user-facing Gian session id stays
   * the same; just the Claude-side persistence ID rotates.
   */
  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeProcess && !session.activeProcess.killed) {
      session.activeProcess.kill('SIGTERM');
      session.activeProcess = null;
    }
    session.claudeSessionId = newClaudeSessionId;
    session.hasHadFirstTurn = false;
    this.emit('debug', `[runtime] Session ${sessionId} reset to fresh claude session ${newClaudeSessionId}`);
  }

  async sendMessage(sessionId: string, content: string, options?: {
    permissionMode?: PermissionMode | null;
    effort?: EffortLevel | null;
    displayName?: string | null;
    additionalDirectories?: string[];
  }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No session found for ${sessionId}`);
    }

    // Kill any still-running process for this session.
    if (session.activeProcess && !session.activeProcess.killed) {
      session.activeProcess.kill('SIGTERM');
    }

    // Permission bridge: bypassPermissions skips the MCP roundtrip entirely
    // (CLI flag handles it). All other modes route through approval-server.
    const mode = options?.permissionMode ?? 'default';
    const useApprovalBridge = mode !== 'bypassPermissions';
    if (useApprovalBridge) {
      session.mcpConfigPath = await this.writeMcpConfig(session.sessionId);
    } else {
      session.mcpConfigPath = null;
    }

    const args = this.buildClaudeArgs(session, content, options);
    this.emit('debug', `[runtime] Spawning turn: claude ${args.slice(0, 4).join(' ')}...`);

    const proc = spawn(claudeExecutable(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: session.cwd,
      env: { ...process.env },
    });

    // Wait until spawn either succeeds or fails so we can surface ENOENT etc.
    // back to the caller and the host-side state machine. Without this the
    // turn would be marked running indefinitely on a missing claude binary.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err: Error) => {
        cleanup();
        // Surface as processExited too so service.ts marks the turn failed.
        this.emit('debug', `[runtime] Failed to spawn claude: ${err.message}`);
        this.emit('processExited', sessionId, null, null);
        reject(err);
      };
      const cleanup = () => {
        proc.removeListener('spawn', onSpawn);
        proc.removeListener('error', onError);
      };
      proc.once('spawn', onSpawn);
      proc.once('error', onError);
    });

    proc.stdin.end();
    session.activeProcess = proc;

    // Parse stdout line by line for stream-json events.
    const lines = createInterface({ input: proc.stdout! });
    let resultText: string | null = null;
    let resultSubtype: string | null = null;
    let resultError: string | null = null;
    let stderrText = '';
    // Tracks whether any text has been streamed via `assistantText` this
    // turn. The `result` event echoes the final assistant message verbatim,
    // so emitting it again as channelReply would duplicate the last text
    // block. When this is true we suppress the result-side text and only
    // signal turn completion.
    let streamedAnyText = false;
    const emittedUnknownKeys = new Set<string>();
    let currentContext: { used: number } | null = null;
    let currentModel: string | null = null;
    const agentTasks = new Map<string, {
      toolUseId: string;
      description?: string;
      agentType?: string;
    }>();

    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const eventType = event.type as string | undefined;

        // The `system init` event reports the actual resolved model id
        // claude is running under (e.g. `claude-opus-4-7[1m]` when the user
        // has 1M enabled). Billing-safe startup capabilities intentionally
        // don't resolve a concrete model id, so capture the real id from the
        // actual structured turn and use it for context-window inference.
        if (eventType === 'system' && event.subtype === 'init') {
          if (typeof event.model === 'string') {
            session.detectedModelId = event.model;
          }
        }

        // Claude -p exposes subagents as a native task lifecycle. Keep the
        // native task id and the parent Agent tool_use id separate: the latter
        // is the stable transcript anchor, while task_id is what later
        // SendMessage/TaskOutput calls address.
        if (eventType === 'system' && event.subtype === 'task_started') {
          const taskId = typeof event.task_id === 'string' ? event.task_id : '';
          const toolUseId = typeof event.tool_use_id === 'string' ? event.tool_use_id : '';
          if (taskId && toolUseId) {
            const description = typeof event.description === 'string' ? event.description : undefined;
            const agentType = typeof event.subagent_type === 'string' ? event.subagent_type : undefined;
            agentTasks.set(taskId, {
              toolUseId,
              ...(description ? { description } : {}),
              ...(agentType ? { agentType } : {}),
            });
            this.emit('agentTask', sessionId, {
              taskId,
              toolUseId,
              status: 'running',
              ...(description ? { description } : {}),
              ...(agentType ? { agentType } : {}),
              startedAt: Date.now(),
            });
          }
        }

        if (eventType === 'system' && event.subtype === 'task_notification') {
          const taskId = typeof event.task_id === 'string' ? event.task_id : '';
          const known = taskId ? agentTasks.get(taskId) : undefined;
          const toolUseId = typeof event.tool_use_id === 'string'
            ? event.tool_use_id
            : known?.toolUseId ?? '';
          if (taskId && toolUseId) {
            const nativeStatus = typeof event.status === 'string' ? event.status : '';
            const summary = typeof event.summary === 'string' ? event.summary : undefined;
            const outputFile = typeof event.output_file === 'string' ? event.output_file : undefined;
            this.emit('agentTask', sessionId, {
              taskId,
              toolUseId,
              status: nativeStatus === 'completed' ? 'done' : 'error',
              ...(known?.description ? { description: known.description } : {}),
              ...(known?.agentType ? { agentType: known.agentType } : {}),
              ...(summary ? { summary } : {}),
              ...(outputFile ? { outputFile } : {}),
              completedAt: Date.now(),
            });
          }
        }

        if (isClaudeCompactBoundary(event)) {
          // Any assistant usage retained above this boundary describes the old
          // context. Clear it before result parsing; the next assistant sample
          // (if this query continues) is the first post-compact replacement.
          currentContext = null;
          this.emit('tokenUsage', sessionId, {
            context: null,
            reason: 'compact_started',
          });
        }

        if (eventType === 'assistant') {
          const usageSample = parseClaudeAssistantUsage(event);
          if (usageSample) {
            currentContext = usageSample.context;
            currentModel = usageSample.model ?? session.detectedModelId ?? session.model;
            this.emit('tokenUsage', sessionId, { context: usageSample.context });
          }

          // Parse all content blocks from assistant messages — both `text`
          // (intermediate commentary) and `tool_use`. Without emitting the
          // text blocks the UI only sees the final `result` summary, missing
          // every "let me check that" / "now I'll do X" the agent says
          // between tool calls.
          const message = event.message as { id?: string; content?: unknown[] } | undefined;
          const messageId = typeof message?.id === 'string' && message.id ? message.id : `msg_${Date.now()}`;
          const content = Array.isArray(message?.content) ? message!.content : [];
          let blockIdx = 0;
          for (const block of content) {
            if (typeof block !== 'object' || block === null) {
              blockIdx++;
              continue;
            }
            const b = block as Record<string, unknown>;
            const blockType = b.type;

            if (blockType === 'text' && typeof b.text === 'string' && b.text.length > 0) {
              streamedAnyText = true;
              const itemId = typeof b.id === 'string' && b.id
                ? b.id
                : `${messageId}_${blockIdx}`;
              this.emit('assistantText', sessionId, b.text, itemId);
            } else if (
              (blockType === 'thinking' || blockType === 'reasoning')
              && typeof (b.thinking ?? b.text) === 'string'
              && String(b.thinking ?? b.text).length > 0
            ) {
              const itemId = typeof b.id === 'string' && b.id
                ? b.id
                : `${messageId}_${blockIdx}`;
              this.emit('assistantReasoning', sessionId, String(b.thinking ?? b.text), itemId);
            } else if (blockType === 'tool_use') {
              const toolName = typeof b.name === 'string' ? b.name : 'unknown';
              const toolInput = typeof b.input === 'object' && b.input !== null
                ? b.input as Record<string, unknown>
                : {};
              const callId = typeof b.id === 'string' && b.id
                ? b.id
                : `${messageId}_${blockIdx}`;

              // ExitPlanMode permission request flows through the approval
              // MCP bridge (Claude SDK calls canUseTool before invoking the
              // tool). Host detects toolName='ExitPlanMode' on the approval
              // event and tags it as exit_plan_mode for special UI rendering.
              // No synthesized event needed here.

              this.emit('toolUse', sessionId, toolName, toolInput, callId);
            }
            blockIdx++;
          }
        }

        if (eventType === 'user') {
          const message = event.message as { content?: unknown[] } | undefined;
          const content = Array.isArray(message?.content) ? message.content : [];
          for (const block of content) {
            if (typeof block !== 'object' || block === null) continue;
            const result = block as Record<string, unknown>;
            if (result.type !== 'tool_result') continue;
            const callId = typeof result.tool_use_id === 'string' ? result.tool_use_id : '';
            if (!callId) continue;
            this.emit(
              'toolResult',
              sessionId,
              callId,
              result.content ?? null,
              result.is_error === true,
            );
          }
        }

        if (eventType === 'result') {
          resultSubtype = (event.subtype as string) ?? null;
          resultText = typeof event.result === 'string' ? event.result : '';
          const terminalReason = typeof event.terminal_reason === 'string'
            ? event.terminal_reason
            : null;
          if (event.is_error === true || terminalReason === 'api_error' || resultSubtype !== 'success') {
            resultError = resultText
              || (terminalReason ? `Claude Code turn failed (${terminalReason}).` : 'Claude Code turn failed.');
          }
          this.emit('debug', `[runtime] Turn result for ${sessionId} (${resultSubtype}): ${resultText.slice(0, 120)}...`);

          const usageUpdate = parseClaudeResultUsage(
            event,
            currentContext,
            currentModel ?? session.detectedModelId ?? session.model,
          );
          if (usageUpdate) this.emit('tokenUsage', sessionId, usageUpdate);
        }

        if (classifyClaudeStreamEvent(event) === 'unknown') {
          const key = unknownClaudeEventKey(event);
          if (!emittedUnknownKeys.has(key)) {
            emittedUnknownKeys.add(key);
            this.emit('unknownClaudeEvent', sessionId, event);
          }
        }

        // Log non-system events.
        if (eventType && eventType !== 'system') {
          this.emit('debug', `[runtime:${sessionId}] ${eventType}${event.subtype ? ':' + String(event.subtype) : ''}`);
        }
      } catch {
        this.emit('debug', `[runtime:${sessionId}:stdout] ${trimmed.slice(0, 200)}`);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (stderrText.length < 16 * 1024) stderrText += chunk.toString().slice(0, 16 * 1024 - stderrText.length);
      if (text) this.emit('debug', `[runtime:${sessionId}:stderr] ${text}`);
    });

    // Post-spawn errors (rare — usually pipe failures). Surface but don't
    // re-emit processExited; the 'exit' handler below covers process death.
    proc.on('error', (err) => {
      this.emit('debug', `[runtime] post-spawn error for ${sessionId}: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      // A manual stop removes this ManagedSession immediately so the next turn
      // can register a replacement under the same Gian session id. SIGTERM is
      // asynchronous, though: the old child may exit after that replacement is
      // already live. Never let the retired child clear or terminate the new
      // registration's state.
      if (this.sessions.get(sessionId) !== session || session.activeProcess !== proc) {
        this.emit('debug', `[runtime] Ignoring stale child exit for ${sessionId} (code=${code}, signal=${signal})`);
        return;
      }
      session.activeProcess = null;
      session.hasHadFirstTurn = true;

      // Drop any per-session state tied to this process. The approval bridge
      // will deny outstanding approvals so claude never gets a stale reply.
      this.cleanupAfterTurn(session);

      if (resultText !== null && resultSubtype === 'success' && resultError === null) {
        // Turn completed successfully. If we've already streamed text via
        // assistantText events, the result text is just a duplicate of the
        // last block — pass an empty string so the service emits the
        // turn-completed signal without re-emitting text. Otherwise (rare
        // edge case where claude reports success but never streamed text)
        // pass the result text through so it isn't lost.
        const replyText = streamedAnyText ? '' : resultText;
        this.emit('channelReply', sessionId, replyText);
      }

      const exitError = resultError
        ?? (code !== 0 && stderrText.trim() ? stderrText.trim() : undefined);
      this.emit('processExited', sessionId, code, signal, exitError);
      this.emit('debug', `[runtime] Turn process exited for ${sessionId} (code=${code}, signal=${signal})`);
    });
  }

  async respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: { updatedInput?: Record<string, unknown>; message?: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emit('debug', `[runtime] respondPermission: no session ${sessionId}`);
      return;
    }
    const ok = this.approvalServer.resolve(
      requestId,
      behavior,
      extra?.message,
      extra?.updatedInput !== undefined ? { updatedInput: extra.updatedInput } : undefined,
    );
    if (ok) {
      session.pendingCallIds.delete(requestId);
    } else {
      this.emit('debug', `[runtime] respondPermission: no pending callId ${requestId}`);
    }
  }

  isSessionAlive(sessionId: string): boolean {
    // A session is "alive" as long as it is registered.
    return this.sessions.has(sessionId);
  }

  getDetectedModelId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.detectedModelId ?? null;
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.activeProcess && !session.activeProcess.killed) {
      session.activeProcess.kill('SIGTERM');
    }
    this.cleanupAfterTurn(session);
    this.approvalServer.dropConnection(sessionId);
    this.sessions.delete(sessionId);
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.activeProcess && !session.activeProcess.killed) {
        session.activeProcess.kill('SIGTERM');
      }
      this.cleanupAfterTurn(session);
    }
    this.sessions.clear();
    await this.approvalServer.stop();
  }

  /** Drop per-turn state: deny pending approvals and unlink the temporary
   *  mcp-config file. Safe to call multiple times. */
  private cleanupAfterTurn(session: ManagedSession): void {
    for (const callId of session.pendingCallIds) {
      this.approvalServer.resolve(callId, 'deny', 'turn ended');
    }
    session.pendingCallIds.clear();

    if (session.mcpConfigPath) {
      const path = session.mcpConfigPath;
      session.mcpConfigPath = null;
      void unlink(path).catch(() => undefined);
    }
  }

  private async writeMcpConfig(sessionId: string): Promise<string> {
    const path = join(tmpdir(), `cc-proxy-mcp-${sessionId}-${process.pid}.json`);
    const config = {
      mcpServers: {
        cc_approval: {
          type: 'sse',
          url: this.approvalServer.urlForSession(sessionId),
        },
      },
    };
    await writeFile(path, JSON.stringify(config), 'utf8');
    return path;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private buildClaudeArgs(
    session: ManagedSession,
    content: string,
    options?: {
      permissionMode?: PermissionMode | null;
      effort?: EffortLevel | null;
      displayName?: string | null;
      additionalDirectories?: string[];
    },
  ): string[] {
    return buildClaudeCliArgs(
      {
        mcpConfigPath: session.mcpConfigPath,
        hasHadFirstTurn: session.hasHadFirstTurn,
        claudeSessionId: session.claudeSessionId,
        model: session.model,
      },
      content,
      options,
    );
  }
}

/** Build the `claude -p` argv for a turn. Extracted and exported so MCP
 *  isolation and permission-mode passthrough are unit-testable without
 *  spawning a real Provider. */
export function buildClaudeCliArgs(
  session: {
    mcpConfigPath: string | null;
    hasHadFirstTurn: boolean;
    claudeSessionId: string;
    model: string | null;
  },
  content: string,
  options?: {
    permissionMode?: PermissionMode | null;
    effort?: EffortLevel | null;
    displayName?: string | null;
    additionalDirectories?: string[];
  },
): string[] {
  const args: string[] = [
    '-p', content,
    '--verbose',
    '--output-format', 'stream-json',
  ];

  if (options?.additionalDirectories?.length) {
    args.push('--add-dir', ...options.additionalDirectories);
  }

  // cc-proxy owns the MCP surface for this process. `--strict-mcp-config`
  // makes Claude load only the servers named by `--mcp-config`, so a session
  // can never inherit unrelated user/project MCP servers. It is passed in
  // bypass mode too: no --mcp-config means no inherited MCP servers.
  const mode = options?.permissionMode ?? 'default';
  if (mode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
    args.push('--strict-mcp-config');
  } else {
    args.push('--permission-mode', mode);
    if (session.mcpConfigPath) {
      args.push('--mcp-config', session.mcpConfigPath);
      args.push('--strict-mcp-config');
      args.push('--permission-prompt-tool', APPROVAL_PROMPT_TOOL);
    }
  }

  if (options?.effort) {
    args.push('--effort', options.effort);
  }

  if (session.hasHadFirstTurn) {
    args.push('--resume', session.claudeSessionId);
  } else {
    args.push('--session-id', session.claudeSessionId);
    const displayName = sanitizeDisplayName(options?.displayName);
    if (displayName) args.push('--name', displayName);
  }

  if (session.model) {
    args.push('--model', session.model);
  }

  return args;
}
