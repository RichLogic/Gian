import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

import type { SlashCommand, SlashCommandSource } from '@gian/shared';

// ---------------------------------------------------------------------------
// Native commands
//
// The authoritative native/plugin list is the `slash_commands` array on
// Claude CLI's `init` event (see `probeSlashCommands`), but collecting it
// requires `claude -p`. Default production listing avoids that billing path
// and only scans local command files; tests and explicit callers can inject
// a probe when they really want native discovery.
//
// The map below is descriptions-only — when probe returns a name, we look it
// up here for human-readable text. Names not in this map still appear (with
// the name as the description) so plugin/skill commands aren't dropped.
// ---------------------------------------------------------------------------

interface NativeMeta {
  description: string;
  argHints?: SlashCommand['argHints'];
}

const NATIVE_DESCRIPTIONS: Record<string, NativeMeta> = {
  clear: {
    description: 'Reset the conversation. Gian rotates the underlying Claude session id, so the next message starts fresh.',
  },
  compact: {
    description: 'Summarise earlier turns into a compact form on disk. Future turns load the compacted history.',
  },
  context: {
    description: 'Show current token usage broken down by category.',
  },
  init: {
    description: 'Generate a CLAUDE.md for this project based on the codebase.',
  },
  review: {
    description: 'Review the current diff or a specific PR / file.',
    argHints: [{ kind: 'free', placeholder: 'file path or PR # (optional)' }],
  },
  'security-review': {
    description: 'Run a security-focused review of pending changes on the current branch.',
  },
  insights: {
    description: 'Show your local Claude Code usage report.',
  },
  usage: {
    description: 'Show recent token / cost usage.',
  },
  'extra-usage': {
    description: 'Show extended usage details and rate-limit state.',
  },
  'team-onboarding': {
    description: 'Generate a team onboarding guide based on your usage.',
  },
  heapdump: {
    description: 'Capture a Node heap snapshot for debugging.',
  },
};

/** Build a SlashCommand entry from a probe-discovered name. */
function nativeToSlashCommand(rawName: string): SlashCommand {
  const name = rawName.startsWith('/') ? rawName : `/${rawName}`;
  const key = rawName.replace(/^\//, '');
  const meta = NATIVE_DESCRIPTIONS[key];
  return {
    name,
    description: meta?.description ?? name,
    source: 'builtin',
    argHints: meta?.argHints ?? [],
  };
}

// ---------------------------------------------------------------------------
// YAML frontmatter regex
// Captures the block between the first `---` line and the closing `---` line.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_DESCRIPTION_RE = /^description\s*:\s*(.+)$/m;

/**
 * Parse the `description` field from YAML frontmatter.
 * Returns undefined when frontmatter is absent or has no description key.
 */
function parseFrontmatterDescription(content: string): string | undefined {
  const fmMatch = FRONTMATTER_RE.exec(content);
  if (!fmMatch) return undefined;
  const block = fmMatch[1];
  if (!block) return undefined;
  const descMatch = FRONTMATTER_DESCRIPTION_RE.exec(block);
  if (!descMatch) return undefined;
  return descMatch[1]?.trim() || undefined;
}

/**
 * Return the first non-empty, non-heading line of the markdown body (after
 * frontmatter).  Lines that start with one or more `#` characters are
 * headings and are skipped.
 */
function fallbackDescription(content: string): string {
  // Strip frontmatter block if present.
  const body = FRONTMATTER_RE.test(content)
    ? content.replace(FRONTMATTER_RE, '').trimStart()
    : content;

  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;          // skip blank lines
    if (trimmed.startsWith('#')) continue;  // skip headings
    return trimmed;
  }
  return '';
}

// ---------------------------------------------------------------------------
// scanCommandsDir
// ---------------------------------------------------------------------------

/**
 * Scan a `commands/` directory for *.md custom commands.
 * Files starting with `_` are treated as drafts and skipped.
 */
export function scanCommandsDir(dir: string, source: SlashCommandSource): SlashCommand[] {
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const commands: SlashCommand[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    if (entry.startsWith('_')) continue;

    const filePath = join(dir, entry);
    const name = '/' + basename(entry, '.md');

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const description =
      parseFrontmatterDescription(content) ||
      fallbackDescription(content) ||
      name;

    commands.push({ name, description, source, filePath, argHints: [] });
  }

  return commands;
}

// ---------------------------------------------------------------------------
// listAllSlashCommands
// ---------------------------------------------------------------------------

/**
 * Cache of slash commands keyed by cwd ('' for no cwd). Default discovery is
 * billing-safe local filesystem scanning; explicit native probes are still
 * cached because a real `claude -p` spawn is expensive.
 */
const SLASH_CACHE = new Map<string, SlashCommand[]>();

/** Probe function shape — injectable for tests so they don't spawn real
 *  `claude` processes. Production callers leave it null by default. */
export type ProbeFn = (cwd?: string) => Promise<string[]>;

/**
 * Returns slash commands known without spending Agent SDK credit:
 *   - optional native + plugin/skill commands from an explicit probe
 *   - user-level file commands from ~/.claude/commands/
 *   - project-level file commands from <cwd>/.claude/commands/ (if cwd given)
 *
 * Dedupes by name — file-scanned entries override probe entries (so user's
 * frontmatter description wins over our static map).
 */
export async function listAllSlashCommands(
  cwd?: string,
  probe: ProbeFn | null = null,
): Promise<SlashCommand[]> {
  const cacheKey = cwd ?? '';
  const cached = SLASH_CACHE.get(cacheKey);
  if (cached) return cached;

  const probeNames = probe ? await probe(cwd) : [];
  const native = probeNames.map(nativeToSlashCommand);
  const all: SlashCommand[] = [
    ...native,
    ...scanCommandsDir(join(homedir(), '.claude', 'commands'), 'user'),
    ...(cwd ? scanCommandsDir(join(cwd, '.claude', 'commands'), 'project') : []),
  ];

  // Dedupe by name — last entry wins (project > user > native).
  const byName = new Map<string, SlashCommand>();
  for (const cmd of all) byName.set(cmd.name, cmd);
  const result = [...byName.values()];
  SLASH_CACHE.set(cacheKey, result);
  return result;
}

/** Clear the slash cache (useful when ~/.claude/commands changes). */
export function clearSlashCache(): void {
  SLASH_CACHE.clear();
}
