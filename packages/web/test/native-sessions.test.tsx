import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NativeSession, Session, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptNativeSession,
  loadNativeSessions,
} from '../src/api.js';
import { NativeSessionsPane } from '../src/views/spaces-native-sessions.js';
import { renderWithOperations } from './operation-test-utils.js';

vi.mock('../src/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  adoptNativeSession: vi.fn(),
  loadNativeSessions: vi.fn(),
}));

const workspace = {
  id: 'ws-native',
  name: 'Native workspace',
  path: '/tmp/native-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
} satisfies Workspace;

const source = {
  id: 'codex-native-id',
  executor: 'codex',
  filePath: '/tmp/codex-native-id.jsonl',
  cwd: workspace.path,
  updatedAt: new Date().toISOString(),
  fileSize: 1536,
  turnCount: 4,
  firstUserMessage: 'Replay the existing native conversation',
  gitBranch: 'fix/native-replay',
} satisfies NativeSession;

const adopted = {
  id: 'gian-adopted',
  name: 'Adopted conversation',
  type: 'coding',
  task_id: null,
  workspace_id: workspace.id,
  executor: 'codex',
  model: null,
  approval_mode: 'ask',
  executor_config: { schemaVersion: 1, values: {} },
  native_config_options: [],
  thinking_effort: null,
  service_tier: null,
  active_channel: 'web',
  status: 'done',
  archived: 0,
  pinned_at: null,
  unread: 0,
  worktree_path: null,
  branch: null,
  base_branch: null,
  worktree_outcome: null,
  native_session_id: source.id,
  summary: null,
  completed_at: null,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
} satisfies Session;

describe('NATIVE-001: Native Sessions UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadNativeSessions).mockResolvedValue([source]);
  });

  it('renders metadata and hands the confirmed adopted session to the caller', async () => {
    vi.mocked(adoptNativeSession).mockResolvedValue({ session: adopted });
    const onSessionAdopted = vi.fn();
    const rendered = renderWithOperations(
      <NativeSessionsPane
        workspace={workspace}
        onChange={vi.fn()}
        onSessionAdopted={onSessionAdopted}
      />,
    );

    const row = await screen.findByTestId(`native-session-${source.executor}-${source.id}`);
    expect(row).toHaveTextContent('Replay the existing native conversation');
    expect(row).toHaveTextContent('fix/native-replay');
    expect(row).toHaveTextContent('4 turns');
    expect(row).toHaveTextContent('1.5 KB');

    await userEvent.click(screen.getByRole('button', { name: 'Adopt', exact: true }));
    await userEvent.type(screen.getByPlaceholderText('auto-generated'), 'Adopted conversation');
    await userEvent.click(within(screen.getByRole('heading', { name: 'Adopt as Gian session' }).closest('.adopt-dialog')!)
      .getByRole('button', { name: 'Adopt', exact: true }));

    await waitFor(() => expect(onSessionAdopted).toHaveBeenCalledWith(adopted));
    expect(adoptNativeSession).toHaveBeenCalledWith(workspace.id, {
      executor: source.executor,
      native_session_id: source.id,
      approval_mode: 'ask',
      name: 'Adopted conversation',
    });
    rendered.dispatcher.dispose();
  });

  it('keeps an adopt race error inside the dialog and does not navigate', async () => {
    vi.mocked(adoptNativeSession).mockResolvedValue({
      session: null,
      error: 'native session not found in this workspace',
    });
    const onSessionAdopted = vi.fn();
    const rendered = renderWithOperations(
      <NativeSessionsPane
        workspace={workspace}
        onChange={vi.fn()}
        onSessionAdopted={onSessionAdopted}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Adopt', exact: true }));
    await userEvent.click(within(screen.getByRole('heading', { name: 'Adopt as Gian session' }).closest('.adopt-dialog')!)
      .getByRole('button', { name: 'Adopt', exact: true }));

    expect(await screen.findByText('native session not found in this workspace')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Adopt as Gian session' })).toBeVisible();
    expect(onSessionAdopted).not.toHaveBeenCalled();
    rendered.dispatcher.dispose();
  });
});
