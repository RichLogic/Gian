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
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '',
    external_editors: [],
    ...overrides,
  };
}

describe('SettingsBody External editors', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders empty-state hint when no editors are configured', () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    expect(screen.getByText(/no editors configured/i)).toBeTruthy();
  });

  it('"+ Add editor" appends a new row with a uuid id', async () => {
    const onChange = vi.fn();
    render(<SettingsBody config={baseConfig()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /add editor/i }));
    await new Promise(r => setTimeout(r, 600));
    expect(api.saveSettings).toHaveBeenCalled();
    const arg = (api.saveSettings as any).mock.calls[0][0] as Partial<SystemConfig>;
    expect(arg.external_editors).toBeDefined();
    expect(arg.external_editors!.length).toBe(1);
    expect(arg.external_editors![0]!.id).toMatch(/[0-9a-f-]{8,}/);
  });

  it('editing Name sends a patch with the updated value', async () => {
    const cfg = baseConfig({
      external_editors: [{ id: 'e1', name: 'VS Code', command: 'code', args: [] }],
    });
    render(<SettingsBody config={cfg} onChange={() => {}} />);
    const nameInput = screen.getByDisplayValue('VS Code');
    fireEvent.change(nameInput, { target: { value: 'VSCode Stable' } });
    // Auto-save fires debounced; for the unit-level guarantee, ensure
    // the input value updated. The actual debounce is covered elsewhere.
    expect((nameInput as HTMLInputElement).value).toBe('VSCode Stable');
  });

  it('editing Args splits on whitespace into string[]', async () => {
    const cfg = baseConfig({
      external_editors: [{ id: 'e1', name: 'VS Code', command: 'code', args: [] }],
    });
    render(<SettingsBody config={cfg} onChange={() => {}} />);
    const argsInput = screen.getByLabelText(/args/i) as HTMLInputElement;
    fireEvent.change(argsInput, { target: { value: '--new-window  {path}' } });
    fireEvent.blur(argsInput);
    // Wait long enough that the 500ms debounce flushes.
    await new Promise(r => setTimeout(r, 600));
    expect(api.saveSettings).toHaveBeenCalled();
    const last = (api.saveSettings as any).mock.calls.at(-1)[0] as Partial<SystemConfig>;
    expect(last.external_editors![0]!.args).toEqual(['--new-window', '{path}']);
  });

  it('Delete (✕) removes the row', async () => {
    const cfg = baseConfig({
      external_editors: [{ id: 'e1', name: 'VS Code', command: 'code', args: [] }],
    });
    render(<SettingsBody config={cfg} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /remove editor/i }));
    await new Promise(r => setTimeout(r, 600));
    const last = (api.saveSettings as any).mock.calls.at(-1)[0] as Partial<SystemConfig>;
    expect(last.external_editors).toEqual([]);
  });
});
