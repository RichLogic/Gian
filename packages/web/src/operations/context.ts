import type { PickComposerResourcesResult } from '@gian/shared';
import { desktopBridge } from '../desktop-bridge.js';
import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

const PICK_TIMEOUT_MS = 300_000;

const contextPickResources: OperationDefinition<Record<string, never>, PickComposerResourcesResult> = {
  policy: 'pending',
  entityKey: () =>
    `pending:context.pickResources:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  execute: async () => {
    const picker = desktopBridge()?.resources;
    if (!picker) throw new Error('Files and folders picker is available in Gian Desktop.');
    return await picker.pick() ?? { resources: [], rejectedFiles: [] };
  },
  timeoutMs: PICK_TIMEOUT_MS,
};

registry.register('context.pickResources', contextPickResources);
