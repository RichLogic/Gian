import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsBody } from '../src/components/SettingsBody.js';
import * as api from '../src/api.js';
import type { SystemConfig } from '@gian/shared';

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
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding', public_url: '',
    tunnel_mode: 'none', tunnel_id: '', force_https: false,
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'zh-CN',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    default_claude_model: '', default_claude_effort: '',
    default_codex_model:  '', default_codex_effort:  '',
    auth_username: '', external_editors: [],
    ...overrides,
  };
}

describe('SettingsBody Appearance', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('switching theme resets accent to the theme default', async () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Dark/ }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'dark', accent: 'plum' });
    });
  });

  it('switching to light theme resets accent to azure', async () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Light/ }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'light', accent: 'azure' });
    });
  });

  it('renders all 8 accent buttons', () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    for (const name of ['Rose', 'Ember', 'Citron', 'Moss', 'Teal', 'Azure', 'Ink', 'Plum']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('clicking an accent button sends a patch with only accent (not theme)', async () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ accent: 'teal' });
    });
  });

});
