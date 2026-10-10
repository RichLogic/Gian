import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import type { Session, TranslationRecord } from '@gian/shared';
import { SessionMain } from '../src/views/SessionMain.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { translateText } from '../src/operations/translation.js';
import { remoteRequest } from '../src/remote-environments.js';
import {
  createMessageEchoSink,
  dispatchMessageSend,
  wireMessageEchoSink,
} from '../src/operations/message.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import type { TranscriptItem } from '../src/types.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

vi.mock('../src/api.js', () => ({ loadAgents: vi.fn(async () => []), loadSessionTrace: vi.fn() }));
vi.mock('../src/remote-environments.js', () => ({ remoteRequest: vi.fn(async () => ({ status: 'ready' })) }));
vi.mock('../src/operations/translation.js', () => ({
  loadTranslationState: vi.fn(async () => ({ enabled: true, results: [], automatic: {},
    preferences: { sending_language: 'en', reading_language: 'zh-CN', agent_id: 'local-translator', model: 'luna' } })),
  translateText: vi.fn(async () => ({ id: 'local-translation-receipt' })),
  setAutoTranslation: vi.fn(), cancelTranslation: vi.fn(async () => {}),
}));
vi.mock('../src/components/Composer.js', () => ({
  discardComposerDraft: vi.fn(),
  Composer: ({ onSend }: { onSend: (text: string) => void }) => <button onClick={() => onSend('中文问题')}>Submit fixture</button>,
}));
vi.mock('../src/components/PlanChip.js', () => ({ PlanChip: () => null }));
vi.mock('../src/components/TurnDiffChip.js', () => ({ TurnDiffChip: () => null }));
vi.mock('../src/transcript/TranscriptMinimap.js', () => ({ TranscriptMinimap: () => null,
  TranscriptNavigation: () => <button>Navigation fixture</button> }));

afterEach(() => { cleanup(); vi.clearAllMocks(); wireMessageEchoSink(null); });

const noop = () => {};

type SendOptions = {
  translationId?: string;
  echoId?: string;
  translation?: TranslationRecord;
  [key: string]: unknown;
};

function renderMain(onSend: (text: string, options?: SendOptions) => void, remote = true) {
  const session = sessionContractFixture({
    id: 'local-conversation',
    status: 'done',
    ...(remote
      ? { remote_execution: { environment_id: 'remote-environment', worktree_root: '/remote/repository' } as NonNullable<Session['remote_execution']> }
      : {}),
  });
  render(<LocaleProvider locale="en"><SessionMain
    session={session} workspace={null} items={[]} hydrated pending={false} queue={[]}
    onSend={onSend} onSendSkill={noop} onStop={noop} onApprove={noop}
    onQueueAdd={noop} onQueueRemove={noop} onQueueUpdate={noop} onQueueClear={noop} onQueueSendNow={noop}
    onSteer={noop} onSetMode={noop} onSetModel={noop} onSetEffort={noop} onSetServiceTier={noop}
    onSetNativeConfig={noop} onShowLastTurnChanges={noop}
  /></LocaleProvider>);
  return session;
}

/** SessionMain with the production echo sink wired to React state, so the
 *  optimistic bubble renders through the real Transcript path. `onSend`
 *  re-enters the real dispatchMessageSend (stub transport) so adoption runs. */
function EchoHarness({ onSend }: { onSend: (text: string, options?: SendOptions) => void }) {
  const [session] = useState(() => sessionContractFixture({ id: 'local-conversation', status: 'done' }));
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [, setPendingBySession] = useState<Record<string, boolean>>({});
  const [dispatch] = useState(() => (
    vi.fn(() => ({ id: 'run-stub' })) as unknown as OperationDispatcher['dispatch']
  ));
  useEffect(() => {
    wireMessageEchoSink(createMessageEchoSink(setItemsBySession, setPendingBySession));
    return () => wireMessageEchoSink(null);
  }, []);
  return <LocaleProvider locale="en"><SessionMain
    session={session} workspace={null} items={itemsBySession[session.id] ?? []} hydrated pending={false} queue={[]}
    onSend={(text, options) => {
      onSend(text, options as SendOptions);
      dispatchMessageSend(dispatch, {
        sessionId: session.id, text, exec: session.executor,
        ...(options as SendOptions | undefined),
      });
    }}
    onSendSkill={noop} onStop={noop} onApprove={noop}
    onQueueAdd={noop} onQueueRemove={noop} onQueueUpdate={noop} onQueueClear={noop} onQueueSendNow={noop}
    onSteer={noop} onSetMode={noop} onSetModel={noop} onSetEffort={noop} onSetServiceTier={noop}
    onSetNativeConfig={noop} onShowLastTurnChanges={noop}
  /></LocaleProvider>;
}

