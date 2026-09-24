import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { DEFAULT_TRANSLATION_PREFERENCES, type TranslationRecord } from '@gian/shared';
import { ChatUiI18nProvider } from '@gian/chat-ui';
import { LocaleProvider } from '../src/i18n/index.js';
import { EN } from '../src/i18n/en.js';
import { Transcript } from '../src/transcript/Transcript.js';
import { AutoTranslationChip, TranslationButton, TranslationResult } from '../src/translation/TranslationControls.js';
import { useTranslation, type TranslationController } from '../src/translation/use-translation.js';
import { loadTranslationState, translateText, cancelTranslation } from '../src/operations/translation.js';
import type { TranscriptItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';

vi.mock('../src/operations/translation.js', () => ({
  loadTranslationState: vi.fn(), translateText: vi.fn(), cancelTranslation: vi.fn(async () => {}),
  setAutoTranslation: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
}));

const record: TranslationRecord = {
  id: 'tr1', sessionId: 's1', sourceText: 'original', text: 'translated',
  targetLanguage: 'zh-CN', agentId: 'agent', model: 'luna', purpose: 'read', sourceId: 'turn:1',
};
const initial = { enabled: false, results: [], automatic: {}, preferences: { ...DEFAULT_TRANSLATION_PREFERENCES } };
function controller(): TranslationController {
  return { state: initial, ready: true, error: '', saving: false, sending: null,
    toggle: vi.fn(), read: vi.fn(), result: () => ({ pending: false }),
    refresh: vi.fn(), retrySend: vi.fn(), finishSend: vi.fn(), prepareSend: vi.fn(), select: vi.fn(),
  } as unknown as TranslationController;
}
const wrap = (children: React.ReactNode) => <LocaleProvider locale="en">
  <ChatUiI18nProvider t={key => EN[key] ?? key}>{children}</ChatUiI18nProvider>
</LocaleProvider>;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('translation surfaces', () => {
  it('substitutes the reading language in the translation action label', () => {
    const translation = controller();
    translation.state = { ...initial, preferences: { ...initial.preferences, reading_language: 'en' } };
    render(wrap(<TranslationButton controller={translation} item={{ kind: 'assistant', id: 'result',
      text: 'source', exec: 'codex', turn: 1, ts: 1 }} />));
    expect(screen.getByRole('button', { name: 'Translate to English' })).toHaveAttribute('title', 'Translate to English');
  });
  it('hydrates a translated send into the original optimistic bubble without duplicates', () => {
    const echo: TranscriptItem = { kind: 'user', id: 'echo', text: 'original', exec: 'codex', turn: 0, ts: 1, pending: true };
    const items = applyEnvelope([echo], {
      type: 'event', session_id: 's1', call_id: 'canonical', event: 'user_message', turn: 1, ts: 2,
      data: { text: 'original', translation: { ...record, purpose: 'send' } },
    }, 'codex');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'original', translation: { text: 'translated' } });
  });
  it('preserves the original user bubble and shows the exact sent translation', () => {
    const items: TranscriptItem[] = [{ kind: 'user', id: 'u', text: 'original', turn: 1, ts: 1, exec: 'codex',
      translation: { ...record, purpose: 'send' } }];
    render(wrap(<Transcript items={items} pending={false} onApprove={() => {}} />));
    expect(screen.getByText('original')).toBeTruthy();
    expect(screen.getByText('translated')).toBeTruthy();
    expect(screen.getByText('The translated text sent to the LM is shown below')).toBeTruthy();
  });

  it('adds translation only to the terminal Result, not process text or thinking', () => {
    const translation = controller();
    const items: TranscriptItem[] = [
      { kind: 'assistant', id: 'process', text: 'process narration', turn: 1, ts: 1, exec: 'codex' },
      { kind: 'reasoning', id: 'thinking', text: 'private reasoning', variant: 'summary', turn: 1, ts: 2 },
      { kind: 'assistant', id: 'result', text: 'final result', turn: 1, ts: 3, exec: 'codex' },
      { kind: 'turn-end', id: 'end', text: 'done', turn: 1, ts: 4, outcome: 'worked' },
    ];
    render(wrap(<Transcript items={items} pending={false} onApprove={() => {}} translation={translation} />));
    const buttons = screen.getAllByRole('button', { name: /Translate to/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(translation.read).toHaveBeenCalledWith('final result', 'turn:1');
  });

  it('does not translate existing results just because automatic mode is enabled', () => {
    const translation = controller();
    render(wrap(<AutoTranslationChip controller={translation} />));
    const toggle = screen.getByRole('button', { name: 'Auto translate' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(translation.toggle).toHaveBeenCalledWith(true);
    expect(translation.read).not.toHaveBeenCalled();
  });

  it('keeps a failed reading translation retryable without replacing the source', () => {
    const retry = vi.fn();
    render(wrap(<TranslationResult value={{ pending: false, error: 'offline' }} onRetry={retry} />));
    fireEvent.click(screen.getByRole('button', { name: 'Retry translation' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('retains a failed send until the user explicitly chooses the original', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(initial);
    vi.mocked(translateText).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let sent!: Promise<string>;
    act(() => { sent = result.current.prepareSend('original'); });
    await waitFor(() => expect(result.current.sending?.error).toContain('offline'));
    let completed = false;
    void sent.then(() => { completed = true; });
    expect(completed).toBe(false);
    act(() => result.current.finishSend(true));
    await expect(sent).resolves.toBe('original');
    expect(translateText).toHaveBeenCalledTimes(1);
  });

  it('cancels translation work on unmount without dispatching a main-model message', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(initial);
    vi.mocked(translateText).mockImplementation((_session, _input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { result, unmount } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let sent!: Promise<string>;
    act(() => { sent = result.current.prepareSend('original'); });
    const rejected = expect(sent).rejects.toThrow('cancelled');
    unmount();
    await rejected;
    expect(cancelTranslation).toHaveBeenCalledTimes(1);
  });
});
