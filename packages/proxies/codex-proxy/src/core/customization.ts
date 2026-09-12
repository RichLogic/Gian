import { spawn } from 'node:child_process';
import { promises as fsp, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MAX_CUSTOMIZATION_ITEMS,
  redactCredentialArgs,
  redactCustomizationTarget,
  redactShellCommandText,
  stableCustomizationId,
  type CustomizationDetailResult,
  type CustomizationDiagnostic,
  type CustomizationItem,
  type CustomizationKind,
  type CustomizationListResult,
} from '@gian/proxy-protocol';
import type { CodexRuntime, HookMetadata, SkillMetadata } from '../runtime/types.js';

export const SCAN_TIMEOUT_MS = 15_000;
export const SCAN_MAX_DIRECTORIES = 500;
export const SCAN_CONCURRENCY = 16;
const MCP_LIST_TIMEOUT_MS = 15_000;
const MCP_LIST_MAX_BYTES = 16 * 1024 * 1024;
const DETAIL_TEXT_MAX_BYTES = 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 16 * 1024 * 1024;

export interface CodexScanLimits {
  /** Directories a single instruction-file walk may visit before it is
   *  called partial and reports SOURCE_NOT_ENUMERABLE. */
  maxDirectories: number;
  /** Hard wall-clock bound for one list/detail inspection. */
  timeoutMs: number;
}

const DEFAULT_LIMITS: CodexScanLimits = {
  maxDirectories: SCAN_MAX_DIRECTORIES,
  timeoutMs: SCAN_TIMEOUT_MS,
};

interface McpListServer {
  name?: unknown;
  enabled?: unknown;
  auth_status?: unknown;
  transport?: unknown;
}

interface McpListTransport {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  env_vars?: unknown;
  cwd?: unknown;
  url?: unknown;
  bearer_token_env_var?: unknown;
  http_headers?: unknown;
  env_http_headers?: unknown;
}

function codexBin(): string {
  return process.env.GIAN_RUNTIME_BIN ?? 'codex';
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** Bounded head read: returns up to `cap` bytes plus the truncation fact.
 *  Symlinked files are refused (no content is read through a link). */
async function readHead(path: string, cap: number): Promise<{ text: string; truncated: boolean } | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    const stat = await fsp.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    handle = await fsp.open(path, 'r');
    const buffer = Buffer.alloc(cap + 1);
    const { bytesRead } = await handle.read(buffer, 0, cap + 1, 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, cap)).toString('utf8'),
      truncated: bytesRead > cap,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return value.slice(0, end);
}

function addBoundedDiagnostics(
  target: CustomizationDiagnostic[],
  diagnostics: CustomizationDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    if (target.length >= 50) return;
    target.push(diagnostic);
  }
}

/** Readability truth is decided by actually opening the file: `access()`
 *  mode checks are unreliable on some platforms for owner-mode-000 files. */
async function openReadable(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(path, 'r');
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedText(path: string, maxBytes = MAX_CONFIG_FILE_BYTES): Promise<string | null> {
  try {
    const stat = await fsp.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (stat.size > maxBytes) return null;
    return (await fsp.readFile(path)).toString('utf8');
  } catch {
    return null;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fsp.realpath(path);
  } catch {
    return null;
  }
}

/** Iterative directory walk with bounded concurrency. Symlinks are never
 *  followed (lstat + skip), so a scan cannot escape its root along a link.
 *  When `maxEntries` entries have been visited the walk stops visiting new
 *  entries and reports `capped`; unvisited content is not enumerated. */
async function walkDirectories(
  root: string,
  maxEntries: number,
  visit: (fullPath: string, stat: Stats) => Promise<void> | void,
  skipEntry?: (entryName: string) => boolean,
): Promise<{ capped: boolean }> {
  const pending: string[] = [root];
  const batch: Promise<void>[] = [];
  let scanned = 0;
  let capped = false;

  const processDir = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipEntry?.(entry)) continue;
      if (scanned >= maxEntries) {
        capped = true;
        continue;
      }
      scanned += 1;
      const full = join(dir, entry);
      let stat: Stats;
      try {
        stat = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      await visit(full, stat);
      if (stat.isDirectory()) pending.push(full);
    }
  };

  for (let index = 0; index < SCAN_CONCURRENCY; index += 1) {
    batch.push((async () => {
      while (true) {
        const dir = pending.pop();
        if (dir === undefined) return;
        await processDir(dir);
      }
    })());
  }
  await Promise.all(batch);
  return { capped };
}

