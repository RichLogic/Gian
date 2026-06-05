import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    host: '127.0.0.1', port: 8990, workspace_root: '~/Coding', public_url: '',
    tunnel_mode: 'none', tunnel_id: '', force_https: false,
    theme: 'warm', accent: 'plum', density: 'cozy', locale: 'en',
    font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '',
    external_editors: [],
    ...overrides,
  };
}

const vscodeOpener = { id: 'e1', name: 'VS Code', command: 'open', args: ['-a', 'VS Code', '{path}'] };

describe('SettingsBody "Open with" apps', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the empty-state hint when no apps are configured', () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    expect(screen.getByText(/no apps configured/i)).toBeTruthy();
  });

  it('picking an installed app appends an `open -a` opener', async () => {
    render(<SettingsBody config={baseConfig()} apps={['VS Code', 'Sublime Text']} onChange={() => {}} />);
    const picker = screen.getByLabelText('Add application') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'VS Code' } });
    await new Promise(r => setTimeout(r, 600));
    expect(api.saveSettings).toHaveBeenCalled();
    const arg = (api.saveSettings as any).mock.calls.at(-1)[0] as Partial<SystemConfig>;
    expect(arg.external_editors!.length).toBe(1);
    expect(arg.external_editors![0]!.name).toBe('VS Code');
    expect(arg.external_editors![0]!.command).toBe('open');
    expect(arg.external_editors![0]!.args).toEqual(['-a', 'VS Code', '{path}']);
  });

  it('a configured app shows as a row and is filtered out of the picker', () => {
    render(
      <SettingsBody
        config={baseConfig({ external_editors: [vscodeOpener] })}
        apps={['VS Code', 'Sublime Text']}
        onChange={() => {}}
      />,
    );
    // Configured app appears as a row (name only — no manual command/args fields).
    expect(document.querySelector('.ee-app-row .ee-app-name')?.textContent).toContain('VS Code');
    expect(screen.queryByLabelText('Args')).toBeNull();
    // …and isn't offered again in the "Add application" picker.
    const picker = screen.getByLabelText('Add application') as HTMLSelectElement;
    const opts = Array.from(picker.querySelectorAll('option')).map(o => o.textContent);
    expect(opts).not.toContain('VS Code');
    expect(opts).toContain('Sublime Text');
  });

  it('Remove (✕) drops the app', async () => {
    render(
      <SettingsBody
        config={baseConfig({ external_editors: [vscodeOpener] })}
        apps={['VS Code']}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove editor/i }));
    await new Promise(r => setTimeout(r, 600));
    const last = (api.saveSettings as any).mock.calls.at(-1)[0] as Partial<SystemConfig>;
    expect(last.external_editors).toEqual([]);
  });
});
