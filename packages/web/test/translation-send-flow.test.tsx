import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { DEFAULT_TRANSLATION_PREFERENCES, type TranslationRecord } from '@gian/shared';
import { ChatUiI18nProvider } from '@gian/chat-ui';
import { LocaleProvider } from '../src/i18n/index.js';
import { EN } from '../src/i18n/en.js';
import { useTranslation } from '../src/translation/use-translation.js';
import { TranslationSendRow } from '../src/translation/TranslationControls.js';
import { SEND_TRANSLATE_TIMEOUT_MS } from '../src/translation/send-timeout.js';
import { loadTranslationState, translateText, cancelTranslation } from '../src/operations/translation.js';
import { getSnapshot, __resetFeedback } from '../src/feedback.js';

vi.mock('../src/operations/translation.js', () => ({
  loadTranslationState: vi.fn(), translateText: vi.fn(), cancelTranslation: vi.fn(async () => {}),
  setAutoTranslation: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
  translationCatalog: vi.fn(),
}));

const configured = {
  enabled: true, results: [], automatic: {},
  preferences: { ...DEFAULT_TRANSLATION_PREFERENCES, agent_id: 'agent', model: 'luna' },
};
const sentRecord: TranslationRecord = {
  id: 'tr-send', sessionId: 's1', sourceText: '你好', text: 'hello',
  targetLanguage: 'en', agentId: 'agent', model: 'luna', purpose: 'send',
};
const PENDING_KEY = 'gian.translation.pending-send.v1.s1';
const DRAFT_KEY = 'gian.composer.draft.v4.s1';
const wrap = (children: React.ReactNode) => <LocaleProvider locale="en">
  <ChatUiI18nProvider t={key => EN[key] ?? key}>{children}</ChatUiI18nProvider>
</LocaleProvider>;

function draftText(): string | null {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as { text?: string }).text ?? null;
}

beforeEach(() => {
  localStorage.clear();
  __resetFeedback();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  __resetFeedback();
});

describe('translated send state machine', () => {
  it('prepareSend persists the text and a successful translation clears the record', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockResolvedValue(sentRecord);
    const { result } = renderHook(() => useTranslation('s1'));
    await act(async () => {});
    expect(result.current.ready).toBe(true);

    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('你好')!; });
    expect(JSON.parse(localStorage.getItem(PENDING_KEY)!)).toMatchObject({ text: '你好' });

    await act(async () => { await sent; });
    await expect(sent).resolves.toBe(sentRecord);
    expect(result.current.sending).toBeNull();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('times out a hung provider into the failed phase without settling the send', async () => {
    vi.useFakeTimers();
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    // Hangs forever and ignores abort — the crashed-provider case.
    vi.mocked(translateText).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useTranslation('s1'));
    await act(async () => {});
    expect(result.current.ready).toBe(true);

    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('你好')!; });
    void sent.catch(() => {});
    expect(result.current.sending).toEqual({ phase: 'translating' });

    await act(async () => { vi.advanceTimersByTime(SEND_TRANSLATE_TIMEOUT_MS); });
    expect(result.current.sending).toMatchObject({ phase: 'failed', timedOut: true });
    expect(cancelTranslation).toHaveBeenCalledTimes(1);

    // The send promise must NOT settle on timeout — the user decides next.
    let settled = false;
    void sent.then(() => { settled = true; }, () => { settled = true; });
    await act(async () => {});
    expect(settled).toBe(false);
    // The text survives the timeout for a later decision.
    expect(localStorage.getItem(PENDING_KEY)).toContain('你好');

    render(wrap(<TranslationSendRow controller={result.current} />));
    expect(screen.getByRole('alert')).toHaveTextContent('Translation timed out after 45s.');
  });

  it('after a timeout, retry succeeds and clears the record', async () => {
    vi.useFakeTimers();
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useTranslation('s1'));
    await act(async () => {});

    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('你好')!; });
    await act(async () => { vi.advanceTimersByTime(SEND_TRANSLATE_TIMEOUT_MS); });
    expect(result.current.sending).toMatchObject({ phase: 'failed', timedOut: true });

    vi.mocked(translateText).mockResolvedValue(sentRecord);
    await act(async () => { await result.current.retrySend(); });
    await expect(sent).resolves.toBe(sentRecord);
    expect(result.current.sending).toBeNull();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('after a timeout, send original resolves the send and clears the record', async () => {
    vi.useFakeTimers();
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useTranslation('s1'));
    await act(async () => {});

    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('你好')!; });
    await act(async () => { vi.advanceTimersByTime(SEND_TRANSLATE_TIMEOUT_MS); });
    expect(result.current.sending).toMatchObject({ phase: 'failed', timedOut: true });

    act(() => result.current.finishSend(true));
    await expect(sent).resolves.toBe('original');
    expect(result.current.sending).toBeNull();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('reclaimSend hands the text back to the composer draft and rejects the send', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useTranslation('s1'));
    await act(async () => {});

    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('give me back')!; });
    expect(localStorage.getItem(PENDING_KEY)).toContain('give me back');

    const rejected = expect(sent).rejects.toThrow('reclaimed');
    act(() => result.current.reclaimSend());
    await rejected;
    expect(draftText()).toBe('give me back');
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(result.current.sending).toBeNull();
    expect(cancelTranslation).toHaveBeenCalledTimes(1);
  });

  it('restores a leftover pending-send record into the composer exactly once', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    localStorage.setItem(PENDING_KEY, JSON.stringify({ text: 'lost words', at: Date.now() }));

    const first = renderHook(() => useTranslation('s1'));
    await act(async () => {});
    expect(draftText()).toBe('lost words');
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(getSnapshot().toasts.map(toast => toast.message))
      .toContain('The unsent text was restored to the composer.');

    // A second mount must not inject again — the record is consumed.
    first.unmount();
    localStorage.removeItem(DRAFT_KEY);
    __resetFeedback();
    renderHook(() => useTranslation('s1'));
    await act(async () => {});
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(getSnapshot().toasts).toHaveLength(0);
  });

  it('unmount with an in-flight send rejects the promise but keeps the durable record', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockImplementation((_session, _input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { result, unmount } = renderHook(() => useTranslation('s1'));
    await act(async () => {});

    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('do not lose me')!; });
    expect(localStorage.getItem(PENDING_KEY)).toContain('do not lose me');

    const rejected = expect(sent).rejects.toThrow('cancelled');
    unmount();
    await rejected;
    expect(localStorage.getItem(PENDING_KEY)).toContain('do not lose me');
  });
});
