/**
 * WorkspaceDialog (2026-09-09): the centered New/Edit Repo modal that
 * replaced the Workbench "New Repo" sheet tab and the sidebar group header's
 * inline rename. Covers: create-mode fields/testids, Escape/backdrop
 * dismissal, successful create (POST /api/workspaces → onChanged + close),
 * inline create failure, and edit-mode name-only rename (Directory/Git URL
 * disabled, Save gating, PATCH /api/workspaces/:id, inline failure).
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Workspace } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { WorkspaceDialog } from '../src/views/workspace-dialog.js';
import { mockFetch } from './setup.js';
import { renderWithOperations } from './operation-test-utils.js';

const workspace: Workspace = {
  id: 'ws-1',
  name: 'Gian-Dev',
  path: '/Users/dev/Gian-Dev',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

function renderDialog(dialog: { kind: 'create' } | { kind: 'edit'; workspace: Workspace }) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const rendered = renderWithOperations(
    <LocaleProvider locale="en">
      <WorkspaceDialog dialog={dialog} onClose={onClose} onChanged={onChanged} />
    </LocaleProvider>,
  );
  return { onClose, onChanged, ...rendered };
}

describe('WorkspaceDialog — create mode', () => {
  it('renders the New Repo form (Name / Directory + Browse / Git URL + Clone) and closes on Escape/backdrop', () => {
    const { onClose } = renderDialog({ kind: 'create' });

    expect(screen.getByRole('dialog', { name: 'New Repo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Repo name')).toBeEnabled();
    expect(screen.getByLabelText('Repo path')).toBeEnabled();
    expect(screen.getByLabelText('Git URL')).toBeEnabled();
    expect(screen.getByTestId('ws-create')).toBeDisabled();
    expect(screen.getByTestId('ws-clone')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeEnabled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(document.querySelector('.ws-dialog-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Create dispatches workspace.create (POST /api/workspaces) and closes via onChanged', async () => {
    const created: Workspace = { ...workspace, id: 'ws-new', name: 'picked-project', path: '/tmp/picked-project' };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    mockFetch(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ workspace: created, notes: [] }), { status: 200 });
    });
    const { onClose, onChanged } = renderDialog({ kind: 'create' });

    fireEvent.change(screen.getByLabelText('Repo path'), { target: { value: '/tmp/picked-project' } });
    // The path-derived name fills in until the user touches the Name field.
    expect(screen.getByLabelText('Repo name')).toHaveValue('picked-project');
    fireEvent.click(screen.getByTestId('ws-create'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{
      url: '/api/workspaces',
      method: 'POST',
      body: { name: 'picked-project', path: '/tmp/picked-project' },
    }]);
  });

  it('shows the create failure inline and keeps the dialog open', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: 'Workspace already registered' }), { status: 409 }));
    const { onClose, onChanged } = renderDialog({ kind: 'create' });

    fireEvent.change(screen.getByLabelText('Repo path'), { target: { value: '/tmp/dup' } });
    fireEvent.click(screen.getByTestId('ws-create'));

    expect(await screen.findByText('Workspace already registered')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Repo' })).toBeInTheDocument();
  });
});

describe('WorkspaceDialog — edit mode', () => {
  it('prefills Name (editable) and disables Directory/Git URL; Save stays disabled while unchanged', () => {
    renderDialog({ kind: 'edit', workspace });

    expect(screen.getByRole('dialog', { name: 'Edit Repo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Repo name')).toHaveValue('Gian-Dev');
    expect(screen.getByLabelText('Repo name')).toBeEnabled();
    expect(screen.getByLabelText('Repo path')).toHaveValue('/Users/dev/Gian-Dev');
    expect(screen.getByLabelText('Repo path')).toBeDisabled();
    expect(screen.getByLabelText('Git URL')).toHaveValue('');
    expect(screen.getByLabelText('Git URL')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
    expect(screen.queryByTestId('ws-clone')).toBeNull();
    expect(screen.getByTestId('ws-save')).toBeDisabled();

    // Whitespace-only / emptied names are not renameable.
    fireEvent.change(screen.getByLabelText('Repo name'), { target: { value: '   ' } });
    expect(screen.getByTestId('ws-save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Repo name'), { target: { value: 'Gian-Renamed' } });
    expect(screen.getByTestId('ws-save')).toBeEnabled();
  });

  it('Save dispatches workspace.rename (PATCH) with the trimmed name and closes via onChanged', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    mockFetch(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ ...workspace, name: 'Gian-Renamed' }), { status: 200 });
    });
    const { onClose, onChanged } = renderDialog({ kind: 'edit', workspace });

    fireEvent.change(screen.getByLabelText('Repo name'), { target: { value: '  Gian-Renamed  ' } });
    fireEvent.click(screen.getByTestId('ws-save'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{
      url: '/api/workspaces/ws-1',
      method: 'PATCH',
      body: { name: 'Gian-Renamed' },
    }]);
  });

  it('shows the rename failure inline and keeps the dialog open', async () => {
    mockFetch(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    const { onClose, onChanged } = renderDialog({ kind: 'edit', workspace });

    fireEvent.change(screen.getByLabelText('Repo name'), { target: { value: 'Gian-Renamed' } });
    fireEvent.click(screen.getByTestId('ws-save'));

    expect(await screen.findByText('Workspace update failed')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit Repo' })).toBeInTheDocument();
  });
});
