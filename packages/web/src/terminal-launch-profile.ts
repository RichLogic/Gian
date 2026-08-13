import type { TerminalPreferences } from '@gian/shared';
import type { TerminalLaunchProfile } from './components/sheet-model.js';

export function resolveTerminalLaunchProfile(
  preferences: Readonly<TerminalPreferences>,
  contextCwd: string | null,
): TerminalLaunchProfile {
  return {
    ...(preferences.start_directory === 'context' && contextCwd ? { cwd: contextCwd } : {}),
    ...(preferences.shell ? { shell: preferences.shell } : {}),
  };
}

export function terminalLaunchLabel(
  profile: TerminalLaunchProfile,
  systemShell: string,
): string {
  const shellPath = profile.shell || systemShell;
  const shellName = shellPath.split('/').filter(Boolean).pop() || 'shell';
  const directoryName = profile.cwd
    ? profile.cwd.split('/').filter(Boolean).pop() || profile.cwd
    : '~';
  return `${shellName} · ${directoryName}`;
}
