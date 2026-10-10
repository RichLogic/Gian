import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_TRANSLATION_PREFERENCES, type SystemConfig, type TranslationRecord, type UserAgentStatus } from '@gian/shared';
import { ChatUiI18nProvider } from '@gian/chat-ui';
import { LocaleProvider } from '../src/i18n/index.js';
import { EN } from '../src/i18n/en.js';
import { Transcript } from '../src/transcript/Transcript.js';
import { AutoTranslationChip, TranslationButton, TranslationResult, TranslationSendRow, TranslatingIndicator } from '../src/translation/TranslationControls.js';
import { SettingsTranslation } from '../src/translation/SettingsTranslation.js';
import { useTranslation, type TranslationController } from '../src/translation/use-translation.js';
import { loadTranslationState, translateText, cancelTranslation, setAutoTranslation, translationCatalog } from '../src/operations/translation.js';
import { loadAgents } from '../src/api.js';
import {
  beginTranslationEcho,
  createMessageEchoSink,
  dispatchMessageSend,
  removeTranslationEcho,
  wireMessageEchoSink,
} from '../src/operations/message.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import type { MsgItem, TranscriptItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';

vi.mock('../src/operations/translation.js', () => ({
  loadTranslationState: vi.fn(), translateText: vi.fn(), cancelTranslation: vi.fn(async () => {}),
  setAutoTranslation: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
  translationCatalog: vi.fn(),
}));
vi.mock('../src/api.js', async () => ({
  ...await vi.importActual<typeof import('../src/api.js')>('../src/api.js'),
  loadAgents: vi.fn(),
}));

const record: TranslationRecord = {
  id: 'tr1', sessionId: 's1', sourceText: 'original', text: 'translated',
  targetLanguage: 'zh-CN', agentId: 'agent', model: 'luna', purpose: 'read', sourceId: 'turn:1',
};
const initial = { enabled: false, results: [], automatic: {}, preferences: { ...DEFAULT_TRANSLATION_PREFERENCES } };
const configured = { ...initial, preferences: { ...initial.preferences, agent_id: 'agent', model: 'luna' } };
function controller(): TranslationController {
  return { state: initial, ready: true, error: '', saving: false, sending: null,
    toggle: vi.fn(), read: vi.fn(), result: () => ({ pending: false }),
    isReadExpanded: () => false, toggleRead: vi.fn(),
    refresh: vi.fn(), retrySend: vi.fn(), finishSend: vi.fn(), prepareSend: vi.fn(), select: vi.fn(),
  } as unknown as TranslationController;
}
const wrap = (children: React.ReactNode) => <LocaleProvider locale="en">
  <ChatUiI18nProvider t={key => EN[key] ?? key}>{children}</ChatUiI18nProvider>
</LocaleProvider>;

