import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadClaudeMd, saveClaudeMd } from '../src/api.js';
import { __resetFeedback, getSnapshot } from '../src/feedback.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
import '../src/operations/workspace.js';
import { createOperationStore } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
} from '../src/operations/use-operations.js';
import { ClaudeMdInspector } from '../src/views/SpacesView.js';
import { FakeOperationTransport } from './operation-test-utils.js';

vi.mock('../src/api.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    loadClaudeMd: vi.fn(),
    saveClaudeMd: vi.fn(),
  };
});

function renderInspector() {
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({
    store,
    transport: new FakeOperationTransport(),
  });
  const rendered = render(
    <LocaleProvider locale="en">
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          <ClaudeMdInspector
            workspaceId="workspace-notes"
            workspaceName="Notes workspace"
            onClose={vi.fn()}
          />
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>,
  );
  return { ...rendered, dispatcher };
}

describe('SPACE-004: CLAUDE.md inspector recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFeedback();
  });

  afterEach(() => __resetFeedback());

  it('shows a read failure instead of an empty editable file, then retries', async () => {
    vi.mocked(loadClaudeMd)
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce('# original notes\n');
    const { dispatcher } = renderInspector();

    const alert = await screen.findByTestId('claude-md-load-error');
    expect(alert).toHaveTextContent('permission denied');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save|保存/ })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('textbox')).toHaveValue('# original notes\n');
    expect(screen.queryByTestId('claude-md-load-error')).not.toBeInTheDocument();
    expect(loadClaudeMd).toHaveBeenCalledTimes(2);
    dispatcher.dispose();
  });

  it('keeps the edited buffer dirty and retryable when save fails', async () => {
    vi.mocked(loadClaudeMd).mockResolvedValue('# original notes\n');
    vi.mocked(saveClaudeMd)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { dispatcher } = renderInspector();
    const editor = await screen.findByRole('textbox');

    await userEvent.clear(editor);
    await userEvent.type(editor, '# changed notes');
    await userEvent.click(screen.getByRole('button', { name: /Save|保存/ }));

    await waitFor(() => {
      expect(getSnapshot().toasts).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'error', message: 'Save failed' }),
      ]));
    });
    expect(editor).toHaveValue('# changed notes');
    expect(screen.getByRole('button', { name: /Save|保存/ })).toBeEnabled();
    expect(saveClaudeMd).toHaveBeenCalledWith('workspace-notes', '# changed notes');

    await userEvent.click(screen.getByRole('button', { name: /Save|保存/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Save|保存/ })).toBeDisabled();
    });
    expect(editor).toHaveValue('# changed notes');
    expect(screen.getByText('已保存')).toBeInTheDocument();
    expect(saveClaudeMd).toHaveBeenCalledTimes(2);
    dispatcher.dispose();
  });
});
