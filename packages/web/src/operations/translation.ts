import type { ComposerDocument, ProxyCatalog, TranslationPreferences, TranslationRecord } from '@gian/shared';
import { registry } from './registry.js';
import type { OperationDispatcher } from './dispatcher.js';
import type { OperationDefinition } from './types.js';

type TranslationOperationName = 'translation.run' | 'translation.cancel' | 'translation.setAuto';
interface TranslationOperationInput {
  key: string;
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
const translationOperation: OperationDefinition<TranslationOperationInput> = {
  policy: 'pending', entityKey: input => input.key, timeoutMs: 180_000,
  execute: async input => {
    try { const value = await input.execute(); input.resolve(value); }
    catch (error) { input.reject(error); throw error; }
  },
};
for (const name of ['translation.run', 'translation.cancel', 'translation.setAuto'] as const) registry.register(name, translationOperation);

function perform<T>(dispatch: OperationDispatcher['dispatch'] | null | undefined, name: TranslationOperationName,
  key: string, execute: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!dispatch) { reject(new Error('Translation controls are unavailable.')); return; }
    try {
      const run = dispatch(name, { key, execute, resolve: (value: unknown) => resolve(value as T), reject });
      if (run.phase === 'failed') reject(new Error(run.error ?? 'Translation request rejected.'));
    } catch (error) { reject(error); }
  });
}

export interface TranslationState {
  enabled: boolean;
  preferences: TranslationPreferences;
  results: TranslationRecord[];
  automatic: Record<string, { pending: boolean; error?: string }>;
}

export async function translationRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Translation request failed');
  return body as T;
}

const root = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/translation`;
export const loadTranslationState = (id: string) => translationRequest<TranslationState>(`${root(id)}/state`);
export const setAutoTranslation = (id: string, enabled: boolean, dispatch?: OperationDispatcher['dispatch'] | null) =>
  perform(dispatch, 'translation.setAuto', `translation:settings:${id}`, () => translationRequest<{ enabled: boolean }>(`${root(id)}/state`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
}));
export function translateText(sessionId: string, input: {
  requestId: string; text: string; purpose: 'send' | 'read'; sourceId?: string; document?: ComposerDocument;
}, signal: AbortSignal, dispatch?: OperationDispatcher['dispatch'] | null): Promise<TranslationRecord> {
  return perform(dispatch, 'translation.run', `translation:request:${input.requestId}`, () => translationRequest<TranslationRecord>(`${root(sessionId)}/requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  }));
}
export async function cancelTranslation(sessionId: string, requestId: string, dispatch?: OperationDispatcher['dispatch'] | null): Promise<void> {
  await perform(dispatch, 'translation.cancel', `translation:cancel:${requestId}`, () =>
    translationRequest(`${root(sessionId)}/requests/${encodeURIComponent(requestId)}`, { method: 'DELETE' }));
}
export const translationCatalog = (pluginId: string, agentId: string) => translationRequest<ProxyCatalog>(
  `/api/proxy/${encodeURIComponent(pluginId)}/capabilities?agent=${encodeURIComponent(agentId)}`,
);
