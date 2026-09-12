import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';
import { __resetFeedback } from '../src/feedback.js';

// WP4 (issue #146): the Settings → AI Agents section no longer manages
// Agents — it links out to the top-level Agents page (My Agents + Proxy
// Catalog). The management surface itself is covered by
// agents-view.test.tsx.

function config(): SystemConfig {
  return {
    host: '127.0.0.1',
    port: 8991,
    workspace_root: '~/Coding',
    theme: 'warm',
    accent: 'ember',
    density: 'cozy',
    locale: 'en',
    font_scale_chrome: 'md',
    font_scale_chat: 'md', chat_font_size: 14, chat_font_family: 'system',
    font_scale_code: 'md',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    default_claude_model: '',
    default_claude_effort: '',
    default_codex_model: '',
    default_codex_effort: '',
    auth_username: '',
    external_editors: [],
  };
}

describe('Settings AI Agents section (link-out)', () => {
  it('renders the link-out card instead of the management block', () => {
    __resetFeedback();
    const onOpenAgentsPage = vi.fn();
    renderWithOperations(
      <SettingsBody
        config={config()}
        activeSection="executors"
        onOpenAgentsPage={onOpenAgentsPage}
      />,
    );
    expect(screen.getByText(/moved to the Agents page/)).toBeTruthy();
    const button = screen.getByTestId('settings-open-agents-page');
    expect(button.textContent).toMatch(/Open Agents page/);
    // No management affordances remain in Settings.
    expect(screen.queryByText(/Save & Restart/)).toBeNull();

    fireEvent.click(button);
    expect(onOpenAgentsPage).toHaveBeenCalledTimes(1);
  });

  it('disables the link-out when no host handler is wired', () => {
    __resetFeedback();
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);
    const button = screen.getByTestId('settings-open-agents-page') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