/** Runs `codex mcp list --json` in a bounded subprocess. Read-only config
 *  listing: never connects to a server, never writes configuration. */
async function listCodexMcpServers(cwd: string | null): Promise<McpListServer[]> {
  const child = spawn(codexBin(), ['mcp', 'list', '--json'], {
    cwd: cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* absent */ }
  }, MCP_LIST_TIMEOUT_MS);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflowed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MCP_LIST_MAX_BYTES) {
        overflowed = true;
        try { child.kill('SIGKILL'); } catch { /* absent */ }
        return;
      }
      chunks.push(chunk);
    });
    const exitCode = await new Promise<number | null>((resolveOut) => {
      child.on('error', () => resolveOut(null));
      child.on('exit', resolveOut);
    });
    if (overflowed || exitCode !== 0) {
      throw new Error('codex mcp list failed or exceeded its output bound.');
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('codex mcp list returned a non-array.');
    return parsed as McpListServer[];
  } finally {
    clearTimeout(timer);
  }
}

function mcpTransport(server: McpListServer): McpListTransport {
  const transport = server.transport;
  return transport && typeof transport === 'object' && !Array.isArray(transport)
    ? transport as McpListTransport
    : {};
}

function transportString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const MCP_TRANSPORT_MAP: Record<string, 'stdio' | 'http' | 'sse' | 'other' | 'unknown'> = {
  stdio: 'stdio',
  streamable_http: 'http',
  http: 'http',
  sse: 'sse',
};

function hookIdentity(
  hook: HookMetadata,
  cwd: string | null,
): { scopeKey: string; locator: string; nativeIdentity: string } {
  const source = hook.source ?? 'unknown';
  const scopeKey = source === 'user'
    ? 'user'
    : source === 'project'
      ? `workspace:${cwd ?? ''}`
      : source === 'system' || source === 'mdm' || source === 'cloudRequirements' || source === 'cloudManagedConfig'
        ? 'system'
        : source === 'plugin'
          ? `workspace:${cwd ?? ''}`
          : 'unknown';
  const command = hook.handlerType === 'command' && hook.command
    ? redactShellCommandText(hook.command)
    : null;
  return {
    scopeKey,
    locator: hook.sourcePath ?? (hook.pluginId ? `plugin:${hook.pluginId}` : ''),
    nativeIdentity: [
      hook.key ?? '',
      hook.eventName,
      hook.matcher ?? '',
      hook.handlerType,
      command ?? '',
    ].join('\u0000'),
  };
}

/** A configured candidate must be a plain file name usable ONLY in the
 *  directory being scanned: absolute paths, separator characters, and dot
 *  paths are refused outright (a `../` candidate must never read outside the
 *  scan root), and the candidate is only ever probed in the current
 *  directory. */
function isPlainConfigFilename(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false;
  if (isAbsolute(value)) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return basename(value) === value;
}

/** Declared state of the Codex `project_doc_fallback_filenames` list.
 *  - `unset`: config.toml missing, key absent, or an explicitly empty list —
 *    the Provider-documented default `["CLAUDE.md"]` applies.
 *  - `unreadable`: config.toml exists but cannot be read/parsed — the
 *    selection is unprovable and the default candidate is reported as
 *    `configured`.
 *  - `declared`: the key is present with a non-empty list. `usable` holds the
 *    entries that passed the plain-file-name safety check and are probed
 *    EXACTLY as configured (never extension-rewritten); `rejected` counts the
 *    entries dropped by the safety check. When `usable` is empty the
 *    effective file is unresolvable and the scan must NOT degrade to the
 *    default CLAUDE.md masquerading as effective.
 */
export type CodexFallbackSelection =
  | { state: 'unset' }
  | { state: 'unreadable' }
  | { state: 'declared'; usable: string[]; rejected: number };

/** Frozen, non-sensitive diagnostic for a declared fallback list whose every
 *  entry failed the plain-file-name safety check. The same object is reuse as
 *  a stable wire value: never interpolate the rejected names. */
export const FALLBACK_ALL_REJECTED_DIAGNOSTIC: CustomizationDiagnostic = {
  code: 'EFFECTIVE_STATE_UNRESOLVED',
  message: 'All configured instruction file names were rejected as unsafe; no instruction file is reported.',
};

/** Read `project_doc_fallback_filenames` from CODEX_HOME/config.toml with a
 *  minimal bounded extractor. Entries that are not plain file names are
 *  dropped (they must never escape the scanned directory): a declared list
 *  that loses every entry must never degrade to the documented default. */
