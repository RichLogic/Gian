import { join } from 'node:path';

import type { SlashCommand, SlashCommandSource } from '@gian/shared';

import {
  claudeConfigDir,
  discoverAgentSkills,
  discoverLegacyCommands,
  type DiscoveredClaudeSkill,
} from './skill-discovery.js';

// ---------------------------------------------------------------------------
// Native commands
//
// The authoritative native/plugin list is the `slash_commands` array on
// Claude CLI's `init` event, but collecting it requires `claude -p`. Default
// production listing avoids that billing path and only scans local command
// files; tests can inject a probe without adding a production billing path.
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

/** File-backed entries share their identity with the Customization
 *  inventory: `customizationId` is the same stable `ci1_…` id the inventory
 *  reports for the same file, and the name follows the inventory rule
 *  (frontmatter `name:` for agent-skills, filename stem for commands). */
function discoveredToSlashCommand(
  discovered: DiscoveredClaudeSkill,
  source: SlashCommandSource,
): SlashCommand {
  const name = `/${discovered.name}`;
  return {
    name,
    description: discovered.description ?? name,
    source,
    filePath: discovered.entryPath,
    argHints: [],
    customizationId: discovered.customizationId,
  };
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
 *   - user-level agent-skills from <claude config dir>/skills/<name>/SKILL.md
 *   - user-level file commands from <claude config dir>/commands/
 *   - project-level skills + commands from <cwd>/.claude/ (if cwd given)
 *
 * Skills and commands come from the shared discovery module
 * (skill-discovery.ts) so this list always matches the Customization
 * inventory's membership, naming, and stable ids.
 *
 * Dedupes by name — last entry wins (project > user > native; within one
 * scope a legacy command wins over a same-named agent-skill, matching the
 * more specific user-authored invocation).
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
  const userRoot = claudeConfigDir();
  const projectRoot = cwd ? join(cwd, '.claude') : null;
  const all: SlashCommand[] = [
    ...native,
    ...(await discoverAgentSkills(userRoot, 'user', null))
      .map(discovered => discoveredToSlashCommand(discovered, 'user')),
    ...(await discoverLegacyCommands(userRoot, 'user', null))
      .map(discovered => discoveredToSlashCommand(discovered, 'user')),
    ...(projectRoot
      ? (await discoverAgentSkills(projectRoot, 'workspace', cwd ?? null))
        .map(discovered => discoveredToSlashCommand(discovered, 'project'))
      : []),
    ...(projectRoot
      ? (await discoverLegacyCommands(projectRoot, 'workspace', cwd ?? null))
        .map(discovered => discoveredToSlashCommand(discovered, 'project'))
      : []),
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
