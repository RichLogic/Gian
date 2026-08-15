import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { Toaster } from '../src/components/Toaster.js';
import type {
  GianDesktopUpdateState,
  GianDesktopUpdaterApi,
} from '../src/desktop-bridge.js';
import { __resetFeedback } from '../src/feedback.js';
import { renderWithOperations } from './operation-test-utils.js';

function config(): SystemConfig {
  return {
    host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
    theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    chat_font_size: 14, chat_font_family: 'system',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '', external_editors: [],
  };
}

function state(
  status: GianDesktopUpdateState['status'],
  version: string | null = null,
): GianDesktopUpdateState {
  return {
    status,
    trigger: status === 'idle' || status === 'disabled' ? null : 'manual',
    update: version ? { version, releaseName: null, releaseDate: null } : null,
    progress: null,
    error: null,
  };
}

function installUpdater(initial: GianDesktopUpdateState) {
  let listener: ((next: GianDesktopUpdateState) => void) | null = null;
  const updater: GianDesktopUpdaterApi = {
    getState: vi.fn(async () => initial),
    check: vi.fn(async () => ({ trigger: 'manual', state: state('up-to-date') })),
    install: vi.fn(async () => true),
    onStateChanged: vi.fn(next => {
      listener = next;
      return () => { listener = null; };
    }),
  };
  window.gianDesktop = { appVersion: '0.4.3', updater };
  return { updater, emit: (next: GianDesktopUpdateState) => listener?.(next) };
}

describe('SettingsBody Updates', () => {
  beforeEach(() => {
    delete window.gianDesktop;
  });

  afterEach(() => {
    __resetFeedback();
    delete window.gianDesktop;
  });

  it('checks the stable App update channel only after a user action', async () => {
    const { updater } = installUpdater(state('idle'));
    renderWithOperations(<SettingsBody config={config()} activeSection="updates" />);

    expect(screen.getByText('Installed version')).toBeInTheDocument();
    expect(screen.getByText('v0.4.3')).toBeInTheDocument();
    expect(await screen.findByText('Checks automatically')).toBeInTheDocument();
    expect(updater.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(updater.check).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Gian is up to date')).toBeInTheDocument();
  });

  it('warns that managed CLI work stops before restart-and-install', async () => {
    const { updater } = installUpdater(state('downloaded', '0.4.4'));
    renderWithOperations(
      <>
        <SettingsBody config={config()} activeSection="updates" />
        <Toaster />
      </>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Restart and install' }));
    expect(await screen.findByText(/every CLI session managed by this App/)).toBeInTheDocument();
    expect(updater.install).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Restart and install',
    }));
    await waitFor(() => expect(updater.install).toHaveBeenCalledTimes(1));
  });
});
