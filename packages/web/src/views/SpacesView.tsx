import { useEffect, useRef, useState } from 'react';
import type { NativeSession, Session, SystemConfig, Workspace } from '@gian/shared';
import {
  deleteWorkspace,
  loadClaudeMd,
  loadNativeSessions,
  loadRepoInfo,
  loadSessions,
  reorderWorkspaces,
  saveClaudeMd,
  updateWorkspace,
} from '../api.js';
import type { RepoInfo } from '../api.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';
import type { GianWs } from '../ws.js';
import { NewWorkspaceForm, useNewWorkspace } from './workspace-create.js';
import { GitPane } from './spaces-git-pane.js';
import { NativeSessionsPane } from './spaces-native-sessions.js';

type WsTab = 'overview' | 'git' | 'native';

export function SpacesView({
  workspaces,
  systemConfig,
  ws,
  onChange,
}: {
  workspaces: Workspace[];
  systemConfig: SystemConfig | null;
  ws: GianWs;
  onChange: () => void;
}) {
  const workspaceRoot = systemConfig?.workspace_root ?? '~/Coding';
  const [listTab, setListTab] = useState<'active' | 'archived'>('active');
  const [selectedId, setSelectedId] = useState<string | null>(
    workspaces.find(w => w.hidden !== 1)?.id ?? null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const newWs = useNewWorkspace(onChange);
  const rail = useResizableWidth('spaces.rail.w', 280, 200, 480, 'left');

  useEffect(() => {
    void loadSessions().then(setSessions);
  }, []);

  // Archived workspaces (hidden === 1) live under their own list tab; the
  // Active tab never shows them.
  const visible = workspaces.filter(w =>
    listTab === 'archived' ? w.hidden === 1 : w.hidden !== 1);
  const archivedCount = workspaces.reduce((n, w) => n + (w.hidden === 1 ? 1 : 0), 0);

  const selected = workspaces.find(w => w.id === selectedId) ?? null;

  // Keep the selection inside the current tab: unarchiving the selected
  // workspace (or switching tabs) drops it from the visible list.
  useEffect(() => {
    if (!visible.some(w => w.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null);
    }
  }, [listTab, workspaces, selectedId]);

  // Reorder swaps two rows of the VISIBLE list inside the full id ordering,
  // so workspaces in the other tab keep their relative positions.
  async function moveVisible(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= visible.length) return;
    const ids = workspaces.map(w => w.id);
    const a = ids.indexOf(visible[idx]!.id);
    const b = ids.indexOf(visible[target]!.id);
    if (a < 0 || b < 0) return;
    const tmp = ids[a]!;
    ids[a] = ids[b]!;
    ids[b] = tmp;
    await reorderWorkspaces(ids);
    onChange();
  }

  const [claudeMdOpen, setClaudeMdOpen] = useState(false);

  // Close the inspector when switching workspaces — the loaded content
  // belongs to the previously selected one.
  useEffect(() => { setClaudeMdOpen(false); }, [selectedId]);

  const sessionCounts = sessions.reduce<Record<string, number>>((acc, s) => {
    if (s.workspace_id) acc[s.workspace_id] = (acc[s.workspace_id] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div
      className={`view${claudeMdOpen ? ' has-inspector' : ''}`}
      style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}
    >
      <SpacesList
        workspaces={visible}
        selectedId={selectedId}
        workspaceRoot={workspaceRoot}
        sessionCounts={sessionCounts}
        listTab={listTab}
        archivedCount={archivedCount}
        onListTabChange={setListTab}
        onSelect={setSelectedId}
        onMoveUp={idx => void moveVisible(idx, -1)}
        onMoveDown={idx => void moveVisible(idx, 1)}
        onNewClick={() => { newWs.reset(); newWs.setOpen(true); }}
        newForm={listTab === 'active' && newWs.open ? (
          <NewWorkspaceForm
            form={newWs.form}
            saving={newWs.saving}
            error={newWs.error}
            projectRoot={workspaceRoot}
            onChange={f => newWs.setForm(prev => ({ ...prev, ...f }))}
            onSubmit={newWs.submit}
            onCancel={() => newWs.setOpen(false)}
          />
        ) : null}
      />
      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize workspaces list" />
      <SpaceDetail
        workspace={selected}
        allSessions={sessions}
        ws={ws}
        onChange={onChange}
        onDeleted={() => { /* selection re-syncs via the visible-list effect */ }}
        onOpenClaudeMd={() => setClaudeMdOpen(true)}
      />
      {claudeMdOpen && selected && (
        <ClaudeMdInspector
          workspaceId={selected.id}
          workspaceName={selected.name}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </div>
  );
}

function SpacesList({
  workspaces,
  selectedId,
  workspaceRoot,
  sessionCounts,
  listTab,
  archivedCount,
  onListTabChange,
  onSelect,
  onMoveUp,
  onMoveDown,
  onNewClick,
  newForm,
}: {
  workspaces: Workspace[];
  selectedId: string | null;
  workspaceRoot: string;
  sessionCounts: Record<string, number>;
  listTab: 'active' | 'archived';
  archivedCount: number;
  onListTabChange: (tab: 'active' | 'archived') => void;
  onSelect: (id: string) => void;
  onMoveUp: (idx: number) => void;
  onMoveDown: (idx: number) => void;
  onNewClick: () => void;
  newForm: React.ReactNode;
}) {
  const t = useT();
  return (
    <aside className="sidebar">
      <div className="spaces-list-head">
        <div className="spaces-list-head-row">
          <span className="sidebar-title">{t('spaces.title')}</span>
          {listTab === 'active' && (
            <button className="btn sm primary" aria-label="New workspace" onClick={onNewClick}>{t('spaces.new')}</button>
          )}
        </div>
        <div className="segm spaces-list-tabs">
          <button
            className={`segm-item ${listTab === 'active' ? 'active' : ''}`}
            onClick={() => onListTabChange('active')}
          >
            {t('spaces.tab.active')}
          </button>
          <button
            className={`segm-item ${listTab === 'archived' ? 'active' : ''}`}
            onClick={() => onListTabChange('archived')}
          >
            {t('spaces.tab.archived')}
            {archivedCount > 0 && <span className="count">{archivedCount}</span>}
          </button>
        </div>
        <div className="spaces-list-head-sub">root: <span className="spaces-list-head-sub-val">{workspaceRoot}</span></div>
      </div>
      <div className="spaces-list-body">
        {newForm}
        {workspaces.map((ws, idx) => {
          const count = sessionCounts[ws.id] ?? 0;
          return (
            <div
              key={ws.id}
              className={`spaces-list-row${selectedId === ws.id ? ' active' : ''}`}
              data-testid={`workspace-row-${ws.id}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(ws.id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(ws.id);
                }
              }}
            >
              <div className="spaces-list-row-info">
                <span className="spaces-ws-name">{ws.name}</span>
                <span className="spaces-ws-path">{ws.path}</span>
              </div>
              {count > 0 && <span className="spaces-ws-meta">{count}</span>}
              {listTab === 'active' && (
                <div className="spaces-list-row-acts" onClick={e => e.stopPropagation()}>
                  <button
                    className="btn xs ghost icon"
                    disabled={idx === 0}
                    onClick={() => onMoveUp(idx)}
                    title={t('spaces.moveup.title')}
                  >↑</button>
                  <button
                    className="btn xs ghost icon"
                    disabled={idx === workspaces.length - 1}
                    onClick={() => onMoveDown(idx)}
                    title={t('spaces.movedown.title')}
                  >↓</button>
                </div>
              )}
            </div>
          );
        })}
        {workspaces.length === 0 && !newForm && (
          <p className="spaces-empty">
            {t(listTab === 'archived' ? 'spaces.archived.empty' : 'spaces.empty')}
          </p>
        )}
      </div>
    </aside>
  );
}

export function SpaceDetail({
  workspace,
  allSessions,
  ws,
  onChange,
  onDeleted,
  onOpenClaudeMd,
}: {
  workspace: Workspace | null;
  allSessions: Session[];
  ws: GianWs;
  onChange: () => void;
  onDeleted: () => void;
  onOpenClaudeMd: () => void;
}) {
  const t = useT();
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [tab, setTab] = useState<WsTab>('overview');
  const [nativeCount, setNativeCount] = useState<number | null>(null);
  void saving;

  // Refresh native-session badge count when workspace changes.
  useEffect(() => {
    if (!workspace) { setNativeCount(null); return; }
    let cancelled = false;
    void loadNativeSessions(workspace.id).then(list => {
      if (!cancelled) setNativeCount(list.length);
    });
    return () => { cancelled = true; };
  }, [workspace?.id]);

  if (!workspace) {
    return (
      <main className="main spaces-detail-empty">
        <p>{t('spaces.detail.empty')}</p>
      </main>
    );
  }

  const relatedSessions = allSessions.filter(s => s.workspace_id === workspace.id);

  async function patchField(field: string, value: unknown) {
    setSaving(field);
    await updateWorkspace(workspace!.id, { [field]: value } as Parameters<typeof updateWorkspace>[1]);
    setSaving(null);
    onChange();
  }

  async function commitNameEdit() {
    if (nameEdit === null) return;
    const trimmed = nameEdit.trim();
    if (!trimmed || trimmed === workspace!.name) {
      setNameEdit(null);
      return;
    }
    await patchField('name', trimmed);
    setNameEdit(null);
  }

  async function handleDelete() {
    setDeleteError(null);
    setDeleting(true);
    const result = await deleteWorkspace(workspace!.id);
    setDeleting(false);
    if (!result.ok) {
      setDeleteError(result.error ?? 'Delete failed');
      return;
    }
    onChange();
    onDeleted();
  }

  return (
    <main className="main">
      <div className="main-scroll">
        <div className="detail">
          <div className="detail-head-row">
            {nameEdit !== null ? (
              <input
                className="input spaces-name-input"
                value={nameEdit}
                autoFocus
                onChange={e => setNameEdit(e.target.value)}
                onBlur={() => void commitNameEdit()}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter') void commitNameEdit();
                  if (e.key === 'Escape') setNameEdit(null);
                }}
              />
            ) : (
              <h1 onClick={() => setNameEdit(workspace.name)}>{workspace.name}</h1>
            )}
            <div className="detail-head-actions">
              {deleteError && <span className="spaces-error">{deleteError}</span>}
              <WorkspaceKebab
                hidden={workspace.hidden === 1}
                onRename={() => setNameEdit(workspace.name)}
                onToggleHidden={() => void patchField('hidden', workspace.hidden !== 1)}
                onDelete={() => void handleDelete()}
                deleting={deleting}
              />
            </div>
          </div>
          <div className="detail-sub">{workspace.path}</div>
          <div className="detail-tabs">
            <button
              className={`detail-tab ${tab === 'overview' ? 'active' : ''}`}
              onClick={() => setTab('overview')}
            >
              Overview
            </button>
            <button
              className={`detail-tab ${tab === 'git' ? 'active' : ''}`}
              onClick={() => setTab('git')}
            >
              Git
            </button>
            <button
              className={`detail-tab ${tab === 'native' ? 'active' : ''}`}
              onClick={() => setTab('native')}
            >
              Native sessions {nativeCount !== null && <span className="count">{nativeCount}</span>}
            </button>
          </div>
          {tab === 'overview' && (
            <OverviewPane
              workspace={workspace}
              relatedSessions={relatedSessions}
              onOpenClaudeMd={onOpenClaudeMd}
              t={t}
            />
          )}
          {tab === 'git' && (
            <GitPane
              workspace={workspace}
              ws={ws}
              onOpenClaudeMd={onOpenClaudeMd}
              onChange={onChange}
            />
          )}
          {tab === 'native' && (
            <NativeSessionsPane workspace={workspace} onChange={onChange} />
          )}
        </div>
      </div>
    </main>
  );
}

function WorkspaceKebab({
  hidden, onRename, onToggleHidden, onDelete, deleting,
}: {
  hidden: boolean;
  onRename: () => void;
  onToggleHidden: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  return (
    <div className="ws-kebab-anchor" ref={ref}>
      <button
        className="ws-kebab-btn"
        onClick={() => setOpen(o => !o)}
        title="More"
        aria-label="More actions"
      >
        ⋯
      </button>
      {open && (
        <div className="ws-kebab-pop">
          <button className="ws-kebab-item" onClick={() => { setOpen(false); onRename(); }}>
            Rename workspace
          </button>
          <button className="ws-kebab-item" onClick={() => { setOpen(false); onToggleHidden(); }}>
            {hidden ? 'Show in sidebar' : 'Hide from sidebar'}
          </button>
          <div className="ws-kebab-divider" />
          <button
            className="ws-kebab-item danger"
            disabled={deleting}
            onClick={() => { setOpen(false); onDelete(); }}
          >
            {deleting ? 'Deleting…' : 'Delete workspace'}
          </button>
        </div>
      )}
    </div>
  );
}

function OverviewPane({
  workspace,
  relatedSessions,
  onOpenClaudeMd,
  t,
}: {
  workspace: Workspace;
  relatedSessions: Session[];
  onOpenClaudeMd: () => void;
  t: ReturnType<typeof useT>;
}) {
  void t;
  void relatedSessions;
  const [native, setNative] = useState<NativeSession[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadNativeSessions(workspace.id),
      loadRepoInfo(workspace.id),
    ]).then(([n, r]) => {
      if (cancelled) return;
      setNative(n);
      setRepo(r);
    });
    return () => { cancelled = true; };
  }, [workspace.id]);

  const ccCount = native.filter(n => n.executor === 'claude').length;
  const codexCount = native.filter(n => n.executor === 'codex').length;
  const adoptedCount = native.filter(n => n.adoptedBy).length;
  const lastNative = native[0];
  const lastNativeRel = lastNative ? relTime(lastNative.updatedAt) : '—';
  const lastNativeAdopted = lastNative?.adoptedBy?.gianSessionName
    || (lastNative?.adoptedBy ? lastNative.adoptedBy.gianSessionId.slice(0, 6) : null);
  const created = new Date(workspace.created_at);
  const createdMonth = created.toLocaleString(undefined, { month: 'short', day: 'numeric' });
  const createdRel = relTime(workspace.created_at);

  return (
    <>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="k">Native sessions</div>
          <div className="v">{native.length}<span className="sub">{ccCount}cc · {codexCount}cx</span></div>
        </div>
        <div className="stat-card">
          <div className="k">Adopted</div>
          <div className="v">{adoptedCount}<span className="sub">/ {native.length}</span></div>
        </div>
        <div className="stat-card">
          <div className="k">Last activity</div>
          <div className="v">{lastNativeRel}{lastNativeAdopted && <span className="sub">via {lastNativeAdopted}</span>}</div>
        </div>
        <div className="stat-card">
          <div className="k">Created</div>
          <div className="v">{createdMonth}<span className="sub">{createdRel}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>About this workspace</h3>
          <span className="aside">path · agent notes</span>
        </div>
        <div className="card-body">
          <dl className="kv-grid">
            <dt>Local path</dt><dd>{workspace.path}</dd>
            <dt>Remote</dt><dd>{repo?.git.remote || '—'}</dd>
            <dt>Default branch</dt><dd>{repo?.git.defaultBranch || 'main'}</dd>
            <dt>CLAUDE.md</dt>
            <dd style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <button
                className="wt-claude"
                onClick={onOpenClaudeMd}
                style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left' }}
              >
                Edit CLAUDE.md
              </button>
            </dd>
          </dl>
        </div>
      </div>
    </>
  );
}

function relTime(iso: string): string {
  const elapsedMs = Date.now() - Date.parse(iso);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function ClaudeMdInspector({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string>('');
  const [original, setOriginal] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    void loadClaudeMd(workspaceId).then(c => {
      setContent(c);
      setOriginal(c);
      setLoading(false);
    });
  }, [workspaceId]);

  const dirty = content !== original;

  async function save() {
    setSaving(true);
    const ok = await saveClaudeMd(workspaceId, content);
    setSaving(false);
    if (ok) {
      setOriginal(content);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
    }
  }

  return (
    <aside className="spaces-inspector">
      <header className="spaces-inspector-head">
        <div className="spaces-inspector-title">
          <span className="spaces-inspector-file">CLAUDE.md</span>
          <span className="spaces-inspector-ws">{workspaceName}</span>
        </div>
        <button className="btn ghost sm" onClick={onClose} title="关闭">×</button>
      </header>
      <textarea
        className="input spaces-claude-md"
        value={loading ? '' : content}
        placeholder={loading ? 'Loading…' : '# notes for AI agents…'}
        onChange={e => setContent(e.target.value)}
      />
      <footer className="spaces-inspector-foot">
        <span className="field-hint">AGENTS.md → 软链接到此文件</span>
        <span className="spaces-inspector-foot-spacer" />
        {savedAt && <span className="settings-saved">已保存</span>}
        <button
          className="btn sm primary"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </footer>
    </aside>
  );
}
