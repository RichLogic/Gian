import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@gian/shared';
import { KEY_BACKSPACE_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical';

import {
  Composer,
  injectComposerAttachment,
  injectComposerContextItems,
} from '../src/components/Composer.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { uploadAttachment } from '../src/api.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';
import { typeInlineComposer } from './inline-composer-test-utils.js';

const { pickResourcesMock } = vi.hoisted(() => ({ pickResourcesMock: vi.fn() }));

vi.mock('../src/desktop-bridge.js', () => ({
  desktopBridge: () => ({ resources: { pick: pickResourcesMock } }),
}));

vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
  loadSessionSlashCommands: vi.fn().mockResolvedValue([]),
  loadNativeConfig: vi.fn().mockResolvedValue(null),
  uploadAttachment: vi.fn(),
  // Imported by operations/session.js (pulled in via use-operations.js).
  dropSession: vi.fn(),
  mergeSession: vi.fn(),
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

function renderComposer(options: { session?: Session; variant?: 'full' | 'fixed' } = {}) {
  const onSend = vi.fn();
  const session = options.session ?? SESSION;
  // The Composer dispatches message.uploadAttachment through the operation
  // layer — mount the providers with a real (transport-less: REST op)
  // dispatcher, as App does.
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({ store });
  const view = render(
    <LocaleProvider locale="en">
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          <Composer
            session={session}
            variant={options.variant}
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
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>,
  );
  return { onSend, unmount: view.unmount };
}

describe('Composer file attachments', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(uploadAttachment).mockReset();
    pickResourcesMock.mockReset();
    pickResourcesMock.mockResolvedValue({ resources: [], rejectedFiles: [] });
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

    pickResourcesMock.mockResolvedValue({
      resources: [{
        type: 'file',
        name: 'notes.txt',
        mime: 'text/plain',
        size: 5,
        data: new Uint8Array(Buffer.from('hello')),
      }],
      rejectedFiles: [],
    });
    await user.click(screen.getByRole('button', { name: 'Add context' }));
    expect(screen.getByRole('button', { name: 'Files and folders' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Files and folders' }));

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledWith(
      'session-attachment',
      expect.objectContaining({ name: 'notes.txt', type: 'text/plain', size: 5 }),
      'notes.txt',
    ));
    await user.click(await screen.findByText('notes.txt'));
    // Clicking the chip opens the attachment popover (no thumbnail for text files).
    expect(document.querySelector('.ref-pop')).not.toBeNull();
    expect(document.querySelector('.ref-pop-thumb')).toBeNull();

    typeInlineComposer(screen.getByRole('textbox'), 'summarize it');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('summarize it', expect.objectContaining({
      attachments: [{
        path: '/tmp/gian/attachments/session-attachment/uuid.txt',
        name: 'notes.txt',
        mime: 'text/plain',
        size: 5,
        previewUrl: 'blob:attachment-preview',
      }],
      composerDocument: expect.objectContaining({
        segments: expect.arrayContaining([expect.objectContaining({ label: 'notes.txt' })]),
      }),
    }));
  });

  it('restores uploaded image attachments from the draft after a remount', async () => {
    vi.mocked(uploadAttachment).mockResolvedValue({
      path: '/tmp/gian/attachments/session-attachment/uuid.png',
      name: 'paste-1.png',
      size: 3,
      mime: 'image/png',
    });
    const first = renderComposer();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['img'], 'paste-1.png', { type: 'image/png' })] } });
    expect(await screen.findByText('paste-1.png')).toBeInTheDocument();

    // Switching away unmounts the composer; coming back must restore the chip
    // from the persisted draft, previewing via the host-served URL.
    first.unmount();
    renderComposer();
    await userEvent.click(await screen.findByText('paste-1.png'));
    await waitFor(() => {
      const img = document.querySelector('.ref-pop-thumb');
      expect(img?.getAttribute('src')).toBe('/api/sessions/session-attachment/attachments/uuid.png');
    });
    expect(screen.getAllByText('paste-1.png')).not.toHaveLength(0);
  });

  it('injects a completed screenshot into the exact mounted Composer and focuses it', async () => {
    renderComposer();
    const textbox = screen.getByRole('textbox');
    expect(textbox).not.toHaveFocus();

    act(() => injectComposerAttachment(SESSION.id, {
      path: '/tmp/gian/attachments/session-attachment/captured.png',
      name: 'screenshot.png',
      mime: 'image/png',
      size: 128,
    }));

    expect(await screen.findByText('screenshot.png')).toBeInTheDocument();
    await waitFor(() => expect(textbox).toHaveFocus());
    const persisted = JSON.parse(
      localStorage.getItem(`gian.composer.draft.v4.${SESSION.id}`) ?? 'null',
    );
    expect(persisted.attachments).toEqual([expect.objectContaining({
      path: '/tmp/gian/attachments/session-attachment/captured.png',
    })]);
  });

  it('turns a long paste into a persistent inline reference and sends it separately', async () => {
    const user = userEvent.setup();
    const { unmount } = renderComposer();
    const pasted = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n');
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [], getData: () => pasted },
    });

    const reference = document.querySelector('.composer-inline-reference[data-reference-type="context"]') as HTMLElement;
    expect(reference).not.toBeNull();
    await user.click(reference);
    expect(screen.getByText('Pasted text')).toBeInTheDocument();
    expect(screen.getByText(/12 lines/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveTextContent(reference.textContent ?? '');

    unmount();
    const second = renderComposer();
    expect(document.querySelector('.composer-inline-reference[data-reference-type="context"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(second.onSend).toHaveBeenCalledWith('', expect.objectContaining({
      contextItems: [expect.objectContaining({
        type: 'pastedText',
        text: pasted,
        lineCount: 12,
      })],
      composerDocument: expect.objectContaining({
        segments: expect.arrayContaining([expect.objectContaining({ referenceType: 'context' })]),
      }),
    }));
  });

  it('hydrates a selected-text card into a fixed Side Chat composer without auto-sending', async () => {
    const user = userEvent.setup();
    const sideChatSession = { ...SESSION, id: 'sc_selected_text' };
    const contextItem = {
      type: 'pastedText' as const,
      id: 'selected-context',
      text: 'exact selected response',
      lineCount: 1,
      byteSize: 23,
    };
    expect(injectComposerContextItems(sideChatSession.id, [contextItem])).toBe(true);

    const { onSend } = renderComposer({ session: sideChatSession, variant: 'fixed' });
    expect(screen.getByText('exact selected response')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('', expect.objectContaining({
      contextItems: [contextItem],
      composerDocument: expect.objectContaining({
        segments: expect.arrayContaining([expect.objectContaining({ id: 'selected-context' })]),
      }),
    }));
  });

  it('restores, expands, and sends a Browser element context card', async () => {
    const user = userEvent.setup();
    const contextItem = {
      type: 'browserElement' as const,
      id: 'browser-context',
      pageUrl: 'https://example.com/settings',
      pageTitle: 'Settings',
      tagName: 'button',
      selector: 'button[data-testid="save"]',
      role: 'button',
      name: 'Save',
      attributes: { 'data-testid': 'save' },
      contentOmitted: false,
      snippet: '<button data-testid="save">Save</button>',
    };
    expect(injectComposerContextItems(SESSION.id, [contextItem])).toBe(true);

    const { onSend } = renderComposer();
    await user.click(screen.getByText('Save'));
    // The chip opens a floating preview card with the capture details.
    expect(screen.getByText('Browser element')).toBeInTheDocument();
    expect(screen.getByText('button[data-testid="save"]')).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example.com\/settings/)).toBeInTheDocument();
    expect(screen.getByText(/<button data-testid="save">Save<\/button>/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('', expect.objectContaining({
      contextItems: [contextItem],
      composerDocument: expect.objectContaining({
        segments: expect.arrayContaining([expect.objectContaining({ id: 'browser-context' })]),
      }),
    }));
  });

  it('adds a folder as a path-only context item', async () => {
    const user = userEvent.setup();
    pickResourcesMock.mockResolvedValue({
      resources: [{ type: 'folder', path: '/tmp/example-folder', name: 'example-folder' }],
      rejectedFiles: [],
    });
    const { onSend } = renderComposer();

    await user.click(screen.getByRole('button', { name: 'Add context' }));
    await user.click(screen.getByRole('button', { name: 'Files and folders' }));
    const textbox = screen.getByRole('textbox');
    const editor = (textbox as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
    // Two-step delete: the first Backspace splices the trailing space and
    // selects the chip, the second deletes it.
    for (let i = 0; i < 2; i += 1) {
      act(() => editor?.dispatchCommand(
        KEY_BACKSPACE_COMMAND,
        new KeyboardEvent('keydown', { key: 'Backspace' }),
      ));
    }
    await waitFor(() => expect(screen.queryByText('example-folder')).toBeNull());
    act(() => editor?.dispatchCommand(UNDO_COMMAND, undefined));
    await user.click(await screen.findByText('example-folder'));
    expect(screen.getByText('/tmp/example-folder')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('', expect.objectContaining({
      contextItems: [expect.objectContaining({
        type: 'folder',
        path: '/tmp/example-folder',
        name: 'example-folder',
      })],
      composerDocument: expect.objectContaining({
        segments: expect.arrayContaining([expect.objectContaining({ referenceType: 'context' })]),
      }),
    }));
  });

  it('uploads an oversized paste as a text file instead of a context card', async () => {
    vi.mocked(uploadAttachment).mockResolvedValue({
      path: '/tmp/gian/attachments/session-attachment/pasted.txt',
      name: 'pasted.txt',
      size: 70_000,
      mime: 'text/plain',
    });
    renderComposer();
    const pasted = 'x'.repeat(70_000);
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [], getData: () => pasted },
    });

    await waitFor(() => expect(uploadAttachment).toHaveBeenCalled());
    expect(screen.queryByText('Pasted text')).not.toBeInTheDocument();
    const uploaded = vi.mocked(uploadAttachment).mock.calls[0]?.[1];
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded?.type).toBe('text/plain');
  });

  it('dedupes identical image names within one paste batch', async () => {
    vi.mocked(uploadAttachment).mockImplementation((_sessionId, file: File) => Promise.resolve({
      path: `/tmp/gian/attachments/session-attachment/${file.name}`,
      name: file.name,
      size: file.size,
      mime: file.type,
    }));
    renderComposer();
    // Clipboard screenshots arrive unnamed; one batch shares one timestamp.
    const unnamed = () => new File([new Uint8Array([1, 2])], '', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        items: [0, 1, 2].map(() => ({ kind: 'file', type: 'image/png', getAsFile: () => unnamed() })),
        getData: () => '',
      },
    });
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(3));
    const names = vi.mocked(uploadAttachment).mock.calls.map(call => (call[1] as File).name);
    // Unnamed files get fabricated paste-<ts> names; every name is unique
    // even when several land in the same millisecond.
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^paste-.+\.png$/);
  });

  it('dedupes a pasted image name against an already staged one', async () => {
    vi.mocked(uploadAttachment).mockImplementation((_sessionId, file: File) => Promise.resolve({
      path: `/tmp/gian/attachments/session-attachment/${file.name}`,
      name: file.name,
      size: file.size,
      mime: file.type,
    }));
    renderComposer();
    const pasteOne = () => fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }) }],
        getData: () => '',
      },
    });
    pasteOne();
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    pasteOne();
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
    const names = vi.mocked(uploadAttachment).mock.calls.map(call => (call[1] as File).name);
    expect(names).toEqual(['image.png', 'image-2.png']);
  });
});
