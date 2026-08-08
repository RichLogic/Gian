import { desktopBridge } from '../desktop-bridge.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

export const BROWSER_PROFILE_ENTITY_KEY = 'browser:profile';
export const browserExternalEntityKey = (tabId: string) => `browser:external:${tabId}`;

type EmptyInput = Record<string, never>;
interface BrowserTabInput { tabId: string }

const browserOpenExternal: OperationDefinition<BrowserTabInput> = {
  policy: 'pending',
  entityKey: input => browserExternalEntityKey(input.tabId),
  execute: async input => {
    const browser = desktopBridge()?.browser;
    if (!browser || !await browser.openExternal(input.tabId)) throw new Error('Could not open this page in the system browser');
  },
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: 15_000,
};

const browserClearData: OperationDefinition<EmptyInput> = {
  policy: 'pending',
  entityKey: () => BROWSER_PROFILE_ENTITY_KEY,
  execute: async () => {
    const browser = desktopBridge()?.browser;
    if (!browser || !await browser.clearData()) throw new Error('Could not clear Browser data');
    toast({ kind: 'success', message: 'Browser data cleared' });
  },
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: 30_000,
};

registry.register('browser.openExternal', browserOpenExternal);
registry.register('browser.clearData', browserClearData);
