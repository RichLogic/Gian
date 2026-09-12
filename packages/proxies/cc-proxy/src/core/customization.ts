import { promises as fsp, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

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
const DEFAULT_STATE_FILE = '.claude.json';
const DEFAULT_SETTINGS_FILE = 'settings.json';
const SETTINGS_LOCAL_FILE = 'settings.local.json';
const DETAIL_TEXT_MAX_BYTES = 1024 * 1024;
const RULES_DIAGNOSTIC_CAP = 50;

export interface ClaudeScanLimits {
  /** Total entries (files + directories) a single directory walk may lstat
   *  before the walk is called partial and reports SOURCE_NOT_ENUMERABLE. */
  maxScanEntries: number;
  /** Hard wall-clock bound for one list/detail inspection. */
  timeoutMs: number;
}

const DEFAULT_LIMITS: ClaudeScanLimits = {
  maxScanEntries: SCAN_MAX_ENTRIES,
  timeoutMs: SCAN_TIMEOUT_MS,
};

interface ClaudeHookEntry {
  type?: unknown;
  command?: unknown;
  url?: unknown;
  timeout?: unknown;
}

interface ClaudeHookMatcher {
  matcher?: unknown;
  hooks?: unknown;
}

type FileState =
  | { state: 'ok'; data: Buffer }
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'oversized' };

function isMissingError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Bounded config read that distinguishes real states: missing files are an
 *  ok+configured vacuum, while oversized/unreadable files are partial facts. */
async function readBounded(path: string, maxBytes = MAX_CONFIG_FILE_BYTES): Promise<FileState> {
  try {
    const stat = await fsp.lstat(path);
    // Never follow symlinks: a link is not the Provider's declared file.
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'missing' };
    if (stat.size > maxBytes) return { state: 'oversized' };
    return { state: 'ok', data: await fsp.readFile(path) };
  } catch (error) {
    return { state: isMissingError(error) ? 'missing' : 'unreadable' };
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

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fsp.realpath(path);
  } catch {
    return null;
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
    if (target.length >= RULES_DIAGNOSTIC_CAP) return;
    target.push(diagnostic);
  }
}

/** Iterative directory walk with bounded concurrency. Symlinks are never
 *  followed (lstat + skip), so a scan cannot escape its root along a link.
 *  When `maxEntries` entries have been visited the walk stops visiting new
 *  entries and reports `capped`; discovered-but-unvisited content is
 *  intentionally not enumerated. */
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

/** Complete bounded instruction-file discovery under `root`: every directory
 *  is visited (no fixed depth), symlinks never followed, and the walk
 *  reports capped when the entry bound is hit. */
async function findInstructionFiles(
  root: string,
  limits: ClaudeScanLimits,
  visit: (fullPath: string, stat: Stats) => Promise<void> | void,
): Promise<{ capped: boolean }> {
  return walkDirectories(
    root,
    limits.maxScanEntries,
    visit,
    entry => entry === '.git' || entry === 'node_modules' || entry === '.claude',
  );
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function userStateFilePath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, DEFAULT_STATE_FILE)
    : join(homedir(), DEFAULT_STATE_FILE);
}

/** Real `@AGENTS.md` import detection over the Provider-documented docs
 *  (CLAUDE.md / CLAUDE.local.md) that Claude actually loads. */
export function claudeImportsAgentsMd(content: string): boolean {
  return /^[ \t]*@AGENTS(?:\.md)?[ \t]*$/m.test(content);
}

/** Parse the optional `paths:` frontmatter of a Claude rules file. Rules with
 *  declared paths apply only under those paths and must never be reported as
 *  broadly effective. */
