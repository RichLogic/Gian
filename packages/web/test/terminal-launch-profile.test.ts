import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import {
  resolveTerminalLaunchProfile,
  terminalLaunchLabel,
} from '../src/terminal-launch-profile.js';

describe('terminal launch profile', () => {
  it('captures the current context and configured shell for a new tab', () => {
    const profile = resolveTerminalLaunchProfile({
      ...DEFAULT_TERMINAL_PREFERENCES,
      shell: '/bin/bash',
    }, '/worktrees/project');
    expect(profile).toEqual({ cwd: '/worktrees/project', shell: '/bin/bash' });
    expect(terminalLaunchLabel(profile, '/bin/zsh')).toBe('bash · project');
  });

  it('omits cwd and shell when Home and the system shell are selected', () => {
    const profile = resolveTerminalLaunchProfile({
      ...DEFAULT_TERMINAL_PREFERENCES,
      start_directory: 'home',
    }, '/worktrees/project');
    expect(profile).toEqual({});
    expect(terminalLaunchLabel(profile, '/bin/zsh')).toBe('zsh · ~');
  });
});
