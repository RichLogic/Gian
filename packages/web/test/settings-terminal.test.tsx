import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  type SystemConfig,
  type TerminalOptions,
} from '@gian/shared';
import { SettingsBody, SettingsNavInspector } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn().mockImplementation(async partial => ({ ...baseConfig(), ...partial })),
  };
});

const options: TerminalOptions = {
  system_shell: '/bin/zsh',
  shells: [
    { path: '/bin/bash', label: 'bash' },
    { path: '/bin/zsh', label: 'zsh' },
  ],
};

function baseConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [],
    ...overrides,
  };
}

describe('SettingsBody Terminal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds Terminal to Settings navigation', () => {
    renderWithOperations(<SettingsNavInspector active="appearance" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy();
  });

  it('renders the complete default terminal preference surface', () => {
    renderWithOperations(
      <SettingsBody
        config={baseConfig()}
        activeSection="terminal"
        terminalOptions={options}
      />,
    );
    expect(screen.getByDisplayValue('JetBrains Mono')).toBeTruthy();
    expect(screen.getByText('13px')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Line height' })).toHaveValue('1.2');
    expect(screen.getByRole('button', { name: 'Block' })).toHaveClass('active');
    expect(screen.getByRole('checkbox', { name: /Keep the cursor blinking/ })).toBeChecked();
    expect(screen.getByDisplayValue('5,000')).toBeTruthy();
    expect(screen.getByDisplayValue('System default · /bin/zsh')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Current context' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Reset defaults' })).toBeDisabled();
  });

  it('saves visual settings as one validated terminal object', async () => {
    renderWithOperations(
      <SettingsBody config={baseConfig()} activeSection="terminal" terminalOptions={options} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Increase terminal font size' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({
        terminal: { ...DEFAULT_TERMINAL_PREFERENCES, font_size: 14 },
      });
    });
  });

  it('saves the selected shell and startup directory for future terminals', async () => {
    renderWithOperations(
      <SettingsBody config={baseConfig()} activeSection="terminal" terminalOptions={options} />,
    );
    fireEvent.change(screen.getByLabelText('Default shell'), { target: { value: '/bin/bash' } });
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({
        terminal: { ...DEFAULT_TERMINAL_PREFERENCES, shell: '/bin/bash' },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({
        terminal: { ...DEFAULT_TERMINAL_PREFERENCES, start_directory: 'home' },
      });
    });
  });

  it('restores every terminal preference to its default', async () => {
    renderWithOperations(
      <SettingsBody
        config={baseConfig({
          terminal: { ...DEFAULT_TERMINAL_PREFERENCES, font_size: 18, cursor_blink: false },
        })}
        activeSection="terminal"
        terminalOptions={options}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset defaults' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({
        terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
      });
    });
  });
});
