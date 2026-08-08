import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { GianBrowserApi, SystemConfig } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import {
  __resetFeedback,
  getSnapshot,
  resolveConfirm,
} from '../src/feedback.js';
import { renderWithOperations } from './operation-test-utils.js';

const config: SystemConfig = {
  host: '127.0.0.1', port: 8990, workspace_root: '~/Coding',
  theme: 'warm', accent: 'plum', density: 'cozy', locale: 'en',
  font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
  default_claude_model: '', default_claude_effort: '',
  default_codex_model: '', default_codex_effort: '',
  auth_username: '', external_editors: [], open_apps: {},
};

const clearData = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  __resetFeedback();
  clearData.mockClear();
  window.gianDesktop = {
    browser: {
      clearData,
    } as unknown as GianBrowserApi,
  };
});

afterEach(() => {
  __resetFeedback();
  delete window.gianDesktop;
});

describe('Settings Browser integration', () => {
  it('shows Browser as the default HTML opener', () => {
    renderWithOperations(<SettingsBody activeSection="openwith" config={config} />);
    const webSelect = screen.getByLabelText('Web (HTML)') as HTMLSelectElement;
    expect(webSelect.value).toBe('@browser');
    expect(Array.from(webSelect.options).some(option => option.text === 'Browser')).toBe(true);
  });

  it('confirms and clears the isolated Browser profile through an operation', async () => {
    renderWithOperations(<SettingsBody activeSection="openwith" config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Browser data' }));
    const record = getSnapshot().confirms.at(-1);
    expect(record?.message).toMatch(/signs Browser out/i);
    resolveConfirm(record!.id, true);
    await waitFor(() => expect(clearData).toHaveBeenCalledTimes(1));
  });
});
