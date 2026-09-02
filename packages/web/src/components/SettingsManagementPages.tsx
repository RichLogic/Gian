import { useEffect, useMemo, useRef, useState } from 'react';
import type { Executor, NativeSession, Session, Workspace } from '@gian/shared';
import {
  loadArchivedSessions,
  loadNativeSessions,
} from '../api.js';
import { confirm, toast } from '../feedback.js';
import {
  useOperationDispatch,
  useOperationStore,
  waitForRunSettle,
} from '../operations/use-operations.js';
import { AdoptDialog } from '../views/spaces-native-sessions.js';
import { useT } from '../i18n/index.js';
import { moveById, useDragReorder } from '../dnd-reorder.js';

const ICONS = {
  archive: 'M21 8v13H3V8 M1 3h22v5H1z M10 12h4',
  eyeOff: 'M3 3l18 18 M10.6 10.6a2 2 0 0 0 2.8 2.8 M9.9 5.1A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-2.1 2.9 M6.6 6.6C3.8 8.3 2 12 2 12s4 7 10 7c1.9 0 3.6-.5 5-1.3',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  search: 'M21 21l-4.3-4.3 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  // grip-vertical — the Settings > Workspaces drag affordance (2026-08-29).
  grip: 'M9 5h.01 M15 5h.01 M9 12h.01 M15 12h.01 M9 19h.01 M15 19h.01',
} as const;

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

