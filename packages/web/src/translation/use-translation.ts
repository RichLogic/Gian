import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_TRANSLATION_PREFERENCES, isTranslationConfigured, type ComposerDocument, type TranslationRecord } from '@gian/shared';
import { cancelTranslation, loadTranslationState, setAutoTranslation, translateText, type TranslationState } from '../operations/translation.js';
import { useOperationDispatchOptional } from '../operations/use-operations.js';
import { useT } from '../i18n/index.js';
import { injectComposerDraft } from '../components/Composer.js';
import { toast } from '../feedback.js';
import { SEND_TRANSLATE_TIMEOUT_MS, withSendTimeout } from './send-timeout.js';

export interface ReadingTranslation { pending: boolean; record?: TranslationRecord; error?: string }
/** Resolved once a translated send may dispatch: the TranslationRecord whose
 *  id the Host expects, or 'original' when the user chose to skip translation. */
export type SendOutcome = TranslationRecord | 'original';
/** Explicit send-gate phase: the send promise stays unsettled across
 *  'translating' and 'failed' — only the user (retry / send original /
 *  reclaim) or a successful translation settles it. */
export type SendPhase = { phase: 'translating' } | { phase: 'failed'; error: string; timedOut: boolean };
interface SendRequest {
  text: string; document?: ComposerDocument;
  resolve: (outcome: SendOutcome) => void; reject: (error: Error) => void;
}

/** Durability for the composed text while a translated send is gated: the
 *  record survives session switches and crashes so a later mount can restore
 *  it into the composer draft (restore-exactly-once, then the key is gone). */