afterEach(() => { cleanup(); vi.clearAllMocks(); wireMessageEchoSink(null); });

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

  it('a sendTranslation echo shows the Translating row even without controller send state (2026-10-09)', () => {
    // The new-session first message dispatches outside the controller, so
    // sending is null — the echo must still show the bare Translating row
    // instead of a bare greyed bubble.
    const translation = controller();
    const items: TranscriptItem[] = [{ kind: 'user', id: 'u', text: '原文', turn: 1, ts: 1, exec: 'codex',
      pending: true, sendTranslation: true }];
    render(wrap(<Transcript items={items} pending={false} onApprove={() => {}} translation={translation} />));
    expect(screen.getByRole('status')).toHaveTextContent(/Translating/);
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
    expect(translation.toggleRead).toHaveBeenCalledWith('final result', 'turn:1');
  });

  it('the new-session / underbar auto-translate control is a shared icon-only chip', () => {
    const onClick = vi.fn();
    render(wrap(<AutoTranslationChip on={false} title="Auto translate" onClick={onClick} testId="chip" />));
    const chip = screen.getByTestId('chip');
    expect(chip).toHaveClass('translation-auto');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveAttribute('title', 'Auto translate');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip.textContent).toBe('');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('refuses to enable automatic translation without an Agent and model', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(initial);
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await result.current.toggle(true); });
    expect(result.current.state.enabled).toBe(false);
    expect(result.current.error).toContain('Choose an available local translation Agent');
    expect(setAutoTranslation).not.toHaveBeenCalled();
  });

  it('reading toggle follows the auto-translate switch by default and respects manual override', async () => {
    // 2026-10-09 (owner): with auto-translate on, a reply's 文A starts
    // selected so the automatic translation renders expanded on arrival.
    vi.mocked(loadTranslationState).mockResolvedValue({ ...configured, enabled: true });
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.isReadExpanded('turn:1')).toBe(true);
    act(() => { result.current.toggleRead('reply text', 'turn:1'); });
    expect(result.current.isReadExpanded('turn:1')).toBe(false);
    act(() => { result.current.toggleRead('reply text', 'turn:1'); });
    expect(result.current.isReadExpanded('turn:1')).toBe(true);
  });

  it('reading toggle defaults to collapsed when auto-translate is off', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue({ ...configured, enabled: false });
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.isReadExpanded('turn:1')).toBe(false);
    act(() => { result.current.toggleRead('reply text', 'turn:1'); });
    expect(result.current.isReadExpanded('turn:1')).toBe(true);
  });

  it('refreshes a deleted translation Agent instead of keeping its stale model picker', async () => {
    const oldAgent = { id: 'old-agent', name: 'Codex', pluginId: 'codex', ready: true, enabled: true } as UserAgentStatus;
    const currentAgent = { ...oldAgent, id: 'current-agent' };
    vi.mocked(loadAgents).mockResolvedValueOnce([oldAgent]).mockResolvedValue([currentAgent]);
    vi.mocked(translationCatalog).mockRejectedValueOnce(new Error('agent not found: old-agent'));
    const config = { translation: {
      sending_language: 'en', reading_language: 'zh-CN', agent_id: oldAgent.id, model: '',
    } } as SystemConfig;
    const onPatch = vi.fn();
    render(wrap(<SettingsTranslation config={config} onPatch={onPatch} />));
    await waitFor(() => expect(translationCatalog).toHaveBeenCalledWith('codex', oldAgent.id));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Codex' })).toHaveValue(currentAgent.id));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Agent unavailable'));
    expect(screen.getByLabelText('Translation model')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Local translation Agent'), { target: { value: currentAgent.id } });
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ translation: {
      ...config.translation, agent_id: currentAgent.id, model: '',
    } }));
    expect(loadAgents).toHaveBeenCalledWith({ refresh: true });
  });

  it('keeps a failed reading translation retryable without replacing the source', () => {
    const retry = vi.fn();
    render(wrap(<TranslationResult value={{ pending: false, error: 'offline' }} expanded onRetry={retry} />));
    fireEvent.click(screen.getByRole('button', { name: 'Retry translation' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while collapsed — even with a cached record — and has no collapse/copy chrome when expanded', () => {
    const retry = vi.fn();
    const { rerender } = render(wrap(<TranslationResult value={{ pending: false, record }} expanded={false} onRetry={retry} />));
    expect(document.querySelector('.translation-block')).toBeNull();
    rerender(wrap(<TranslationResult value={{ pending: false, record }} expanded onRetry={retry} />));
    const block = document.querySelector('.translation-block')!;
    expect(block).not.toBeNull();
    expect(within(block as HTMLElement).getByText('Translation · 简体中文')).toBeTruthy();
    expect(within(block as HTMLElement).getByText('translated')).toBeTruthy();
    expect(within(block as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('the shared Translating indicator is three permanent dots, not a cycling ellipsis', () => {
    const { container } = render(wrap(<TranslatingIndicator />));
    expect(screen.getByText('Translating')).toBeTruthy();
    expect(container.querySelectorAll('.translation-dots > span')).toHaveLength(3);
    expect(container.querySelector('.translation-dots')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows only the indicator while a reply translation is pending — no duplicated heading (2026-10-09)', () => {
    const { container } = render(wrap(<TranslationResult value={{ pending: true }} expanded onRetry={() => {}} />));
    expect(container.querySelector('.translation-pending')).not.toBeNull();
    expect(container.querySelector('.translation-heading')).toBeNull();
  });

  it('the send row offers Send original while translating and Retry / Send original on failure', () => {
    const translation = controller();
    translation.sending = { pending: true };
    const { rerender } = render(wrap(<TranslationSendRow controller={translation} />));
    expect(screen.getByText('Translating')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send original' }));
    expect(translation.finishSend).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Retry translation' })).toBeNull();

    translation.sending = { pending: false, error: 'offline' };
    rerender(wrap(<TranslationSendRow controller={translation} />));
    expect(screen.getByText('offline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry translation' }));
    expect(translation.retrySend).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Send original' }));
    expect(translation.finishSend).toHaveBeenCalledWith(true);
  });

  it('retains a failed send until the user explicitly chooses the original', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('original')!; });
    await waitFor(() => expect(result.current.sending?.error).toContain('offline'));
    let completed = false;
    void sent.then(() => { completed = true; });
    expect(completed).toBe(false);
    act(() => result.current.finishSend(true));
    await expect(sent).resolves.toBe('original');
    expect(translateText).toHaveBeenCalledTimes(1);
  });

  it('resolves a completed translation with the full record so the echo can show it before the canonical message', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    const sentRecord: TranslationRecord = { ...record, id: 'tr-send', purpose: 'send' };
    vi.mocked(translateText).mockResolvedValue(sentRecord);
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('original')!; });
    await act(async () => { await sent; });
    await expect(sent).resolves.toBe(sentRecord);
    expect(result.current.sending).toBeNull();
  });

  it('refuses to start a second translated send while one is in flight', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let first!: Promise<TranslationRecord | 'original'>;
    act(() => { first = result.current.prepareSend('first')!; });
    // The in-flight send is cancelled by the unmount cleanup — swallow it.
    void first.catch(() => {});
    await waitFor(() => expect(result.current.sending?.pending).toBe(true));
    expect(result.current.prepareSend('second')).toBeNull();
  });

  it('cancels translation work on unmount without dispatching a main-model message', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    vi.mocked(translateText).mockImplementation((_session, _input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { result, unmount } = renderHook(() => useTranslation('s1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let sent!: Promise<TranslationRecord | 'original'>;
    act(() => { sent = result.current.prepareSend('original')!; });
    const rejected = expect(sent).rejects.toThrow('cancelled');
    unmount();
    await rejected;
    expect(cancelTranslation).toHaveBeenCalledTimes(1);
  });
});

describe('文A reading toggle', () => {
  function ToggleHarness() {
    const translation = useTranslation('s1');
    return <Transcript items={[
      { kind: 'assistant', id: 'result', text: 'final result', turn: 1, ts: 3, exec: 'codex' },
      { kind: 'turn-end', id: 'end', text: 'done', turn: 1, ts: 4, outcome: 'worked' },
    ]} pending={false} onApprove={() => {}} translation={translation} />;
  }

  it('expands with Translating dots, swaps in the record, and collapses again', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue(configured);
    let resolveRead!: (value: TranslationRecord) => void;
    vi.mocked(translateText).mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    render(wrap(<ToggleHarness />));
    const toggle = await screen.findByRole('button', { name: 'Translate to 简体中文' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.translation-block')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveClass('on');
    expect(translateText).toHaveBeenCalledWith('s1',
      expect.objectContaining({ text: 'final result', purpose: 'read', sourceId: 'turn:1' }),
      expect.any(AbortSignal), null);
    const pending = await screen.findByText('Translating');
    const block = pending.closest('.translation-block')!;
    expect(block.querySelectorAll('.translation-dots > span')).toHaveLength(3);
    await act(async () => { resolveRead({ ...record, sourceId: 'turn:1', sourceText: 'final result' }); });
    expect(await screen.findByText('translated')).toBeTruthy();
    expect(screen.getByText('Translation · 简体中文')).toBeTruthy();
    expect(screen.queryByText('Translating')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('translated')).toBeNull();
  });

  it('stays collapsed by default when a cached record exists, then expands instantly from cache', async () => {
    vi.mocked(loadTranslationState).mockResolvedValue({
      ...configured, results: [{ ...record, sourceText: 'final result' }],
    });
    render(wrap(<ToggleHarness />));
    const toggle = await screen.findByRole('button', { name: 'Translate to 简体中文' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    // Cached record, but the toggle owns visibility: nothing renders yet.
    expect(screen.queryByText('translated')).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText('translated')).toBeTruthy();
    expect(translateText).not.toHaveBeenCalled();
  });
});

describe('translated send echo lifecycle', () => {
  let itemsBox: Record<string, TranscriptItem[]>;
  let pendingBox: Record<string, boolean>;
  function wireSink() {
    wireMessageEchoSink(createMessageEchoSink(
      update => { itemsBox = update(itemsBox); },
      update => { pendingBox = update(pendingBox); },
    ));
  }
  function stubDispatch() {
    return vi.fn(() => ({ id: 'run-1' })) as unknown as OperationDispatcher['dispatch'];
  }

  it('appends the optimistic echo before dispatch (no session spinner), adopts it on send, and the canonical user_message replaces it exactly once', () => {
    itemsBox = {}; pendingBox = {};
    wireSink();
    const echo = beginTranslationEcho({ sessionId: 's1', text: '原文', exec: 'codex' })!;
    expect(itemsBox.s1).toHaveLength(1);
    expect(itemsBox.s1![0]).toMatchObject({ kind: 'user', text: '原文', pending: true, sendTranslation: true });
    // The session spinner must wait for the real dispatch — translation is not a turn.
    expect(pendingBox.s1).toBeUndefined();

    const dispatch = stubDispatch();
    dispatchMessageSend(dispatch, {
      sessionId: 's1', text: '原文', exec: 'codex', echoId: echo.id,
      translationId: 'tr1', translation: { ...record, purpose: 'send' },
    });
    expect(dispatch).toHaveBeenCalledWith('message.send', expect.objectContaining({ translationId: 'tr1' }));
    // Adopted in place — no duplicate bubble.
    expect(itemsBox.s1).toHaveLength(1);
    const adopted = itemsBox.s1![0] as MsgItem;
    expect(adopted.id).toBe(echo.id);
    expect(adopted.sendTranslation).toBeUndefined();
    expect(adopted.sendRunId).toBe('run-1');
    expect(adopted.translation?.text).toBe('translated');
    expect(pendingBox.s1).toBe(true);

    const after = applyEnvelope(itemsBox.s1!, {
      type: 'event', session_id: 's1', call_id: 'canonical', event: 'user_message', turn: 1, ts: echo.ts + 1,
      data: { text: '原文', send_id: adopted.sendRetry!.sendId, translation: { ...record, purpose: 'send' } },
    }, 'codex');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: 'canonical', pending: true, sendCanonical: true,
      text: '原文', translation: { text: 'translated' },
    });
  });

  it('drops the echo when the translation is abandoned before dispatch', () => {
    itemsBox = {}; pendingBox = {};
    wireSink();
    const echo = beginTranslationEcho({ sessionId: 's1', text: '原文', exec: 'codex' })!;
    removeTranslationEcho('s1', echo.id);
    expect(itemsBox.s1).toEqual([]);
  });

  it('falls back to a fresh echo when the pre-dispatch echo is gone', () => {
    itemsBox = {}; pendingBox = {};
    wireSink();
    const dispatch = stubDispatch();
    dispatchMessageSend(dispatch, { sessionId: 's1', text: '原文', exec: 'codex', echoId: 'missing' });
    expect(itemsBox.s1).toHaveLength(1);
    expect(itemsBox.s1![0]).toMatchObject({ kind: 'user', text: '原文', pending: true, sendRunId: 'run-1' });
  });

  it('without a wired sink the send flow degrades to the pre-echo behavior', () => {
    wireMessageEchoSink(null);
    expect(beginTranslationEcho({ sessionId: 's1', text: '原文', exec: 'codex' })).toBeNull();
    const dispatch = stubDispatch();
    dispatchMessageSend(dispatch, { sessionId: 's1', text: '原文', exec: 'codex', echoId: 'ignored' });
    expect(dispatch).toHaveBeenCalledWith('message.send', expect.objectContaining({ text: '原文' }));
  });

  it('never double-appends when React defers the echo updater (2026-10-09 lane race)', () => {
    // The old adopt() read a `found` flag set from INSIDE the state updater;
    // when React skipped eager evaluation (the dispatch had already scheduled
    // a lane on the owning fiber) the flag stayed false and the fallback
    // appended a second bubble — the duplicated translated-send pair. Wire a
    // sink whose setters QUEUE updates without running them: adoption must
    // still resolve to exactly one bubble.
    const queued: Array<(prev: Record<string, TranscriptItem[]>) => Record<string, TranscriptItem[]>> = [];
    wireMessageEchoSink(createMessageEchoSink(
      update => { queued.push(update); },
      update => { update({}); },
    ));
    const echo = beginTranslationEcho({ sessionId: 's1', text: '原文', exec: 'codex' })!;
    const dispatch = stubDispatch();
    dispatchMessageSend(dispatch, {
      sessionId: 's1', text: '原文', exec: 'codex', echoId: echo.id,
      translationId: 'tr1', translation: { ...record, purpose: 'send' },
    });
    const final = queued.reduce<Record<string, TranscriptItem[]>>((state, update) => update(state), {});
    expect(final.s1).toHaveLength(1);
    expect(final.s1![0]).toMatchObject({ id: echo.id, sendRunId: 'run-1' });
  });
});
