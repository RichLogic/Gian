import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_TRANSLATION_PREFERENCES, type ComposerDocument, type TranslationRecord } from '@gian/shared';
import { cancelTranslation, loadTranslationState, setAutoTranslation, translateText, type TranslationState } from '../operations/translation.js';
import { useOperationDispatchOptional } from '../operations/use-operations.js';

export interface ReadingTranslation { pending: boolean; record?: TranslationRecord; error?: string }
interface SendRequest {
  text: string; document?: ComposerDocument;
  resolve: (id: string) => void; reject: (error: Error) => void;
}

export function useTranslation(sessionId: string) {
  const dispatch = useOperationDispatchOptional();
  const [state, setState] = useState<TranslationState>({ enabled: false, results: [], automatic: {}, preferences: { ...DEFAULT_TRANSLATION_PREFERENCES } });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState<Record<string, ReadingTranslation>>({});
  const [sending, setSending] = useState<{ pending: boolean; error?: string } | null>(null);
  const sendRef = useRef<SendRequest | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  const sendId = useRef<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await loadTranslationState(sessionId);
      if (!next?.preferences || !Array.isArray(next.results)) throw new Error('Translation settings are unavailable.');
      if (alive.current) { setState(next); setReady(true); setError(''); }
    } catch (error) { if (alive.current) setError(String(error)); }
  }, [sessionId]);
  useEffect(() => {
    alive.current = true;
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
    setSending({ pending: true });
    try {
      const record = await request(current.text, 'send', undefined, current.document);
      if (!alive.current || sendRef.current !== current) return;
      sendRef.current = null; setSending(null); current.resolve(record.id);
    } catch (error) {
      if (alive.current && sendRef.current === current) setSending({ pending: false, error: String(error) });
    }
  }
  function prepareSend(text: string, document?: ComposerDocument): Promise<string> {
    if (!ready) return Promise.reject(new Error('Translation settings are still loading.'));
    if (sendRef.current) return Promise.reject(new Error('Translation is already running.'));
    return new Promise((resolve, reject) => {
      sendRef.current = { text, document, resolve, reject };
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
    if (original) current?.resolve('original');
    else current?.reject(new Error('Translation cancelled.'));
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
  return { state, ready, error, saving, toggle, sending, prepareSend, retrySend, finishSend, read, result, refresh, select };
}

export type TranslationController = ReturnType<typeof useTranslation>;
