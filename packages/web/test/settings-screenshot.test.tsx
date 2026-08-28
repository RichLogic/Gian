import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { GianScreenshotApi, SystemConfig } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';

const config: SystemConfig = {
  host: '127.0.0.1', port: 8990, workspace_root: '~/Coding',
  theme: 'warm', accent: 'plum', density: 'cozy', locale: 'en',
  font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
  chat_font_size: 14, chat_font_family: 'system',
  terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
  default_claude_model: '', default_claude_effort: '',
  default_codex_model: '', default_codex_effort: '',
  auth_username: '', external_editors: [],
};

const getPreferences = vi.fn().mockResolvedValue({
  hideMainWindowDuringCapture: false,
  shortcut: null,
});
const setPreferences = vi.fn().mockImplementation(
  async (preferences: { hideMainWindowDuringCapture: boolean; shortcut: string | null }) =>
    preferences,
);
const getState = vi.fn().mockResolvedValue({
  shortcut: 'Control+Command+A',
  shortcutRegistered: true,
  capturing: false,
});

beforeEach(() => {
  getPreferences.mockClear();
  getPreferences.mockResolvedValue({ hideMainWindowDuringCapture: false, shortcut: null });
  setPreferences.mockClear();
  getState.mockClear();
  getState.mockResolvedValue({
    shortcut: 'Control+Command+A',
    shortcutRegistered: true,
    capturing: false,
  });
  window.gianDesktop = {
    screenshot: {
      getState,
      getPreferences,
      setPreferences,
    } as unknown as GianScreenshotApi,
  };
});

afterEach(() => {
  delete window.gianDesktop;
});

describe('Settings screenshot behavior', () => {
  it('loads and reflects the persisted hide-window preference', async () => {
    getPreferences.mockResolvedValue({ hideMainWindowDuringCapture: true, shortcut: null });
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));
    const toggle = await screen.findByRole('checkbox', {
      name: /hide the window while capturing/i,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('persists the toggle through setPreferences', async () => {
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    const toggle = await screen.findByRole('checkbox', {
      name: /hide the window while capturing/i,
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(setPreferences).toHaveBeenCalledTimes(1));
    expect(setPreferences).toHaveBeenCalledWith({
      hideMainWindowDuringCapture: true,
      shortcut: null,
    });
  });

  it('shows the active global shortcut as keycaps', async () => {
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    const capture = await screen.findByRole('button', { name: 'Global screenshot' });
    await waitFor(() => {
      // "Control+Command+A" renders with the ⌃/⌘ distinction preserved.
      expect(capture.textContent).toBe('⌃⌘A');
    });
  });

  it('keeps the long hide-window hint out of the auto-sized keycap column', async () => {
    // Layout regression: the hint sentence used to sit in the same dd as the
    // toggle, and as the widest cell it inflated the grid's auto track to
    // ~490px, squeezing every shortcut label to ~67px (broken layout report).
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    const toggle = await screen.findByRole('checkbox', {
      name: /hide the window while capturing/i,
    });
    const toggleDd = toggle.closest('dd');
    expect(toggleDd).toBeTruthy();
    expect(toggleDd!.textContent).not.toContain('temporarily hidden');

    const hint = screen.getByText(/temporarily hidden/);
    const hintDd = hint.closest('dd');
    expect(hintDd).toBeTruthy();
    expect(hintDd!.className).toContain('shortcut-hint');
  });

  it('remaps the global shortcut by capturing the next keydown', async () => {
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    const capture = await screen.findByRole('button', { name: 'Global screenshot' });
    fireEvent.click(capture);
    fireEvent.keyDown(window, { key: 's', metaKey: true, shiftKey: true });
    await waitFor(() => expect(setPreferences).toHaveBeenCalledTimes(1));
    expect(setPreferences).toHaveBeenCalledWith({
      hideMainWindowDuringCapture: false,
      shortcut: 'Command+Shift+S',
    });
  });

  it('rejects a bare letter as a global shortcut', async () => {
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    const capture = await screen.findByRole('button', { name: 'Global screenshot' });
    fireEvent.click(capture);
    fireEvent.keyDown(window, { key: 's' });
    // Still listening, nothing saved.
    expect(setPreferences).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Global screenshot' }).textContent).not
        .toBe('Press keys…');
    });
  });

  it('resets a remapped shortcut to the platform default', async () => {
    getPreferences.mockResolvedValue({
      hideMainWindowDuringCapture: false,
      shortcut: 'CommandOrControl+Shift+S',
    });
    renderWithOperations(<SettingsBody activeSection="keymap" config={config} />);
    const reset = await screen.findByRole('button', { name: 'Reset to default' });
    fireEvent.click(reset);
    await waitFor(() => expect(setPreferences).toHaveBeenCalledTimes(1));
    expect(setPreferences).toHaveBeenCalledWith({
      hideMainWindowDuringCapture: false,
      shortcut: null,
    });
  });
});