async function readCodexFallbackFilenames(): Promise<CodexFallbackSelection> {
  let text: string | null;
  try {
    const stat = await fsp.lstat(join(codexHome(), 'config.toml'));
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'unset' };
    if (stat.size > MAX_CONFIG_FILE_BYTES) return { state: 'unreadable' };
    text = await fsp.readFile(join(codexHome(), 'config.toml'), 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'unset' } : { state: 'unreadable' };
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, '').trim();
    const match = /^project_doc_fallback_filenames\s*=\s*\[(.*)\]$/.exec(line);
    if (!match) continue;
    const parsed = match[1]!.split(',').map(entry => entry.trim())
      .map(entry => /^"((?:[^"\\]|\\.)*)"$/.exec(entry)?.[1])
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    // An explicitly empty list means the documented default applies; a
    // non-empty list whose every entry failed the safety check is a declared
    // selection that must never silently become the default.
    if (parsed.length === 0) return { state: 'unset' };
    const usable = parsed.filter(isPlainConfigFilename);
    return { state: 'declared', usable, rejected: parsed.length - usable.length };
  }
  return { state: 'unset' };
}

export class CodexCustomizationScanner {
  /** id → non-sensitive item locator for lazy per-item detail resolution.
   *  Bounded and in-memory only; never persisted, never logged. */
  private readonly listMemory = new Map<string, {
    kind: string;
    path: string;
    /** Exact native selector inside the source (server name / hook key). */
    selector?: string;
  }>();
  private readonly limits: CodexScanLimits;

