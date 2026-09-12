import { promises as fsp, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

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

export const SCAN_TIMEOUT_MS = 15_000;
export const SCAN_MAX_ENTRIES = 500;
export const SCAN_CONCURRENCY = 16;
const MAX_CONFIG_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRA_DIRS = 50;
const DETAIL_TEXT_MAX_BYTES = 1024 * 1024;

export interface KimiScanLimits {
  /** Total entries (files + directories) a single walk may visit before it
   *  is called partial and reports SOURCE_NOT_ENUMERABLE. */
  maxScanEntries: number;
  /** Hard wall-clock bound for one list/detail inspection. */
  timeoutMs: number;
}

const DEFAULT_LIMITS: KimiScanLimits = {
  maxScanEntries: SCAN_MAX_ENTRIES,
  timeoutMs: SCAN_TIMEOUT_MS,
};

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fsp.realpath(path);
  } catch {
    return null;
  }
}

async function readBounded(path: string, maxBytes = MAX_CONFIG_FILE_BYTES): Promise<{
  state: 'ok' | 'missing' | 'unreadable' | 'oversized';
  data?: Buffer;
}> {
  try {
    const stat = await fsp.lstat(path);
    // Never follow symlinks: a link is not the Provider's declared file.
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'missing' };
    if (stat.size > maxBytes) return { state: 'oversized' };
    return { state: 'ok', data: await fsp.readFile(path) };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { state: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
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

async function readdirList(path: string): Promise<string[]> {
  try {
    const stat = await fsp.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return await fsp.readdir(path);
  } catch {
    return [];
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

// ---------------------------------------------------------------------------
// Minimal bounded TOML extractor — Kimi `config.toml` is read ONLY for the
// two documented customization constructs: the top-level `extra_skill_dirs`
// string array and `[[hooks]]` tables with the four documented scalar fields
// (event/matcher/command/timeout). Anything the subset cannot parse fails
// closed into a SOURCE_MALFORMED diagnostic; nothing else in the file is
// ever read, copied, or hashed.
// ---------------------------------------------------------------------------

function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inDouble) {
      escaped = true;
      continue;
    }
    if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '#' && !inDouble && !inSingle) return line.slice(0, index);
  }
  return line;
}

function parseBasicString(value: string): string {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value.trim());
  if (!match) return '';
  return match[1]!
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export interface KimiHookRule {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  sourcePath: string;
}

export interface KimiTomlCustomization {
  extraSkillDirs: string[];
  hooks: KimiHookRule[];
  malformed: boolean;
}

/** Extract the two documented customization constructs from a Kimi
 *  `config.toml`. Returns empty results for missing files; `malformed` only
 *  when a construct exists but cannot be parsed by the subset. */
export async function parseKimiConfigToml(path: string): Promise<KimiTomlCustomization> {
  const content = await readBounded(path);
  if (content.state !== 'ok' || content.data === undefined) {
    return { extraSkillDirs: [], hooks: [], malformed: false };
  }
  const lines = content.data.toString('utf8').split(/\r?\n/);
  const extraSkillDirs: string[] = [];
  const hooks: KimiHookRule[] = [];
  let malformed = false;
  let currentHook: Partial<KimiHookRule> | null = null;
  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (line === '') continue;
    const table = /^\[\[hooks\]\]\s*$/.exec(line);
    if (table) {
      if (currentHook) {
        if (currentHook.event && currentHook.command) hooks.push(currentHook as KimiHookRule);
        else malformed = true;
      }
      currentHook = {};
      continue;
    }
    if (/^\[[^\]]+\]\s*$/.test(line) && !line.startsWith('[[')) {
      // Any other table ends the hooks section.
      if (currentHook) {
        if (currentHook.event && currentHook.command) hooks.push(currentHook as KimiHookRule);
        else malformed = true;
      }
      currentHook = null;
      continue;
    }
    const extra = /^extra_skill_dirs\s*=\s*\[(.*)\]$/.exec(line);
    if (extra) {
      const entries = extra[1]!.split(',');
      for (const entry of entries) {
        const parsed = parseBasicString(entry);
        if (parsed.length > 0 && extraSkillDirs.length < MAX_EXTRA_DIRS) extraSkillDirs.push(parsed);
      }
      continue;
    }
    if (currentHook) {
      const event = /^event\s*=\s*(.+)$/.exec(line);
      if (event) {
        currentHook.event = parseBasicString(event[1]!);
        if (!currentHook.event) malformed = true;
        continue;
      }
      const matcher = /^matcher\s*=\s*(.+)$/.exec(line);
      if (matcher) {
        currentHook.matcher = parseBasicString(matcher[1]!);
        continue;
      }
      const command = /^command\s*=\s*(.+)$/.exec(line);
      if (command) {
        const parsed = parseBasicString(command[1]!);
        if (parsed.length === 0) malformed = true;
        currentHook.command = parsed;
        continue;
      }
      const timeout = /^timeout\s*=\s*(.+)$/.exec(line);
      if (timeout) {
        const value = Number(timeout[1]!.trim());
        if (Number.isFinite(value) && Number.isInteger(value)) currentHook.timeout = value;
        continue;
      }
      if (/^\w[\w.-]*\s*=/.test(line)) malformed = true;
    }
  }
  if (currentHook) {
    if (currentHook.event && currentHook.command) hooks.push(currentHook as KimiHookRule);
    else malformed = true;
  }
  return {
    extraSkillDirs,
    hooks: hooks.map(hook => ({ ...hook, sourcePath: path })),
    malformed,
  };
}

