import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigValue, TranslationPreferences } from '@gian/shared';
import type { ProxyClient } from '../proxy/types.js';

export interface TranslationClientLease { client: ProxyClient; dispose: () => Promise<void> }

export function createTranslationModel(dataDir: string,
  acquire: (id: string, preferences: TranslationPreferences) => Promise<TranslationClientLease>,
) {
  return async (preferences: TranslationPreferences, prompt: string, signal: AbortSignal): Promise<string> => {
    const id = `translation:${randomUUID()}`;
    const turnId = randomUUID();
    const root = join(dataDir, 'translation-workspaces');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(root, 'request-'));
    let lease: TranslationClientLease | undefined;
    const off: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    try {
      if (signal.aborted) throw new Error('Translation cancelled.');
      lease = await acquire(id, preferences);
      const { client } = lease;
      let catalog = await client.catalog();
      if (!catalog.configOptions.some(option => option.id === 'gian.translation' && option.binding === 'session')) {
        throw new Error('This Agent Proxy does not support isolated translation. Update its Proxy or choose a supported Agent.');
      }
      const model = catalog.configOptions.find(option => option.role === 'model');
      if (!model?.choices?.some(choice => choice.value === preferences.model)) {
        throw new Error('The configured translation model is no longer available.');
      }
      const sessionConfig: Record<string, ConfigValue> = { 'gian.translation': true };
      const config: Record<string, ConfigValue> = {};
      (model.binding === 'session' ? sessionConfig : config)[model.id] = preferences.model;
      if (client.resolveCatalog && (await client.initialize()).capabilities['catalog.resolve'] !== undefined) {
        catalog = await client.resolveCatalog({ catalogRevision: catalog.catalogRevision, sessionConfig, turnConfig: config });
      }
      const effort = catalog.configOptions.find(option => option.role === 'effort');
      const low = effort?.choices?.find(choice => choice.value === 'none')
        ?? effort?.choices?.find(choice => choice.value === 'low');
      if (effort && low) (effort.binding === 'session' ? sessionConfig : config)[effort.id] = low.value;
      await client.createSession({ cwd, workspaceRoots: [cwd], sessionConfig });
      if (signal.aborted) throw new Error('Translation cancelled.');
      const text = await new Promise<string>((resolve, reject) => {
        const chunks = new Map<string, string>();
        const fail = (error: Error) => { reject(error); void client.interruptTurn().catch(() => undefined); };
        const abort = () => fail(new Error('Translation cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        off.push(() => signal.removeEventListener('abort', abort));
        off.push(client.onNotification(event => {
          if (!('turnId' in event.params) || event.params.turnId !== turnId) return;
          const data = event.params.data as Record<string, unknown>;
          if (event.method === 'content.completed' && data.kind === 'text' && typeof data.content === 'string') {
            chunks.set(String(data.contentId), data.content);
          } else if (event.method === 'turn.completed') {
            if (data.stopReason !== 'completed') fail(new Error('Translation did not complete.'));
            else resolve([...chunks.values()].join('\n'));
          } else if (event.method === 'turn.failed') fail(new Error('Translation model failed.'));
          else if (event.method === 'interaction.requested' || event.method === 'activity.updated') {
            fail(new Error('Translation attempted an unsupported tool or interaction.'));
          }
        }));
        off.push(client.onExit(() => fail(new Error('Translation Agent disconnected.'))));
        if (client.onSessionFault) off.push(client.onSessionFault(fail));
        timer = setTimeout(() => fail(new Error('Translation timed out.')), 120_000);
        void client.startTurn({ sessionId: id, turnId, input: [{ type: 'text', text: prompt }], config }).catch(fail);
      });
      return text;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      const cleanupErrors: unknown[] = [];
      for (const unsubscribe of off) {
        try { unsubscribe(); } catch (error) { cleanupErrors.push(error); }
      }
      try { await lease?.dispose(); } catch (error) { cleanupErrors.push(error); }
      try { await rm(cwd, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) {
        if (!failed) throw cleanupErrors[0];
        // Keep the original failure; never log Provider text or credentials.
        console.warn('[translation] cleanup failed after translation error');
      }
    }
  };
}
