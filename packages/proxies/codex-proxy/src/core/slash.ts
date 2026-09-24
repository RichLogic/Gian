import type { SlashCommand, SlashCommandSource } from '@gian/shared';
import { stableCustomizationId } from '@gian/proxy-protocol';
import type { SkillMetadata, SkillsListResponse } from '../runtime/types.js';

/**
 * Codex app-server has no "slash/list" RPC. Most CLI slash commands are
 * TUI-side shortcuts, so exposing them in Gian would advertise behavior the
 * app-server cannot execute.
 *
 * For the session-main composer we expose:
 *   - the three built-ins with structured app-server implementations; and
 *   - `skills/list` results, which are first-class app-server input items.
 *
 * Skills are listed enabled AND disabled — matching the Customization
 * inventory, which surfaces both — with `disabled: true` on the entries the
 * app-server would refuse, and each skill carries the same stable
 * `customizationId` the inventory assigns it (same stable-id inputs as
 * core/customization.ts `toSkillItem`).
 */

export const CODEX_NATIVE_COMMANDS: SlashCommand[] = [
  { name: '/clear', description: 'Clear the current Codex conversation and start a fresh native thread.', source: 'builtin', argHints: [] },
  { name: '/compact', description: 'Summarize the conversation to free tokens.', source: 'builtin', argHints: [] },
  { name: '/new', description: 'Start a new conversation inside the same CLI session.', source: 'builtin', argHints: [] },
];

const CODEX_NATIVE_COMMAND_NAMES = new Set(CODEX_NATIVE_COMMANDS.map(command => command.name));

export function isCodexNativeCommandName(name: string): boolean {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  return CODEX_NATIVE_COMMAND_NAMES.has(normalized);
}

function scopeToSource(scope: SkillMetadata['scope']): SlashCommandSource {
  switch (scope) {
    case 'user':
      return 'user';
    case 'repo':
      return 'project';
    case 'system':
    case 'admin':
      return 'builtin';
  }
}

function pickDescription(skill: SkillMetadata): string {
  return (
    skill.interface?.shortDescription ||
    skill.shortDescription ||
    skill.description ||
    skill.name
  );
}

/** The exact scope key core/customization.ts `toSkillItem` feeds the stable
 *  id — keep in lockstep or the slash/inventory join breaks. */
function skillScopeKey(skill: SkillMetadata, cwd: string): string {
  return skill.scope === 'user' ? 'user' : skill.scope === 'repo' ? `workspace:${cwd}` : 'system';
}

function skillCustomizationId(skill: SkillMetadata, cwd: string): string {
  return stableCustomizationId({
    provider: 'codex',
    kind: 'skill',
    scopeKey: skillScopeKey(skill, cwd),
    canonicalSourceLocator: skill.path,
    nativeIdentity: skill.name,
  });
}

export function mapSkillsResponse(response: SkillsListResponse, cwd?: string): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const entry of response.data ?? []) {
    // The inventory resolves the workspace root as requested-cwd first, then
    // the response entry's cwd — mirror that order so ids match.
    const entryCwd = cwd ?? entry.cwd ?? '';
    for (const skill of entry.skills ?? []) {
      const source = scopeToSource(skill.scope);
      const cmd: SlashCommand = {
        name: '/' + skill.name,
        description: pickDescription(skill),
        source,
        filePath: skill.path,
        argHints: [],
        ...(skill.enabled ? {} : { disabled: true }),
        customizationId: skillCustomizationId(skill, entryCwd),
      };
      // Last entry wins; project (repo) overrides user/builtin same-name skills.
      byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()];
}

export function listCodexSlashCommands(response: SkillsListResponse, cwd?: string): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of CODEX_NATIVE_COMMANDS) {
    byName.set(command.name, command);
  }
  for (const command of mapSkillsResponse(response, cwd)) {
    // Preserve local override semantics used by the Claude side: user/repo
    // authored commands can intentionally shadow a built-in name.
    byName.set(command.name, command);
  }
  return [...byName.values()];
}
