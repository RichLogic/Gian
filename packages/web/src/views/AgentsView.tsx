import { useEffect, useState } from 'react';
import type {
  ManagedRuntimeStatus,
  ProxyCatalogEntry,
  ProxyCatalogItem,
  ProxyCatalogList,
  TerminalPreferences,
  UserAgentStatus,
} from '@gian/shared';
import { productExecutorForPluginId } from '@gian/shared';
import {
  loadAgents,
  loadManagedRuntimeStatus,
  loadProxyCatalog,
} from '../api.js';
import { confirm } from '../feedback.js';
import type { CreateAgentOperationResult } from '../operations/agents.js';
import { CATALOG_SYNC_ENTITY_KEY, catalogEntityKey, runtimeEntityKey } from '../operations/catalog.js';
import {
  useOperationDispatch,
  useOperationStore,
  usePendingOperations,
  waitForRunSettle,
} from '../operations/use-operations.js';
import type { OperationRun } from '../operations/types.js';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';
import { Splitter } from '../components/Splitter.js';
import { usePanel2Width } from '../components/RailLayout.js';
import type { TerminalWire } from '../components/terminal-wire.js';
import { agentProxyDisplay, catalogInstallationStatus } from '../agents/catalog-model.js';
import { CatalogBadgeList } from '../agents/badges.js';
import { AgentDetailPanel } from '../agents/AgentDetailPanel.js';
import type { AgentTerminalControl } from '../agents/AgentDetailPanel.js';
import { ProxyDetailPanel } from '../agents/ProxyDetailPanel.js';
import { AgentDialog, type CreateAgentDialogInput } from './agent-dialog.js';

type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'proxy'; pluginId: string }
  | null;

interface AgentTerminalState {
  termId: string;
  visible: boolean;
  started: boolean;
}

/** Agent CLI PTYs intentionally outlive this page being hidden. The Host owns
 * the process and replay buffer; this page-level registry only retains ids. */
const liveAgentTerminals = new Map<string, AgentTerminalState>();

export interface AgentsTerminalHost {
  preferences: TerminalPreferences;
  makeWire: (termId: string, agentId: string, spawn: boolean) => TerminalWire;
  close: (termId: string) => void;
}

function useMediaQuery(queryText: string): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window.matchMedia === 'function' && window.matchMedia(queryText).matches
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(queryText);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [queryText]);
  return matches;
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" /><path d="M5 12h14" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" />
    </svg>
  );
}

