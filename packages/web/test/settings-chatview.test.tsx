// Coverage for traceability row:
//   CHATVIEW-001 — The chat-view Settings controls confirm before the page
//                  reload. Cancel persists nothing; confirm saves + reloads.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsBody } from '../src/components/SettingsBody.js';
import * as api from '../src/api.js';
import { confirm } from '../src/feedback.js';
import type { SystemConfig } from '@gian/shared';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn().mockImplementation(async partial => ({ ...baseConfig(), ...partial })),
    loadProxyModels: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../src/feedback.js', async () => {
  const actual = await vi.importActual<typeof import('../src/feedback.js')>('../src/feedback.js');
  return { ...actual, confirm: vi.fn() };
});

const confirmMock = confirm as unknown as ReturnType<typeof vi.fn>;
const reloadMock = vi.fn();

function baseConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding', public_url: '',
    tunnel_mode: 'none', tunnel_id: '', force_https: false,
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'zh-CN',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [],
    claude_chat_surface: 'tty', claude_chat_cli: true, codex_chat_cli: false,
    ...overrides,
  };
}

describe('CHATVIEW-001: chat-view settings confirm-then-reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: Object.assign({}, window.location, { reload: reloadMock }),
    });
  });

  it('cancelling the confirm persists nothing and does not reload', async () => {
    confirmMock.mockResolvedValue(false);
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude -p' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('confirming saves the surface + reseeded CLI default, then reloads', async () => {
    confirmMock.mockResolvedValue(true);
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'claude -p' }));
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({
        claude_chat_surface: 'structured',
        claude_chat_cli: false, // reseeded: structured → CLI off
      });
    });
    await waitFor(() => expect(reloadMock).toHaveBeenCalled());
  });

  it('toggling Codex CLI also goes through the confirm gate', async () => {
    confirmMock.mockResolvedValue(true);
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    const codexToggle = screen.getByText('Show a CLI (terminal) tab for Codex sessions')
      .closest('label')!.querySelector('input')!;
    fireEvent.click(codexToggle);
    await waitFor(() => {
      expect(api.saveSettings).toHaveBeenCalledWith({ codex_chat_cli: true });
    });
  });
});
