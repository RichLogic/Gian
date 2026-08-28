import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';
import * as api from '../src/api.js';
import type { SystemConfig } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn().mockImplementation(async partial => ({ ...baseConfig(), ...partial })),
    loadProxyModels: vi.fn().mockResolvedValue([]),
  };
});

function baseConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'zh-CN',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model:  '', default_codex_effort:  '',
    auth_username: '', external_editors: [],
    ...overrides,
  };
}

describe('SettingsBody Appearance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete window.gianDesktop;
  });

  it('removes Density and the Interface/Code font controls', () => {
    renderWithOperations(<SettingsBody config={baseConfig({
      density: 'compact',
      font_scale_chrome: 'xl',
      font_scale_code: 'sm',
    })} />);
    expect(screen.queryByText('Density')).toBeNull();
    expect(screen.queryByText('Font · Interface')).toBeNull();
    expect(screen.queryByText('Font · Code')).toBeNull();
  });

  it('controls device zoom from a dropdown on the same 10% steps as Cmd +/-', () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    const select = screen.getByRole('combobox', { name: 'Zoom' }) as HTMLSelectElement;
    const values = Array.from(select.options).map(option => option.value);
    expect(values).toEqual(['80', '90', '100', '110', '120', '130', '140', '150']);
    expect(select.value).toBe('100');

    fireEvent.change(select, { target: { value: '130' } });
    expect(select.value).toBe('130');
    expect(localStorage.getItem('gian.appearance.zoom-percent')).toBe('130');
  });

  it('switches theme from a dropdown and resets accent to the theme default', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'dark' } });
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'dark', accent: 'plum' });
    });
  });

  it('switching to light theme resets accent to azure', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), { target: { value: 'light' } });
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'light', accent: 'azure' });
    });
  });

  it('renders all 8 accent swatches', () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    for (const name of ['Rose', 'Ember', 'Citron', 'Moss', 'Teal', 'Azure', 'Ink', 'Plum']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('clicking an accent swatch sends a patch with only accent (not theme)', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ accent: 'teal' });
    });
  });

  it('switches language from a dropdown and saves only the locale', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'en' } });
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ locale: 'en' });
    });
  });

});

describe('SettingsBody Chat section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete window.gianDesktop;
  });

  it('sets the chat font size in concrete px', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} activeSection="chat" />);
    const select = screen.getByRole('combobox', { name: 'Font size' }) as HTMLSelectElement;
    expect(select.value).toBe('14');
    expect(Array.from(select.options).map(option => option.textContent))
      .toEqual(['12px', '13px', '14px', '15px', '16px', '17px', '18px', '19px', '20px']);
    fireEvent.change(select, { target: { value: '16' } });
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ chat_font_size: 16 });
    });
  });

  it('switches the chat font family', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} activeSection="chat" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Font' }), { target: { value: 'mono' } });
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ chat_font_family: 'mono' });
    });
  });

  it('keeps the minimap toggle in the Chat section', () => {
    renderWithOperations(<SettingsBody config={baseConfig()} activeSection="chat" />);
    const toggle = screen.getByRole('checkbox', { name: /show a rail/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(localStorage.getItem('gian.transcript.minimap')).toBe('1');
  });

  it('keeps Chat controls in their own section of the continuous settings page', () => {
    renderWithOperations(<SettingsBody config={baseConfig()} activeSection="appearance" />);
    const appearance = document.getElementById('settings-section-appearance')!;
    const chat = document.getElementById('settings-section-chat')!;
    expect(within(appearance).queryByRole('combobox', { name: 'Font size' })).toBeNull();
    expect(within(chat).getByRole('combobox', { name: 'Font size' })).toBeTruthy();
  });
});