  constructor(
    private readonly runtime: CodexRuntime,
    options?: { limits?: Partial<CodexScanLimits> },
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options?.limits };
  }

  async list(kind: CustomizationKind, cwd: string | null): Promise<CustomizationListResult> {
    return withScanTimeout(this.limits.timeoutMs, async () => {
      switch (kind) {
        case 'skill': return this.listSkills(cwd);
        case 'hook': return this.listHooks(cwd);
        case 'mcp': return this.listMcp(cwd);
        case 'rule': return this.listRules(cwd);
      }
    });
  }

  async detail(
    kind: CustomizationKind,
    id: string,
    cwd: string | null,
  ): Promise<CustomizationDetailResult> {
    return withScanTimeout(this.limits.timeoutMs, async () => {
      if (!this.listMemory.has(id)) {
        // Self-heal after Host restart or cache eviction: rebuild the id map.
        await this.list(kind, cwd);
      }
      const memory = this.listMemory.get(id);
      if (!memory || memory.kind !== kind) {
        return {
          kind,
          id,
          status: 'unavailable',
          observedAt: new Date().toISOString(),
          text: '',
          truncated: false,
          diagnostics: [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'Item source is no longer resolvable.' }],
        };
      }
      if (kind === 'mcp' || kind === 'hook') {
        const text = await this.sanitizedItemView(kind, id, memory, cwd);
        if (text === null) {
          return {
            kind,
            id,
            status: 'unavailable',
            observedAt: new Date().toISOString(),
            text: '',
            truncated: false,
            diagnostics: [{ code: 'SOURCE_UNREADABLE', message: 'Item source could not be read.' }],
          };
        }
        return {
          kind,
          id,
          status: 'ok',
          observedAt: new Date().toISOString(),
          text,
          truncated: false,
        };
      }
      const head = await readHead(memory.path, DETAIL_TEXT_MAX_BYTES);
      if (head === null) {
        return unavailableDetail(kind, id, 'SOURCE_UNREADABLE', 'Item source could not be read.');
      }
      return {
        kind,
        id,
        status: 'ok',
        observedAt: new Date().toISOString(),
        text: head.text,
        truncated: head.truncated,
      };
    });
  }

  private remember(id: string, kind: string, path: string, selector?: string): void {
    if (this.listMemory.size >= 2000) this.listMemory.clear();
    this.listMemory.set(id, { kind, path, ...(selector ? { selector } : {}) });
  }

  private async listSkills(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    let response;
    try {
      response = await this.runtime.listSkills(cwd ?? undefined);
    } catch {
      return unavailableList('skill', [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'Codex skills/list failed.' }]);
    }
    for (const entry of response.data) {
      for (const error of entry.errors ?? []) {
        // Provider-native error text is never copied onto the wire: raw
        // messages can carry configuration fragments and secrets. Only a
        // stable, generalized diagnostic survives.
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_UNREADABLE',
          message: 'The Provider reported an unreadable skill entry.',
        }]);
      }
      for (const skill of entry.skills ?? []) {
        items.push(this.toSkillItem(skill, cwd ?? entry.cwd ?? ''));
      }
    }
    const capped = capItems(items);
    if (capped.truncated) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'INVENTORY_TRUNCATED',
        message: 'Skill inventory exceeded the item limit and was truncated.',
      }]);
    }
    return {
      kind: 'skill',
      status: 'ok',
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'effective',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
  }

  private toSkillItem(skill: SkillMetadata, cwd: string): CustomizationItem {
    const scopeLevel = skill.scope === 'user'
      ? 'user'
      : skill.scope === 'repo'
        ? 'workspace'
        : 'system';
    const originKind = skill.scope === 'system' || skill.scope === 'admin'
      ? 'builtin'
      : isAbsolute(skill.path) && cwd && (skill.path === cwd || skill.path.startsWith(cwd + sep))
        ? 'project_file'
        : 'user_file';
    const description = truncateUtf8(skill.description ?? '', 4096);
    const id = stableCustomizationId({
      provider: 'codex',
      kind: 'skill',
      scopeKey: skill.scope === 'user' ? 'user' : skill.scope === 'repo' ? `workspace:${cwd}` : 'system',
      canonicalSourceLocator: skill.path,
      nativeIdentity: skill.name,
    });
    this.remember(id, 'skill', skill.path);
    return {
      id,
      kind: 'skill',
      name: truncateUtf8(skill.name ?? basename(skill.path), 256),
      ...(description.length > 0 ? { description } : {}),
      nativeType: `codex.skill.${skill.scope}`,
      nativeStatus: skill.enabled ? 'enabled' : 'disabled',
      activation: skill.enabled ? 'enabled' : 'disabled',
      scope: {
        level: scopeLevel,
        ...(scopeLevel === 'workspace' ? { root: cwd } : scopeLevel === 'system' ? { native: skill.scope } : {}),
      },
      origin: { kind: originKind, path: skill.path },
      discovery: { method: 'provider_api' },
      skill: {
        format: skill.scope === 'system' || skill.scope === 'admin' ? 'provider-builtin' : 'agent-skill',
        entryPath: skill.path,
        userInvocable: skill.enabled,
        modelInvocable: skill.enabled,
      },
    };
  }

  private async listHooks(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    let response;
    try {
      response = await this.runtime.listHooks?.(cwd ?? undefined);
    } catch {
      return unavailableList('hook', [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'Codex hooks/list failed.' }]);
    }
    if (!response) {
      return unavailableList('hook', [{ code: 'PROXY_UPGRADE_REQUIRED', message: 'Codex runtime does not expose hooks/list.' }]);
    }
    for (const entry of response.data) {
      for (const error of entry.errors ?? []) {
        // Provider-native error/warning text is never copied onto the wire:
        // raw messages can carry configuration fragments and secrets. Only
        // stable, generalized diagnostics survive.
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_UNREADABLE',
          message: 'The Provider reported an unreadable hook entry.',
        }]);
      }
      for (const warning of entry.warnings ?? []) {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_MALFORMED',
          message: 'The Provider reported a malformed hook entry.',
        }]);
      }
      for (const hook of entry.hooks ?? []) {
        items.push(this.toHookItem(hook, cwd ?? entry.cwd ?? null));
      }
    }
    const capped = capItems(items);
    if (capped.truncated) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'INVENTORY_TRUNCATED',
        message: 'Hook inventory exceeded the item limit and was truncated.',
      }]);
    }
    return {
      kind: 'hook',
      status: 'ok',
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'effective',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
  }

  private toHookItem(hook: HookMetadata, cwd: string | null): CustomizationItem {
    const source = hook.source ?? 'unknown';
    const scopeLevel = source === 'user'
      ? 'user'
      : source === 'project' || source === 'plugin'
        ? 'workspace'
        : source === 'system' || source === 'mdm' || source === 'cloudRequirements' || source === 'cloudManagedConfig'
          ? 'system'
          : 'unknown';
    const originKind = source === 'system' || source === 'mdm' || source === 'cloudRequirements'
      ? 'builtin'
      : source === 'plugin'
        ? 'plugin'
        : source === 'user'
          ? 'user_file'
          : source === 'managed' || source === 'sessionFlags'
            ? 'managed'
            : 'unknown';
    const pendingTrust = hook.trustStatus === 'untrusted' || hook.trustStatus === 'modified';
    const activation = !hook.enabled
      ? 'disabled'
      : pendingTrust
        ? 'pending_trust'
        : hook.trustStatus === 'trusted' || hook.trustStatus === 'managed'
          ? 'enabled'
          : 'unknown';
    const identity = hookIdentity(hook, cwd);
    const commandText = hook.handlerType === 'command' && hook.command
      ? redactShellCommandText(hook.command)
      : null;
    const handlerText = commandText ?? (
      hook.handlerType === 'prompt'
        ? 'prompt handler'
        : hook.handlerType === 'agent'
          ? `agent handler${hook.pluginId ? ` (${hook.pluginId})` : ''}`
          : 'handler'
    );
    const id = stableCustomizationId({
      provider: 'codex',
      kind: 'hook',
      scopeKey: identity.scopeKey,
      canonicalSourceLocator: identity.locator,
      nativeIdentity: identity.nativeIdentity,
    });
    const sourcePath = hook.sourcePath ?? '';
    this.remember(id, 'hook', sourcePath || `virtual:${hook.key ?? hook.eventName}`, hook.key ?? hook.eventName);
    return {
      id,
      kind: 'hook',
      name: truncateUtf8(hook.eventName, 256),
      nativeType: `codex.hook.${hook.handlerType}`,
      nativeStatus: activation === 'enabled' ? 'enabled' : activation,
      activation,
      scope: {
        level: scopeLevel,
        ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
        ...(hook.source ? { native: hook.source } : {}),
      },
      origin: {
        kind: originKind,
        ...(sourcePath ? { path: sourcePath } : {}),
      },
      discovery: { method: 'provider_api' },
      hook: {
        nativeEvent: truncateUtf8(hook.eventName, 256),
        ...(hook.matcher ? { matcher: truncateUtf8(hook.matcher, 256) } : {}),
        handler: {
          nativeType: hook.handlerType,
          targetSummary: truncateUtf8(handlerText, 4096),
        },
        // timeoutMs is positive-only on the wire (schema requires int > 0).
        ...(typeof hook.timeoutSec === 'number' && Number.isFinite(hook.timeoutSec) && hook.timeoutSec > 0
          ? { timeoutMs: Math.round(hook.timeoutSec * 1000) }
          : {}),
      },
    };
  }

  private async listMcp(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    let servers: McpListServer[];
    try {
      servers = await listCodexMcpServers(cwd);
    } catch {
      return unavailableList('mcp', [{ code: 'PROVIDER_INSPECTION_FAILED', message: 'codex mcp list failed.' }]);
    }
    for (const server of servers) {
      if (typeof server.name !== 'string' || server.name.length === 0) continue;
      const transport = mcpTransport(server);
      const type = transportString(transport.type);
      const rawTransport = MCP_TRANSPORT_MAP[type ?? ''] ?? (type ? 'other' : 'unknown');
      const command = transportString(transport.command);
      const url = transportString(transport.url);
      const targetSummary = command
        ? basename(command)
        : url
          ? redactCustomizationTarget(url)
          : undefined;
      const disabled = server.enabled === false;
      const id = stableCustomizationId({
        provider: 'codex',
        kind: 'mcp',
        scopeKey: 'unknown',
        canonicalSourceLocator: `mcp:${server.name}`,
        nativeIdentity: server.name,
      });
      this.remember(id, 'mcp', `virtual:${server.name}`, server.name);
      items.push({
        id,
        kind: 'mcp',
        name: truncateUtf8(server.name, 256),
        nativeType: 'codex.mcp',
        ...(typeof server.auth_status === 'string' && server.auth_status
          ? { nativeStatus: server.auth_status }
          : {}),
        activation: disabled ? 'disabled' : 'enabled',
        scope: { level: 'unknown' },
        origin: { kind: 'unknown' },
        discovery: { method: 'provider_cli' },
        mcp: {
          transport: rawTransport,
          ...(targetSummary ? { targetSummary } : {}),
        },
      });
    }
    const capped = capItems(items);
    if (capped.truncated) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'INVENTORY_TRUNCATED',
        message: 'MCP inventory exceeded the item limit and was truncated.',
      }]);
    }
    return {
      kind: 'mcp',
      status: 'ok',
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'configured',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
  }

  /** Codex instruction selection per directory follows the Provider's
   *  documented relation: AGENTS.override.md wins over AGENTS.md, which wins
   *  over the project_doc_fallback_filenames list. The inventory never
   *  guesses AGENTS.md to be effective when an override exists, and never
   *  displays override/fallback terminology. Declared fallback candidates
   *  are probed EXACTLY as configured: a legitimately extensionless or
   *  non-`.md` name is never rewritten into another file. */
  private async addDirectoryRuleFiles(
    items: CustomizationItem[],
    dir: string,
    scanRoot: string,
    fallbackSelection: CodexFallbackSelection,
  ): Promise<void> {
    const isRoot = dir === scanRoot;
    const appliesTo = isRoot ? undefined : relative(scanRoot, dir);
    const scopeKey = isRoot ? `workspace:${scanRoot}` : appliesTo ? `directory:${appliesTo}` : `workspace:${scanRoot}`;
    // The selected file of a nested directory applies under that directory;
    // only the workspace root's selected file is broadly effective.
    const selectedStatus = isRoot ? 'effective' as const : 'subtree' as const;
    // An absent or unset config key means the documented default
    // `["CLAUDE.md"]`; only an unreadable config makes the selection
    // unprovable (null). A declared list whose every entry was rejected by
    // the safety check yields an empty probe list: no default masquerade.
    const fallbackList = fallbackSelection.state === 'unset'
      ? ['CLAUDE.md']
      : fallbackSelection.state === 'unreadable'
        ? null
        : fallbackSelection.usable;

    const addFile = async (
      fileName: string,
      status: 'effective' | 'inactive' | 'configured' | 'subtree',
      nativeType: string,
    ): Promise<boolean> => {
      const path = join(dir, fileName);
      let stat: Stats | null = null;
      try {
        stat = await fsp.lstat(path);
      } catch {
        return false;
      }
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
      const truncated = stat.size > DETAIL_TEXT_MAX_BYTES;
      const unreadable = !(await openReadable(path));
      const id = stableCustomizationId({
        provider: 'codex',
        kind: 'rule',
        scopeKey,
        canonicalSourceLocator: resolve(path),
        nativeIdentity: nativeType,
      });
      this.remember(id, 'rule', path);
      const scopeLevel = isRoot ? 'workspace' as const : 'directory' as const;
      items.push({
        id,
        kind: 'rule',
        name: fileName,
        nativeType,
        activation: status === 'inactive' ? 'disabled' : 'enabled',
        scope: {
          level: scopeLevel,
          ...(isRoot ? { root: scanRoot } : {}),
        },
        origin: {
          kind: 'project_file',
          path: resolve(path),
        },
        discovery: { method: 'filesystem_scan' },
        ...(unreadable
          ? { warnings: [{ code: 'SOURCE_UNREADABLE' as const, message: 'Item source is not readable.' }] }
          : {}),
        rule: {
          ...(!isRoot && status === 'subtree' && appliesTo ? { appliesTo } : {}),
          status: unreadable ? 'unreadable' : status,
          truncated,
        },
      });
      return true;
    };

    const hasOverride = await addFile('AGENTS.override.md', selectedStatus, 'agents.override.md');
    if (hasOverride) {
      // The override is the selected doc; AGENTS.md and fallbacks are not.
      await addFile('AGENTS.md', 'inactive', 'agents.md');
      for (const fallback of fallbackList ?? []) {
        await addFile(fallback, 'inactive', 'other-discovered');
      }
      return;
    }
    const hasAgents = await addFile('AGENTS.md', selectedStatus, 'agents.md');
    if (hasAgents) {
      for (const fallback of fallbackList ?? []) {
        await addFile(fallback, 'inactive', 'other-discovered');
      }
      return;
    }
    if (fallbackList === null) {
      // The config file exists but its fallback selection cannot be read:
      // the default candidate is reported as declared-but-unproven.
      await addFile('CLAUDE.md', isRoot ? 'configured' : 'subtree', 'claude.md');
      return;
    }
    // The first present candidate is selected; any further present
    // candidates are reported inactive (never effective). An empty declared
    // probe list (every configured entry rejected as unsafe) selects
    // nothing: the scan never masquerades the default as effective.
    let selected = false;
    for (const fallback of fallbackList) {
      const present = await addFile(
        fallback,
        selected ? 'inactive' : selectedStatus,
        fallback.toLowerCase() === 'claude.md' ? 'claude.md' : 'other-discovered',
      );
      if (present) selected = true;
    }
  }

  private async listRules(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const userRoot = codexHome();
    const scanRoot = cwd ? await realpathOrNull(cwd) : null;
    const fallbackFilenames = await readCodexFallbackFilenames();

    const addUserFile = async (
      fileName: string,
      status: 'effective' | 'inactive' | 'configured',
      nativeType: string,
    ): Promise<boolean> => {
      const path = join(userRoot, fileName);
      let stat: Stats | null = null;
      try {
        stat = await fsp.lstat(path);
      } catch {
        return false;
      }
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
      const truncated = stat.size > DETAIL_TEXT_MAX_BYTES;
      const unreadable = !(await openReadable(path));
      const id = stableCustomizationId({
        provider: 'codex',
        kind: 'rule',
        scopeKey: 'user',
        canonicalSourceLocator: resolve(path),
        nativeIdentity: nativeType,
      });
      this.remember(id, 'rule', path);
      items.push({
        id,
        kind: 'rule',
        name: fileName,
        nativeType,
        activation: status === 'inactive' ? 'disabled' : 'enabled',
        scope: { level: 'user' },
        origin: { kind: 'user_file', path: resolve(path) },
        discovery: { method: 'filesystem_scan' },
        ...(unreadable
          ? { warnings: [{ code: 'SOURCE_UNREADABLE' as const, message: 'Item source is not readable.' }] }
          : {}),
        rule: {
          status: unreadable ? 'unreadable' : status,
          truncated,
        },
      });
      return true;
    };

    // Global instructions: the documented ~/.codex/AGENTS.md plus its
    // override variant. When AGENTS.override.md exists it is the selected
    // global doc and AGENTS.md is inactive — the inventory never guesses
    // AGENTS.md to be effective while an override exists. The ~/.codex/
    // rules/*.rules files are exec policies (not instructions) and are
    // deliberately NOT part of the Custom Rules inventory.
    const globalOverride = await addUserFile('AGENTS.override.md', 'effective', 'agents.md');
    await addUserFile('AGENTS.md', globalOverride ? 'inactive' : 'effective', 'agents.md');

    // A declared fallback list whose every entry failed the plain-file-name
    // safety check is a frozen, honest partial result: the effective file
    // cannot be resolved, and the scan never degrades to the default
    // CLAUDE.md masquerading as effective.
    const fallbackAllRejected = fallbackFilenames.state === 'declared'
      && fallbackFilenames.usable.length === 0;
    if (fallbackAllRejected) {
      addBoundedDiagnostics(diagnostics, [FALLBACK_ALL_REJECTED_DIAGNOSTIC]);
    }

    if (scanRoot) {
      await this.addDirectoryRuleFiles(items, scanRoot, scanRoot, fallbackFilenames);
      const walk = await walkDirectories(
        scanRoot,
        this.limits.maxDirectories,
        async (full, stat) => {
          if (!stat.isDirectory()) return;
          if (full === scanRoot) return;
          await this.addDirectoryRuleFiles(items, full, scanRoot, fallbackFilenames);
        },
        entry => entry === '.git' || entry === 'node_modules' || entry === '.codex',
      );
      if (walk.capped) {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_NOT_ENUMERABLE',
          message: 'Rule scan stopped at the directory bound; some subtree rules were not enumerated.',
        }]);
      }
    }

    const cappedItems = capItems(items);
    if (cappedItems.truncated) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'INVENTORY_TRUNCATED',
        message: 'Rule inventory exceeded the item limit and was truncated.',
      }]);
    }
    return {
      kind: 'rule',
      status: 'ok',
      completeness: cappedItems.truncated || diagnostics.length > 0 ? 'partial' : 'configured',
      observedAt: new Date().toISOString(),
      items: cappedItems.kept,
      truncated: cappedItems.truncated,
      diagnostics,
    };
  }

  private async sanitizedItemView(
    kind: 'mcp' | 'hook',
    id: string,
    memory: { path: string; selector?: string },
    cwd: string | null,
  ): Promise<string | null> {
    void memory;
    if (kind === 'mcp') {
      let servers: McpListServer[];
      try {
        servers = await listCodexMcpServers(cwd);
      } catch {
        return null;
      }
      const server = servers.find(candidate => (
        typeof candidate.name === 'string'
        && stableCustomizationId({
          provider: 'codex',
          kind: 'mcp',
          scopeKey: 'unknown',
          canonicalSourceLocator: `mcp:${candidate.name}`,
          nativeIdentity: candidate.name,
        }) === id
      ));
      if (!server || typeof server.name !== 'string') return null;
      const transport = mcpTransport(server);
      const view: Record<string, unknown> = {
        name: server.name,
        enabled: server.enabled ?? true,
      };
      const t: Record<string, unknown> = {};
      const type = transportString(transport.type);
      if (type) t.type = type;
      if (typeof transport.command === 'string') t.command = transport.command;
      if (Array.isArray(transport.args)) {
        t.args = redactCredentialArgs(transport.args.map(String));
      }
      if (typeof transport.url === 'string') {
        t.url = redactCustomizationTarget(transport.url);
      }
      if (typeof transport.bearer_token_env_var === 'string') {
        t.bearer_token_env_var = transport.bearer_token_env_var;
      }
      if (transport.env && typeof transport.env === 'object' && !Array.isArray(transport.env)) {
        const redacted: Record<string, string> = {};
        for (const key of Object.keys(transport.env as Record<string, unknown>)) redacted[key] = '[REDACTED]';
        t.env = redacted;
      }
      if (Array.isArray(transport.env_http_headers)) {
        t.env_http_headers = transport.env_http_headers.map(String);
      }
      if (transport.http_headers && typeof transport.http_headers === 'object' && !Array.isArray(transport.http_headers)) {
        const redacted: Record<string, string> = {};
        for (const key of Object.keys(transport.http_headers as Record<string, unknown>)) redacted[key] = '[REDACTED]';
        t.http_headers = redacted;
      }
      if (typeof transport.cwd === 'string') t.cwd = transport.cwd;
      view.transport = t;
      if (server.auth_status !== undefined) view.auth_status = server.auth_status;
      return JSON.stringify(view, null, 2);
    }
    let response;
    try {
      response = await this.runtime.listHooks?.(cwd ?? undefined);
    } catch {
      return null;
    }
    const selector = memory.selector ?? '';
    const hook = (response?.data ?? []).flatMap(entry => entry.hooks ?? [])
      .find(candidate => {
        const identity = hookIdentity(candidate, cwd);
        const candidateId = stableCustomizationId({
          provider: 'codex',
          kind: 'hook',
          scopeKey: identity.scopeKey,
          canonicalSourceLocator: identity.locator,
          nativeIdentity: identity.nativeIdentity,
        });
        return candidateId === id && (candidate.key ?? candidate.eventName) === selector;
      });
    if (!hook) return null;
    const view: Record<string, unknown> = {
      event: hook.eventName,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      handlerType: hook.handlerType,
      enabled: hook.enabled,
      ...(hook.trustStatus ? { trustStatus: hook.trustStatus } : {}),
      ...(typeof hook.timeoutSec === 'number' ? { timeoutSec: hook.timeoutSec } : {}),
      ...(hook.pluginId ? { pluginId: hook.pluginId } : {}),
    };
    if (hook.handlerType === 'command' && hook.command) {
      view.command = redactShellCommandText(hook.command);
    }
    return JSON.stringify(view, null, 2);
  }
}

