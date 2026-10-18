import type { InitializeResult } from '@gian/proxy-protocol';
import type { Executor, ProxyCatalog, ProxySession } from '@gian/shared';

export function stubInitialize(pluginId: Executor, version = '0.2.0'): InitializeResult {
  return {
    protocol: { name: 'gian.proxy', version: '2.0' },
    plugin: { id: pluginId, name: pluginId, version },
    process: {
      scope: pluginId === 'codex' || pluginId === 'kimi' ? 'shared' : 'session',
    },
    capabilities: {},
  };
}

export const EMPTY_CATALOG: ProxyCatalog = {
  catalogRevision: 'test',
  input: [{ type: 'text' }],
  configOptions: [],
  slashCommands: [],
};

/** Explicit test vocabulary for fixtures that exercise legacy approval routing. */
export const LEGACY_APPROVAL_CATALOG: ProxyCatalog = {
  ...EMPTY_CATALOG,
  catalogRevision: 'fixture-legacy-approval',
  configOptions: [{
    id: 'approval_mode', displayName: 'Approval', binding: 'turn', role: 'approval_mode',
    control: 'select', required: false, defaultValue: 'ask',
    choices: [
      { value: 'ask', displayName: 'Ask' },
      { value: 'auto', displayName: 'Auto' },
      { value: 'plan', displayName: 'Plan' },
    ],
  }],
};

export function stubSession(id: string, cwd: string, state: ProxySession['state'] = 'idle'): ProxySession {
  return {
    id,
    cwd,
    state,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    lastError: null,
  };
}
