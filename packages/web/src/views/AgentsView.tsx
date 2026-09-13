import { useEffect, useState } from 'react';
import type {
  ManagedRuntimeStatus,
  ProductExecutor,
  ProxyCatalogEntry,
  ProxyCatalogItem,
  ProxyCatalogList,
  TerminalPreferences,
  UserAgentStatus,
} from '@gian/shared';
import {
  loadAgents,
  loadAgentDraftDefaults,
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
import { agentProxyDisplay, draftNameError } from '../agents/catalog-model.js';
import { CatalogBadgeList } from '../agents/badges.js';
import { AgentDetailPanel } from '../agents/AgentDetailPanel.js';
import type { AgentTerminalControl } from '../agents/AgentDetailPanel.js';
import { AgentDraftPanel } from '../agents/AgentDraftPanel.js';
import type { AgentDraftState } from '../agents/AgentDraftPanel.js';
import { ProxyDetailPanel } from '../agents/ProxyDetailPanel.js';

type Selection =
  | { kind: 'agent'; id: string }
  | { kind: 'proxy'; pluginId: string }
  | { kind: 'draft'; pluginId: string }
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

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
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

function nextDraftName(base: string, agents: UserAgentStatus[]): string {
  const taken = new Set(agents.map(agent => agent.name.trim().toLowerCase()));
  if (!taken.has(base.trim().toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function canDraftAgent(item: ProxyCatalogItem): boolean {
  if (item.compatibility.state !== 'compatible') return false;
  return item.availableActions.some(action => (
    action === 'create_agent' || action === 'install_runtime'
      || action === 'install_proxy' || action === 'update_proxy'
  ));
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
  const [pageMode, setPageMode] = useState<'agents' | 'add'>('agents');
  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<AgentDraftState | null>(null);
  const [draftPluginId, setDraftPluginId] = useState<string | null>(null);
  const [draftHomeSupported, setDraftHomeSupported] = useState(true);
  const [draftSaving, setDraftSaving] = useState(false);
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

  function legacyKindFor(pluginId: string): ProductExecutor | null {
    return legacyProxies.find(entry => entry.id === pluginId)?.id ?? null;
  }

  function startAddAgent() {
    setPageMode('add');
    setSelection(null);
    setDraft(null);
    setDraftPluginId(null);
    setDraftHomeSupported(true);
    if (catalogItems.length === 0 && !catalogSyncing) void syncCatalog();
  }

  function leaveAddAgent() {
    setPageMode('agents');
    setSelection(null);
    setDraft(null);
    setDraftPluginId(null);
    setDraftHomeSupported(true);
  }

  async function startDraft(item: ProxyCatalogItem) {
    if (!canDraftAgent(item)) return;
    if (draft && draftPluginId === item.pluginId) {
      setSelection({ kind: 'draft', pluginId: item.pluginId });
      return;
    }
    let name = nextDraftName(item.displayName, agents);
    let homeSupported = true;
    const legacyKind = legacyKindFor(item.pluginId);
    if (legacyKind) {
      try {
        const defaults = await loadAgentDraftDefaults(legacyKind);
        if (defaults.name && !draftNameError(defaults.name, agents)) name = defaults.name;
        homeSupported = defaults.home !== null;
      } catch {
        // Catalog identity is enough to keep the draft usable.
      }
    }
    setSelection({ kind: 'draft', pluginId: item.pluginId });
    setDraft({ name, customHome: null });
    setDraftPluginId(item.pluginId);
    setDraftHomeSupported(homeSupported);
  }

  async function saveDraft() {
    if (!draft || selection?.kind !== 'draft') return;
    if (draftNameError(draft.name, agents)) return;
    setError('');
    setDraftSaving(true);
    try {
      const item = catalogItems.find(candidate => candidate.pluginId === selection.pluginId);
      const preparation = item?.availableActions.includes('install_runtime')
        ? 'catalog.installRuntime'
        : item?.availableActions.includes('install_proxy')
          ? 'catalog.installProxy'
          : item?.availableActions.includes('update_proxy')
            ? 'catalog.updateProxy'
            : null;
      if (preparation) {
        const prepared = await waitForRunSettle(store, dispatch(preparation, {
          pluginId: selection.pluginId,
        }).id);
        if (prepared.phase !== 'confirmed') {
          setError(prepared.error ?? 'Agent Integration installation failed');
          return;
        }
      }
      const settled = await waitForRunSettle(store, dispatch('agent.create', {
        name: draft.name.trim(),
        pluginId: selection.pluginId,
        home: draft.customHome === null
          ? { kind: 'managed' }
          : { kind: 'custom', path: draft.customHome.trim() },
      }).id);
      if (settled.phase !== 'confirmed') {
        setError(settled.error ?? 'Agent operation failed');
        return;
      }
      const result = settled.result as CreateAgentOperationResult;
      setPageMode('agents');
      setDraft(null);
      setDraftPluginId(null);
      setDraftHomeSupported(true);
      setSelection({ kind: 'agent', id: result.agent.id });
      await refresh();
    } finally {
      setDraftSaving(false);
    }
  }

  async function pickHome(agentId?: string): Promise<string | null> {
    const settled = await waitForRunSettle(store, dispatch('agent.pickHome', {
      ...(agentId ? { agentId } : {}),
    }).id);
    if (settled.phase === 'confirmed') return settled.result as string | null;
    setError(settled.error ?? 'HOME picker failed');
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
  const draftItem = selection?.kind === 'draft'
    ? integrationItems.find(item => item.pluginId === selection.pluginId) ?? null
    : null;
  const panelOpen = !!selectedAgent || !!selectedProxy || (!!draftItem && !!draft);
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
                {pageMode === 'add' && (
                  <button type="button" className="btn icon ghost"
                          title={t('agents.add.back')} aria-label={t('agents.add.back')}
                          onClick={leaveAddAgent}>
                    <BackIcon />
                  </button>
                )}
                <h1>{pageMode === 'agents' ? t('nav.agents') : t('settings.agents.add')}</h1>
                {!loading && (
                  <span className="sub">
                    {pageMode === 'agents'
                      ? t('agents.agentCount').replace('{count}', String(agents.length))
                      : t('agents.proxyCount').replace('{count}', String(catalogItems.length))}
                  </span>
                )}
                <span className="spacer" />
                {pageMode === 'agents' && (
                  <button type="button" className="btn sm primary" data-testid="agents-add"
                          onClick={startAddAgent}>
                    <PlusIcon />{t('settings.agents.add')}
                  </button>
                )}
              </div>
            </div>

            <div className="page-body">
              {loading && agents.length === 0 && catalogItems.length === 0 ? (
                <p className="s2-help">{t('settings.agents.loading')}</p>
              ) : pageMode === 'agents' ? (
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
                                onClick={() => { setDraft(null); setSelection({ kind: 'agent', id: agent.id }); }}>
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
              ) : (
                <>
                  {errorNotice}
                  {catalogNotice}
                  <div className="s2-subhead">
                    {t('agents.draft.pickProxy')} · {integrationItems.length}
                  </div>
                  <div className="catalog" data-testid="proxy-catalog-list">
                    {integrationItems.map(item => (
                      <CatalogRow key={item.pluginId} item={item}
                                  active={selection?.kind !== 'agent'
                                    && selection?.pluginId === item.pluginId}
                                  onPick={() => {
                                    if (canDraftAgent(item)) void startDraft(item);
                                    else setSelection({ kind: 'proxy', pluginId: item.pluginId });
                                  }}
                                  onInfo={() => { setSelection({ kind: 'proxy', pluginId: item.pluginId }); }} />
                    ))}
                  </div>
                  {catalog && integrationItems.length === 0 && (
                    <p className="s2-help">{t('agents.catalog.empty')}</p>
                  )}
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
               data-testid={selection?.kind === 'draft' ? 'agent-draft-panel'
                 : selection?.kind === 'proxy' ? 'proxy-detail-panel' : 'agents-detail-panel'}>
          {draftItem && draft && selection?.kind === 'draft' ? (
            <AgentDraftPanel
              draft={draft}
              draftError={draftNameError(draft.name, agents)}
              item={draftItem}
              runtime={runtimeByPlugin[draftItem.pluginId] ?? null}
              developmentFallback={window.gianDesktop?.appVariant === 'development'
                ? agents.find(agent => agent.pluginId === draftItem.pluginId
                  || agent.proxy === legacyKindFor(draftItem.pluginId))
                : undefined}
              homeSupported={draftHomeSupported}
              showBack={narrow}
              busy={draftSaving}
              onChange={setDraft}
              onPickHome={() => pickHome()}
              onOpenProxy={() => setSelection({ kind: 'proxy', pluginId: draftItem.pluginId })}
              onSave={() => { void saveDraft(); }}
              onClose={() => { setSelection(null); }}
            />
          ) : selectedProxy ? (
            <ProxyDetailWithBusy
              item={selectedProxy}
              runtime={runtimeByPlugin[selectedProxy.pluginId] ?? null}
              developmentFallback={window.gianDesktop?.appVariant === 'development'
                ? agents.find(agent => agent.pluginId === selectedProxy.pluginId
                  || agent.proxy === legacyKindFor(selectedProxy.pluginId))
                : undefined}
              docGeneration={catalog?.source.sequence ?? null}
              showBack={narrow}
              onAction={action => { void runCatalog(
                action === 'install_runtime' ? 'catalog.installRuntime'
                  : action === 'install_proxy' ? 'catalog.installProxy'
                  : action === 'update_proxy' ? 'catalog.updateProxy' : 'catalog.rollbackProxy',
                selectedProxy.pluginId,
              ); }}
              onCreateAgent={() => { void startDraft(selectedProxy); }}
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