async function withScanTimeout<T>(
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(
          new ScanTimeoutError(`${timeoutMs}ms`),
        ), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Internal marker: list/detail timeouts surface as unavailable at the
 *  service boundary (see service.ts). */
export class ScanTimeoutError extends Error {}

function unavailableList(
  kind: CustomizationKind,
  diagnostics: CustomizationDiagnostic[],
): CustomizationListResult {
  return {
    kind,
    status: 'unavailable',
    completeness: 'none',
    observedAt: new Date().toISOString(),
    items: [],
    truncated: false,
    diagnostics,
  };
}

function unavailableDetail(
  kind: CustomizationKind,
  id: string,
  code: 'SOURCE_UNREADABLE' | 'PROVIDER_INSPECTION_FAILED',
  message: string,
): CustomizationDetailResult {
  return {
    kind,
    id,
    status: 'unavailable',
    observedAt: new Date().toISOString(),
    text: '',
    truncated: false,
    diagnostics: [{ code, message }],
  };
}

/** Stable truncation: sort by (scope, name, id) ALWAYS — also when nothing
 *  is truncated — so the wire order is deterministic across refreshes
 *  (Contract §4.4). */
function capItems(items: CustomizationItem[]): { kept: CustomizationItem[]; truncated: boolean } {
  const sorted = [...items].sort((left, right) => {
    const leftKey = `${left.scope.level}\u0000${left.name}\u0000${left.id}`;
    const rightKey = `${right.scope.level}\u0000${right.name}\u0000${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (items.length <= MAX_CUSTOMIZATION_ITEMS) {
    return { kept: sorted, truncated: false };
  }
  return { kept: sorted.slice(0, MAX_CUSTOMIZATION_ITEMS), truncated: true };
}