/** Expand a user-declared extra skill dir. Only `~`/`~/…` is expanded;
 *  absolute paths are kept verbatim (a `dir.slice(2)` corrupts absolute
 *  paths like `/home/x`), and relative paths resolve against the declaring
 *  config's directory. */
export function expandExtraSkillDir(dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2));
  return dir;
}

function resolveExtraSkillDir(dir: string, declaringDir: string): string {
  const expanded = expandExtraSkillDir(dir);
  return isAbsolute(expanded) ? expanded : resolve(declaringDir, expanded);
}

interface McpServerEntry {
  command?: unknown;
  enabled?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  url?: unknown;
  transport?: unknown;
  headers?: unknown;
}

export class KimiCustomizationScanner {
  /** id → non-sensitive item locator for lazy per-item detail resolution.
   *  Bounded and in-memory only; never persisted, never logged. */
  private readonly listMemory = new Map<string, {
    kind: string;
    path: string;
    /** Exact item selector inside the source (server name / hook identity). */
    selector?: string;
  }>();
  private readonly limits: KimiScanLimits;

  constructor(options?: { limits?: Partial<KimiScanLimits> }) {
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

  async detail(kind: CustomizationKind, id: string, cwd: string | null): Promise<CustomizationDetailResult> {
    return withScanTimeout(this.limits.timeoutMs, async () => {
      if (!this.listMemory.has(id)) await this.list(kind, cwd);
      const memory = this.listMemory.get(id);
      if (!memory || memory.kind !== kind) {
        return unavailableDetail(kind, id, 'PROVIDER_INSPECTION_FAILED', 'Item source is no longer resolvable.');
      }
      if (kind === 'mcp') {
        const text = await this.sanitizedMcpView(memory);
        if (text === null) return unavailableDetail(kind, id, 'SOURCE_UNREADABLE', 'Item source could not be read.');
        return { kind, id, status: 'ok', observedAt: new Date().toISOString(), text, truncated: false };
      }
      if (kind === 'hook') {
        const text = await this.sanitizedHookView(memory);
        if (text === null) return unavailableDetail(kind, id, 'SOURCE_UNREADABLE', 'Item source could not be read.');
        return { kind, id, status: 'ok', observedAt: new Date().toISOString(), text, truncated: false };
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

  // ---- skills -------------------------------------------------------------

  private async scanSkillDir(
    root: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<{ items: CustomizationItem[]; capped: boolean }> {
    const items: CustomizationItem[] = [];
    const scanRoot = await realpathOrNull(root);
    if (scanRoot === null) return { items, capped: false };
    const walked = await walkDirectories(
      scanRoot,
      this.limits.maxScanEntries,
      async (full, stat) => {
        if (stat.isDirectory()) {
          const entryPath = join(full, 'SKILL.md');
          const direct = await readBounded(entryPath, DETAIL_TEXT_MAX_BYTES);
          if (direct.state === 'ok') {
            items.push(await this.toSkillItem(entryPath, basename(full), scopeLevel, cwd));
            return;
          }
          return;
        }
        if (stat.isFile() && full.endsWith('.md') && !basename(full).startsWith('SKILL.')) {
          items.push(await this.toSkillItem(full, basename(full).slice(0, -3), scopeLevel, cwd));
        }
      },
      entry => entry.startsWith('.') || entry === 'node_modules',
    );
    if (walked.capped) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_NOT_ENUMERABLE',
        message: 'Skill directory scan stopped at the entry bound; some skills were not enumerated.',
      }]);
    }
    return { items, capped: walked.capped };
  }

  private async toSkillItem(
    entryPath: string,
    fallbackName: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
  ): Promise<CustomizationItem> {
    const content = await readBounded(entryPath, DETAIL_TEXT_MAX_BYTES);
    const frontmatter = content.state === 'ok' && content.data !== undefined
      ? parseSkillFrontmatter(content.data.toString('utf8'))
      : {};
    const name = truncateUtf8(frontmatter.name ?? fallbackName, 256);
    const description = frontmatter.description ? truncateUtf8(frontmatter.description, 4096) : undefined;
    const type = frontmatter.type ?? 'prompt';
    const disableModelInvocation = frontmatter.disableModelInvocation ?? false;
    const flow = type === 'flow';
    const id = stableCustomizationId({
      provider: 'kimi',
      kind: 'skill',
      scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
      canonicalSourceLocator: resolve(entryPath),
      nativeIdentity: name,
    });
    this.remember(id, 'skill', entryPath);
    return {
      id,
      kind: 'skill',
      name,
      ...(description ? { description } : {}),
      nativeType: 'kimi.skill',
      nativeStatus: 'configured',
      activation: 'unknown',
      scope: {
        level: scopeLevel,
        ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
      },
      origin: {
        kind: scopeLevel === 'user' ? 'user_file' : 'project_file',
        path: entryPath,
      },
      discovery: { method: 'filesystem_scan' },
      skill: {
        format: 'agent-skill',
        entryPath,
        userInvocable: true,
        modelInvocable: !flow && !disableModelInvocation,
      },
    };
  }

  private async listSkills(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const home = kimiHome();
    const genericHome = join(homedir(), '.agents');
    const userDirs: string[] = [join(home, 'skills'), join(genericHome, 'skills')];
    const projectDirs: string[] = [];
    if (cwd) {
      projectDirs.push(join(cwd, '.kimi-code', 'skills'), join(cwd, '.agents', 'skills'));
    }
    const extraDirs: Array<{ path: string; scope: 'user' | 'workspace' }> = [];

    // Scope of an extra_skill_dirs entry is decided by the config layer that
    // declares it (user config.toml → user scope; project config.toml →
    // workspace scope) — never by whether the path is absolute.
    const userConfig = await parseKimiConfigToml(join(home, 'config.toml'));
    if (userConfig.malformed) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_MALFORMED',
        message: `${basename(join(home, 'config.toml'))} contains hooks or extra_skill_dirs this Proxy cannot parse.`,
      }]);
    }
    // Relative extra dirs resolve against the declaring config's directory
    // (user config → KIMI_CODE_HOME; project config → the workspace root).
    for (const dir of userConfig.extraSkillDirs) {
      if (extraDirs.length >= MAX_EXTRA_DIRS) break;
      extraDirs.push({ path: resolveExtraSkillDir(dir, dirname(join(home, 'config.toml'))), scope: 'user' });
    }
    let projectConfig: KimiTomlCustomization | null = null;
    if (cwd) {
      projectConfig = await parseKimiConfigToml(join(cwd, '.kimi-code', 'config.toml'));
      if (projectConfig.malformed) {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_MALFORMED',
          message: `${basename(join(cwd, '.kimi-code', 'config.toml'))} contains hooks or extra_skill_dirs this Proxy cannot parse.`,
        }]);
      }
      for (const dir of projectConfig.extraSkillDirs) {
        if (extraDirs.length >= MAX_EXTRA_DIRS) break;
        extraDirs.push({ path: resolveExtraSkillDir(dir, dirname(join(cwd, '.kimi-code', 'config.toml'))), scope: 'workspace' });
      }
    }

    for (const dir of userDirs) {
      const scanned = await this.scanSkillDir(dir, 'user', cwd, diagnostics);
      items.push(...scanned.items);
      if (scanned.capped) addBoundedDiagnostics(diagnostics, [{ code: 'SOURCE_NOT_ENUMERABLE', message: 'Kimi skill scan hit its entry bound; results are partial.' }]);
    }
    for (const dir of projectDirs) {
      const scanned = await this.scanSkillDir(dir, 'workspace', cwd, diagnostics);
      items.push(...scanned.items);
      if (scanned.capped) addBoundedDiagnostics(diagnostics, [{ code: 'SOURCE_NOT_ENUMERABLE', message: 'Kimi skill scan hit its entry bound; results are partial.' }]);
    }
    for (const extra of extraDirs) {
      const scanned = await this.scanSkillDir(extra.path, extra.scope, cwd, diagnostics);
      items.push(...scanned.items);
      if (scanned.capped) addBoundedDiagnostics(diagnostics, [{ code: 'SOURCE_NOT_ENUMERABLE', message: 'Kimi extra skill dir scan hit its entry bound; results are partial.' }]);
    }
    // Plugin-provided skills live behind installed plugin manifests; V1 does
    // not enumerate them.
    if ((await readdirList(join(home, 'plugins'))).length > 0) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_NOT_ENUMERABLE',
        message: 'Plugin-provided skills are not enumerated by this Proxy version.',
      }]);
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
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'configured',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
  }

  // ---- mcp ----------------------------------------------------------------

  private async mcpItemsFromFile(
    path: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<CustomizationItem[]> {
    const items: CustomizationItem[] = [];
    const content = await readBounded(path);
    if (content.state === 'missing') return items;
    if (content.state === 'oversized' || content.state === 'unreadable') {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_UNREADABLE',
        message: `${basename(path)} could not be read within bounds.`,
      }]);
      return items;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data!.toString('utf8'));
    } catch {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_MALFORMED',
        message: `${basename(path)} is not valid JSON.`,
      }]);
      return items;
    }
    const servers = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return items;
    for (const [name, rawServer] of Object.entries(servers as Record<string, unknown>)) {
      if (typeof rawServer !== 'object' || rawServer === null || Array.isArray(rawServer)) continue;
      const server = rawServer as McpServerEntry;
      const transport = typeof server.url === 'string'
        ? (typeof server.transport === 'string' && server.transport.toLowerCase() === 'sse' ? 'sse' : 'http')
        : typeof server.command === 'string'
          ? 'stdio'
          : 'unknown';
      const targetSummary = typeof server.url === 'string'
        ? redactCustomizationTarget(server.url)
        : typeof server.command === 'string'
          ? basename(server.command)
          : undefined;
      const enabled = server.enabled === false ? 'disabled' : 'unknown';
      const id = stableCustomizationId({
        provider: 'kimi',
        kind: 'mcp',
        scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
        canonicalSourceLocator: path,
        nativeIdentity: name,
      });
      this.remember(id, 'mcp', path, name);
      items.push({
        id,
        kind: 'mcp',
        name: truncateUtf8(name, 256),
        nativeType: 'kimi.mcp',
        nativeStatus: 'configured',
        activation: enabled,
        scope: {
          level: scopeLevel,
          ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
        },
        origin: {
          kind: scopeLevel === 'user' ? 'user_file' : 'project_file',
          path,
        },
        discovery: { method: 'config_parse' },
        mcp: {
          transport,
          ...(targetSummary ? { targetSummary } : {}),
        },
      });
    }
    return items;
  }

  private async listMcp(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const userFile = join(kimiHome(), 'mcp.json');
    items.push(...await this.mcpItemsFromFile(userFile, 'user', null, diagnostics));
    if (cwd) {
      const projectFile = join(cwd, '.kimi-code', 'mcp.json');
      items.push(...await this.mcpItemsFromFile(projectFile, 'workspace', cwd, diagnostics));
    }
    if ((await readdirList(join(kimiHome(), 'plugins'))).length > 0) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_NOT_ENUMERABLE',
        message: 'Plugin-provided MCP servers are not enumerated by this Proxy version.',
      }]);
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

  /** Render ONLY the selected MCP server's sanitized configuration — never
   *  the whole file. */
  private async sanitizedMcpView(memory: { path: string; selector?: string }): Promise<string | null> {
    const content = await readBounded(memory.path);
    if (content.state !== 'ok' || content.data === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data.toString('utf8'));
    } catch {
      return null;
    }
    const servers = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    const server = (servers as Record<string, unknown>)[memory.selector ?? ''];
    if (typeof server !== 'object' || server === null || Array.isArray(server)) return null;
    return JSON.stringify(sanitizeMcpServer(server as McpServerEntry), null, 2);
  }

  // ---- hooks --------------------------------------------------------------

  private async hookItemsFromConfig(
    configPath: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<CustomizationItem[]> {
    const config = await parseKimiConfigToml(configPath);
    if (config.malformed) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_MALFORMED',
        message: `${basename(configPath)} contains hooks this Proxy cannot parse.`,
      }]);
    }
    // identical hooks in one source get a stable occurrence ordinal so their
    // ids never collide; unrelated insertions never shift them.
    const occurrenceByKey = new Map<string, number>();
    const items: CustomizationItem[] = [];
    for (const hook of config.hooks) {
      const targetSummary = redactShellCommandText(hook.command);
      const identityKey = [hook.event, hook.matcher ?? '', targetSummary].join('\u0000');
      const occurrence = occurrenceByKey.get(identityKey) ?? 0;
      occurrenceByKey.set(identityKey, occurrence + 1);
      const nativeIdentity = occurrence === 0 ? identityKey : `${identityKey}\u0000#${occurrence}`;
      const id = stableCustomizationId({
        provider: 'kimi',
        kind: 'hook',
        scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
        canonicalSourceLocator: configPath,
        nativeIdentity,
      });
      this.remember(id, 'hook', configPath, nativeIdentity);
      items.push({
        id,
        kind: 'hook',
        name: truncateUtf8(hook.event, 256),
        nativeType: 'kimi.hook.command',
        nativeStatus: 'configured',
        activation: 'unknown',
        scope: {
          level: scopeLevel,
          ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
        },
        origin: {
          kind: scopeLevel === 'user' ? 'user_file' : 'project_file',
          path: configPath,
        },
        discovery: { method: 'config_parse' },
        hook: {
          nativeEvent: truncateUtf8(hook.event, 256),
          ...(hook.matcher ? { matcher: truncateUtf8(hook.matcher, 256) } : {}),
          handler: {
            nativeType: 'command',
            targetSummary: truncateUtf8(targetSummary, 4096),
          },
          // timeoutMs is positive-only on the wire (schema requires int > 0).
          ...(hook.timeout !== undefined && hook.timeout > 0 ? { timeoutMs: hook.timeout } : {}),
        },
      });
    }
    return items;
  }

  private async listHooks(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const userConfig = join(kimiHome(), 'config.toml');
    items.push(...await this.hookItemsFromConfig(userConfig, 'user', null, diagnostics));
    if (cwd) {
      const projectConfig = join(cwd, '.kimi-code', 'config.toml');
      items.push(...await this.hookItemsFromConfig(projectConfig, 'workspace', cwd, diagnostics));
    }
    if ((await readdirList(join(kimiHome(), 'plugins'))).length > 0) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_NOT_ENUMERABLE',
        message: 'Plugin-provided hooks are not enumerated by this Proxy version.',
      }]);
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
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'configured',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
  }

  /** Render ONLY the selected Hook entry's sanitized config — never the
   *  whole file. */
  private async sanitizedHookView(memory: { path: string; selector?: string }): Promise<string | null> {
    const config = await parseKimiConfigToml(memory.path);
    const selector = memory.selector ?? '';
    const [eventPart, matcherPart, commandPart, occurrencePart] = [
      selector.split('\u0000')[0] ?? '',
      selector.split('\u0000')[1] ?? '',
      selector.split('\u0000')[2] ?? '',
      selector.split('\u0000')[3] ?? '',
    ];
    let seen = -1;
    for (const hook of config.hooks) {
      const targetSummary = redactShellCommandText(hook.command);
      if (hook.event !== eventPart) continue;
      if ((hook.matcher ?? '') !== matcherPart) continue;
      if (targetSummary !== commandPart) continue;
      seen += 1;
      const occurrence = occurrencePart.startsWith('#')
        ? Number(occurrencePart.slice(1))
        : Number(occurrencePart || '0');
      if (seen !== occurrence) continue;
      const view: Record<string, unknown> = {
        event: hook.event,
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        command: targetSummary,
        ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
      };
      return JSON.stringify(view, null, 2);
    }
    return null;
  }

  // ---- rules --------------------------------------------------------------

  private async listRules(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const home = kimiHome();
    const genericHome = join(homedir(), '.agents');
    const scanRoot = cwd ? await realpathOrNull(cwd) : null;

    const addFile = async (
      path: string,
      status: 'effective' | 'imported' | 'subtree',
      scopeLevel: 'user' | 'workspace' | 'directory',
      nativeType: string,
      appliesTo?: string,
    ): Promise<void> => {
      const stat = await fsp.lstat(path).catch(() => null);
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
      const truncated = stat.size > DETAIL_TEXT_MAX_BYTES;
      const unreadable = !(await openReadable(path));
      const scopeKey = scopeLevel === 'user'
        ? 'user'
        : scopeLevel === 'directory' && appliesTo
          ? `directory:${appliesTo}`
          : `workspace:${scanRoot ?? ''}`;
      const id = stableCustomizationId({
        provider: 'kimi',
        kind: 'rule',
        scopeKey,
        canonicalSourceLocator: resolve(path),
        nativeIdentity: nativeType,
      });
      this.remember(id, 'rule', path);
      items.push({
        id,
        kind: 'rule',
        name: basename(path),
        nativeType,
        activation: 'enabled',
        scope: {
          level: scopeLevel,
          ...(scopeLevel === 'workspace' && scanRoot ? { root: scanRoot } : {}),
        },
        origin: {
          kind: scopeLevel === 'user' ? 'user_file' : 'project_file',
          path: resolve(path),
        },
        discovery: { method: 'filesystem_scan' },
        ...(unreadable
          ? { warnings: [{ code: 'SOURCE_UNREADABLE' as const, message: 'Item source is not readable.' }] }
          : {}),
        rule: {
          ...(appliesTo ? { appliesTo } : {}),
          status: unreadable ? 'unreadable' : status,
          truncated,
        },
      });
    };

    await addFile(join(home, 'AGENTS.md'), 'effective', 'user', 'kimi.agents');
    await addFile(join(genericHome, 'AGENTS.md'), 'imported', 'user', 'agents.md');
    await addFile(join(homedir(), '.kimi', 'AGENTS.md'), 'imported', 'user', 'kimi.agents.legacy');
    if (scanRoot) {
      await addFile(join(scanRoot, 'AGENTS.md'), 'effective', 'workspace', 'agents.md');
      await addFile(join(scanRoot, '.kimi-code', 'AGENTS.md'), 'imported', 'workspace', 'kimi.agents');
      await addFile(join(scanRoot, '.kimi', 'AGENTS.md'), 'imported', 'workspace', 'kimi.agents.legacy');
      // Nested AGENTS.md instruction files apply under their own directories
      // (complete bounded walk; any cap yields partial + SOURCE_NOT_ENUMERABLE).
      const walked = await walkDirectories(
        scanRoot,
        this.limits.maxScanEntries,
        async (full, stat) => {
          if (!stat.isDirectory()) return;
          if (full === scanRoot) return;
          await addFile(join(full, 'AGENTS.md'), 'subtree', 'directory', 'kimi.agents', relative(scanRoot, full));
        },
        entry => entry === '.git' || entry === 'node_modules' || entry === '.kimi-code' || entry === '.kimi',
      );
      if (walked.capped) {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_NOT_ENUMERABLE',
          message: 'Rule scan stopped at the directory bound; some subtree rules were not enumerated.',
        }]);
      }
    }
    const capped = capItems(items);
    if (capped.truncated) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'INVENTORY_TRUNCATED',
        message: 'Rule inventory exceeded the item limit and was truncated.',
      }]);
    }
    return {
      kind: 'rule',
      status: 'ok',
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'configured',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
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
        timer = setTimeout(() => reject(new ScanTimeoutError(`${timeoutMs}ms`)), timeoutMs);
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

function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  type?: string;
  disableModelInvocation?: boolean;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const out: { name?: string; description?: string; type?: string; disableModelInvocation?: boolean } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) out.name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
    const descriptionMatch = /^description:\s*(.+)$/.exec(line);
    if (descriptionMatch) out.description = descriptionMatch[1]!.trim().replace(/^["']|["']$/g, '');
    const typeMatch = /^type:\s*(.+)$/.exec(line);
    if (typeMatch) out.type = typeMatch[1]!.trim().replace(/^["']|["']$/g, '');
    const disableMatch = /^disableModelInvocation:\s*(.+)$/i.exec(line);
    if (disableMatch) out.disableModelInvocation = disableMatch[1]!.trim() === 'true';
  }
  return out;
}

function sanitizeMcpServer(server: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof server.command === 'string') out.command = server.command;
  if (Array.isArray(server.args)) out.args = redactCredentialArgs(server.args.map(String));
  if (typeof server.url === 'string') out.url = redactCustomizationTarget(server.url);
  if (typeof server.transport === 'string') out.transport = server.transport;
  if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(server.env as Record<string, unknown>)) redacted[key] = '[REDACTED]';
    out.env = redacted;
  }
  if (server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(server.headers as Record<string, unknown>)) redacted[key] = '[REDACTED]';
    out.headers = redacted;
  }
  if (typeof server.cwd === 'string') out.cwd = server.cwd;
  return out;
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

/** Stable ordering: (scope, name, id) always — also when nothing is
 *  truncated — so the wire order is deterministic across refreshes. */
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