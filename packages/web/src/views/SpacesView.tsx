import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalMode, NativeSession, Session, SystemConfig, Workspace } from '@gian/shared';
import {
  adoptNativeSession,
  createWorkspace,
  deleteNativeSession,
  deleteWorkspace,
  loadClaudeMd,
  loadNativeSessions,
  loadRepoInfo,
  loadSessions,
  loadWorkspaceTrees,
  pickWorkspaceFolder,
  reorderWorkspaces,
  saveClaudeMd,
  updateWorkspace,
} from '../api.js';
import type { RepoInfo, WorkspaceTree } from '../api.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';

type WsTab = 'config' | 'native';

type NewWorkspaceSource = 'new' | 'adopt';

interface NewWorkspaceForm {
  source: NewWorkspaceSource;
  name: string;
  gitRemote: string;
  /** Absolute path (~ allowed) — used when source === 'adopt'. */
  path: string;
  /** True once the user types into the name field directly — stops the
   *  adopt-mode auto-rename from clobbering their choice. */
  nameTouched: boolean;
}

function useNewWorkspace(onChange: () => void) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewWorkspaceForm>({ source: 'new', name: '', gitRemote: '', path: '', nameTouched: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  function reset() {
    setForm({ source: 'new', name: '', gitRemote: '', path: '', nameTouched: false });
    setError(null);
    setNotes([]);
  }

  async function submit() {
    if (!form.name) {
      setError('Name is required');
      return;
    }
    if (form.source === 'adopt' && !form.path.trim()) {
      setError('Path is required');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createWorkspace(form.name, form.source === 'adopt'
      ? { path: form.path.trim() }
      : { gitRemote: form.gitRemote.trim() || undefined });
    setSaving(false);
    if (!result.workspace) {
      setError(result.error ?? 'Create failed');
      setNotes(result.notes);
      return;
    }
    reset();
    setOpen(false);
    onChange();
  }

  return { open, setOpen, form, setForm, saving, error, notes, submit, reset };
}

export interface CreateWorktreeSessionInput {
  workspaceId: string;
  executor: 'claude' | 'codex';
  baseBranch?: string;
  branch?: string;
}

export function SpacesView({
  workspaces,
  systemConfig,
  onChange,
  onCreateWorktreeSession,
}: {
  workspaces: Workspace[];
  systemConfig: SystemConfig | null;
  onChange: () => void;
  onCreateWorktreeSession: (input: CreateWorktreeSessionInput) => void;
}) {
  const workspaceRoot = systemConfig?.workspace_root ?? '~/Coding';
  const [selectedId, setSelectedId] = useState<string | null>(workspaces[0]?.id ?? null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const newWs = useNewWorkspace(onChange);
  const rail = useResizableWidth('spaces.rail.w', 280, 200, 480, 'left');

  useEffect(() => {
    void loadSessions().then(setSessions);
  }, []);

  const selected = workspaces.find(w => w.id === selectedId) ?? null;

  async function moveUp(idx: number) {
    if (idx === 0) return;
    const ids = workspaces.map(w => w.id);
    const tmp = ids[idx - 1]!;
    ids[idx - 1] = ids[idx]!;
    ids[idx] = tmp;
    await reorderWorkspaces(ids);
    onChange();
  }

  async function moveDown(idx: number) {
    if (idx >= workspaces.length - 1) return;
    const ids = workspaces.map(w => w.id);
    const tmp = ids[idx + 1]!;
    ids[idx + 1] = ids[idx]!;
    ids[idx] = tmp;
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
        workspaces={workspaces}
        selectedId={selectedId}
        workspaceRoot={workspaceRoot}
        sessionCounts={sessionCounts}
        onSelect={setSelectedId}
        onMoveUp={moveUp}
        onMoveDown={moveDown}
        onNewClick={() => { newWs.reset(); newWs.setOpen(true); }}
        newForm={newWs.open ? (
          <NewWorkspaceForm
            form={newWs.form}
            saving={newWs.saving}
            error={newWs.error}
            workspaceRoot={workspaceRoot}
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
        onChange={onChange}
        onDeleted={() => setSelectedId(workspaces.find(w => w.id !== selectedId)?.id ?? null)}
        onOpenClaudeMd={() => setClaudeMdOpen(true)}
        onCreateWorktreeSession={onCreateWorktreeSession}
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
          <button className="btn sm primary" onClick={onNewClick}>{t('spaces.new')}</button>
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
              onClick={() => onSelect(ws.id)}
            >
              <div className="spaces-list-row-info">
                <span className="spaces-ws-name">{ws.name}</span>
                <span className="spaces-ws-path">{ws.path}</span>
              </div>
              {count > 0 && <span className="spaces-ws-meta">{count}</span>}
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
            </div>
          );
        })}
        {workspaces.length === 0 && !newForm && (
          <p className="spaces-empty">{t('spaces.empty')}</p>
        )}
      </div>
    </aside>
  );
}

function NewWorkspaceForm({
  form,
  saving,
  error,
  workspaceRoot,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: NewWorkspaceForm;
  saving: boolean;
  error: string | null;
  workspaceRoot: string;
  onChange: (patch: Partial<NewWorkspaceForm>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isAdopt = form.source === 'adopt';
  const pathPreview = isAdopt
    ? form.path.trim() || ''
    : form.name ? `${workspaceRoot.replace(/\/$/, '')}/${form.name}` : '';

  function changeSource(source: NewWorkspaceSource) {
    if (source === form.source) return;
    // When switching to adopt, auto-fill name from the trailing segment of the
    // path the user might already have typed. Keep what they have otherwise.
    onChange({ source });
  }

  function changePath(raw: string) {
    const patch: Partial<NewWorkspaceForm> = { path: raw };
    // Auto-suggest a name from the trailing path segment whenever the user
    // hasn't typed into the name field themselves. Re-runs on every keystroke
    // so the name keeps tracking the path until they take it over.
    if (isAdopt && !form.nameTouched) {
      const trimmed = raw.trim().replace(/\/+$/, '');
      const tail = trimmed.split('/').filter(Boolean).pop() ?? '';
      const cleaned = tail.replace(/[^a-zA-Z0-9._-]/g, '-');
      patch.name = cleaned;
    }
    onChange(patch);
  }

  const submitDisabled = saving || !form.name || (isAdopt && !form.path.trim());

  return (
    <div className="spaces-new-form">
      <div className="segm spaces-new-source" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={!isAdopt}
          className={`segm-item${!isAdopt ? ' active' : ''}`}
          onClick={() => changeSource('new')}
        >
          New
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isAdopt}
          className={`segm-item${isAdopt ? ' active' : ''}`}
          onClick={() => changeSource('adopt')}
        >
          Adopt path
        </button>
      </div>
      {isAdopt && (
        <div className="spaces-new-path-row">
          <input
            className="input"
            placeholder="/Users/you/Code/some-project or ~/Code/some-project"
            value={form.path}
            onChange={e => changePath(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          <BrowseFolderButton
            disabled={saving}
            onPicked={picked => changePath(picked)}
          />
        </div>
      )}
      <input
        className="input"
        placeholder="Name (a-z A-Z 0-9 . _ -)"
        value={form.name}
        onChange={e => onChange({ name: e.target.value, nameTouched: true })}
        autoFocus={!isAdopt}
      />
      {!isAdopt && (
        <input
          className="input"
          placeholder="Git remote URL (optional)"
          value={form.gitRemote}
          onChange={e => onChange({ gitRemote: e.target.value })}
        />
      )}
      {pathPreview && (
        <div className="spaces-path-preview">
          <span className="spaces-path-preview-lbl">→</span>
          <span className="spaces-path-preview-val">{pathPreview}</span>
        </div>
      )}
      {error && <p className="spaces-error">{error}</p>}
      <div className="spaces-new-form-actions">
        <button className="btn sm ghost" onClick={onCancel} disabled={saving}>{t('spaces.form.cancel')}</button>
        <button className="btn sm primary" onClick={onSubmit} disabled={submitDisabled}>
          {saving ? t('spaces.form.creating') : t('spaces.form.create')}
        </button>
      </div>
    </div>
  );
}

function BrowseFolderButton({
  disabled,
  onPicked,
}: {
  disabled?: boolean;
  onPicked: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await pickWorkspaceFolder();
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.path) onPicked(result.path);
    // result.canceled → silent no-op
  }

  return (
    <>
      <button
        type="button"
        className="btn sm ghost spaces-browse-btn"
        onClick={() => void pick()}
        disabled={disabled || busy}
        title="Open native folder picker"
      >
        {busy ? 'Picking…' : 'Browse…'}
      </button>
      {error && <p className="spaces-error">{error}</p>}
    </>
  );
}

function SpaceDetail({
  workspace,
  allSessions,
  onChange,
  onDeleted,
  onOpenClaudeMd,
  onCreateWorktreeSession,
}: {
  workspace: Workspace | null;
  allSessions: Session[];
  onChange: () => void;
  onDeleted: () => void;
  onOpenClaudeMd: () => void;
  onCreateWorktreeSession: (input: CreateWorktreeSessionInput) => void;
}) {
  const t = useT();
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  void saving;

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
      <div className="spaces-detail-head">
        <div className="spaces-detail-head-l">
          {nameEdit !== null ? (
            <input
              className="input spaces-name-input"
              value={nameEdit}
              autoFocus
              onChange={e => setNameEdit(e.target.value)}
              onBlur={() => void commitNameEdit()}
              onKeyDown={e => { if (e.key === 'Enter') void commitNameEdit(); if (e.key === 'Escape') setNameEdit(null); }}
            />
          ) : (
            <h2 className="spaces-detail-name" onClick={() => setNameEdit(workspace.name)}>
              {workspace.name}
            </h2>
          )}
        </div>
        <div className="spaces-detail-head-r">
          {deleteError && <span className="spaces-error">{deleteError}</span>}
          <WorkspaceKebab
            onRename={() => setNameEdit(workspace.name)}
            onDelete={() => void handleDelete()}
            deleting={deleting}
          />
        </div>
      </div>

      <WorkspaceTabs workspace={workspace} sessionCount={relatedSessions.length}>
        {(activeTab) => activeTab === 'config' ? (
          <ConfigPane
            workspace={workspace}
            relatedSessions={relatedSessions}
            onOpenClaudeMd={onOpenClaudeMd}
            onChange={onChange}
            onCreateWorktreeSession={onCreateWorktreeSession}
            t={t}
          />
        ) : (
          <NativeSessionsPane workspace={workspace} onChange={onChange} />
        )}
      </WorkspaceTabs>
    </main>
  );
}

function WorkspaceKebab({
  onRename, onDelete, deleting,
}: { onRename: () => void; onDelete: () => void; deleting: boolean }) {
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

function WorkspaceTabs({
  workspace,
  sessionCount,
  children,
}: {
  workspace: Workspace;
  sessionCount: number;
  children: (active: WsTab) => React.ReactNode;
}) {
  const [active, setActive] = useState<WsTab>('config');
  const [nativeCount, setNativeCount] = useState<number | null>(null);

  // Lightweight count fetch for the tab badge — same endpoint the tab body
  // uses, just for the number. Refreshed when workspace changes.
  useEffect(() => {
    let cancelled = false;
    void loadNativeSessions(workspace.id).then(list => {
      if (!cancelled) setNativeCount(list.length);
    });
    return () => { cancelled = true; };
  }, [workspace.id]);

  void sessionCount; // available if we ever want to display Gian session count too
  return (
    <>
      <nav className="ws-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={active === 'config'}
          className={`ws-tab${active === 'config' ? ' active' : ''}`}
          onClick={() => setActive('config')}
        >
          Config
        </button>
        <button
          role="tab"
          aria-selected={active === 'native'}
          className={`ws-tab${active === 'native' ? ' active' : ''}`}
          onClick={() => setActive('native')}
        >
          Native Sessions
          {nativeCount !== null && <span className="ws-tab-count">{nativeCount}</span>}
        </button>
      </nav>
      {children(active)}
    </>
  );
}

function ConfigPane({
  workspace,
  relatedSessions,
  onOpenClaudeMd,
  onChange,
  onCreateWorktreeSession,
  t,
}: {
  workspace: Workspace;
  relatedSessions: Session[];
  onOpenClaudeMd: () => void;
  onChange: () => void;
  onCreateWorktreeSession: (input: CreateWorktreeSessionInput) => void;
  t: ReturnType<typeof useT>;
}) {
  void t;
  const [native, setNative] = useState<NativeSession[]>([]);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [trees, setTrees] = useState<WorkspaceTree[]>([]);
  const [treesLoaded, setTreesLoaded] = useState(false);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);

  const refreshTrees = useCallback(async () => {
    const tr = await loadWorkspaceTrees(workspace.id);
    setTrees(tr);
    setTreesLoaded(true);
  }, [workspace.id]);

  useEffect(() => {
    let cancelled = false;
    setTreesLoaded(false);
    void Promise.all([
      loadNativeSessions(workspace.id),
      loadRepoInfo(workspace.id),
      loadWorkspaceTrees(workspace.id),
    ]).then(([n, r, tr]) => {
      if (cancelled) return;
      setNative(n);
      setRepo(r);
      setTrees(tr);
      setTreesLoaded(true);
    });
    return () => { cancelled = true; };
  }, [workspace.id]);

  const ccCount = native.filter(n => n.executor === 'claude').length;
  const codexCount = native.filter(n => n.executor === 'codex').length;
  const adoptedCount = native.filter(n => n.adoptedBy).length;
  const lastNative = native[0]; // already sorted by updatedAt desc
  const lastNativeRel = lastNative ? relTime(lastNative.updatedAt) : '—';
  const lastNativeAdopted = lastNative?.adoptedBy?.gianSessionName
    || (lastNative?.adoptedBy ? lastNative.adoptedBy.gianSessionId.slice(0, 6) : null);
  const created = new Date(workspace.created_at);
  const createdMonth = created.toLocaleString(undefined, { month: 'short', day: 'numeric' });
  const createdRel = relTime(workspace.created_at);

  void relatedSessions;

  return (
    <div className="spaces-detail-body">
      <div className="cfg-stats">
        <div className="cfg-stat">
          <span className="cfg-stat-label">Native sessions</span>
          <span className="cfg-stat-value">{native.length}</span>
          <span className="cfg-stat-sub">{ccCount} claude · {codexCount} codex</span>
        </div>
        <div className="cfg-stat">
          <span className="cfg-stat-label">Adopted</span>
          <span className="cfg-stat-value">{adoptedCount}</span>
          <span className="cfg-stat-sub">linked to Gian sessions</span>
        </div>
        <div className="cfg-stat">
          <span className="cfg-stat-label">Last activity</span>
          <span className="cfg-stat-value-mono">{lastNativeRel}</span>
          <span className="cfg-stat-sub">
            {lastNativeAdopted ? `via ${lastNativeAdopted}` : (lastNative ? `${lastNative.executor}` : 'no sessions yet')}
          </span>
        </div>
        <div className="cfg-stat">
          <span className="cfg-stat-label">Created</span>
          <span className="cfg-stat-value-mono">{createdMonth}</span>
          <span className="cfg-stat-sub">{createdRel}</span>
        </div>
      </div>

      <div className="cfg-grid">
        <div className="cfg-card full">
          <div className="cfg-card-head">
            <span className="cfg-card-title">Repository</span>
            {repo?.git.remote && (
              <a
                className="cfg-card-action"
                href={repo.git.remote.startsWith('http') ? repo.git.remote : `https://${repo.git.remote}`}
                target="_blank"
                rel="noreferrer"
              >
                View on GitHub
              </a>
            )}
          </div>
          <div className="cfg-card-body">
            <div className="cfg-kv">
              <span className="cfg-kv-key">Local path</span>
              <span className="cfg-kv-val mono">{workspace.path}</span>
            </div>
            {repo?.git.isRepo ? (
              <>
                {repo.git.remote && (
                  <div className="cfg-kv">
                    <span className="cfg-kv-key">Remote</span>
                    <span className="cfg-kv-val mono">
                      <a
                        className="cfg-kv-link"
                        href={`https://${repo.git.remote}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {repo.git.remote}
                      </a>
                    </span>
                  </div>
                )}
                {repo.git.defaultBranch && (
                  <div className="cfg-kv">
                    <span className="cfg-kv-key">Default branch</span>
                    <span className="cfg-kv-val">
                      <span className="cfg-branch-pill">{repo.git.defaultBranch}</span>
                    </span>
                  </div>
                )}
                {repo.git.lastCommit && (
                  <div className="cfg-kv">
                    <span className="cfg-kv-key">Last commit</span>
                    <span className="cfg-kv-val">
                      <span className="cfg-commit-mono">{repo.git.lastCommit.hash}</span>
                      <span style={{ color: 'var(--text-3)', fontSize: '11px' }}>
                        {repo.git.lastCommit.message} · {repo.git.lastCommit.age}
                      </span>
                    </span>
                  </div>
                )}
              </>
            ) : repo ? (
              <div className="cfg-kv">
                <span className="cfg-kv-key">Status</span>
                <span className="cfg-kv-val" style={{ color: 'var(--text-3)' }}>not a git repository</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="cfg-card full">
          <div className="cfg-card-head">
            <span className="cfg-card-title">
              Workspace Trees · {trees.length}
            </span>
            {repo?.git.isRepo && (
              <button
                className="cfg-card-action"
                onClick={() => setNewWorktreeOpen(true)}
                title="Create a new git worktree + session"
              >
                + New worktree
              </button>
            )}
          </div>
          <div className="cfg-card-body compact">
            {trees.map(tree => (
              <WorkspaceTreeRow
                key={tree.id}
                tree={tree}
                onOpenClaudeMd={tree.kind === 'main' ? onOpenClaudeMd : undefined}
                onRefresh={() => { void refreshTrees(); onChange(); }}
              />
            ))}
            {trees.length === 0 && !treesLoaded && (
              <div className="cfg-wt-row cfg-wt-loading">
                <span className="spinner" aria-hidden="true" />
                <span>Loading worktrees…</span>
              </div>
            )}
            {trees.length === 0 && treesLoaded && (
              <div className="cfg-wt-row" style={{ color: 'var(--text-3)' }}>
                No worktrees yet.
              </div>
            )}
          </div>
        </div>
      </div>
      {newWorktreeOpen && (
        <NewWorktreeDialog
          workspace={workspace}
          defaultBranch={repo?.git.defaultBranch ?? null}
          onCancel={() => setNewWorktreeOpen(false)}
          onCreate={(input) => {
            onCreateWorktreeSession({
              workspaceId: workspace.id,
              executor: input.executor,
              ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
              ...(input.branch ? { branch: input.branch } : {}),
            });
            setNewWorktreeOpen(false);
            // Optimistic refresh after a short delay to let the proxy/git
            // pipeline finish. session:created will also push a new session
            // through; this just brings the trees list back in sync.
            setTimeout(() => { void refreshTrees(); onChange(); }, 800);
          }}
        />
      )}
    </div>
  );
}

function WorkspaceTreeRow({
  tree,
  onOpenClaudeMd,
  onRefresh,
}: {
  tree: WorkspaceTree;
  onOpenClaudeMd?: () => void;
  onRefresh: () => void;
}) {
  const isMain = tree.kind === 'main';
  return (
    <div className={`cfg-wt-row${isMain ? ' main-tree' : ''}`}>
      <svg className="cfg-wt-icon" viewBox="0 0 16 16" fill="none">
        {isMain ? (
          <path
            d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        ) : (
          <>
            <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="12" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M4 5.5v5M5.5 12h5M5 5l5 7" stroke="currentColor" strokeWidth="1.2" />
          </>
        )}
      </svg>
      <div className="cfg-wt-info">
        <span className="cfg-wt-branch">{tree.branch ?? tree.label}</span>
        {isMain ? <span className="cfg-wt-tag">main tree</span> : null}
      </div>
      <button
        className={`cfg-wt-claude${tree.claudeMd.exists ? '' : ' empty'}`}
        title={tree.claudeMd.exists ? 'Edit CLAUDE.md' : 'Create CLAUDE.md'}
        onClick={onOpenClaudeMd}
        disabled={!onOpenClaudeMd}
      >
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M3 2h6l3 3v9H3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        {tree.claudeMd.exists ? 'CLAUDE.md' : '+ CLAUDE.md'}
        {tree.claudeMd.exists && <span className="lines">{tree.claudeMd.lines}L</span>}
      </button>
      <span className={`cfg-wt-state ${tree.isDirty ? 'dirty' : 'clean'}`}>
        {tree.isDirty ? `${tree.modifiedCount} modified` : 'clean'}
      </span>
      {tree.session ? (
        <span className="cfg-wt-session" title={`Linked to ${tree.session.name ?? tree.session.id}`}>
          {tree.session.name ?? tree.session.id.slice(0, 6)}
        </span>
      ) : (
        <span className="cfg-wt-session muted" title="Not bound to a Gian session">no session</span>
      )}
      <WorkspaceTreeRowKebab tree={tree} onRefresh={onRefresh} />
    </div>
  );
}

function WorkspaceTreeRowKebab({
  tree,
  onRefresh,
}: {
  tree: WorkspaceTree;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'reveal' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  async function handleReveal() {
    setBusy('reveal');
    setError(null);
    try {
      const res = await fetch(`/api/working_trees/${tree.id}/reveal`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `Reveal failed (${res.status})`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!tree.session) return;
    const sid = tree.session.id;
    const label = tree.branch ?? tree.label;
    if (!confirm(`Delete worktree "${label}"?\nThis removes the linked Gian session (${sid.slice(0, 8)}…) and the worktree directory.`)) return;
    setBusy('delete');
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `Delete failed (${res.status})`);
        return;
      }
      setOpen(false);
      onRefresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  const isWorktree = tree.kind === 'worktree' && !!tree.session;

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
          <button
            className="ws-kebab-item"
            disabled={busy !== null}
            onClick={() => { setOpen(false); void handleReveal(); }}
          >
            {busy === 'reveal' ? 'Opening…' : 'Open in Finder'}
          </button>
          {isWorktree && (
            <>
              <div className="ws-kebab-divider" />
              <button
                className="ws-kebab-item danger"
                disabled={busy !== null}
                onClick={() => { void handleDelete(); }}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete worktree'}
              </button>
            </>
          )}
          {error && (
            <>
              <div className="ws-kebab-divider" />
              <div className="ws-kebab-item" style={{ color: 'var(--danger)', cursor: 'default' }}>
                {error}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NativeSessionsPane({
  workspace,
  onChange,
}: {
  workspace: Workspace;
  onChange: () => void;
}) {
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [executor, setExecutor] = useState<'all' | 'claude' | 'codex'>('all');
  const [status, setStatus] = useState<'all' | 'adopted' | 'available'>('all');
  const [adoptingFor, setAdoptingFor] = useState<NativeSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    const list = await loadNativeSessions(workspace.id);
    setSessions(list);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  const filtered = sessions.filter(s => {
    if (executor !== 'all' && s.executor !== executor) return false;
    if (status === 'adopted' && !s.adoptedBy) return false;
    if (status === 'available' && s.adoptedBy) return false;
    return true;
  });

  async function handleDelete(s: NativeSession) {
    if (!confirm(`Delete native ${s.executor} session ${s.id.slice(0, 8)}…?\nThis removes the .jsonl file from disk and cannot be undone.`)) return;
    const r = await deleteNativeSession(workspace.id, s.executor, s.id);
    if (!r.ok) {
      setError(r.error ?? 'Delete failed');
      return;
    }
    setError(null);
    void refresh();
  }

  return (
    <div className="ns-pane">
      <p className="ns-pane-sub">
        All claude code and codex sessions that ran inside this workspace's path. Adopt one to continue inside Gian.
      </p>

      <div className="ns-filterbar">
        <div className="ns-filter-group">
          <span className="ns-filter-label">Executor</span>
          <button className={`ns-chip${executor === 'all' ? ' active' : ''}`} onClick={() => setExecutor('all')}>All</button>
          <button className={`ns-chip ns-chip-claude${executor === 'claude' ? ' active' : ''}`} onClick={() => setExecutor('claude')}>Claude</button>
          <button className={`ns-chip ns-chip-codex${executor === 'codex' ? ' active' : ''}`} onClick={() => setExecutor('codex')}>Codex</button>
        </div>
        <div className="ns-filter-group">
          <span className="ns-filter-label">Status</span>
          <button className={`ns-chip${status === 'all' ? ' active' : ''}`} onClick={() => setStatus('all')}>All</button>
          <button className={`ns-chip${status === 'adopted' ? ' active' : ''}`} onClick={() => setStatus('adopted')}>Adopted</button>
          <button className={`ns-chip${status === 'available' ? ' active' : ''}`} onClick={() => setStatus('available')}>Available</button>
        </div>
        <div className="ns-filterbar-spacer" />
        <span className="ns-count"><strong>{filtered.length}</strong> sessions</span>
      </div>

      {error && <p className="spaces-error">{error}</p>}

      <div className="ns-list">
        {loading && <p className="ns-empty">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <p className="ns-empty">No native sessions in this workspace.</p>
        )}
        {filtered.map(s => (
          <NativeSessionRow
            key={`${s.executor}:${s.id}`}
            session={s}
            onAdopt={() => setAdoptingFor(s)}
            onDelete={() => void handleDelete(s)}
          />
        ))}
      </div>

      {adoptingFor && (
        <AdoptDialog
          source={adoptingFor}
          onCancel={() => setAdoptingFor(null)}
          onAdopted={() => {
            setAdoptingFor(null);
            void refresh();
            onChange();
          }}
          workspaceId={workspace.id}
        />
      )}
    </div>
  );
}

function NativeSessionRow({
  session,
  onAdopt,
  onDelete,
}: {
  session: NativeSession;
  onAdopt: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) {
      setCopied(false);
      return;
    }
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  async function copyId() {
    try {
      await navigator.clipboard.writeText(session.id);
      setCopied(true);
      setTimeout(() => { setCopied(false); setMenuOpen(false); }, 900);
    } catch {
      setMenuOpen(false);
    }
  }
  const adopted = !!session.adoptedBy;
  const wtName = session.cwd ? session.cwd.split('/').filter(Boolean).slice(-1)[0] : '';
  return (
    <div className={`ns-row${adopted ? ' adopted' : ''}`}>
      <div className="ns-executor">
        <span className={`ns-exec-dot ${session.executor}`} />
        <span className="ns-exec-name">{session.executor}</span>
      </div>
      <div className="ns-meta">
        <span className="ns-meta-time">{relTime(session.updatedAt)}</span>
        <span className="ns-meta-sep">·</span>
        <span className="ns-meta-turns">{session.turnCount} turns</span>
        <span className="ns-meta-sep">·</span>
        <span className="ns-meta-size" title={`JSONL ${session.fileSize.toLocaleString()} bytes`}>{fmtBytes(session.fileSize)}</span>
        {wtName && (
          <>
            <span className="ns-meta-sep">·</span>
            <span className="ns-meta-wt" title={session.cwd}>{wtName}</span>
          </>
        )}
      </div>
      <div className="ns-preview-row">
        {session.gitBranch && (
          <span className="ns-branch-chip" title={session.gitBranch}>{session.gitBranch}</span>
        )}
        <div className="ns-preview" title={session.firstUserMessage}>
          {session.firstUserMessage || '(no user message)'}
        </div>
      </div>
      <div className="ns-actions" ref={ref}>
        {adopted ? (
          <span className="ns-adopted-chip" title="Open the linked Gian session">
            ✓ Adopted as <span className="ns-adopted-chip-name">{session.adoptedBy!.gianSessionName ?? session.adoptedBy!.gianSessionId.slice(0, 8)}</span>
          </span>
        ) : (
          <button className="ns-adopt-btn" onClick={onAdopt}>Adopt</button>
        )}
        <button
          className="ns-row-kebab"
          onClick={() => setMenuOpen(o => !o)}
          title="More"
          aria-label="More actions"
        >⋯</button>
        {menuOpen && (
          <div className="ns-row-kebab-pop">
            <button
              className="ws-kebab-item"
              onClick={() => void copyId()}
            >
              {copied ? 'Copied!' : 'Copy native session ID'}
            </button>
            <button
              className="ws-kebab-item danger"
              disabled={adopted}
              title={adopted ? 'Unbind the Gian session before deleting the underlying native session' : ''}
              onClick={() => { setMenuOpen(false); onDelete(); }}
            >
              Delete native session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AdoptDialog({
  source, onCancel, onAdopted, workspaceId,
}: {
  source: NativeSession;
  workspaceId: string;
  onCancel: () => void;
  onAdopted: () => void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ApprovalMode>('ask');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    const result = await adoptNativeSession(workspaceId, {
      executor: source.executor,
      native_session_id: source.id,
      approval_mode: mode,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    setSubmitting(false);
    if (!result.session) {
      setError(result.error ?? 'Adopt failed');
      return;
    }
    onAdopted();
  }

  return (
    <div className="adopt-dialog-backdrop" onClick={onCancel}>
      <div className="adopt-dialog" onClick={e => e.stopPropagation()}>
        <header className="adopt-dialog-head">
          <h2 className="adopt-dialog-title">Adopt as Gian session</h2>
          <p className="adopt-dialog-sub">
            Continue this conversation in Gian. Both sides write to the same on-disk session — you can switch back to the CLI at any time.
          </p>
        </header>
        <div className="adopt-dialog-body">
          <div className="adopt-source">
            <span className={`ns-exec-dot ${source.executor}`} />
            <div className="adopt-source-info">
              <div className="adopt-source-meta">
                <span className="adopt-source-exec">{source.executor}</span>
                <span style={{ color: 'var(--text-3)' }}>·</span>
                <span className="adopt-source-id">{source.id}</span>
              </div>
              <div className="adopt-source-msg" title={source.firstUserMessage}>
                {source.firstUserMessage || '(no user message)'}
              </div>
            </div>
          </div>

          <div className="adopt-field">
            <label className="adopt-label">Session name</label>
            <input
              className="input"
              placeholder="auto-generated"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <div className="adopt-field">
            <label className="adopt-label">Approval mode</label>
            <div className="segm" style={{ width: 'fit-content' }}>
              {(['plan', 'ask', 'auto'] as ApprovalMode[]).map(m => (
                <button
                  key={m}
                  type="button"
                  className={`segm-item${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'plan' ? 'Plan' : m === 'ask' ? 'Ask' : 'Auto'}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="spaces-error">{error}</p>}
        </div>
        <footer className="adopt-dialog-foot">
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? 'Adopting…' : 'Adopt'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function NewWorktreeDialog({
  workspace,
  defaultBranch,
  onCancel,
  onCreate,
}: {
  workspace: Workspace;
  defaultBranch: string | null;
  onCancel: () => void;
  onCreate: (input: {
    executor: 'claude' | 'codex';
    baseBranch?: string;
    branch?: string;
  }) => void;
}) {
  const [executor, setExecutor] = useState<'claude' | 'codex'>('codex');
  const [baseBranch, setBaseBranch] = useState(defaultBranch ?? '');
  const [branch, setBranch] = useState(() => `gian/${shortId()}`);
  const [submitting, setSubmitting] = useState(false);

  function submit() {
    setSubmitting(true);
    onCreate({
      executor,
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
    });
    // Parent closes the dialog optimistically; nothing else to do here.
  }

  return (
    <div className="adopt-dialog-backdrop" onClick={onCancel}>
      <div className="adopt-dialog" onClick={e => e.stopPropagation()}>
        <header className="adopt-dialog-head">
          <h2 className="adopt-dialog-title">New worktree</h2>
          <p className="adopt-dialog-sub">
            Create a dedicated git worktree + Gian session in <strong>{workspace.name}</strong>. The worktree lives under the data dir; the branch is created from the base.
          </p>
        </header>
        <div className="adopt-dialog-body">
          <div className="adopt-field">
            <label className="adopt-label">Base branch</label>
            <input
              className="input"
              placeholder={defaultBranch ?? 'main'}
              value={baseBranch}
              onChange={e => setBaseBranch(e.target.value)}
            />
          </div>

          <div className="adopt-field">
            <label className="adopt-label">Branch name</label>
            <input
              className="input"
              placeholder="gian/<short-id>"
              value={branch}
              onChange={e => setBranch(e.target.value)}
            />
          </div>

          <div className="adopt-field">
            <label className="adopt-label">Executor</label>
            <div className="segm" style={{ width: 'fit-content' }}>
              {(['claude', 'codex'] as const).map(x => (
                <button
                  key={x}
                  type="button"
                  className={`segm-item${executor === x ? ' active' : ''}`}
                  onClick={() => setExecutor(x)}
                >
                  {x === 'claude' ? 'Claude Code' : 'Codex'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="adopt-dialog-foot">
          <button className="btn ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={submitting || !branch.trim()}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function shortId(): string {
  // 8 hex chars, matches the host's gian/<8-char-uuid> default convention.
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}


function ClaudeMdInspector({
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
