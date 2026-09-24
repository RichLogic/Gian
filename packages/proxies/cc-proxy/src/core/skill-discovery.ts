import { promises as fsp, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  stableCustomizationId,
  type CustomizationDiagnostic,
} from '@gian/proxy-protocol';

// ---------------------------------------------------------------------------
// Shared Claude skill / legacy-command discovery.
//
// Both the slash-command surface (slash.ts) and the Customization inventory
// (customization.ts) discover the SAME files — `commands/*.md` legacy
// commands and `skills/<dir>/SKILL.md` agent-skills under the user
// (`$CLAUDE_CONFIG_DIR`, default ~/.claude) and project (<cwd>/.claude)
// roots. This module is the single scan so the two surfaces can never drift
// on membership, naming, or identity:
//
//   - name: frontmatter `name:` wins for agent-skills, the directory name is
//     the fallback; legacy commands are named by their filename stem (Claude
//     invokes them by filename).
//   - description: frontmatter `description:` wins, then the first non-empty,
//     non-heading markdown body line.
//   - customizationId: the exact stable id the inventory reports for the
//     same file (same provider/kind/scopeKey/locator/nativeIdentity inputs).
//
// Discovery is bounded and never follows symlinks, matching the inventory's
// read-only contract (docs/protocol-customization-inventory.md, ADR-0054).
// ---------------------------------------------------------------------------

export const DISCOVERY_MAX_ENTRIES = 500;
const ENTRY_TEXT_MAX_BYTES = 1024 * 1024;

export interface DiscoveredClaudeSkill {
  /** Inventory-canonical name (frontmatter `name:` ?? fallback stem). */
  name: string;
  description?: string;
  /** Absolute path of the source file (SKILL.md or the command .md). */
  entryPath: string;
  format: 'agent-skill' | 'legacy-command';
  /** The same stable id the Customization inventory assigns this file. */
  customizationId: string;
}

export interface ClaudeSkillDiscoveryOptions {
  /** Directory-entry bound per scanned directory (inventory default 500). */
  maxEntries?: number;
  /** Bounded diagnostic sink; omit to drop diagnostics (slash path). */
  reportDiagnostic?: (diagnostic: CustomizationDiagnostic) => void;
}

/** The user-level Claude root honors CLAUDE_CONFIG_DIR exactly like the
 *  inventory scanner (and the Claude CLI itself). */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function scopeKey(scopeLevel: 'user' | 'workspace', cwd: string | null): string {
  return scopeLevel === 'user' ? 'user' : `workspace:${cwd ?? ''}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return value.slice(0, end);
}

// ---------------------------------------------------------------------------
// YAML frontmatter
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Minimal frontmatter extraction shared by both surfaces: flat `name:` and
 *  `description:` keys, surrounding quotes stripped. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = FRONTMATTER_RE.exec(content);
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

/** First non-empty, non-heading line of the markdown body after frontmatter.
 *  Lines starting with `#` are headings and are skipped. */
export function fallbackDescription(content: string): string {
  const body = FRONTMATTER_RE.test(content)
    ? content.replace(FRONTMATTER_RE, '').trimStart()
    : content;
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Bounded reads (symlink-refusing, matching the inventory's read policy)
// ---------------------------------------------------------------------------

type FileContent =
  | { state: 'ok'; text: string }
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'oversized' };

async function readEntry(path: string): Promise<FileContent> {
  try {
    const stat = await fsp.lstat(path);
    // Never follow symlinks: a link is not the Provider's declared file.
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'missing' };
    if (stat.size > ENTRY_TEXT_MAX_BYTES) return { state: 'oversized' };
    return { state: 'ok', text: await fsp.readFile(path, 'utf8') };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'missing' } : { state: 'unreadable' };
  }
}

async function listEntries(dir: string): Promise<string[] | null> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return null;
  }
}

function boundedEntries(
  entries: string[],
  options: ClaudeSkillDiscoveryOptions,
  overflowMessage: string,
): string[] {
  const maxEntries = options.maxEntries ?? DISCOVERY_MAX_ENTRIES;
  if (entries.length > maxEntries) {
    options.reportDiagnostic?.({ code: 'SOURCE_NOT_ENUMERABLE', message: overflowMessage });
  }
  return entries.slice(0, maxEntries);
}

function skillId(
  scopeLevel: 'user' | 'workspace',
  cwd: string | null,
  entryPath: string,
  name: string,
): string {
  return stableCustomizationId({
    provider: 'claude',
    kind: 'skill',
    scopeKey: scopeKey(scopeLevel, cwd),
    canonicalSourceLocator: resolve(entryPath),
    nativeIdentity: name,
  });
}

// ---------------------------------------------------------------------------
// Agent-skills: <root>/skills/<dir>/SKILL.md
// ---------------------------------------------------------------------------

export async function discoverAgentSkills(
  root: string,
  scopeLevel: 'user' | 'workspace',
  cwd: string | null,
  options: ClaudeSkillDiscoveryOptions = {},
): Promise<DiscoveredClaudeSkill[]> {
  const entries = await listEntries(join(root, 'skills'));
  if (entries === null) return [];
  const discovered: DiscoveredClaudeSkill[] = [];
  for (const entry of boundedEntries(entries, options, 'Skill directory exceeded the entry bound; some skills were not enumerated.')) {
    const skillDir = join(root, 'skills', entry);
    let stat: Stats;
    try {
      stat = await fsp.lstat(skillDir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const entryPath = join(skillDir, 'SKILL.md');
    const content = await readEntry(entryPath);
    if (content.state === 'oversized' || content.state === 'unreadable') {
      options.reportDiagnostic?.({
        code: 'SOURCE_UNREADABLE',
        message: `Skill ${truncateUtf8(entry, 200)} entry could not be read within bounds.`,
      });
      continue;
    }
    if (content.state !== 'ok') continue;
    const frontmatter = parseSkillFrontmatter(content.text);
    const name = truncateUtf8(frontmatter.name ?? entry, 256);
    discovered.push({
      name,
      ...(frontmatter.description ? { description: truncateUtf8(frontmatter.description, 4096) } : {}),
      entryPath,
      format: 'agent-skill',
      customizationId: skillId(scopeLevel, cwd, entryPath, name),
    });
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// Legacy commands: <root>/commands/*.md
// Files starting with `_` are drafts and are skipped on both surfaces.
// ---------------------------------------------------------------------------

export async function discoverLegacyCommands(
  root: string,
  scopeLevel: 'user' | 'workspace',
  cwd: string | null,
  options: ClaudeSkillDiscoveryOptions = {},
): Promise<DiscoveredClaudeSkill[]> {
  const entries = await listEntries(join(root, 'commands'));
  if (entries === null) return [];
  const discovered: DiscoveredClaudeSkill[] = [];
  for (const entry of boundedEntries(entries, options, 'Command directory exceeded the entry bound; some commands were not enumerated.')) {
    if (!entry.endsWith('.md')) continue;
    if (entry.startsWith('_')) continue;
    const entryPath = join(root, 'commands', entry);
    const content = await readEntry(entryPath);
    if (content.state !== 'ok') continue;
    const name = truncateUtf8(entry.slice(0, -3), 256);
    const description = parseSkillFrontmatter(content.text).description
      ?? fallbackDescription(content.text);
    discovered.push({
      name,
      ...(description ? { description: truncateUtf8(description, 4096) } : {}),
      entryPath,
      format: 'legacy-command',
      customizationId: skillId(scopeLevel, cwd, entryPath, name),
    });
  }
  return discovered;
}
