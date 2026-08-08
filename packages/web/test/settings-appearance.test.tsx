import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';
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
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'zh-CN',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
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
    expect(screen.getByText('Font · Transcript')).toBeTruthy();
  });

  it('controls device zoom from 80% to 150% in the same 10% steps as Cmd +/-', () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    const slider = screen.getByRole('slider', { name: 'Zoom' }) as HTMLInputElement;
    expect(slider.min).toBe('80');
    expect(slider.max).toBe('150');
    expect(slider.step).toBe('10');
    expect(screen.getByText('100%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('110%')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '150' } });
    expect(screen.getByText('150%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  });

  it('switching theme resets accent to the theme default', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.click(screen.getByRole('button', { name: /Dark/ }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'dark', accent: 'plum' });
    });
  });

  it('switching to light theme resets accent to azure', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.click(screen.getByRole('button', { name: /Light/ }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ theme: 'light', accent: 'azure' });
    });
  });

  it('renders all 8 accent buttons', () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    for (const name of ['Rose', 'Ember', 'Citron', 'Moss', 'Teal', 'Azure', 'Ink', 'Plum']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('clicking an accent button sends a patch with only accent (not theme)', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ accent: 'teal' });
    });
  });

  it('switching language saves only the locale', async () => {
    renderWithOperations(<SettingsBody config={baseConfig()} />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ locale: 'en' });
    });
  });

});