export function AgentsView({ terminalHost }: { terminalHost?: AgentsTerminalHost }) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const store = useOperationStore();
  const [agents, setAgents] = useState<UserAgentStatus[]>([]);
  const [catalog, setCatalog] = useState<ProxyCatalogList | null>(null);
  const [legacyProxies, setLegacyProxies] = useState<ProxyCatalogEntry[]>([]);
  const [runtimeByPlugin, setRuntimeByPlugin] = useState<Record<string, ManagedRuntimeStatus | null>>({});
  const [loading, setLoading] = useState(true);
  const [catalogLoadError, setCatalogLoadError] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Selection>(null);
  const [addDialogPluginId, setAddDialogPluginId] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [terminals, setTerminals] = useState<Record<string, AgentTerminalState>>(() => (
    Object.fromEntries(liveAgentTerminals)
  ));
  const narrow = useMediaQuery('(max-width: 1100px)');
  const catalogSyncRuns = usePendingOperations(CATALOG_SYNC_ENTITY_KEY);
  const catalogSyncing = catalogSyncRuns.length > 0;
  const p2Width = usePanel2Width();

  async function refreshAgents() {
    setAgents(await loadAgents({ refresh: true }));
  }

  async function refreshRuntimes(items: ProxyCatalogItem[]) {
    const entries = await Promise.all(items.map(async item => {
      try {
        return [item.pluginId, await loadManagedRuntimeStatus(item.pluginId)] as const;
      } catch {
        return [item.pluginId, null] as const;
      }
    }));
    setRuntimeByPlugin(Object.fromEntries(entries));
  }

  async function refreshCatalog() {
    try {
      const body = await loadProxyCatalog();
      setCatalog(body.catalog);
      setLegacyProxies(body.proxies);
      setCatalogLoadError('');
      await refreshRuntimes(body.catalog.items);
    } catch (value) {
      setCatalogLoadError(value instanceof Error ? value.message : String(value));
    }
  }

  async function refresh() {
    try {
      await Promise.all([refreshAgents(), refreshCatalog()]);
      setError('');
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    liveAgentTerminals.clear();
    for (const [agentId, terminal] of Object.entries(terminals)) {
      liveAgentTerminals.set(agentId, terminal);
    }
  }, [terminals]);

  async function run(
    name: 'agent.delete' | 'agent.patch',
    input: Parameters<typeof dispatch>[1],
  ): Promise<boolean> {
    setError('');
    const settled: OperationRun = await waitForRunSettle(store, dispatch(name, input).id);
    if (settled.phase === 'confirmed') {
      await refresh();
      return true;
    }
    setError(settled.error ?? 'Agent operation failed');
    return false;
  }

  async function runCatalog(
    name: 'catalog.installRuntime' | 'catalog.installProxy' | 'catalog.updateProxy' | 'catalog.rollbackProxy',
    pluginId: string,
    agentId?: string,
  ): Promise<void> {
    setError('');
    const settled = await waitForRunSettle(store, dispatch(name, { pluginId, ...(agentId ? { agentId } : {}) }).id);
    if (settled.phase === 'confirmed') {
      await refresh();
      return;
    }
    setError(settled.error ?? 'Catalog operation failed');
  }

  async function syncCatalog(): Promise<void> {
    setError('');
    const settled = await waitForRunSettle(store, dispatch('catalog.sync', {}).id);
    if (settled.phase === 'confirmed') await refresh();
    else setError(settled.error ?? 'Catalog sync failed');
  }

  const signedCatalogItems = catalog?.items ?? [];
  // GianDev can remain useful while the remote Catalog is unavailable: the
  // Host's bounded legacy metadata is a development-only fallback. Production
  // never manufactures actions when its signed Catalog is empty.
  const catalogItems: ProxyCatalogItem[] = signedCatalogItems.length > 0
    ? signedCatalogItems
    : window.gianDesktop?.appVariant === 'development'
      ? legacyProxies.map(entry => {
          const saved = agents.find(agent => agent.proxy === entry.id);
          return {
            pluginId: entry.id,
            displayName: entry.name,
            tagline: entry.tagline,
            logo: entry.logo,
            documentation: {
              overview: `/api/proxies/${entry.id}/docs/overview`,
              setup: `/api/proxies/${entry.id}/docs/setup`,
              usage: `/api/proxies/${entry.id}/docs/usage`,
              troubleshooting: `/api/proxies/${entry.id}/docs/troubleshooting`,
            },
            compatibility: {
              state: 'compatible',
              hostVersions: [],
              protocolRange: '',
              reason: null,
            },
            installation: saved?.plugin.state === 'ready'
              ? {
                  state: 'installed',
                  installedVersion: saved.plugin.version,
                  latestVersion: saved.plugin.version,
                  updateAvailable: false,
                  source: 'giandev',
                }
              : {
                  state: 'not_installed',
                  installedVersion: null,
                  latestVersion: null,
                  updateAvailable: false,
                  source: null,
                },
            runtime: {
              state: saved?.cli.state === 'ready' ? 'ready' : 'setup_required',
              displayName: entry.name,
              ...(saved?.cli.readinessIssue ? { readinessIssue: saved.cli.readinessIssue } : {}),
            },
            availableActions: ['create_agent'],
          } satisfies ProxyCatalogItem;
        })
      : [];
  // CatalogService preserves local packages without a trusted coordinate so
  // existing My Agents can still be explained. They are not official
  // Integrations and must not leak into Add Agent or global installation.
  const integrationItems = signedCatalogItems.length > 0
    ? catalogItems.filter(item => item.installation.latestVersion !== null)
    : catalogItems;
  const installedIntegrationItems = integrationItems.filter(item => (
    catalogInstallationStatus(item) === 'installed'
    && item.availableActions.includes('create_agent')
  ));

  function openAddAgent(pluginId?: string) {
    setAddDialogPluginId(pluginId ?? '');
    setAddError('');
    if (catalogItems.length === 0 && !catalogSyncing) void syncCatalog();
  }

  async function createAgentFromDialog(input: CreateAgentDialogInput) {
    setAddError('');
    setAddSaving(true);
    try {
      const settled = await waitForRunSettle(store, dispatch('agent.create', {
        name: input.name,
        pluginId: input.pluginId,
        ...(input.home ? { home: input.home } : {}),
      }).id);
      if (settled.phase !== 'confirmed') {
        setAddError(settled.error ?? 'Agent creation failed');
        return;
      }
      const result = settled.result as CreateAgentOperationResult;
      setAddDialogPluginId(null);
      setSelection({ kind: 'agent', id: result.agent.id });
      await refresh();
    } finally {
      setAddSaving(false);
    }
  }

  async function pickHome(agentId?: string): Promise<string | null> {
    const settled = await waitForRunSettle(store, dispatch('agent.pickHome', {
      ...(agentId ? { agentId } : {}),
    }).id);
    if (settled.phase === 'confirmed') return settled.result as string | null;
    if (agentId) setError(settled.error ?? 'HOME picker failed');
    else setAddError(settled.error ?? 'HOME picker failed');
    return null;
  }

  async function removeAgent(agent: UserAgentStatus): Promise<void> {
    const accepted = await confirm({
      title: t('settings.agents.deleteTitle'),
      message: t('settings.agents.deleteMessage').replace('{name}', agent.name),
      confirmLabel: t('settings.agents.deleteConfirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!accepted) return;
    if (await run('agent.delete', {
      agentId: agent.id,
      snapshot: {
        name: agent.name,
        pluginId: agent.pluginId,
        proxy: agent.proxy,
        cliPath: agent.cliPath,
        defaults: agent.defaults,
      },
    })) {
      const terminal = terminals[agent.id];
      if (terminal) {
        terminalHost?.close(terminal.termId);
        setTerminals(previous => {
          const next = { ...previous };
          delete next[agent.id];
          return next;
        });
      }
      setSelection(null);
    }
  }

  function openTerminal(agentId: string) {
    setTerminals(previous => {
      const current = previous[agentId];
      if (current) return { ...previous, [agentId]: { ...current, visible: true } };
      return {
        ...previous,
        [agentId]: {
          termId: `agent-cli-${agentId}-${Date.now()}`,
          visible: true,
          started: false,
        },
      };
    });
  }

  function terminalControl(agentId: string): AgentTerminalControl | undefined {
    if (!terminalHost) return undefined;
    const state = terminals[agentId];
    return {
      termId: state?.termId ?? null,
      visible: state?.visible ?? false,
      started: state?.started ?? false,
      preferences: terminalHost.preferences,
      makeWire: terminalHost.makeWire,
      onOpen: () => openTerminal(agentId),
      onSpawned: () => setTerminals(previous => {
        const current = previous[agentId];
        return current ? { ...previous, [agentId]: { ...current, started: true } } : previous;
      }),
      onHide: () => setTerminals(previous => {
        const current = previous[agentId];
        return current ? { ...previous, [agentId]: { ...current, visible: false } } : previous;
      }),
      onStop: () => setTerminals(previous => {
        const current = previous[agentId];
        if (!current) return previous;
        terminalHost.close(current.termId);
        const next = { ...previous };
        delete next[agentId];
        return next;
      }),
    };
  }

  const selectedAgent = selection?.kind === 'agent'
    ? agents.find(agent => agent.id === selection.id) ?? null
    : null;
  const selectedProxy = selection?.kind === 'proxy'
    ? integrationItems.find(item => item.pluginId === selection.pluginId) ?? null
    : null;
  const panelOpen = !!selectedAgent || !!selectedProxy;
  const source = catalog?.source ?? null;
  const errorNotice = error ? <div className="notice danger" role="alert">{error}</div> : null;
  const catalogNotice = (
    <>
      {catalogLoadError && (
        <div className="notice danger" role="alert">
          <span className="grow">{t('agents.catalog.loadError').replace('{message}', catalogLoadError)}</span>
          <button type="button" className="btn xs secondary" data-testid="catalog-sync"
                  onClick={() => { void syncCatalog(); }}>
            {t('common.retry')}
          </button>
        </div>
      )}
      {source && (source.state === 'stale' || source.state === 'error') && (
        <div className="notice warn" role="status" data-testid="catalog-source-state">
          <span className="grow">
            {t(`agents.catalog.source.${source.state}`).replace('{message}', source.error?.message ?? '')}
          </span>
          <button type="button" className="btn xs secondary" data-testid="catalog-sync"
                  disabled={catalogSyncing} onClick={() => { void syncCatalog(); }}>
            {catalogSyncing ? t('agents.catalog.syncing') : t('agents.catalog.refresh')}
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className="agents-view" data-testid="agents-view" data-loading={loading ? 'true' : 'false'}>
      {(!narrow || !panelOpen) && (
        <main className="main main-pane">
          <div className="page">
            <div className="page-head">
              <div className="ph-row">
                <h1>{t('nav.agents')}</h1>
                {!loading && (
                  <span className="sub">
                    {t('agents.agentCount').replace('{count}', String(agents.length))}
                  </span>
                )}
                <span className="spacer" />
                <button type="button" className="btn sm primary" data-testid="agents-add"
                        onClick={() => openAddAgent()}>
                  <PlusIcon />{t('settings.agents.add')}
                </button>
              </div>
            </div>

            <div className="page-body">
              {loading && agents.length === 0 && catalogItems.length === 0 ? (
                <p className="s2-help">{t('settings.agents.loading')}</p>
              ) : (
                <>
                  {!panelOpen && errorNotice}
                  <div className="s2-subhead">
                    {t('agents.myAgents').replace('{count}', String(agents.length))}
                  </div>
                  <div className="catalog" data-testid="agent-list">
                    {agents.map(agent => {
                      const display = agentProxyDisplay(agent, catalogItems, legacyProxies);
                      return (
                        <button key={agent.id} type="button"
                                className={`catalog-item ${selectedAgent?.id === agent.id ? 'active' : ''}`}
                                data-testid={`agent-row-${agent.id}`}
                                onClick={() => { setSelection({ kind: 'agent', id: agent.id }); }}>
                          <AgentLogo proxy={agent.proxy} logo={display.logo ?? undefined}
                                     fallback={display.name} size={28} />
                          <span className="grow">
                            <span className="catalog-name">{agent.name}</span>
                            <span className="catalog-sub ellip" title={display.name}>
                              {display.name}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {agents.length === 0 && <p className="s2-help">{t('settings.agents.empty')}</p>}
                  {catalogNotice}
                  <div className="s2-subhead">
                    {t('agents.integrations').replace('{count}', String(integrationItems.length))}
                  </div>
                  <div className="catalog" data-testid="agent-integrations-list">
                    {integrationItems.map(item => (
                      <CatalogRow key={item.pluginId} item={item}
                                  active={selection?.kind === 'proxy'
                                    && selection.pluginId === item.pluginId}
                                  onPick={() => { setSelection({ kind: 'proxy', pluginId: item.pluginId }); }}
                                  onInfo={() => { setSelection({ kind: 'proxy', pluginId: item.pluginId }); }} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </main>
      )}

      {panelOpen && !narrow && (
        <Splitter seam="main-panel2" className="p2-splitter"
                  onMouseDown={p2Width.onMouseDown} ariaLabel={t('common.resize.panel')} />
      )}

      {panelOpen && (
        <aside className={`p2 agents-detail ${narrow ? 'replacing' : ''}`}
               style={!narrow && p2Width.customized ? { width: p2Width.width } : undefined}
               data-testid={selection?.kind === 'proxy' ? 'proxy-detail-panel' : 'agents-detail-panel'}>
          {selectedProxy ? (
            <ProxyDetailWithBusy
              item={selectedProxy}
              runtime={runtimeByPlugin[selectedProxy.pluginId] ?? null}
              developmentFallback={window.gianDesktop?.appVariant === 'development'
                ? agents.find(agent => agent.pluginId === selectedProxy.pluginId
                  || agent.proxy === productExecutorForPluginId(selectedProxy.pluginId))
                : undefined}
              docGeneration={catalog?.source.sequence ?? null}
              showBack={narrow}
              onAction={action => { void runCatalog(
                action === 'install_runtime' ? 'catalog.installRuntime'
                  : action === 'install_proxy' ? 'catalog.installProxy'
                  : action === 'update_proxy' ? 'catalog.updateProxy' : 'catalog.rollbackProxy',
                selectedProxy.pluginId,
              ); }}
              onCreateAgent={() => openAddAgent(selectedProxy.pluginId)}
              onClose={() => setSelection(null)}
            />
          ) : selectedAgent ? (
            <AgentDetailPanel
              agent={selectedAgent}
              display={agentProxyDisplay(selectedAgent, catalogItems, legacyProxies)}
              terminal={terminalControl(selectedAgent.id)}
              showBack={narrow}
              errorNotice={errorNotice}
              onRename={name => run('agent.patch', { agentId: selectedAgent.id, patch: { name } })}
              onSetHome={home => run('agent.patch', { agentId: selectedAgent.id, patch: { home } })}
              onPickHome={() => pickHome(selectedAgent.id)}
              onSetDefaults={defaults => run('agent.patch', {
                agentId: selectedAgent.id,
                patch: { defaults },
              })}
              onDelete={() => { void removeAgent(selectedAgent); }}
              onOpenProxy={integrationItems.some(item => item.pluginId === selectedAgent.pluginId)
                ? () => { setSelection({ kind: 'proxy', pluginId: selectedAgent.pluginId }); }
                : undefined}
              onClose={() => setSelection(null)}
            />
          ) : null}
        </aside>
      )}
      {addDialogPluginId !== null && (
        <AgentDialog
          integrations={installedIntegrationItems}
          agents={agents}
          initialPluginId={addDialogPluginId}
          busy={addSaving}
          error={addError}
          onPickHome={() => pickHome()}
          onSubmit={input => { void createAgentFromDialog(input); }}
          onClose={() => { if (!addSaving) setAddDialogPluginId(null); }}
        />
      )}
    </div>
  );
}

function CatalogRow({
  item,
  active,
  onPick,
  onInfo,
}: {
  item: ProxyCatalogItem;
  active: boolean;
  onPick: () => void;
  onInfo: () => void;
}) {
  const t = useT();
  return (
    <div className={`catalog-item catalog-card ${active ? 'active' : ''}`}
         data-testid={`catalog-item-${item.pluginId}`}>
      <button type="button" className="catalog-item-open"
              data-testid={`catalog-open-${item.pluginId}`}
              onClick={onPick}>
        <AgentLogo proxy={null} logo={item.logo} fallback={item.displayName} size={28} />
        <span className="grow">
          <span className="catalog-name">{item.displayName}</span>
          <span className="catalog-sub ellip" title={item.tagline}>{item.tagline}</span>
        </span>
      </button>
      <CatalogBadgeList item={item} />
      <button type="button" className="btn icon ghost row-info"
              title={t('agents.detail.viewInCatalog')}
              aria-label={t('agents.detail.viewInCatalog')}
              onClick={onInfo}>
        <InfoIcon />
      </button>
    </div>
  );
}

function ProxyDetailWithBusy({
  item,
  runtime,
  developmentFallback,
  docGeneration,
  showBack,
  onAction,
  onCreateAgent,
  onClose,
}: {
  item: ProxyCatalogItem;
  runtime: ManagedRuntimeStatus | null;
  developmentFallback?: UserAgentStatus;
  docGeneration: number | null;
  showBack: boolean;
  onAction: (action: 'install_runtime' | 'install_proxy' | 'update_proxy' | 'rollback_proxy') => void;
  onCreateAgent: () => void;
  onClose: () => void;
}) {
  const runs = usePendingOperations(catalogEntityKey(item.pluginId));
  const runtimeRuns = usePendingOperations(runtimeEntityKey(item.pluginId));
  const syncRuns = usePendingOperations(CATALOG_SYNC_ENTITY_KEY);
  return (
    <ProxyDetailPanel
      item={item}
      runtime={runtime}
      developmentFallback={developmentFallback}
      docGeneration={docGeneration}
      showBack={showBack}
      busy={runs.length > 0 || runtimeRuns.length > 0 || syncRuns.length > 0}
      onAction={onAction}
      onCreateAgent={onCreateAgent}
      onClose={onClose}
    />
  );
}
