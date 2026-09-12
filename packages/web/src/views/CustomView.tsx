/**
 * Custom — read-only Customization Inventory page (Issue #50).
 *
 * One top-level page listing the selected Agent's Skills / MCP servers /
 * Hooks / Rules for a chosen scope (Global only, or Global + one registered
 * Workspace), backed by the Host's read-only inventory API
 * (`packages/host/src/web/routes/customizations.ts`). The page is read-only
 * by contract: Refresh is the only data operation; item details open in a
 * real second track of the content column (design "panel 2",
 * `presentation/custom-layout.ts`) as read-only text — Skills/Rules show the
 * entry file, MCP/Hooks show the sanitized configuration view. The only edit
 * hand-off is the product-wide "Open in VS Code" (`vscode://file/…`), and
 * only for Workspace-scope Skill/Rule entries; MCP/Hook details are always
 * Copy-only. There is no in-app editor and no override/fallback/layering UI.
 *
 * Behavior contract (design r6+): search / tab / filter are local-only and
 * never re-probe; Refresh bypasses the Host's 30s result cache; switching
 * Agent, Scope, or Tab closes the detail at the event boundary; after a
 * Refresh the detail survives only while its stable ID is still listed; a
 * failing kind never hides the other three. Rules display vocabulary is
 * frozen to Active / Imported / Applies under … / Not active over scopes
 * Global / Project / Subdirectory — internal wire facts (unreadable /
 * configured / unknown) fold into Not active and are explained through
 * item warnings and result diagnostics, never through new status labels.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UserAgentStatus, Workspace } from '@gian/shared';
import {
  loadAgents,
  loadCustomizationDetail,
  loadCustomizationInventory,
  type CustomizationDetailResult,
  type CustomizationInventoryResult,
  type CustomizationItem,
  type CustomizationKind,
  type CustomizationListResult,
  type RuleCustomizationItem,
} from '../api.js';
import { useT } from '../i18n/index.js';
import { AgentLogo } from '../components/AgentLogo.js';
import { Splitter } from '../components/Splitter.js';
import { usePanel2Width } from '../components/RailLayout.js';
import { customDetailLayout } from '../presentation/custom-layout.js';

const KINDS: readonly CustomizationKind[] = ['skill', 'mcp', 'hook', 'rule'];

const I = {
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15'],
  caretDown: ['M6 9l6 6 6-6'],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54L22 3z'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  check: ['M20 6L9 17l-5-5'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  back: ['M19 12H5', 'M12 19l-7-7 7-7'],
  copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  ext: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  alert: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
  box: ['M16.5 9.4L7.55 4.24', 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', 'M3.29 7L12 12l8.71-5', 'M12 22V12'],
  zap: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  bot: ['M12 8V4H8', 'M20 8H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2z', 'M9 13v2', 'M15 13v2'],
} as const;

function Icon({ d, size = 14 }: { d: readonly string[]; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((path, idx) => <path key={idx} d={path} />)}
    </svg>
  );
}

type StatusTone = 'ok' | 'warn' | 'err' | 'muted';
interface RowStatus { tone: StatusTone; label: string }

function isWorkspaceScope(item: CustomizationItem): boolean {
  return item.scope.level === 'workspace' || item.scope.level === 'directory';
}

function isAbsPath(path: string | undefined): path is string {
  return !!path && (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path));
}

/** Short mono origin tag shown on list rows (design: `.codex/skills`,
 *  `plugin · gian-tools`, `builtin · codex`). */
function originLabel(item: CustomizationItem): string {
  const { origin } = item;
  if (origin.kind === 'builtin') return origin.label ? `builtin · ${origin.label}` : 'builtin';
  if (origin.kind === 'plugin') return origin.label ? `plugin · ${origin.label}` : 'plugin';
  return origin.path ?? origin.label ?? origin.kind;
}

/** Rules-chain membership (design 10D): effective/imported/subtree form the
 *  Effective chain group; everything else is "Other discovered rules". */
function isChainRule(item: RuleCustomizationItem): boolean {
  return item.rule.status === 'effective' || item.rule.status === 'imported' || item.rule.status === 'subtree';
}

/** Effective-chain display order (design r7): Global → Project →
 *  Subdirectory. The protocol's generic (scope,name,id) sort would place
 *  directory rules first, so the Web layer owns this ordering. */
function ruleScopeRank(item: RuleCustomizationItem): number {
  if (item.scope.level === 'workspace') return 1;
  if (item.scope.level === 'directory') return 2;
  return 0; // user / system / unknown all display as Global
}

function compareChainRules(a: RuleCustomizationItem, b: RuleCustomizationItem): number {
  return ruleScopeRank(a) - ruleScopeRank(b)
    || (a.rule.appliesTo ?? a.origin.path ?? '').localeCompare(b.rule.appliesTo ?? b.origin.path ?? '')
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id);
}

/** Displayed rule scope — vocabulary frozen to Global / Project /
 *  Subdirectory; user/system/unknown all read as Global. */