const PENDING_SEND_KEY_PREFIX = 'gian.translation.pending-send.v1.';
const pendingSendKey = (sessionId: string) => `${PENDING_SEND_KEY_PREFIX}${sessionId}`;
interface PendingSendRecord { text: string; document?: ComposerDocument; at: number }
function writePendingSend(sessionId: string, record: PendingSendRecord): void {
  try { localStorage.setItem(pendingSendKey(sessionId), JSON.stringify(record)); } catch { /* ephemeral */ }
}
function clearPendingSend(sessionId: string): void {
  try { localStorage.removeItem(pendingSendKey(sessionId)); } catch { /* ephemeral */ }
}
function readPendingSend(sessionId: string): PendingSendRecord | null {
  try {
    const raw = localStorage.getItem(pendingSendKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSendRecord>;
    return typeof parsed.text === 'string' && parsed.text
      ? { text: parsed.text, document: parsed.document, at: typeof parsed.at === 'number' ? parsed.at : 0 }
      : null;
  } catch { return null; }
}

export function useTranslation(sessionId: string) {
  const t = useT();
  const dispatch = useOperationDispatchOptional();
  const [state, setState] = useState<TranslationState>({ enabled: false, results: [], automatic: {}, preferences: { ...DEFAULT_TRANSLATION_PREFERENCES } });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState<Record<string, ReadingTranslation>>({});
  /** Ephemeral per-message override of the reading toggle (文A): page-level
   *  only, deliberately NOT persisted. The DEFAULT follows the session's
   *  auto-translate switch — with it on, a reply's translation renders
   *  expanded on arrival (2026-10-09 owner: the toggle used to start collapsed
   *  even for auto-translated replies); a manual click overrides in either
   *  direction until the session remounts. */
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<SendPhase | null>(null);
  const sendRef = useRef<SendRequest | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  const sendId = useRef<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await loadTranslationState(sessionId);
      if (!next?.preferences || !Array.isArray(next.results)) throw new Error('Translation settings are unavailable.');
      if (alive.current) {
        setState(next);
        setReady(true);
        setError(next.enabled && !isTranslationConfigured(next.preferences) ? t('translation.configureFirst') : '');
      }
    } catch (error) { if (alive.current) setError(String(error)); }
  }, [sessionId, t]);
  useEffect(() => {
    alive.current = true;
    // Turn-keyed expand/collapse overrides are per-session (turn:1 exists in
    // every session) and ephemeral by design — a fresh mount returns to the
    // auto-translate default.
    setExpandOverride({});
    // Crash / session-switch recovery: a send gated on a translation that
    // never settled left its composed text behind. Hand it back to the
    // composer exactly once (the key is removed before any later mount).
    const pendingSend = readPendingSend(sessionId);
    if (pendingSend) {
      injectComposerDraft(sessionId, pendingSend.text);
      toast({ kind: 'info', message: t('translation.draftRestored') });
      clearPendingSend(sessionId);
    }
    void refresh();
    window.addEventListener('gian:translation-settings', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      alive.current = false;
      window.removeEventListener('gian:translation-settings', refresh);
      window.removeEventListener('focus', refresh);
      for (const [id, controller] of requests.current) {
        controller.abort(); void cancelTranslation(sessionId, id, dispatch).catch(() => undefined);
      }
      requests.current.clear();
      sendRef.current?.reject(new Error('Translation cancelled.'));
      sendRef.current = null;
    };
  }, [sessionId, refresh, dispatch]);
  useEffect(() => {
    if (!state.enabled && !Object.values(state.automatic).some(value => value.pending)) return;
    const timer = setInterval(() => { void refresh(); }, 2_000);
    return () => clearInterval(timer);
  }, [state.enabled, state.automatic, refresh]);

  async function toggle(enabled: boolean) {
    if (saving) return;
    if (enabled && !isTranslationConfigured(state.preferences)) {
      setError(t('translation.configureFirst'));
      return;
    }
    setSaving(true);
    try { await setAutoTranslation(sessionId, enabled, dispatch); await refresh(); }
    catch (error) { setError(String(error)); }
    finally { if (alive.current) setSaving(false); }
  }
  async function request(text: string, purpose: 'send' | 'read', sourceId?: string, document?: ComposerDocument) {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    requests.current.set(requestId, controller);
    if (purpose === 'send') sendId.current = requestId;
    try {
      return await translateText(sessionId, { requestId, text, purpose, sourceId, document }, controller.signal, dispatch);
    } finally {
      requests.current.delete(requestId);
      if (sendId.current === requestId) sendId.current = null;
    }
  }
  async function retrySend() {
    const current = sendRef.current;
    if (!current || sendId.current) return;
    setSending({ phase: 'translating' });
    // Hard timeout: a hung translation provider must not gate the dispatch
    // forever. On expiry the request is aborted + cancelled Host-side and the
    // send drops to the failed phase — the send promise stays unsettled so the
    // user (not the timer) decides what happens to the text. The request is
    // evicted from the in-flight maps so a retry can start immediately; its
    // late settle is guarded out below (`timedOut` / `sendRef` checks).
    let timedOut = false;
    const timeout = withSendTimeout(() => {
      if (!alive.current || sendRef.current !== current) return;
      timedOut = true;
      const id = sendId.current;
      if (id) {
        requests.current.get(id)?.abort();
        requests.current.delete(id);
        if (sendId.current === id) sendId.current = null;
        void cancelTranslation(sessionId, id, dispatch).catch(() => undefined);
      }
      setSending({ phase: 'failed', timedOut: true,
        error: t('translation.sendTimeout').replace('{s}', String(SEND_TRANSLATE_TIMEOUT_MS / 1000)) });
    });
    try {
      const record = await request(current.text, 'send', undefined, current.document);
      if (!alive.current || sendRef.current !== current || timedOut) return;
      sendRef.current = null; setSending(null); clearPendingSend(sessionId); current.resolve(record);
    } catch (error) {
      if (timedOut) return;
      if (alive.current && sendRef.current === current) {
        setSending({ phase: 'failed', error: String(error), timedOut: false });
      }
    } finally {
      timeout.clear();
    }
  }
  /**
   * Gate + start of a translated send. Returns null synchronously when the
   * send cannot start at all (state still loading, translation unconfigured,
   * another translated send in flight) so the caller can keep the composer's
   * blocking contract (draft retained, no optimistic echo). Otherwise the
   * returned promise settles with the SendOutcome: the caller dispatches only
   * then, while its already-appended echo shows the inline progress row.
   */
  function prepareSend(text: string, document?: ComposerDocument): Promise<SendOutcome> | null {
    if (!ready) return null;
    if (!isTranslationConfigured(state.preferences)) {
      setError(t('translation.configureFirst'));
      return null;
    }
    if (sendRef.current) return null;
    return new Promise((resolve, reject) => {
      sendRef.current = { text, document, resolve, reject };
      // Durability first: if this tab dies or the session unmounts before the
      // send resolves, the text is recoverable on the next mount.
      writePendingSend(sessionId, { text, document, at: Date.now() });
      void retrySend();
    });
  }
  function finishSend(original: boolean) {
    const current = sendRef.current;
    sendRef.current = null;
    if (sendId.current) {
      requests.current.get(sendId.current)?.abort();
      void cancelTranslation(sessionId, sendId.current, dispatch).catch(() => undefined);
    }
    setSending(null);
    clearPendingSend(sessionId);
    if (original) current?.resolve('original');
    else current?.reject(new Error('Translation cancelled.'));
  }
  /** Give the gated text back to the composer: abort the in-flight send
   *  translation, restore the draft, drop the durable record, and reject the
   *  send promise (the caller's .catch removes the optimistic echo). */
  function reclaimSend() {
    const current = sendRef.current;
    if (!current) return;
    sendRef.current = null;
    if (sendId.current) {
      requests.current.get(sendId.current)?.abort();
      void cancelTranslation(sessionId, sendId.current, dispatch).catch(() => undefined);
    }
    clearPendingSend(sessionId);
    injectComposerDraft(sessionId, current.text);
    setSending(null);
    current.reject(new Error('Translation send reclaimed.'));
  }
  async function read(text: string, sourceId: string): Promise<void> {
    if (reading[sourceId]?.pending) return;
    setReading(previous => ({ ...previous, [sourceId]: { pending: true } }));
    try {
      const record = await request(text, 'read', sourceId);
      if (alive.current) setReading(previous => ({ ...previous, [sourceId]: { pending: false, record } }));
    } catch (error) {
      if (alive.current) setReading(previous => ({ ...previous, [sourceId]: { pending: false, error: String(error) } }));
    }
  }
  function result(sourceId: string, text: string): ReadingTranslation {
    const local = reading[sourceId];
    const record = [...state.results].reverse().find(record => record.sourceId === sourceId && record.sourceText === text
      && record.targetLanguage === state.preferences.reading_language);
    return local?.record && (local.record.sourceText !== text || local.record.targetLanguage !== state.preferences.reading_language)
      ? { pending: false, record }
      : local ?? { ...state.automatic[sourceId], pending: state.automatic[sourceId]?.pending ?? false, record };
  }
  function isReadExpanded(sourceId: string): boolean {
    return expandOverride[sourceId] ?? state.enabled;
  }
  /** 文A toggle: expand shows the cached record instantly or kicks off the
   *  translation (unless one is already pending/errored for this source);
   *  collapse only hides the block — the translated record stays cached. */
  function toggleRead(text: string, sourceId: string): void {
    const next = !isReadExpanded(sourceId);
    setExpandOverride(previous => ({ ...previous, [sourceId]: next }));
    if (!next) return;
    const current = result(sourceId, text);
    if (!current.pending && !current.record && !current.error) void read(text, sourceId);
  }
  function select(text: string) {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    requests.current.set(requestId, controller);
    const promise = translateText(sessionId, { requestId, text, purpose: 'read' }, controller.signal, dispatch)
      .finally(() => requests.current.delete(requestId));
    return { promise, cancel: () => {
      controller.abort(); void cancelTranslation(sessionId, requestId, dispatch).catch(() => undefined);
    } };
  }
  return { state, ready, error, saving, toggle, sending, prepareSend, retrySend, finishSend, reclaimSend, read, result, isReadExpanded, toggleRead, refresh, select };
}

export type TranslationController = ReturnType<typeof useTranslation>;
