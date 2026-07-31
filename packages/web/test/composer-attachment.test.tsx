import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';

import { Composer } from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { uploadAttachment } from '../src/api.js';

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
  uploadAttachment: vi.fn(),
}));

const SESSION = {
  id: 'session-attachment',
  name: 'Attachment test',
  type: 'coding',
  workspace_id: 'workspace-1',
  executor: 'claude',
  model: null,
  approval_mode: 'ask',
  thinking_effort: null,
  active_channel: 'web',
  status: 'idle',
  archived: 0,
  worktree_path: null,
  branch: null,
  base_branch: null,
  worktree_outcome: null,
  native_session_id: 'native-1',
  service_tier: null,
  executor_config: { schemaVersion: 1, values: {} },
  native_config_options: [],
  created_at: '2026-07-30T00:00:00.000Z',
  updated_at: '2026-07-30T00:00:00.000Z',
} as Session;

function renderComposer() {
  const onSend = vi.fn();
  render(
    <LocaleProvider locale="en">
      <Composer
        session={SESSION}
        executor="claude"
        workspaceId="workspace-1"
        disabled={false}
        running={false}
        onSend={onSend}
        onSendSkill={vi.fn()}
        onStop={vi.fn()}
        onQueueAdd={vi.fn()}
        onSetMode={vi.fn()}
        onSetModel={vi.fn()}
        onSetEffort={vi.fn()}
      />
    </LocaleProvider>,
  );
  return { onSend };
}

describe('Composer file attachments', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(uploadAttachment).mockReset();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: vi.fn(() => 'blob:attachment-preview') },
      revokeObjectURL: { configurable: true, value: vi.fn() },
    });
  });

  it('enables the existing picker and sends an uploaded generic file', async () => {
    const user = userEvent.setup();
    vi.mocked(uploadAttachment).mockResolvedValue({
      path: '/tmp/gian/attachments/session-attachment/uuid.txt',
      name: 'notes.txt',
      size: 5,
      mime: 'text/plain',
    });
    const { onSend } = renderComposer();

    expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledWith(
      'session-attachment',
      file,
      'notes.txt',
    ));
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(document.querySelector('.att-file-icon')).not.toBeNull();
    expect(document.querySelector('.att-thumb')).toBeNull();

    await user.type(screen.getByRole('textbox'), 'summarize it');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('summarize it', {
      attachments: [{
        path: '/tmp/gian/attachments/session-attachment/uuid.txt',
        name: 'notes.txt',
        mime: 'text/plain',
        size: 5,
        previewUrl: 'blob:attachment-preview',
      }],
    });
  });
});
