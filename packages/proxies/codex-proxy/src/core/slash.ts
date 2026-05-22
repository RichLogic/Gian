import type { SlashCommand, SlashCommandSource } from '@gian/shared';
import type { SkillMetadata, SkillsListResponse } from '../runtime/types.js';

/**
 * Codex app-server has no "slash/list" RPC. The CLI's /clear, /compact,
 * /model, etc. are TUI-side shortcuts; sending those strings as ordinary
 * turn text to app-server is not a reliable command protocol.
 *
 * For the session-main composer we expose:
 *   - a curated copy of Codex's documented built-in CLI commands, so the UI
 *     can show the native command surface; and
 *   - `skills/list` results, which are first-class app-server input items.
 *
 * Structured execution for built-ins lives in `service.ts`: commands with
 * app-server equivalents are intercepted there, and TUI-only commands return
 * a clear local message instead of leaking `/command` text to the model.
 */

export const CODEX_NATIVE_COMMANDS: SlashCommand[] = [
  { name: '/permissions', description: 'Set what Codex can do without asking first.', source: 'builtin', argHints: [] },
  { name: '/ide', description: 'Include open files, current selection, and other IDE context.', source: 'builtin', argHints: [] },
  { name: '/keymap', description: 'Remap TUI keyboard shortcuts.', source: 'builtin', argHints: [] },
  { name: '/vim', description: 'Toggle Vim mode for the composer.', source: 'builtin', argHints: [] },
  { name: '/sandbox-add-read-dir', description: 'Grant sandbox read access to an extra directory on Windows.', source: 'builtin', argHints: [{ kind: 'free', placeholder: 'absolute directory' }] },
  { name: '/agent', description: 'Switch the active agent thread.', source: 'builtin', argHints: [] },
  { name: '/apps', description: 'Browse apps and insert them into your prompt.', source: 'builtin', argHints: [] },
  { name: '/plugins', description: 'Browse installed and discoverable plugins.', source: 'builtin', argHints: [] },
  { name: '/hooks', description: 'Review lifecycle hooks.', source: 'builtin', argHints: [] },
  { name: '/clear', description: 'Clear the current Codex conversation and start a fresh native thread.', source: 'builtin', argHints: [] },
  { name: '/compact', description: 'Summarize the conversation to free tokens.', source: 'builtin', argHints: [] },
  { name: '/copy', description: 'Copy the latest completed Codex output.', source: 'builtin', argHints: [] },
  { name: '/diff', description: 'Show the Git diff, including untracked files.', source: 'builtin', argHints: [] },
  { name: '/exit', description: 'Exit the Codex CLI.', source: 'builtin', argHints: [] },
  { name: '/experimental', description: 'Toggle experimental features.', source: 'builtin', argHints: [] },
  { name: '/approve', description: 'Approve one retry of a recent auto-review denial.', source: 'builtin', argHints: [] },
  { name: '/memories', description: 'Configure memory use and generation.', source: 'builtin', argHints: [] },
  { name: '/skills', description: 'Browse and use skills.', source: 'builtin', argHints: [] },
  { name: '/feedback', description: 'Send logs to the Codex maintainers.', source: 'builtin', argHints: [] },
  { name: '/init', description: 'Generate an AGENTS.md scaffold in the current directory.', source: 'builtin', argHints: [] },
  { name: '/logout', description: 'Sign out of Codex.', source: 'builtin', argHints: [] },
  { name: '/mcp', description: 'List configured Model Context Protocol tools.', source: 'builtin', argHints: [{ kind: 'enum', values: ['verbose'] }] },
  { name: '/mention', description: 'Attach a file or folder to the conversation.', source: 'builtin', argHints: [{ kind: 'path', placeholder: 'path' }] },
  { name: '/model', description: 'Choose the active model and reasoning effort.', source: 'builtin', argHints: [] },
  { name: '/fast', description: 'Toggle or inspect the Fast service tier.', source: 'builtin', argHints: [{ kind: 'enum', values: ['on', 'off', 'status'] }] },
  { name: '/plan', description: 'Switch to plan mode and optionally send a prompt.', source: 'builtin', argHints: [{ kind: 'free', placeholder: 'prompt (optional)' }] },
  { name: '/goal', description: 'Set, pause, resume, view, or clear a task goal.', source: 'builtin', argHints: [{ kind: 'free', placeholder: 'objective | pause | resume | clear' }] },
  { name: '/personality', description: 'Choose a communication style for responses.', source: 'builtin', argHints: [] },
  { name: '/ps', description: 'Show experimental background terminals and recent output.', source: 'builtin', argHints: [] },
  { name: '/stop', description: 'Stop all background terminals.', source: 'builtin', argHints: [] },
  { name: '/clean', description: 'Alias for /stop.', source: 'builtin', argHints: [] },
  { name: '/fork', description: 'Fork the current conversation into a new thread.', source: 'builtin', argHints: [] },
  { name: '/side', description: 'Start an ephemeral side conversation.', source: 'builtin', argHints: [{ kind: 'free', placeholder: 'prompt (optional)' }] },
  { name: '/raw', description: 'Toggle raw scrollback mode.', source: 'builtin', argHints: [{ kind: 'enum', values: ['on', 'off'] }] },
  { name: '/resume', description: 'Resume a saved conversation from the session list.', source: 'builtin', argHints: [] },
  { name: '/new', description: 'Start a new conversation inside the same CLI session.', source: 'builtin', argHints: [] },
  { name: '/quit', description: 'Exit the Codex CLI.', source: 'builtin', argHints: [] },
  { name: '/review', description: 'Ask Codex to review your working tree.', source: 'builtin', argHints: [] },
  { name: '/status', description: 'Display session configuration and token usage.', source: 'builtin', argHints: [] },
  { name: '/debug-config', description: 'Print config layer and requirements diagnostics.', source: 'builtin', argHints: [] },
  { name: '/statusline', description: 'Configure TUI status-line fields.', source: 'builtin', argHints: [] },
  { name: '/title', description: 'Configure terminal window or tab title fields.', source: 'builtin', argHints: [] },
  { name: '/theme', description: 'Choose a syntax-highlighting theme.', source: 'builtin', argHints: [] },
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