function ruleScopeLabelKey(item: RuleCustomizationItem): string {
  if (item.scope.level === 'workspace') return 'custom.scopeLabel.workspace';
  if (item.scope.level === 'directory') return 'custom.scopeLabel.directory';
  return 'custom.scopeLabel.user';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One status filter chip: the id stored in the filter set, the label, and
 *  the underlying wire statuses it matches (what you see is what you filter). */
type StatusChip = readonly [id: string, label: string, matches: readonly string[]];

export function CustomView({
  workspaces,
  onOpenAgents,
}: {
  workspaces: Workspace[];
  /** Opens the Agents management surface (Settings → AI executors). */
  onOpenAgents: () => void;
}) {
  const t = useT();

  const visibleWorkspaces = useMemo(() => workspaces.filter(w => w.hidden !== 1), [workspaces]);

  // --- Agents + scope context -------------------------------------------
  const [agents, setAgents] = useState<UserAgentStatus[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  /** null = Global only; otherwise Global + this registered Workspace. */
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadAgents()
      .then(list => {
        if (cancelled) return;
        setAgents(list);
        setAgentsError(null);
      })
      .catch(error => {
        if (cancelled) return;
        setAgents([]);
        setAgentsError(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, []);

  // Default/repair the selection: first ready Agent, else the first Agent.
  useEffect(() => {
    if (!agents || agents.length === 0) return;
    if (agentId && agents.some(a => a.id === agentId)) return;
    setAgentId((agents.find(a => a.ready) ?? agents[0]!).id);
  }, [agents, agentId]);

  // Default scope: Global + first visible Workspace (design default).
  useEffect(() => {
    if (workspaceId && visibleWorkspaces.some(w => w.id === workspaceId)) return;
    setWorkspaceId(visibleWorkspaces[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleWorkspaces]);

  const agent = agents?.find(a => a.id === agentId) ?? null;
  const scopeWorkspace = visibleWorkspaces.find(w => w.id === workspaceId) ?? null;
  const scopeLabel = scopeWorkspace
    ? t('custom.scope.globalPlus').replace('{name}', scopeWorkspace.name)
    : t('custom.scope.globalOnly');

  // --- Inventory ----------------------------------------------------------
  const [inventory, setInventory] = useState<CustomizationInventoryResult | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  /** Non-blocking failure of a manual Refresh while previous results stay
   *  visible. Kept separate from `inventoryError` (which means "no usable
   *  results at all") so the copy never claims cached results are hidden. */
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    // Every Agent/Scope/readiness change invalidates the previous in-flight
    // request at the effect boundary — a late response from the old context
    // must never write into the new one, and loading must always settle.
    const seq = ++requestSeq.current;
    setInventory(null);
    setInventoryError(null);
    setRefreshError(null);
    if (!agentId || !agent || !agent.ready) {
      setInventoryLoading(false);
      return;
    }
    setInventoryLoading(true);
    void loadCustomizationInventory(agentId, workspaceId)
      .then(result => {
        if (requestSeq.current !== seq) return;
        setInventory(result);
        setInventoryLoading(false);
      })
      .catch(error => {
        if (requestSeq.current !== seq) return;
        setInventoryError(errorMessage(error));
        setInventoryLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, workspaceId, agent?.ready]);

  function refresh() {
    if (!agentId || !agent?.ready || inventoryLoading) return;
    const seq = ++requestSeq.current;
    setInventoryLoading(true);
    setInventoryError(null);
    setRefreshError(null);
    void loadCustomizationInventory(agentId, workspaceId, { refresh: true })
      .then(result => {
        if (requestSeq.current !== seq) return;
        setInventory(result);
        setInventoryLoading(false);
      })
      .catch(error => {
        if (requestSeq.current !== seq) return;
        const message = errorMessage(error);
        if (inventory === null) {
          // A Retry after the initial HTTP failure still has no usable data;
          // keep it in the blocking error state rather than showing an error
          // beside a loading skeleton.
          setInventoryError(message);
        } else {
          // Previous results stay visible, so surface a non-blocking notice.
          setRefreshError(message);
        }
        setInventoryLoading(false);
      });
  }

  // --- Tab / search / filter (all local — never re-probe) -----------------
  const [tab, setTab] = useState<CustomizationKind>('skill');
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ReadonlySet<'workspace' | 'global'>>(new Set());
  const [originFilter, setOriginFilter] = useState<ReadonlySet<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<string>>(new Set());

  // --- Detail (second content track) ---------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomizationDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
  }

  // Agent / Scope / Tab switches close the detail at the EVENT boundary, so
  // no frame ever pairs a stale detail with the new context. (The effect
  // below remains as a backstop for context changes without an event, e.g.
  // the workspace list repairing the default scope.)
  function selectAgent(next: string) {
    if (next === agentId) return;
    closeDetail();
    setAgentId(next);
  }
  function selectScope(next: string | null) {
    if (next === workspaceId) return;
    closeDetail();
    setWorkspaceId(next);
  }
  function selectTab(next: CustomizationKind) {
    if (next === tab) return;
    closeDetail();
    // The status filter vocabulary differs per tab — reset it on switch.
    setStatusFilter(new Set());
    setTab(next);
  }
  useEffect(() => { closeDetail(); }, [agentId, workspaceId, tab]);

  // After any inventory reload the detail survives only while its stable ID
  // is still listed; if it survives, re-fetch the content (it may changed).
  useEffect(() => {
    if (!inventory || !selectedId) return;
    const result = inventory.kinds[tab];
    const survives = result?.status === 'ok' && result.items.some(item => item.id === selectedId);
    if (!survives) {
      closeDetail();
    } else {
      setDetailNonce(n => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory]);

  useEffect(() => {
    if (!selectedId || !agentId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void loadCustomizationDetail(agentId, workspaceId, tab, selectedId)
      .then(result => {
        if (cancelled) return;
        setDetail(result);
        setDetailLoading(false);
      })
      .catch(error => {
        if (cancelled) return;
        setDetail(null);
        setDetailError(errorMessage(error));
        setDetailLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, agentId, workspaceId, tab, detailNonce]);

  const selectedItem = useMemo(() => {
    if (!selectedId || !inventory) return null;
    const result = inventory.kinds[tab];
    if (result?.status !== 'ok') return null;
    return result.items.find(item => item.id === selectedId) ?? null;
  }, [inventory, selectedId, tab]);

  // --- Detail layout: side-by-side tracks, swap when they cannot fit -------
  const contentRef = useRef<HTMLDivElement>(null);
  const [detailLayout, setDetailLayout] = useState<'side' | 'swap'>('side');
  const p2Width = usePanel2Width();
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setDetailLayout(customDetailLayout(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // --- Derived list data ----------------------------------------------------
  const result = inventory?.kinds[tab];
  const filtersActive = scopeFilter.size + originFilter.size + statusFilter.size > 0;

  const statusChips: readonly StatusChip[] = tab === 'rule'
    ? [
      ['effective', t('custom.status.active'), ['effective']],
      ['imported', t('custom.status.imported'), ['imported']],
      ['subtree', t('custom.status.appliesUnder').replace('{path}', '…'), ['subtree']],
      // Every status displayed as "Not active" filters as "Not active".
      ['not-active', t('custom.status.notActive'), ['inactive', 'unreadable', 'configured', 'unknown']],
    ]
    : [
      ['enabled', t('custom.status.enabled'), ['enabled']],
      ['disabled', t('custom.status.disabled'), ['disabled']],
      ['shadowed', t('custom.status.shadowed'), ['shadowed']],
    ];

  const visibleItems = useMemo(() => {
    if (result?.status !== 'ok') return [];
    const query = search.trim().toLowerCase();
    return result.items.filter(item => {
      if (query
        && !item.name.toLowerCase().includes(query)
        && !(item.description ?? '').toLowerCase().includes(query)) return false;
      if (scopeFilter.size > 0) {
        const group = isWorkspaceScope(item) ? 'workspace' : 'global';
        if (!scopeFilter.has(group)) return false;
      }
      if (originFilter.size > 0 && !originFilter.has(item.origin.kind)) return false;
      if (statusFilter.size > 0) {
        const wireStatus = item.kind === 'rule' ? item.rule.status : item.activation;
        const matched = statusChips.some(([id, , matches]) => statusFilter.has(id) && matches.includes(wireStatus));
        if (!matched) return false;
      }
      return true;
    });
  }, [result, search, scopeFilter, originFilter, statusFilter, statusChips]);

  function rowStatus(listResult: CustomizationListResult, item: CustomizationItem): RowStatus {
    if (item.kind === 'rule') {
      // Frozen Rules vocabulary (design r7): Active / Imported / Applies
      // under … / Not active. unreadable/configured/unknown are internal
      // facts — they display as Not active and are explained through item
      // warnings and result diagnostics, never new labels.
      switch (item.rule.status) {
        case 'effective': return { tone: 'ok', label: t('custom.status.active') };
        case 'imported': return { tone: 'ok', label: t('custom.status.imported') };
        case 'subtree': return { tone: 'ok', label: t('custom.status.appliesUnder').replace('{path}', item.rule.appliesTo ?? '') };
        default: return { tone: 'muted', label: t('custom.status.notActive') };
      }
    }
    // Configured-only inventories must not pretend items are active (design 11-3).
    if (listResult.completeness === 'configured') {
      return { tone: 'muted', label: t('custom.status.configured') };
    }
    switch (item.activation) {
      case 'enabled': return { tone: 'ok', label: t('custom.status.enabled') };
      case 'disabled': return { tone: 'muted', label: t('custom.status.disabled') };
      case 'shadowed': return { tone: 'warn', label: t('custom.status.shadowed') };
      case 'pending_trust': return { tone: 'warn', label: t('custom.status.pendingTrust') };
      case 'invalid': return { tone: 'err', label: t('custom.status.invalid') };
      default: return { tone: 'muted', label: t('custom.status.unknown') };
    }
  }

  function relTime(iso: string): string {
    const elapsedMs = Date.now() - Date.parse(iso);
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 1) return t('custom.time.now');
    if (minutes < 60) return t('custom.time.minutes').replace('{n}', String(minutes));
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('custom.time.hours').replace('{n}', String(hours));
    return t('custom.time.days').replace('{n}', String(Math.floor(hours / 24)));
  }

  function kindCount(kind: CustomizationKind): string {
    const kindResult = inventory?.kinds[kind];
    if (!kindResult || kindResult.status !== 'ok') return '—';
    return String(kindResult.items.length);
  }

  // --- Render ---------------------------------------------------------------
  const detailOpen = selectedId !== null;
  const swapDetail = detailOpen && detailLayout === 'swap';
  const showSkeleton = !agentsError && (agents === null
    || (agents.length > 0 && agent?.ready === true && inventory === null && !inventoryError && !refreshError));
  const pageError = inventoryError;

  const head = (
    <div className="custom-page-head">
      <div>
        <h1>{t('custom.title')}</h1>
        <div className="sub">
          {t('custom.sub.readonly')}
          {inventory ? ` · ${t('custom.sub.refreshed').replace('{time}', relTime(inventory.fetchedAt))}` : ''}
        </div>
      </div>
      <span className="custom-spacer" />
      {agent?.ready && (
        <button
          type="button"
          className="btn icon ghost"
          data-testid="custom-refresh"
          title={t('custom.refresh.title')}
          aria-label={t('custom.refresh.title')}
          disabled={inventoryLoading}
          onClick={refresh}
        >
          <Icon d={I.refresh} size={15} />
        </button>
      )}
    </div>
  );

  const selectors = (
    <div className="custom-selectors">
      <CustomSelect
        label={t('custom.selector.agent')}
        buttonContent={agent ? (
          <>
            <AgentLogo proxy={agent.proxy} size={16} />
            <span className="custom-select-name" title={agent.name}>{agent.name}</span>
            <span className={`custom-dot ${agent.ready ? 'ok' : 'warn'}`} title={agent.ready ? 'ready' : t('custom.agent.setupRequired')} />
          </>
        ) : <span className="custom-select-name">…</span>}
      >
        <div className="custom-pop-label">{t('custom.agents')}</div>
        {(agents ?? []).map(candidate => (
          <button
            key={candidate.id}
            type="button"
            className={`mode-pop-item ${candidate.id === agentId ? 'active' : ''}`}
            role="menuitemradio"
            aria-checked={candidate.id === agentId}
            onClick={() => selectAgent(candidate.id)}
          >
            <AgentLogo proxy={candidate.proxy} size={16} />
            {candidate.name}
            <span className={`custom-dot ${candidate.ready ? 'ok' : 'warn'}`} />
            {!candidate.ready && <span className="sub">{t('custom.agent.setupRequired')}</span>}
            {candidate.id === agentId && <span className="check"><Icon d={I.check} size={12} /></span>}
          </button>
        ))}
      </CustomSelect>
      <CustomSelect
        label={t('custom.selector.scope')}
        buttonContent={
          <>
            <span className="custom-lead"><Icon d={scopeWorkspace ? I.folder : I.globe} size={13} /></span>
            <span className="custom-select-name" title={scopeLabel}>{scopeLabel}</span>
          </>
        }
      >
        <div className="custom-pop-label">{t('custom.selector.scope')}</div>
        <button
          type="button"
          className={`mode-pop-item ${workspaceId === null ? 'active' : ''}`}
          role="menuitemradio"
          aria-checked={workspaceId === null}
          onClick={() => selectScope(null)}
        >
          <span className="custom-pop-ic"><Icon d={I.globe} size={13} /></span>
          {t('custom.scope.globalOnly')}
          {workspaceId === null && <span className="check"><Icon d={I.check} size={12} /></span>}
        </button>
        {visibleWorkspaces.length > 0 && <div className="custom-pop-rule" />}
        {visibleWorkspaces.length > 0 && <div className="custom-pop-label">{t('custom.scope.workspaces')}</div>}
        {visibleWorkspaces.map(ws => (
          <button
            key={ws.id}
            type="button"
            className={`mode-pop-item ${workspaceId === ws.id ? 'active' : ''}`}
            role="menuitemradio"
            aria-checked={workspaceId === ws.id}
            onClick={() => selectScope(ws.id)}
          >
            <span className="custom-pop-ic"><Icon d={I.folder} size={13} /></span>
            {t('custom.scope.globalPlus').replace('{name}', ws.name)}
            {workspaceId === ws.id && <span className="check"><Icon d={I.check} size={12} /></span>}
          </button>
        ))}
      </CustomSelect>
    </div>
  );

  const tabs = (
    <div className="custom-tabs-row">
      <div className="segm custom-tabs" role="tablist" aria-label={t('custom.title')}>
        {KINDS.map(kind => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={tab === kind}
            className={`segm-item ${tab === kind ? 'active' : ''}`}
            data-testid={`custom-tab-${kind}`}
            onClick={() => selectTab(kind)}
          >
            {t(`custom.tab.${kind}`)}
            <span className="n">{kindCount(kind)}</span>
          </button>
        ))}
      </div>
      <FilterPopover
        t={t}
        active={filtersActive}
        statusChips={statusChips}
        scopeFilter={scopeFilter}
        originFilter={originFilter}
        statusFilter={statusFilter}
        onScopeFilter={setScopeFilter}
        onOriginFilter={setOriginFilter}
        onStatusFilter={setStatusFilter}
      />
    </div>
  );

  function renderNotices(listResult: CustomizationListResult) {
    return (
      <>
        {listResult.completeness === 'configured' && listResult.items.length > 0 && (
          <div className="custom-notice info" role="status">
            <span className="n-ico"><Icon d={I.info} size={15} /></span>
            <span className="grow">{t('custom.notice.configured')}</span>
          </div>
        )}
        {(listResult.completeness === 'partial' || listResult.truncated) && (
          <PartialNotice result={listResult} t={t} />
        )}
      </>
    );
  }

  function renderList() {
    if (!result) return null;
    if (result.status !== 'ok') return <KindUnavailable result={result} />;
    if (result.items.length === 0) {
      // Notices (partial/diagnostics) stay visible even over an empty list.
      return (
        <>
          {renderNotices(result)}
          <EmptyState
            icon={I.box}
            title={t('custom.empty.none.title').replace('{kind}', t(`custom.kind.${tab}`))}
            desc={t('custom.empty.none.desc')
              .replace('{kind}', t(`custom.kind.${tab}`))
              .replace('{scope}', scopeLabel)}
          />
        </>
      );
    }
    if (visibleItems.length === 0) {
      return (
        <>
          {renderNotices(result)}
          <EmptyState
            icon={I.search}
            title={t('custom.empty.noMatch').replace('{query}', search.trim())}
            desc={null}
          />
        </>
      );
    }
    return (
      <>
        {renderNotices(result)}
        {tab === 'rule' ? renderRuleGroups(result) : renderScopeGroups(result)}
      </>
    );
  }

  function renderRow(listResult: CustomizationListResult, item: CustomizationItem, ordinal: string | null) {
    const status = rowStatus(listResult, item);
    const warnings = (item.warnings ?? []).map(w => `${w.code}: ${w.message}`).join('\n');
    return (
      <div
        key={item.id}
        className={`management-row ${selectedId === item.id ? 'sel' : ''}`}
        role="button"
        tabIndex={0}
        data-testid={`custom-row-${item.id}`}
        aria-current={selectedId === item.id ? 'true' : undefined}
        onClick={() => setSelectedId(item.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setSelectedId(item.id);
          }
        }}
      >
        <div className="management-row-copy">
          {ordinal !== null && <span className="custom-ord">{ordinal}</span>}
          <strong>{item.name}</strong>
          <span title={item.description ?? ''}>
            {item.kind === 'rule'
              ? `${t(ruleScopeLabelKey(item))}${item.description ? ` · ${item.description}` : ''}`
              : (item.description ?? '')}
          </span>
        </div>
        <div className="management-row-actions">
          {item.kind !== 'rule' && (
            <span className="custom-orig ellip" title={`${item.origin.kind} · ${originLabel(item)}`}>
              {originLabel(item)}
            </span>
          )}
          <span className={`st ${status.tone}`} title={warnings || undefined}>
            <span className="st-dot" />
            {status.label}
          </span>
        </div>
      </div>
    );
  }

  function renderScopeGroups(listResult: CustomizationListResult) {
    const workspaceItems = visibleItems.filter(isWorkspaceScope);
    const globalItems = visibleItems.filter(item => !isWorkspaceScope(item));
    return (
      <>
        {scopeWorkspace && workspaceItems.length > 0 && (
          <div className="management-group">
            <div className="management-group-heading">
              <strong>{t('custom.group.workspace').replace('{name}', scopeWorkspace.name)}</strong>
              <span>{workspaceItems.length}</span>
            </div>
            <div className="management-list custom-inv custom-1line">
              {workspaceItems.map(item => renderRow(listResult, item, null))}
            </div>
          </div>
        )}
        {globalItems.length > 0 && (
          <div className="management-group">
            <div className="management-group-heading">
              <strong>{t('custom.group.global')}</strong>
              <span>{globalItems.length}</span>
            </div>
            <div className="management-list custom-inv custom-1line">
              {globalItems.map(item => renderRow(listResult, item, null))}
            </div>
          </div>
        )}
      </>
    );
  }

  /** Full effective chain in display order (Global → Project → Subdirectory).
   *  Ordinals come from this list so filtering never renumbers the chain. */
  function effectiveChain(listResult: CustomizationListResult): RuleCustomizationItem[] {
    return listResult.items
      .filter((item): item is RuleCustomizationItem => item.kind === 'rule' && isChainRule(item))
      .sort(compareChainRules);
  }

  function renderRuleGroups(listResult: CustomizationListResult) {
    // The chain renders in display order (Global → Project → Subdirectory);
    // ordinals follow the full chain so filtering never renumbers it.
    const chainSorted = effectiveChain(listResult);
    const visibleIds = new Set(visibleItems.map(item => item.id));
    const chain = chainSorted.filter(item => visibleIds.has(item.id));
    const other = visibleItems.filter(item => item.kind === 'rule' && !isChainRule(item));
    return (
      <>
        {chain.length > 0 && (
          <div className="management-group">
            <div className="management-group-heading">
              <strong>{t('custom.group.chain')}</strong>
              <span>{chain.length}</span>
            </div>
            <div className="management-list custom-inv custom-1line">
              {chain.map(item => renderRow(listResult, item, `#${chainSorted.indexOf(item) + 1}`))}
            </div>
          </div>
        )}
        {other.length > 0 && (
          <div className="management-group">
            <div className="management-group-heading">
              <strong>{t('custom.group.otherRules')}</strong>
              <span>{other.length}</span>
            </div>
            <div className="management-list custom-inv custom-1line">
              {other.map(item => renderRow(listResult, item, '–'))}
            </div>
          </div>
        )}
      </>
    );
  }

  function KindUnavailable({ result: kindResult }: { result: CustomizationListResult }) {
    const firstDiagnostic = kindResult.diagnostics[0];
    if (kindResult.status === 'provider_unsupported') {
      return (
        <EmptyState
          icon={I.zap}
          title={t('custom.empty.unsupported.title')
            .replace('{agent}', agent?.name ?? '')
            .replace('{kind}', t(`custom.kind.${tab}`))}
          desc={t('custom.empty.unsupported.desc')}
        />
      );
    }
    if (kindResult.status === 'proxy_unsupported') {
      return (
        <EmptyState
          icon={I.download}
          title={t('custom.empty.proxyUpgrade.title')}
          desc={firstDiagnostic?.message ?? t('custom.empty.unsupported.desc')}
          action={(
            <button type="button" className="btn sm secondary" onClick={onOpenAgents}>
              {t('custom.empty.openAgents')}
            </button>
          )}
        />
      );
    }
    return (
      <EmptyState
        icon={I.alert}
        title={t('custom.empty.unavailable.title')}
        desc={firstDiagnostic?.message ?? t('custom.empty.unavailable.desc')}
        action={(
          <button type="button" className="btn sm secondary" onClick={refresh}>
            <Icon d={I.refresh} size={12} />
            {t('common.retry')}
          </button>
        )}
      />
    );
  }

  const listBody = (
    <>
      {agentsError && (
        <div className="custom-notice warn" role="alert">
          <span className="n-ico"><Icon d={I.alert} size={15} /></span>
          <span className="grow">{agentsError}</span>
        </div>
      )}
      {agent && !agent.ready && (
        <>
          <div className="custom-notice warn" role="status">
            <span className="n-ico"><Icon d={I.alert} size={15} /></span>
            <span className="grow">{t('custom.notice.agentNotReady').replace('{name}', agent.name)}</span>
          </div>
          <EmptyState
            icon={I.bot}
            title={t('custom.empty.notReady.title')}
            desc={t('custom.empty.notReady.desc').replace('{name}', agent.name)}
            action={(
              <button type="button" className="btn sm secondary" onClick={onOpenAgents}>
                {t('custom.empty.openAgents')}
              </button>
            )}
          />
        </>
      )}
      {agent?.ready && pageError && (
        <EmptyState
          icon={I.alert}
          title={t('custom.empty.unavailable.title')}
          desc={pageError}
          action={(
            <button type="button" className="btn sm secondary" onClick={refresh}>
              <Icon d={I.refresh} size={12} />
              {t('common.retry')}
            </button>
          )}
        />
      )}
      {agent?.ready && refreshError && inventory && (
        <div className="custom-notice warn" role="alert" data-testid="custom-refresh-failed">
          <span className="n-ico"><Icon d={I.alert} size={15} /></span>
          <span className="grow">{t('custom.notice.refreshFailed')}</span>
          <button type="button" className="btn ghost sm" onClick={refresh}>
            <Icon d={I.refresh} size={12} />
            {t('common.retry')}
          </button>
        </div>
      )}
      {showSkeleton && <LoadingSkeleton />}
      {agent?.ready && inventory && renderList()}
    </>
  );

  const mainColumn = (
    <main className={`main custom-main${swapDetail ? ' custom-hidden' : ''}`}>
      {head}
      <div className="custom-page-body">
        <div className="settings-search">
          <Icon d={I.search} size={14} />
          <input
            value={search}
            placeholder={t('custom.search.placeholder')}
            aria-label={t('custom.search.placeholder')}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        {selectors}
        {agent?.ready && tabs}
        {listBody}
      </div>
    </main>
  );

  const detailColumn = detailOpen && (
    <CustomDetail
      t={t}
      swap={swapDetail}
      width={!swapDetail && p2Width.customized ? p2Width.width : undefined}
      item={selectedItem}
      status={selectedItem && result ? rowStatus(result, selectedItem) : null}
      detail={detail}
      loading={detailLoading}
      error={detailError}
      observedRelTime={detail ? relTime(detail.observedAt) : null}
      chainPosition={
        selectedItem?.kind === 'rule' && result?.status === 'ok' && isChainRule(selectedItem)
          ? effectiveChain(result).findIndex(item => item.id === selectedItem.id) + 1
          : null
      }
      onClose={closeDetail}
      onRetry={() => setDetailNonce(n => n + 1)}
    />
  );

  return (
    <div className="custom-view" data-testid="custom-view">
      {agents !== null && agents.length === 0 && !agentsError ? (
        <main className="main custom-main">
          {head}
          <div className="custom-page-body">
            <EmptyState
              icon={I.bot}
              title={t('custom.empty.noAgents.title')}
              desc={t('custom.empty.noAgents.desc')}
              action={(
                <button type="button" className="btn sm primary" onClick={onOpenAgents}>
                  {t('custom.empty.noAgents.cta')}
                </button>
              )}
            />
          </div>
        </main>
      ) : (
        <div
          ref={contentRef}
          className={`custom-content${detailOpen && !swapDetail ? ' detail-side' : ''}`}
        >
          {/* Swap: the detail replaces the content column (design 09B) but the
              list stays mounted (hidden) so search text, filters, and scroll
              position survive the round trip. */}
          {swapDetail && detailColumn}
          {mainColumn}
          {!swapDetail && detailColumn && (
            <Splitter
              seam="main-panel2"
              className="p2-splitter"
              onMouseDown={p2Width.onMouseDown}
              ariaLabel={t('common.resize.panel')}
            />
          )}
          {!swapDetail && detailColumn}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function CustomSelect({
  label,
  buttonContent,
  children,
}: {
  label: string;
  buttonContent: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span className="mode-anchor custom-select" ref={ref}>
      <button
        type="button"
        className="btn secondary custom-select-btn"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {buttonContent}
        <span className="custom-caret"><Icon d={I.caretDown} size={12} /></span>
      </button>
      {open && (
        <div className="mode-pop" role="menu" aria-label={label} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </span>
  );
}

const ORIGIN_CHIPS: ReadonlyArray<readonly [string, string]> = [
  ['builtin', 'builtin'],
  ['user_file', 'user file'],
  ['project_file', 'project file'],
  ['plugin', 'plugin'],
  ['managed', 'managed'],
];

function FilterPopover({
  t,
  active,
  statusChips,
  scopeFilter,
  originFilter,
  statusFilter,
  onScopeFilter,
  onOriginFilter,
  onStatusFilter,
}: {
  t: ReturnType<typeof useT>;
  active: boolean;
  statusChips: readonly StatusChip[];
  scopeFilter: ReadonlySet<'workspace' | 'global'>;
  originFilter: ReadonlySet<string>;
  statusFilter: ReadonlySet<string>;
  onScopeFilter: (next: ReadonlySet<'workspace' | 'global'>) => void;
  onOriginFilter: (next: ReadonlySet<string>) => void;
  onStatusFilter: (next: ReadonlySet<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  return (
    <span className="mode-anchor custom-filter-anchor" ref={ref}>
      <button
        type="button"
        className={`btn icon ghost ${active ? 'custom-badged' : ''}`}
        data-testid="custom-filter"
        title={active ? t('custom.filter.activeTitle') : t('custom.filter.title')}
        aria-label={t('custom.filter.title')}
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Icon d={I.filter} size={14} />
      </button>
      {open && (
        <div className="mode-pop custom-filter-pop" role="menu" aria-label={t('custom.filter.title')}>
          <div className="custom-pop-label">{t('custom.filter.scope')}</div>
          <div className="chips">
            {(['workspace', 'global'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={`custom-chip ${scopeFilter.has(value) ? 'on' : ''}`}
                aria-pressed={scopeFilter.has(value)}
                onClick={() => onScopeFilter(toggle(scopeFilter, value))}
              >
                {t(value === 'workspace' ? 'custom.filter.workspace' : 'custom.filter.global')}
              </button>
            ))}
          </div>
          <div className="custom-pop-label">{t('custom.filter.origin')}</div>
          <div className="chips">
            {ORIGIN_CHIPS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`custom-chip ${originFilter.has(value) ? 'on' : ''}`}
                aria-pressed={originFilter.has(value)}
                onClick={() => onOriginFilter(toggle(originFilter, value))}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="custom-pop-label">{t('custom.filter.status')}</div>
          <div className="chips">
            {statusChips.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`custom-chip ${statusFilter.has(id) ? 'on' : ''}`}
                aria-pressed={statusFilter.has(id)}
                onClick={() => onStatusFilter(toggle(statusFilter, id))}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="custom-pop-rule" />
          <div className="custom-pop-foot">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                onScopeFilter(new Set());
                onOriginFilter(new Set());
                onStatusFilter(new Set());
              }}
            >
              {t('custom.filter.clearAll')}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

function PartialNotice({
  result,
  t,
}: {
  result: CustomizationListResult;
  t: ReturnType<typeof useT>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="custom-notice warn" role="status" data-testid="custom-partial-notice">
      <span className="n-ico"><Icon d={I.alert} size={15} /></span>
      <span className="grow">
        {t('custom.notice.partial')}
        {expanded && result.diagnostics.length > 0 && (
          <ul className="custom-diagnostics">
            {result.diagnostics.map((diagnostic, idx) => (
              <li key={idx}><code>{diagnostic.code}</code> {diagnostic.message}</li>
            ))}
          </ul>
        )}
      </span>
      {result.diagnostics.length > 0 && (
        <button type="button" className="btn ghost sm" onClick={() => setExpanded(e => !e)}>
          {t(expanded ? 'custom.notice.hideDiagnostics' : 'custom.notice.viewDiagnostics')}
        </button>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: readonly string[];
  title: string;
  desc: string | null;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty custom-empty">
      <span className="e-ico"><Icon d={icon} size={26} /></span>
      <div className="e-t">{title}</div>
      {desc && <div className="e-d">{desc}</div>}
      {action}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="custom-skeleton" data-testid="custom-skeleton" aria-hidden="true">
      <div className="custom-sk" style={{ height: 30, width: 260 }} />
      {[26, 20, 30, 22, 27].map((width, idx) => (
        <div className="custom-sk-row" key={idx}>
          <span className="custom-sk" style={{ width: 12, height: 12, borderRadius: '50%' }} />
          <span className="custom-sk" style={{ height: 11, width: `${width}%` }} />
          <span className="custom-sk" style={{ height: 11, flex: 1 }} />
          <span className="custom-sk" style={{ height: 18, width: 62, borderRadius: 99 }} />
        </div>
      ))}
    </div>
  );
}

function CustomDetail({
  t,
  swap,
  width,
  item,
  status,
  detail,
  loading,
  error,
  observedRelTime,
  chainPosition,
  onClose,
  onRetry,
}: {
  t: ReturnType<typeof useT>;
  swap: boolean;
  /** User-dragged panel-2 width; undefined keeps the CSS clamp baseline. */
  width?: number;
  item: CustomizationItem | null;
  status: RowStatus | null;
  detail: CustomizationDetailResult | null;
  loading: boolean;
  error: string | null;
  observedRelTime: string | null;
  chainPosition: number | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // MCP / Hook details are sanitized configuration views and are ALWAYS
  // Copy-only. The VS Code hand-off exists solely for Workspace-scope
  // Skill/Rule entries with an absolute file path (design + issue contract:
  // no in-app editor, no edit affordance for global/user files).
  const vscodePath = item && isWorkspaceScope(item)
    ? item.kind === 'skill'
      ? (isAbsPath(item.skill.entryPath) ? item.skill.entryPath : isAbsPath(item.origin.path) ? item.origin.path : null)
      : item.kind === 'rule'
        ? (isAbsPath(item.origin.path) ? item.origin.path : null)
        : null
    : null;

  function copyText() {
    if (!detail?.text) return;
    try {
      void navigator.clipboard?.writeText(detail.text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } catch { /* clipboard blocked */ }
  }

  function openInVsCode() {
    if (!vscodePath) return;
    window.open(`vscode://file/${encodeURI(vscodePath)}`, '_blank', 'noopener');
  }

  const sanitized = item?.kind === 'mcp' || item?.kind === 'hook';
  const metaLine = item ? detailMetaLine(item, chainPosition) : null;

  return (
    <aside
      className={`p2 custom-detail${swap ? ' replacing' : ''}`}
      style={width !== undefined ? { width } : undefined}
      data-testid="custom-detail"
    >
      <div className="p2-head custom-detail-head">
        {swap && (
          <button type="button" className="btn icon ghost" title={t('custom.detail.back')} aria-label={t('custom.detail.back')} onClick={onClose}>
            <Icon d={I.back} size={15} />
          </button>
        )}
        <h2>{item?.name ?? '…'}</h2>
        {status && <span className={`st ${status.tone}`}><span className="st-dot" />{status.label}</span>}
        <span className="custom-spacer" />
        {!swap && (
          <button type="button" className="btn icon ghost" title={t('custom.detail.close')} aria-label={t('custom.detail.close')} onClick={onClose}>
            <Icon d={I.close} size={13} />
          </button>
        )}
      </div>
      <div className="p2-body custom-detail-body">
        {item && (
          <div className="custom-meta">
            <div>{metaLine}</div>
            <div className="obs">
              {t('custom.detail.observed')
                .replace('{method}', item.discovery.method)
                .replace('{time}', observedRelTime ?? '…')}
            </div>
          </div>
        )}
        {sanitized && <div className="custom-viewlabel">{t('custom.detail.sanitized')}</div>}
        {loading && <div className="custom-sk" style={{ flex: 1, minHeight: 120 }} />}
        {!loading && error && (
          <div className="custom-detail-error" role="alert">
            <span>{t('custom.detail.loadFailed')}</span>
            <span className="custom-error-text">{error}</span>
            <button type="button" className="btn sm" onClick={onRetry}>{t('common.retry')}</button>
          </div>
        )}
        {!loading && !error && detail && (
          <>
            {detail.status === 'unavailable' ? (
              <div className="custom-detail-error" role="alert">
                <span>{t('custom.detail.loadFailed')}</span>
                <span className="custom-error-text">{detail.diagnostics?.[0]?.message ?? ''}</span>
                <button type="button" className="btn sm" onClick={onRetry}>{t('common.retry')}</button>
              </div>
            ) : (
              <pre className={`custom-code ${sanitized ? '' : 'wrap'}`} data-testid="custom-detail-text">{detail.text}</pre>
            )}
            {detail.truncated && <div className="custom-note">{t('custom.detail.truncated')}</div>}
          </>
        )}
      </div>
      <div className="p2-foot custom-detail-foot">
        <button type="button" className="btn xs ghost" disabled={!detail?.text} onClick={copyText}>
          <Icon d={copied ? I.check : I.copy} size={12} />
          {copied ? t('common.copied') : t('common.copy')}
        </button>
        {vscodePath && (
          <button type="button" className="btn xs ghost" onClick={openInVsCode}>
            <Icon d={I.ext} size={12} />
            {t('custom.detail.openVSCode')}
          </button>
        )}
        {sanitized && <span className="custom-note">{t('custom.detail.note.sanitized')}</span>}
      </div>
    </aside>
  );
}

/** First meta line of the detail sheet, per kind (design 08/09B/10C/10D). */
function detailMetaLine(item: CustomizationItem, chainPosition: number | null): React.ReactNode {
  const path = item.kind === 'skill'
    ? (item.skill.entryPath ?? item.origin.path)
    : item.origin.path;
  const monoPath = path ? <span className="mono">{path}</span> : null;
  switch (item.kind) {
    case 'skill':
      return <><strong>{item.name}</strong>{` · ${item.origin.kind} · `}{monoPath}</>;
    case 'mcp':
      return (
        <>
          <strong>{item.name}</strong>{` · ${item.origin.kind} · `}{monoPath}
          {` · Transport ${item.mcp.transport}`}
          {item.mcp.toolCount !== undefined ? ` · Tools ${item.mcp.toolCount}` : ''}
        </>
      );
    case 'hook':
      return (
        <>
          <strong>{item.name}</strong>{` · ${item.hook.nativeEvent}`}
          {item.hook.matcher ? <> · matcher <span className="mono">{item.hook.matcher}</span></> : null}
          {item.hook.timeoutMs ? ` · ${item.hook.timeoutMs} ms` : ''}
        </>
      );
    case 'rule':
      return (
        <>
          <strong>{item.name}</strong>{` · ${item.origin.kind} · `}{monoPath}
          {item.rule.lineCount !== undefined ? ` · ${item.rule.lineCount} lines` : ''}
          {chainPosition !== null ? ` · chain position #${chainPosition}` : ''}
        </>
      );
  }
}
