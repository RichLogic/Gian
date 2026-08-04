import type { SlashCommand, SlashCommandSource } from '@gian/shared';
import type { SkillMetadata, SkillsListResponse } from '../runtime/types.js';

/**
 * Codex app-server has no "slash/list" RPC. Most CLI slash commands are
 * TUI-side shortcuts, so exposing them in Gian would advertise behavior the
 * app-server cannot execute.
 *
 * For the session-main composer we expose:
 *   - the three built-ins with structured app-server implementations; and
 *   - `skills/list` results, which are first-class app-server input items.
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

export function mapSkillsResponse(response: SkillsListResponse): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const entry of response.data ?? []) {
    for (const skill of entry.skills ?? []) {
      if (!skill.enabled) continue;
      const source = scopeToSource(skill.scope);
      const cmd: SlashCommand = {
        name: '/' + skill.name,
        description: pickDescription(skill),
        source,
        filePath: skill.path,
        argHints: [],
      };
      // Last entry wins; project (repo) overrides user/builtin same-name skills.
      byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()];
}

export function listCodexSlashCommands(response: SkillsListResponse): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of CODEX_NATIVE_COMMANDS) {
    byName.set(command.name, command);
  }
  for (const command of mapSkillsResponse(response)) {
    // Preserve local override semantics used by the Claude side: user/repo
    // authored commands can intentionally shadow a built-in name.
    byName.set(command.name, command);
  }
  return [...byName.values()];
}