function PageHeading({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="settings-page-heading">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

function SearchField({ value, onChange, placeholder }: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
}) {
  return (
    <label className="settings-search">
      <Icon path={ICONS.search} size={17} />
      <input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function workspaceLabel(workspaces: Workspace[], id: string | null): string {
  return workspaces.find(workspace => workspace.id === id)?.name ?? 'Unfiled';
}

function displaySessionName(session: Session): string {
  return session.name?.trim() || `Session ${session.id.slice(0, 8)}`;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

export function SettingsArchivePage({ workspaces, active = true }: { workspaces: Workspace[]; active?: boolean }) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const store = useOperationStore();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState('none');
  const [workspaceId, setWorkspaceId] = useState('none');
  const [loading, setLoading] = useState(active);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setLoading(true);
    try {
      setSessions(await loadArchivedSessions());
    } catch (error) {
      toast({ kind: 'error', message: error instanceof Error ? error.message : t('settings.archive.loadFailed') });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (active) void refresh(); }, [active]);

  const agents = useMemo(() => [...new Set(sessions.map(session =>
    session.agent_name || session.executor))].sort(), [sessions]);
  const filtered = sessions.filter(session => {
    if (agent === 'none' || workspaceId === 'none') return false;
    const needle = query.trim().toLocaleLowerCase();
    if (needle && !displaySessionName(session).toLocaleLowerCase().includes(needle)) return false;
    if (agent !== 'all' && (session.agent_name || session.executor) !== agent) return false;
    if (workspaceId !== 'all' && (session.workspace_id ?? 'unfiled') !== workspaceId) return false;
    return true;
  });
  const groups = groupSessions(filtered, workspaces);

  async function run(session: Session, action: 'restore' | 'delete') {
    if (action === 'delete') {
      const accepted = await confirm({
        title: t('settings.archive.deleteTitle'),
        message: t('settings.archive.deleteMessage').replace('{name}', displaySessionName(session)),
        confirmLabel: t('common.delete'),
        danger: true,
      });
      if (!accepted) return;
    }
    setBusyIds(current => new Set(current).add(session.id));
    const operation = action === 'restore'
      ? dispatch('session.archive', { sessionId: session.id, archived: false })
      : dispatch('session.delete', { sessionId: session.id });
    const settled = await waitForRunSettle(store, operation.id);
    setBusyIds(current => {
      const next = new Set(current);
      next.delete(session.id);
      return next;
    });
    if (settled.phase !== 'confirmed') {
      toast({ kind: 'error', message: settled.error ?? t('settings.archive.actionFailed') });
      return;
    }
    setSessions(current => current.filter(candidate => candidate.id !== session.id));
  }

  return (
    <section className="settings-page archive-page" data-testid="settings-archive-page">
      <PageHeading title={t('settings.archive.title')} />
      <div className="management-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder={t('settings.archive.search')} />
        <select value={agent} onChange={event => setAgent(event.target.value)} aria-label={t('settings.archive.agentFilter')}>
          <option value="none">{t('settings.archive.selectAgent')}</option>
          <option value="all">{t('settings.archive.allAgents')}</option>
          {agents.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} aria-label={t('settings.archive.workspaceFilter')}>
          <option value="none">{t('settings.archive.selectWorkspace')}</option>
          <option value="all">{t('settings.archive.allWorkspaces')}</option>
          {workspaces.filter(workspace => workspace.name !== '__gian_root__').map(workspace => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
          <option value="unfiled">{t('coding.sidebar.section.unfiled')}</option>
        </select>
      </div>
      {loading ? <ManagementEmpty>{t('common.loading')}</ManagementEmpty>
        : groups.length === 0 ? <ManagementEmpty>{t('settings.archive.empty')}</ManagementEmpty>
          : groups.map(group => (
            <ManagementGroup key={group.key} name={group.name} count={group.sessions.length} countLabel={t('settings.archive.chats')}>
              {group.sessions.map(session => (
                <div className="management-row" key={session.id}>
                  <div className="management-row-copy">
                    <strong>{displaySessionName(session)}</strong>
                    <span>{session.agent_name || session.executor} · {displayDate(session.updated_at)}</span>
                  </div>
                  <div className="management-row-actions">
                    <button className="iconbtn management-trash" title={t('common.delete')} aria-label={t('common.delete')}
                            disabled={busyIds.has(session.id)} onClick={() => void run(session, 'delete')}>
                      <Icon path={ICONS.trash} />
                    </button>
                    <button className="btn sm secondary management-primary-action" disabled={busyIds.has(session.id)}
                            onClick={() => void run(session, 'restore')}>
                      {t('settings.archive.unarchive')}
                    </button>
                  </div>
                </div>
              ))}
            </ManagementGroup>
          ))}
    </section>
  );
}

function groupSessions(sessions: Session[], workspaces: Workspace[]) {
  const order = new Map(workspaces.map((workspace, index) => [workspace.id, index]));
  const grouped = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = session.workspace_id ?? 'unfiled';
    grouped.set(key, [...(grouped.get(key) ?? []), session]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER))
    .map(([key, items]) => ({ key, name: workspaceLabel(workspaces, key === 'unfiled' ? null : key), sessions: items }));
}

interface NativeEntry {
  workspace: Workspace;
  session: NativeSession;
}

export function SettingsAdoptPage({
  workspaces,
  onSessionOpened,
  active = true,
}: {
  workspaces: Workspace[];
  onSessionOpened?(session: Session): void;
  active?: boolean;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const store = useOperationStore();
  const refreshGeneration = useRef(0);
  const [entries, setEntries] = useState<NativeEntry[]>([]);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'none' | 'all' | Executor>('none');
  const [workspaceId, setWorkspaceId] = useState('none');
  const [loading, setLoading] = useState(active);
  const [adopting, setAdopting] = useState<NativeEntry | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function refresh() {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    const visible = workspaces.filter(workspace => workspace.name !== '__gian_root__');
    const lists = await Promise.all(visible.map(async workspace => ({
      workspace,
      sessions: await loadNativeSessions(workspace.id),
    })));
    if (generation !== refreshGeneration.current) return;
    setEntries(lists.flatMap(result => result.sessions.map(session => ({ workspace: result.workspace, session }))));
    setLoading(false);
  }

  useEffect(() => {
    if (!active) return;
    void refresh();
    return () => { refreshGeneration.current += 1; };
  }, [active, workspaces.map(workspace => workspace.id).join(':')]);

  const filtered = entries.filter(entry => {
    if (entry.session.adoptedBy || provider === 'none' || workspaceId === 'none') return false;
    const needle = query.trim().toLocaleLowerCase();
    if (needle && !`${entry.session.firstUserMessage} ${entry.session.id}`.toLocaleLowerCase().includes(needle)) return false;
    if (provider !== 'all' && entry.session.executor !== provider) return false;
    if (workspaceId !== 'all' && entry.workspace.id !== workspaceId) return false;
    return true;
  });
  const grouped = workspaces
    .filter(workspace => filtered.some(entry => entry.workspace.id === workspace.id))
    .map(workspace => ({ workspace, entries: filtered.filter(entry => entry.workspace.id === workspace.id) }));

  async function removeNative(entry: NativeEntry) {
    const accepted = await confirm({
      title: t('settings.adopt.deleteTitle'),
      message: t('settings.adopt.deleteMessage'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!accepted) return;
    const key = `${entry.workspace.id}:${entry.session.executor}:${entry.session.id}`;
    setDeleting(key);
    const run = dispatch('native.delete', {
      workspaceId: entry.workspace.id,
      executor: entry.session.executor,
      nativeId: entry.session.id,
    });
    const settled = await waitForRunSettle(store, run.id);
    setDeleting(null);
    if (settled.phase !== 'confirmed') {
      toast({ kind: 'error', message: settled.error ?? t('settings.adopt.deleteFailed') });
      return;
    }
    setEntries(current => current.filter(candidate => candidate !== entry));
  }

  return (
    <section className="settings-page adopt-page" data-testid="settings-adopt-page">
      <PageHeading title={t('settings.adopt.title')} action={(
        <button className="btn secondary" disabled={loading} onClick={() => void refresh()}>
          <Icon path={ICONS.refresh} /> {t('settings.adopt.refresh')}
        </button>
      )} />
      <div className="management-toolbar adopt-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder={t('settings.adopt.search')} />
        <select value={provider} onChange={event => setProvider(event.target.value as 'none' | 'all' | Executor)} aria-label={t('settings.adopt.providerFilter')}>
          <option value="none">{t('settings.adopt.selectProvider')}</option>
          <option value="all">{t('settings.adopt.allProviders')}</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="kimi">Kimi</option>
        </select>
        <select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} aria-label={t('settings.adopt.workspaceFilter')}>
          <option value="none">{t('settings.archive.selectWorkspace')}</option>
          <option value="all">{t('settings.archive.allWorkspaces')}</option>
          {workspaces.filter(workspace => workspace.name !== '__gian_root__').map(workspace => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
      </div>
      {loading ? <ManagementEmpty>{t('common.loading')}</ManagementEmpty>
        : grouped.length === 0 ? <ManagementEmpty>{t('settings.adopt.empty')}</ManagementEmpty>
          : grouped.map(group => (
            <ManagementGroup key={group.workspace.id} name={group.workspace.name}
                             count={group.entries.length} countLabel={t('settings.adopt.sessions')}>
              {group.entries.map(entry => {
                const native = entry.session;
                const deleteKey = `${entry.workspace.id}:${native.executor}:${native.id}`;
                return (
                  <div className="management-row native-management-row" key={`${native.executor}:${native.id}`}>
                    <span className={`native-provider-dot ${native.executor}`} />
                    <div className="management-row-copy">
                      <strong>{native.firstUserMessage || t('settings.adopt.untitled')}</strong>
                      <span>{native.executor} · {displayDate(native.updatedAt)} · {native.turnCount} {t('settings.adopt.turns')}{native.gitBranch ? ` · ${native.gitBranch}` : ''}</span>
                    </div>
                    <div className="management-row-actions">
                      <button className="iconbtn management-trash" title={t('common.delete')} aria-label={t('common.delete')}
                              disabled={deleting === deleteKey} onClick={() => void removeNative(entry)}>
                        <Icon path={ICONS.trash} />
                      </button>
                      <button className="btn sm primary management-primary-action" onClick={() => setAdopting(entry)}>
                        {t('settings.adopt.action')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </ManagementGroup>
          ))}
      {adopting && (
        <AdoptDialog
          source={adopting.session}
          workspaceId={adopting.workspace.id}
          onCancel={() => setAdopting(null)}
          onAdopted={session => {
            setAdopting(null);
            void refresh();
            onSessionOpened?.(session);
          }}
        />
      )}
    </section>
  );
}

export function SettingsWorkspacesPage({
  workspaces,
  onWorkspaceOpened,
}: {
  workspaces: Workspace[];
  onWorkspaceOpened?: (workspaceId: string) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  const visible = workspaces.filter(workspace => workspace.name !== '__gian_root__' && workspace.hidden !== 1);
  const hidden = workspaces.filter(workspace => workspace.name !== '__gian_root__' && workspace.hidden === 1);

  // Drag reorder (2026-08-29, replaces the up/down arrows): visible rows drag
  // to reorder; the dispatched id array always covers EVERY workspace (the
  // host rewrites sort_order wholesale) — hidden/root rows keep their
  // relative positions because moveById only relocates the dragged id.
  const dnd = useDragReorder((dragId, targetId, place) => {
    const current = workspaces.map(workspace => workspace.id);
    const next = moveById(current, dragId, targetId, place);
    if (next !== current) dispatch('workspace.reorder', { ids: next });
  });

  return (
    <section className="settings-page workspaces-settings-page" data-testid="settings-workspaces-page">
      <PageHeading title={t('settings.workspaces.title')} />
      <div className="workspace-settings-section">
        <div className="management-group-heading">
          <strong>{t('settings.workspaces.active')}</strong>
          <span>{visible.length}</span>
        </div>
        <div className="management-list">
          {visible.length === 0 && <ManagementEmpty>{t('settings.workspaces.empty')}</ManagementEmpty>}
          {visible.map(workspace => (
            <div
              className={`management-row workspace-management-row${dnd.rowClass(workspace.id)}`}
              key={workspace.id}
              data-testid={`ws-item-${workspace.id}`}
              {...dnd.rowProps(workspace.id)}
            >
              <span className="management-drag-grip" aria-hidden>
                <Icon path={ICONS.grip} />
              </span>
              <button
                type="button"
                className="management-row-copy ws-item-main"
                onClick={() => onWorkspaceOpened?.(workspace.id)}
              >
                <strong>{workspace.name}</strong>
                <span className="mono">{workspace.path}</span>
              </button>
              <button className="btn sm secondary" onClick={() => dispatch('workspace.setHidden', { workspaceId: workspace.id, hidden: true })}>
                <Icon path={ICONS.eyeOff} /> {t('settings.workspaces.hide')}
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="workspace-settings-section">
        <div className="management-group-heading">
          <strong>{t('settings.workspaces.hidden')}</strong>
          <span>{hidden.length}</span>
        </div>
        <div className="management-list">
          {hidden.length === 0 && <ManagementEmpty>{t('settings.workspaces.hiddenEmpty')}</ManagementEmpty>}
          {hidden.map(workspace => (
            <div
              className="management-row workspace-management-row"
              key={workspace.id}
              data-testid={`ws-item-${workspace.id}`}
            >
              <button
                type="button"
                className="management-row-copy ws-item-main"
                onClick={() => onWorkspaceOpened?.(workspace.id)}
              >
                <strong>{workspace.name}</strong>
                <span className="mono">{workspace.path}</span>
              </button>
              <button className="btn sm secondary" onClick={() => dispatch('workspace.setHidden', { workspaceId: workspace.id, hidden: false })}>
                {t('settings.workspaces.show')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ManagementGroup({ name, count, countLabel, children }: {
  name: string;
  count: number;
  countLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="management-group">
      <div className="management-group-heading">
        <strong>{name}</strong>
        <span>{count} {countLabel}</span>
      </div>
      <div className="management-list">{children}</div>
    </section>
  );
}

function ManagementEmpty({ children }: { children: React.ReactNode }) {
  return <div className="management-empty">{children}</div>;
}
