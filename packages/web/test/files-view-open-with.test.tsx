import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilesView } from '../src/views/FilesView.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadTree: vi.fn().mockResolvedValue([{ name: 'foo.md', type: 'file', path: 'foo.md' }]),
    loadFile: vi.fn().mockResolvedValue({ content: '# foo', size: 5 }),
    loadFileMeta: vi.fn().mockResolvedValue({ edit_count_today: 0, uncommitted: false }),
    openFileWith: vi.fn().mockResolvedValue({ ok: true }),
  };
});

const workingTrees = [{
  id: 'ws:demo', kind: 'workspace' as const, label: 'demo', path: '/tmp/demo',
  branch: null, workspace_id: 'demo', workspace_name: 'demo',
  session_id: null, session_name: null,
}];

describe('FilesView open-with', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('clicking "Open" calls openFileWith without editor_id', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[]}
        onOpenSettings={() => {}}
      />,
    );
    const btn = await screen.findByRole('button', { name: /^Open$/ });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.openFileWith).toHaveBeenCalledWith('ws:demo', 'foo.md', undefined);
    });
  });

  it('caret menu lists configured editors and Configure tail row', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[
          { id: 'vsc', name: 'VS Code', command: 'code', args: [] },
        ]}
        onOpenSettings={() => {}}
      />,
    );
    const caret = await screen.findByRole('button', { name: /open with menu/i });
    fireEvent.click(caret);
    expect(await screen.findByText('VS Code')).toBeTruthy();
    expect(screen.getByText(/configure editors/i)).toBeTruthy();
  });

  it('clicking editor row calls openFileWith with its id', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[
          { id: 'vsc', name: 'VS Code', command: 'code', args: [] },
        ]}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open with menu/i }));
    fireEvent.click(await screen.findByText('VS Code'));
    await waitFor(() => {
      expect(api.openFileWith).toHaveBeenCalledWith('ws:demo', 'foo.md', 'vsc');
    });
  });

  it('empty editor list still shows Configure row', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[]}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open with menu/i }));
    expect(screen.getByText(/configure editors/i)).toBeTruthy();
  });

  it('Configure row calls onOpenSettings', async () => {
    const onOpenSettings = vi.fn();
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[]}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open with menu/i }));
    fireEvent.click(screen.getByText(/configure editors/i));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
