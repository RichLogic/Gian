import type { SlashCommand, SlashCommandSource } from '@gian/shared';
import type { SkillMetadata, SkillsListResponse } from '../runtime/types.js';

/**
 * Codex has no "built-in slash commands" concept on the daemon side. The TUI's
 * /clear, /compact, /fork, /model, etc. are TUI-only shortcuts that translate
 * to RPC calls (thread/start, thread/fork, etc.) — sending those strings as
 * message text to codex daemon is a no-op (it just becomes part of the prompt).
 *
 * What the daemon DOES expose is `skills/list` — user/repo/system/admin scoped
 * authored prompts. That's the only real slash command source for codex; we
 * map it to our SlashCommand wire shape and return it from `slash.list`.
 */

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
