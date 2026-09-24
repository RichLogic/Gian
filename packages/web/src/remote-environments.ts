import type { ConfigOption, ConfigValue, ProxyCatalog, UserAgentStatus, Workspace } from '@gian/shared';

export interface RemoteEnvironment {
  id: string; name: string; host_id: string; server_origin: string; pending: boolean; connected: boolean;
}
export interface RemoteEnvironmentCatalog {
  catalog_revision: string;
  workspaces: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; proxy: string; readiness: 'ready' | 'unavailable';
    defaults?: { model?: string; thinking?: string; mode?: string; options?: Record<string, ConfigValue> };
    models?: Array<{ id: string; label: string; is_default: boolean; supported_thinking: string[] }> }>;
}
export interface RemoteSessionChoice {
  id: string; name: string | null; workspace_id: string; agent: { id: string; name: string; proxy: string };
}
export interface RemoteAgentCatalog extends Omit<ProxyCatalog, 'slashCommands'> {
  resolveSupported: boolean;
  resolvedDefaults?: { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> };
}

export class RemoteRequestError extends Error {
  constructor(readonly status: number) {
    super('Remote request failed (' + status + ')');
  }
}

export async function remoteRequest<T>(path: string, body?: unknown, method?: 'DELETE'): Promise<T> {
  const response = await fetch('/api/remote' + path, { credentials: 'same-origin', cache: 'no-store',
    ...(method === 'DELETE' ? { method: 'DELETE' } : {}),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new RemoteRequestError(response.status);
  return response.json() as Promise<T>;
}

export function remoteAgentIdentity(agentId?: string | null): { environmentId: string; agentId: string } | null {
  const match = agentId?.match(/^remote:([0-9a-f-]{36}):([0-9a-f-]{36})$/);
  return match ? { environmentId: match[1]!, agentId: match[2]! } : null;
}

export async function loadRemoteAgentCatalog(agentId: string, input?: {
  catalogRevision: string; sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue>;
}): Promise<RemoteAgentCatalog> {
  const identity = remoteAgentIdentity(agentId);
  if (!identity) throw new Error('Invalid remote Agent');
  return remoteRequest(`/environments/${identity.environmentId}/agents/${identity.agentId}/catalog`, input);
}

export function remotePickerAgents(environmentId: string, catalog: RemoteEnvironmentCatalog): UserAgentStatus[] {
  return catalog.agents.map(agent => {
    const defaults = { model: agent.defaults?.model ?? '', thinking: agent.defaults?.thinking ?? '',
      mode: agent.defaults?.mode ?? '', options: agent.defaults?.options ?? {} };
    const state = agent.readiness === 'ready' ? 'ready' as const : 'missing' as const;
    return { id: `remote:${environmentId}:${agent.id}`, name: agent.name,
      pluginId: agent.proxy as UserAgentStatus['pluginId'],
      proxy: agent.proxy as UserAgentStatus['proxy'], cliPath: null, defaults, proxyName: agent.proxy,
      ready: agent.readiness === 'ready', cli: { state, path: null, version: null, source: null },
      plugin: { state, path: null, version: null, source: null, defaults }, runtimeProfile: null, officialInstallUrl: '' };
  });
}

export function remotePickerWorkspaces(catalog: RemoteEnvironmentCatalog): Workspace[] {
  return catalog.workspaces.map(workspace => ({ ...workspace, path: '', created_at: '', updated_at: '' } as Workspace));
}

export function optionModels(options: ConfigOption[]) {
  const model = options.find(option => option.role === 'model');
  const effort = options.find(option => option.role === 'effort');
  const efforts = (effort?.choices ?? []).map(choice => String(choice.value));
  return (model?.choices ?? []).map(choice => ({ id: String(choice.value), model: String(choice.value),
    displayName: choice.displayName, description: choice.description ?? '', hidden: false,
    isDefault: choice.value === model?.defaultValue, defaultEffort: null, defaultThinking: null,
    supportedEfforts: efforts, supportedThinking: efforts }));
}