function claudeRulePaths(content: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return [];
  const lines = match[1]!.split(/\r?\n/);
  for (const line of lines) {
    const paths = /^paths:\s*(.+)$/.exec(line.trim());
    if (!paths) continue;
    const body = paths[1]!.trim();
    const list = body.startsWith('[') && body.endsWith(']')
      ? body.slice(1, -1).split(',')
      : [body];
    return list
      .map(entry => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(entry => entry.length > 0);
  }
  return [];
}

export class ClaudeCustomizationScanner {
  /** id → non-sensitive item locator for lazy per-item detail resolution.
   *  Bounded and in-memory only; never persisted, never logged. */
  private readonly listMemory = new Map<string, {
    kind: string;
    path: string;
    /** Exact item selector inside the source (server name / hook identity). */
    selector?: string;
  }>();
  private readonly limits: ClaudeScanLimits;

  constructor(options?: { limits?: Partial<ClaudeScanLimits> }) {
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
        return unavailableDetail(kind, id, 'PROVIDER_INSPECTION_FAILED', 'Item source is no longer resolvable.');
      }
      if (kind === 'mcp') {
        const text = await this.sanitizedMcpView(memory);
        if (text === null) {
          return unavailableDetail(kind, id, 'SOURCE_UNREADABLE', 'Item source could not be read.');
        }
        return { kind, id, status: 'ok', observedAt: new Date().toISOString(), text, truncated: false };
      }
      if (kind === 'hook') {
        const text = await this.sanitizedHookView(memory);
        if (text === null) {
          return unavailableDetail(kind, id, 'SOURCE_UNREADABLE', 'Item source could not be read.');
        }
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

  private async skillItemsFromRoot(
    root: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<CustomizationItem[]> {
    const items: CustomizationItem[] = [];
    const itemsBase = join(root, 'skills');
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(itemsBase);
    } catch {
      return items;
    }
    if (entries.length > this.limits.maxScanEntries) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_NOT_ENUMERABLE',
        message: 'Skill directory exceeded the entry bound; some skills were not enumerated.',
      }]);
    }
    for (const entry of entries.slice(0, this.limits.maxScanEntries)) {
      const skillDir = join(itemsBase, entry);
      let stat: Stats | null = null;
      try {
        stat = await fsp.lstat(skillDir);
      } catch {
        continue;
      }
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const entryPath = join(skillDir, 'SKILL.md');
      const content = await readBounded(entryPath, DETAIL_TEXT_MAX_BYTES);
      if (content.state === 'oversized' || content.state === 'unreadable') {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_UNREADABLE',
          message: `Skill ${truncateUtf8(entry, 200)} entry could not be read within bounds.`,
        }]);
        continue;
      }
      if (content.state !== 'ok') continue;
      const frontmatter = parseSkillFrontmatter(content.data.toString('utf8'));
      const name = truncateUtf8(frontmatter.name ?? entry, 256);
      const description = frontmatter.description
        ? truncateUtf8(frontmatter.description, 4096)
        : undefined;
      const id = stableCustomizationId({
        provider: 'claude',
        kind: 'skill',
        scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
        canonicalSourceLocator: resolve(entryPath),
        nativeIdentity: name,
      });
      this.remember(id, 'skill', entryPath);
      items.push({
        id,
        kind: 'skill',
        name,
        ...(description ? { description } : {}),
        nativeType: 'claude.agent-skill',
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
          modelInvocable: false,
        },
      });
    }
    return items;
  }

  private async commandItemsFromRoot(
    root: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<CustomizationItem[]> {
    const items: CustomizationItem[] = [];
    const commandsBase = join(root, 'commands');
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(commandsBase);
    } catch {
      return items;
    }
    if (entries.length > this.limits.maxScanEntries) {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_NOT_ENUMERABLE',
        message: 'Command directory exceeded the entry bound; some commands were not enumerated.',
      }]);
    }
    for (const entry of entries.slice(0, this.limits.maxScanEntries)) {
      if (!entry.endsWith('.md')) continue;
      const entryPath = join(commandsBase, entry);
      const content = await readBounded(entryPath, DETAIL_TEXT_MAX_BYTES);
      if (content.state !== 'ok') continue;
      const name = truncateUtf8(entry.slice(0, -3), 256);
      const description = firstNonEmptyLine(content.data.toString('utf8'));
      const id = stableCustomizationId({
        provider: 'claude',
        kind: 'skill',
        scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
        canonicalSourceLocator: resolve(entryPath),
        nativeIdentity: name,
      });
      this.remember(id, 'skill', entryPath);
      items.push({
        id,
        kind: 'skill',
        name,
        ...(description ? { description: truncateUtf8(description, 4096) } : {}),
        nativeType: 'claude.legacy-command',
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
          format: 'legacy-command',
          entryPath,
          invocation: `/${name}`,
          userInvocable: true,
          modelInvocable: false,
        },
      });
    }
    return items;
  }

  private async listSkills(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const userRoot = claudeDir();
    items.push(...await this.skillItemsFromRoot(userRoot, 'user', null, diagnostics));
    items.push(...await this.commandItemsFromRoot(userRoot, 'user', null, diagnostics));
    if (cwd) {
      const projectRoot = join(cwd, '.claude');
      items.push(...await this.skillItemsFromRoot(projectRoot, 'workspace', cwd, diagnostics));
      items.push(...await this.commandItemsFromRoot(projectRoot, 'workspace', cwd, diagnostics));
    }
    // Plugin-managed skills/hooks/MCP exist but are not enumerated in V1.
    if (await readdirCount(join(userRoot, 'plugins')) > 0
      || (cwd !== null && await readdirCount(join(cwd, '.claude', 'plugins')) > 0)) {
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

  private async addClaudeRuleFile(
    items: CustomizationItem[],
    path: string,
    status: 'effective' | 'imported' | 'subtree' | 'inactive',
    scopeLevel: 'user' | 'workspace' | 'directory',
    cwd: string | null,
    appliesTo?: string,
  ): Promise<void> {
    let stat: Stats | null = null;
    try {
      stat = await fsp.lstat(path);
    } catch {
      return;
    }
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
    const truncated = stat.size > DETAIL_TEXT_MAX_BYTES;
    const unreadable = !(await openReadable(path));
    const fileName = basename(path).toLowerCase();
    const nativeType = fileName === 'claude.md'
      ? 'claude.md'
      : fileName === 'agents.md'
        ? 'agents.md'
        : 'claude.rules';
    const scopeKey = scopeLevel === 'user'
      ? 'user'
      : scopeLevel === 'directory' && appliesTo
        ? `directory:${appliesTo}`
        : `workspace:${cwd ?? ''}`;
    const id = stableCustomizationId({
      provider: 'claude',
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
      activation: status === 'inactive' ? 'disabled' : 'enabled',
      scope: {
        level: scopeLevel,
        ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
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
        ...(appliesTo && status === 'subtree' ? { appliesTo } : {}),
        status: unreadable ? 'unreadable' : status,
        truncated,
      },
    });
  }

  private async listRules(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    const userRoot = claudeDir();
    const scanRoot = cwd ? await realpathOrNull(cwd) : null;

    const addRuleDir = async (
      dir: string,
      scopeLevel: 'user' | 'workspace',
    ): Promise<void> => {
      const walkResult = await walkDirectories(
        dir,
        this.limits.maxScanEntries,
        async (full, stat) => {
          if (!stat.isFile() || !full.toLowerCase().endsWith('.md')) return;
          const content = await readBounded(full, MAX_CONFIG_FILE_BYTES);
          const paths = content.state === 'ok' ? claudeRulePaths(content.data.toString('utf8')) : [];
          // Rules with declared `paths:` apply under those paths only — they
          // are never broadly effective.
          if (paths.length > 0) {
            await this.addClaudeRuleFile(items, full, 'subtree', scopeLevel, cwd, paths[0]!);
          } else {
            await this.addClaudeRuleFile(items, full, 'effective', scopeLevel, cwd);
          }
        },
        entry => entry.startsWith('.'),
      );
      if (walkResult.capped) {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_NOT_ENUMERABLE',
          message: 'Rules scan stopped at the entry bound; some rules were not enumerated.',
        }]);
      }
    };

    const addUserDocs = async (): Promise<void> => {
      const imports: string[] = [];
      for (const doc of ['CLAUDE.md', 'CLAUDE.local.md']) {
        const docPath = join(userRoot, doc);
        const content = await readBounded(docPath, MAX_CONFIG_FILE_BYTES);
        if (content.state === 'ok') imports.push(content.data.toString('utf8'));
      }
      const imported = imports.some(claudeImportsAgentsMd);
      await this.addClaudeRuleFile(items, join(userRoot, 'CLAUDE.md'), 'effective', 'user', null);
      await this.addClaudeRuleFile(items, join(userRoot, 'CLAUDE.local.md'), 'effective', 'user', null);
      await this.addClaudeRuleFile(
        items,
        join(userRoot, 'AGENTS.md'),
        imported ? 'imported' : 'inactive',
        'user',
        null,
      );
    };

    await addUserDocs();
    await addRuleDir(join(userRoot, 'rules'), 'user');

    if (scanRoot) {
      const wsImports: string[] = [];
      for (const doc of [
        join(scanRoot, 'CLAUDE.md'),
        join(scanRoot, 'CLAUDE.local.md'),
        join(scanRoot, '.claude', 'CLAUDE.md'),
        join(scanRoot, '.claude', 'CLAUDE.local.md'),
      ]) {
        const content = await readBounded(doc, MAX_CONFIG_FILE_BYTES);
        if (content.state === 'ok') wsImports.push(content.data.toString('utf8'));
      }
      const wsImported = wsImports.some(claudeImportsAgentsMd);
      await this.addClaudeRuleFile(items, join(scanRoot, 'CLAUDE.md'), 'effective', 'workspace', scanRoot);
      await this.addClaudeRuleFile(items, join(scanRoot, 'CLAUDE.local.md'), 'effective', 'workspace', scanRoot);
      await this.addClaudeRuleFile(items, join(scanRoot, '.claude', 'CLAUDE.md'), 'effective', 'workspace', scanRoot);
      await this.addClaudeRuleFile(items, join(scanRoot, '.claude', 'CLAUDE.local.md'), 'effective', 'workspace', scanRoot);
      await this.addClaudeRuleFile(
        items,
        join(scanRoot, 'AGENTS.md'),
        wsImported ? 'imported' : 'inactive',
        'workspace',
        scanRoot,
      );
      await addRuleDir(join(scanRoot, '.claude', 'rules'), 'workspace');
      // Nested CLAUDE.md / CLAUDE.local.md instruction files apply under
      // their own directories (complete bounded walk; cap yields partial).
      const subtree = await findInstructionFiles(scanRoot, this.limits, async (full, stat) => {
        if (!stat.isFile()) return;
        const rel = relative(scanRoot, full);
        if (rel === 'CLAUDE.md' || rel === 'CLAUDE.local.md') return;
        const lower = basename(full).toLowerCase();
        if (lower !== 'claude.md' && lower !== 'claude.local.md') return;
        await this.addClaudeRuleFile(items, full, 'subtree', 'directory', scanRoot, rel);
      });
      if (subtree.capped) {
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

  private async mcpItemsFromFile(
    statePath: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<CustomizationItem[]> {
    const items: CustomizationItem[] = [];
    const content = await readBounded(statePath);
    if (content.state === 'missing') return items;
    if (content.state === 'oversized' || content.state === 'unreadable') {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_UNREADABLE',
        message: `${basename(statePath)} could not be read within bounds.`,
      }]);
      return items;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data.toString('utf8'));
    } catch {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_MALFORMED',
        message: `${basename(statePath)} is not valid JSON.`,
      }]);
      return items;
    }
    const mcpServers = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
    if (mcpServers === undefined || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      return items;
    }
    for (const [name, rawConfig] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) {
        addBoundedDiagnostics(diagnostics, [{
          code: 'SOURCE_MALFORMED',
          message: `MCP server ${truncateUtf8(name, 200)} has a malformed configuration.`,
        }]);
        continue;
      }
      const config = rawConfig as Record<string, unknown>;
      const transportType = typeof config.type === 'string' ? config.type.toLowerCase() : '';
      const transport = transportType === 'http' || transportType === 'sse'
        ? (transportType as 'http' | 'sse')
        : typeof config.command === 'string'
          ? 'stdio'
          : 'unknown';
      const targetSummary = typeof config.url === 'string'
        ? redactCustomizationTarget(config.url)
        : typeof config.command === 'string'
          ? basename(config.command)
          : undefined;
      const id = stableCustomizationId({
        provider: 'claude',
        kind: 'mcp',
        scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
        canonicalSourceLocator: statePath,
        nativeIdentity: name,
      });
      this.remember(id, 'mcp', statePath, name);
      items.push({
        id,
        kind: 'mcp',
        name: truncateUtf8(name, 256),
        nativeType: 'claude.mcp',
        nativeStatus: 'configured',
        activation: 'unknown',
        scope: {
          level: scopeLevel,
          ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
        },
        origin: {
          kind: scopeLevel === 'user' ? 'user_file' : 'project_file',
          path: statePath,
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
    // User scope: the official default location is ~/.claude.json (it moves
    // under CLAUDE_CONFIG_DIR only when that variable is set).
    items.push(...await this.mcpItemsFromFile(userStateFilePath(), 'user', null, diagnostics));
    if (cwd) {
      // Project scope: the official shared .mcp.json plus the Claude
      // settings layers (which accept mcpServers). Never cwd/.claude.json.
      for (const layer of ['.mcp.json', join('.claude', DEFAULT_SETTINGS_FILE), join('.claude', SETTINGS_LOCAL_FILE)]) {
        items.push(...await this.mcpItemsFromFile(join(cwd, layer), 'workspace', cwd, diagnostics));
      }
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

  private async hookItemsFromFile(
    settingsPath: string,
    scopeLevel: 'user' | 'workspace',
    cwd: string | null,
    diagnostics: CustomizationDiagnostic[],
  ): Promise<CustomizationItem[]> {
    const items: CustomizationItem[] = [];
    const content = await readBounded(settingsPath);
    if (content.state === 'missing') return items;
    if (content.state === 'oversized' || content.state === 'unreadable') {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_UNREADABLE',
        message: `${basename(settingsPath)} could not be read within bounds.`,
      }]);
      return items;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data.toString('utf8'));
    } catch {
      addBoundedDiagnostics(diagnostics, [{
        code: 'SOURCE_MALFORMED',
        message: `${basename(settingsPath)} is not valid JSON.`,
      }]);
      return items;
    }
    const hooks = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).hooks
      : undefined;
    if (hooks === undefined || typeof hooks !== 'object' || Array.isArray(hooks)) {
      return items;
    }
    // Flatten every handler first so identical handlers in the same source
    // get a stable occurrence ordinal: an unrelated handler inserted before
    // them never shifts their ids.
    const flattened: Array<{
      event: string;
      matcher: string;
      handlerType: 'command' | 'http' | 'prompt';
      targetSummary: string;
      entry: ClaudeHookEntry;
      identityKey: string;
    }> = [];
    for (const [event, rawMatchers] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(rawMatchers)) continue;
      for (const rawMatcher of rawMatchers) {
        if (typeof rawMatcher !== 'object' || rawMatcher === null || Array.isArray(rawMatcher)) continue;
        const matcherEntry = rawMatcher as ClaudeHookMatcher;
        const matcher = typeof matcherEntry.matcher === 'string' ? matcherEntry.matcher : '';
        const hookEntries = Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : [];
        for (const hookEntry of hookEntries) {
          if (typeof hookEntry !== 'object' || hookEntry === null || Array.isArray(hookEntry)) continue;
          const entry = hookEntry as ClaudeHookEntry;
          const handlerType = entry.type === 'command' ? 'command' as const : entry.type === 'http' ? 'http' as const : 'prompt' as const;
          const commandText = typeof entry.command === 'string' ? entry.command : undefined;
          const urlText = typeof entry.url === 'string' ? entry.url : undefined;
          const targetSummary = handlerType === 'command' && commandText
            ? redactShellCommandText(commandText)
            : handlerType === 'http' && urlText
              ? `${redactCustomizationTarget(urlText)} (http)`
              : handlerType === 'http'
                ? 'http handler'
                : handlerType === 'command'
                  ? 'command handler'
                  : 'prompt handler';
          flattened.push({
            event,
            matcher,
            handlerType,
            targetSummary,
            entry,
            identityKey: [event, matcher, handlerType, targetSummary].join('\u0000'),
          });
        }
      }
    }
    const occurrenceByKey = new Map<string, number>();
    for (const flat of flattened) {
      const occurrence = occurrenceByKey.get(flat.identityKey) ?? 0;
      occurrenceByKey.set(flat.identityKey, occurrence + 1);
      const nativeIdentity = occurrence === 0
        ? flat.identityKey
        : `${flat.identityKey}\u0000#${occurrence}`;
      const selector = nativeIdentity;
      const id = stableCustomizationId({
        provider: 'claude',
        kind: 'hook',
        scopeKey: scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`,
        canonicalSourceLocator: settingsPath,
        nativeIdentity,
      });
      this.remember(id, 'hook', settingsPath, selector);
      const timeoutMs = typeof flat.entry.timeout === 'number' && Number.isFinite(flat.entry.timeout)
        ? Math.round(flat.entry.timeout)
        : 0;
      items.push({
        id,
        kind: 'hook',
        name: truncateUtf8(flat.event, 256),
        nativeType: `claude.hook.${flat.handlerType}`,
        nativeStatus: 'configured',
        activation: 'unknown',
        scope: {
          level: scopeLevel,
          ...(scopeLevel === 'workspace' && cwd ? { root: cwd } : {}),
        },
        origin: {
          kind: scopeLevel === 'user' ? 'user_file' : 'project_file',
          path: settingsPath,
        },
        discovery: { method: 'config_parse' },
        hook: {
          nativeEvent: truncateUtf8(flat.event, 256),
          ...(flat.matcher ? { matcher: truncateUtf8(flat.matcher, 256) } : {}),
          handler: {
            nativeType: flat.handlerType,
            targetSummary: truncateUtf8(flat.targetSummary, 4096),
          },
          // timeoutMs is positive-only on the wire (schema requires int > 0).
          ...(timeoutMs > 0 ? { timeoutMs } : {}),
        },
      });
    }
    return items;
  }

  private async listHooks(cwd: string | null): Promise<CustomizationListResult> {
    const diagnostics: CustomizationDiagnostic[] = [];
    const items: CustomizationItem[] = [];
    items.push(...await this.hookItemsFromFile(join(claudeDir(), DEFAULT_SETTINGS_FILE), 'user', null, diagnostics));
    if (cwd) {
      const projectRoot = join(cwd, '.claude');
      for (const file of [DEFAULT_SETTINGS_FILE, SETTINGS_LOCAL_FILE]) {
        items.push(...await this.hookItemsFromFile(join(projectRoot, file), 'workspace', cwd, diagnostics));
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
      completeness: capped.truncated || diagnostics.length > 0 ? 'partial' : 'configured',
      observedAt: new Date().toISOString(),
      items: capped.kept,
      truncated: capped.truncated,
      diagnostics,
    };
  }

  /** Render ONLY the selected MCP server's sanitized configuration — never
   *  the whole file. */
  private async sanitizedMcpView(memory: {
    path: string;
    selector?: string;
  }): Promise<string | null> {
    const content = await readBounded(memory.path);
    if (content.state !== 'ok') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const servers = (parsed as Record<string, unknown>).mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    const name = memory.selector ?? '';
    const config = (servers as Record<string, unknown>)[name];
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
    return JSON.stringify(sanitizeMcpServerConfig(config as Record<string, unknown>), null, 2);
  }

  /** Render ONLY the selected Hook handler's sanitized entry with its
   *  event/matcher context — never the whole settings file. */
  private async sanitizedHookView(memory: {
    path: string;
    selector?: string;
  }): Promise<string | null> {
    const content = await readBounded(memory.path);
    if (content.state !== 'ok') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.data.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const hooks = (parsed as Record<string, unknown>).hooks;
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return null;
    const selector = memory.selector ?? '';
    const [event, matcherPart, handlerTypePart, targetPart, occurrencePart] = [
      selector.split('\u0000')[0] ?? '',
      selector.split('\u0000')[1] ?? '',
      selector.split('\u0000')[2] ?? '',
      selector.split('\u0000')[3] ?? '',
      selector.split('\u0000')[4] ?? '',
    ];
    let seen = -1;
    for (const [rawEvent, rawMatchers] of Object.entries(hooks as Record<string, unknown>)) {
      if (rawEvent !== event) continue;
      if (!Array.isArray(rawMatchers)) continue;
      for (const rawMatcher of rawMatchers) {
        if (typeof rawMatcher !== 'object' || rawMatcher === null || Array.isArray(rawMatcher)) continue;
        const matcher = typeof rawMatcher.matcher === 'string' ? rawMatcher.matcher : '';
        if (matcher !== matcherPart) continue;
        for (const hook of Array.isArray(rawMatcher.hooks) ? rawMatcher.hooks : []) {
          if (typeof hook !== 'object' || hook === null || Array.isArray(hook)) continue;
          const entry = hook as ClaudeHookEntry;
          const handlerType = entry.type === 'command' ? 'command' : entry.type === 'http' ? 'http' : 'prompt';
          if (handlerType !== handlerTypePart) continue;
          const commandText = typeof entry.command === 'string' ? entry.command : undefined;
          const urlText = typeof entry.url === 'string' ? entry.url : undefined;
          const targetSummary = handlerType === 'command' && commandText
            ? redactShellCommandText(commandText)
            : handlerType === 'http' && urlText
              ? `${redactCustomizationTarget(urlText)} (http)`
              : handlerType === 'http'
                ? 'http handler'
                : handlerType === 'command'
                  ? 'command handler'
                  : 'prompt handler';
          if (targetSummary !== targetPart) continue;
          seen += 1;
          const occurrence = occurrencePart.startsWith('#')
            ? Number(occurrencePart.slice(1))
            : Number(occurrencePart || '0');
          if (seen !== occurrence) continue;
          const view: Record<string, unknown> = {
            event,
            ...(matcher ? { matcher } : {}),
            hooks: [sanitizeClaudeHookEntry(entry)],
          };
          return JSON.stringify(view, null, 2);
        }
      }
    }
    return null;
  }
}

/** Bounded directory listing count used for plugin-presence probes. */
async function readdirCount(path: string): Promise<number> {
  try {
    const stat = await fsp.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 0;
    return (await fsp.readdir(path)).length;
  } catch {
    return 0;
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
          new ScanTimeoutError(`scan exceeded ${timeoutMs}ms.`),
        ), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Internal marker: list/detail timeouts surface as unavailable at the
 *  adapter boundary (see service.ts). */
export class ScanTimeoutError extends Error {}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) out.name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
    const descriptionMatch = /^description:\s*(.+)$/.exec(line);
    if (descriptionMatch) out.description = descriptionMatch[1]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function firstNonEmptyLine(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return line?.trim();
}

function sanitizeMcpServerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof config.type === 'string') out.type = config.type;
  if (typeof config.command === 'string') out.command = config.command;
  if (Array.isArray(config.args)) out.args = redactCredentialArgs(config.args.map(String));
  if (typeof config.url === 'string') out.url = redactCustomizationTarget(config.url);
  if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(config.env as Record<string, unknown>)) redacted[key] = '[REDACTED]';
    out.env = redacted;
  }
  if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(config.headers as Record<string, unknown>)) redacted[key] = '[REDACTED]';
    out.headers = redacted;
  }
  if (typeof config.cwd === 'string') out.cwd = config.cwd;
  return out;
}

function sanitizeClaudeHookEntry(entry: ClaudeHookEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof entry.type === 'string' && entry.type) out.type = entry.type;
  if (typeof entry.command === 'string' && entry.command) {
    out.command = redactShellCommandText(entry.command);
  }
  if (typeof entry.url === 'string' && entry.url) {
    out.url = redactCustomizationTarget(entry.url);
  }
  if (typeof entry.timeout === 'number') out.timeout = entry.timeout;
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