import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TERMINAL_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
} from '@gian/shared';
import type { SystemConfig } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import type { NavKey } from '../src/components/SettingsBody.js';
import * as api from '../src/api.js';
import { renderWithOperations } from './operation-test-utils.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn(async patch => ({ ...config(), ...patch })),
    loadAgents: vi.fn().mockResolvedValue([]),
    loadProxies: vi.fn().mockResolvedValue([]),
  };
});

function config(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    keymap: { preset: 'default', bindings: {} },
    layout: { ...DEFAULT_LAYOUT_PREFERENCES },
    tools: structuredClone(DEFAULT_TOOL_PREFERENCES),
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [], open_apps: {},
    ...overrides,
  };
}

describe('Panel-2 Settings redesign', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the directory and active page in one Settings surface', () => {
    const onSectionChange = vi.fn();
    const { container } = renderWithOperations(
      <SettingsBody config={config()} activeSection="appearance" onSectionChange={onSectionChange} />,
    );
    expect(container.querySelector('.settings2-internal-nav')).not.toBeNull();
    expect(container.querySelector('.settings-nav-inspector')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(onSectionChange).toHaveBeenCalledWith('layout');
  });

  it('exposes every non-Settings Dock tool plus Archive, Adopt, and Workspaces', () => {
    const { container } = renderWithOperations(<SettingsBody config={config()} />);
    const navigation = container.querySelector('.settings2-internal-nav')!;
    for (const label of [
      'Files', 'Diffs', 'History', 'Side Chat', 'Browser', 'Terminal',
      'Archive', 'Adopt', 'Workspaces',
    ]) {
      expect(within(navigation as HTMLElement).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('keeps Workspaces, Archive, and Adopt as standalone pages at the bottom', () => {
    const { container } = renderWithOperations(
      <SettingsBody config={config()} activeSection="workspaces" workspaces={[]} />,
    );
    expect(screen.getByTestId('settings-workspaces-page')).toBeTruthy();
    expect(document.getElementById('settings-section-appearance')).toBeNull();
    const navigation = container.querySelector('.settings2-internal-nav')!;
    const labels = [...navigation.querySelectorAll<HTMLButtonElement>('.s2-navitem')]
      .map(button => button.textContent);
    expect(labels.slice(-3)).toEqual(['Workspaces', 'Archive', 'Adopt']);
  });

  it('replaces every Settings slider with a minus/value/plus stepper', async () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="layout" />);
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Increase Sidebar width' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({
      layout: { ...DEFAULT_LAYOUT_PREFERENCES, sidebar_width: 280 },
    }));
  });

  it('keeps each boolean switch label visible only once', () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="files" />);
    expect(screen.getAllByText('Compact folders')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: 'Compact folders' })).toBeTruthy();
  });

  it('replaces the deferred AI Agents placeholder after the section is selected', async () => {
    function ControlledSettings() {
      const [section, setSection] = useState<NavKey>('appearance');
      return <SettingsBody config={config()} activeSection={section} onSectionChange={setSection} />;
    }
    const { container } = renderWithOperations(<ControlledSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Agents' }));
    expect(await screen.findByText(/No Agents yet/)).toBeTruthy();
    expect(container.querySelector('#settings-section-executors .settings-section-deferred')).toBeNull();
  });

  it('uses command-based Keymap entries without Provider or approval commands', () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="keymap" />);
    expect(screen.getByText('Later')).toBeTruthy();
    expect(screen.queryByText('New Claude session')).toBeNull();
    expect(screen.queryByText('New Codex session')).toBeNull();
    expect(screen.queryByText(/allow once/i)).toBeNull();
    const terminalCapture = document.querySelector<HTMLButtonElement>('.shortcut-capture[aria-label="Terminal"]');
    expect(terminalCapture?.textContent).toBe('⌘6');
  });

  it('gives Diffs a functional settings page backed by tools preferences', async () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="diffs" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Default layout' }), {
      target: { value: 'stacked' },
    });
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({
      tools: {
        ...DEFAULT_TOOL_PREFERENCES,
        diffs: { ...DEFAULT_TOOL_PREFERENCES.diffs, layout: 'stacked' },
      },
    }));
  });
});