it('enables the remote-session toggle and prepares translated sends through the local translation API', async () => {
  const onSend = vi.fn();
  renderMain(onSend);
  // The auto-translate toggle is a chip button (aria-pressed), not a switch.
  const chip = await screen.findByRole('button', { name: 'Auto translate' });
  await waitFor(() => expect(chip).not.toBeDisabled());
  expect(chip).toHaveAttribute('aria-pressed', 'true');
  const underbar = chip.closest('.main-underbar')!;
  expect(underbar).not.toBeNull();
  const nav = screen.getByRole('button', { name: 'Navigation fixture' });
  expect(chip.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Submit fixture' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('中文问题',
    expect.objectContaining({ translationId: 'local-translation-receipt' })));
  expect(translateText).toHaveBeenCalledWith('local-conversation', expect.objectContaining({ text: '中文问题', purpose: 'send' }),
    expect.any(AbortSignal), null);
  expect(vi.mocked(remoteRequest).mock.calls.every(([path]) => String(path).endsWith('/status'))).toBe(true);
});

it('shows the message immediately with an inline Translating row, then swaps in the sent translation', async () => {
  let resolveTranslation!: (value: TranslationRecord) => void;
  vi.mocked(translateText).mockImplementation(() => new Promise(resolve => { resolveTranslation = resolve; }));
  const onSend = vi.fn();
  render(<EchoHarness onSend={onSend} />);
  // Wait until the translation controller is ready, or the send no-ops.
  const chip = await screen.findByRole('button', { name: 'Auto translate' });
  await waitFor(() => expect(chip).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Submit fixture' }));
  // Optimistic up-screen: bubble + inline row before any dispatch happens.
  expect(await screen.findByText('中文问题')).toBeTruthy();
  expect(await screen.findByText('Translating')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send original' })).toBeTruthy();
  expect(onSend).not.toHaveBeenCalled();
  // No centered status bar anymore — progress lives under the bubble.
  expect(document.querySelector('.translation-send-status')).toBeNull();
  await act(async () => {
    resolveTranslation({
      id: 'tr-1', sessionId: 'local-conversation', sourceText: '中文问题',
      text: 'translated question', targetLanguage: 'en', agentId: 'local-translator', model: 'luna', purpose: 'send',
    });
  });
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('中文问题',
    expect.objectContaining({ translationId: 'tr-1' })));
  // The dispatch adopted the pending echo: one bubble, row replaced by the
  // sent-translation block.
  expect(document.querySelectorAll('.msg.user')).toHaveLength(1);
  expect(await screen.findByText('The translated text sent to the LM is shown below')).toBeTruthy();
  expect(screen.getByText('translated question')).toBeTruthy();
  expect(screen.queryByText('Translating')).toBeNull();
});

it('keeps the bubble in place on translation failure with in-place Retry / Send original', async () => {
  vi.mocked(translateText).mockRejectedValue(new Error('offline'));
  const onSend = vi.fn();
  render(<EchoHarness onSend={onSend} />);
  const chip = await screen.findByRole('button', { name: 'Auto translate' });
  await waitFor(() => expect(chip).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Submit fixture' }));
  expect(await screen.findByText('中文问题')).toBeTruthy();
  expect(await screen.findByText(/offline/)).toBeTruthy();
  expect(onSend).not.toHaveBeenCalled();

  // Retry reuses the same in-flight send.
  const record: TranslationRecord = {
    id: 'tr-2', sessionId: 'local-conversation', sourceText: '中文问题',
    text: 'translated question', targetLanguage: 'en', agentId: 'local-translator', model: 'luna', purpose: 'send',
  };
  vi.mocked(translateText).mockResolvedValue(record);
  fireEvent.click(screen.getByRole('button', { name: 'Retry translation' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('中文问题',
    expect.objectContaining({ translationId: 'tr-2' })));
  expect(await screen.findByText('translated question')).toBeTruthy();
  expect(document.querySelectorAll('.msg.user')).toHaveLength(1);
});

it('Send original skips the failed translation and dispatches the original text', async () => {
  vi.mocked(translateText).mockRejectedValue(new Error('offline'));
  const onSend = vi.fn();
  render(<EchoHarness onSend={onSend} />);
  const chip = await screen.findByRole('button', { name: 'Auto translate' });
  await waitFor(() => expect(chip).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Submit fixture' }));
  // Wait for the failure row (the pending row's same-named button is replaced).
  await screen.findByText(/offline/);
  fireEvent.click(screen.getByRole('button', { name: 'Send original' }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith('中文问题',
    expect.objectContaining({ translationId: 'original' })));
  // Adopted echo: the row is gone and no translation block is shown.
  expect(screen.queryByText('Send original')).toBeNull();
  expect(document.querySelectorAll('.msg.user')).toHaveLength(1);
  expect(screen.queryByText('The translated text sent to the LM is shown below')).toBeNull();
});
