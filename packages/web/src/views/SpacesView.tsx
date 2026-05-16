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

// ── V2 icon set ─────────────────────────────────────────────────────────────
// Paths copied verbatim from design/gian-design-v2/js/data.jsx (`I`). Only the
// ones used by Spaces / Bots views are inlined here — keep this list narrow.
const I = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  plus: 'M12 5v14 M5 12h14',
  github: 'M9 19c-4.5 1.5-4.5-2.5-6-3 m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6 0C6.7 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  check: 'M5 12l5 5L20 7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v.01 M11 12h1v5h1',
  copy: 'M9 9h10v10H9z M5 15V5h10',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  edit: 'M4 20h4l10-10-4-4L4 16z M14 6l4 4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
};

export function Icon({
  d,
  size = 16,
  stroke = 1.6,
  className,
}: {
  d: string;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  // V2's icon paths are space-separated `M…` subpaths intended to be rendered
  // as one `<path>`. The browser parses them correctly when joined; splitting
  // would lose the chain. So we just emit a single <path d=...>.
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

export function BranchIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      className="branch-ico"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 5v6 M4 11c0-3 8-2 8-4.5" />
    </svg>
  );
}

// Hover-anchored "?" hint used to inline-explain jargon — copied verbatim
// from V2's HelpHint.
function HelpHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="help-hint" tabIndex={0}>
      <span className="help-hint-trigger" aria-label="More info">
        <Icon d={I.info} size={12} stroke={1.8} />
      </span>
      <span className="help-hint-pop" role="tooltip">{children}</span>
    </span>
  );
}

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
          <button className="btn sm primary" aria-label="New workspace" onClick={onNewClick}>{t('spaces.new')}</button>
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
            aria-label="Workspace path"
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
        aria-label="Workspace name"
        placeholder="Name (a-z A-Z 0-9 . _ -)"
        value={form.name}
        onChange={e => onChange({ name: e.target.value, nameTouched: true })}
        autoFocus={!isAdopt}
      />
      {!isAdopt && (
        <input
          className="input"
          aria-label="Git remote URL"
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
  const [tab, setTab] = useState<WsTab>('config');
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
                onKeyDown={e => { if (e.key === 'Enter') void commitNameEdit(); if (e.key === 'Escape') setNameEdit(null); }}
              />
            ) : (
              <h1 onClick={() => setNameEdit(workspace.name)}>{workspace.name}</h1>
            )}
            <div className="detail-head-actions">
              {deleteError && <span className="spaces-error">{deleteError}</span>}
              <WorkspaceKebab
                onRename={() => setNameEdit(workspace.name)}
                onDelete={() => void handleDelete()}
                deleting={deleting}
              />
            </div>
          </div>
          <div className="detail-sub">{workspace.path}</div>
          <div className="detail-tabs">
            <button
              className={`detail-tab ${tab === 'config' ? 'active' : ''}`}
              onClick={() => setTab('config')}
            >
              Config
            </button>
            <button
              className={`detail-tab ${tab === 'native' ? 'active' : ''}`}
              onClick={() => setTab('native')}
            >
              Native sessions {nativeCount !== null && <span className="count">{nativeCount}</span>}
            </button>
          </div>
          {tab === 'config' ? (
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
        </div>
      </div>
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

  const dirtyCount = trees.filter(tr => tr.isDirty).length;
  const remoteHref = repo?.git.remote
    ? (repo.git.remote.startsWith('http') ? repo.git.remote : `https://${repo.git.remote}`)
    : null;

  void relatedSessions;

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
          <h3>Repository</h3>
          <span className="aside">git remote · default branch · last commit</span>
          {remoteHref && (
            <div className="right">
              <a className="btn ghost sm" href={remoteHref} target="_blank" rel="noreferrer">
                <Icon d={I.github} size={13} />View on GitHub
              </a>
            </div>
          )}
        </div>
        <div className="card-body">
          <dl className="kv-grid">
            <dt>Local path</dt><dd>{workspace.path}</dd>
            <dt>Remote</dt><dd>{repo?.git.remote || '—'}</dd>
            <dt>Default branch</dt><dd>{repo?.git.defaultBranch || 'main'}</dd>
            {repo?.git.lastCommit && (
              <>
                <dt>Last commit</dt>
                <dd style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span>{repo.git.lastCommit.hash}</span>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>
                    {repo.git.lastCommit.message} · {repo.git.lastCommit.age}
                  </span>
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            Worktrees
            <HelpHint>
              A <b>worktree</b> is a separate checkout of the repo on disk —
              each sits in its own folder with one branch checked out. Gian
              spins up one worktree per session so agents can work on
              different branches without colliding.
            </HelpHint>
          </h3>
          <span className="aside">{trees.length} on disk · {dirtyCount} dirty</span>
          {repo?.git.isRepo && (
            <div className="right">
              <button className="btn primary sm" onClick={() => setNewWorktreeOpen(true)}>
                <Icon d={I.plus} size={11} stroke={2.4} />New worktree
              </button>
            </div>
          )}
        </div>
        <div className="card-body compact">
          {trees.map(tree => (
            <WorkspaceTreeRow
              key={tree.id}
              tree={tree}
              onOpenClaudeMd={tree.kind === 'main' ? onOpenClaudeMd : undefined}
              onRefresh={() => { void refreshTrees(); onChange(); }}
            />
          ))}
          {trees.length === 0 && !treesLoaded && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              <span className="spinner" aria-hidden="true" />
              <span>Loading worktrees…</span>
            </div>
          )}
          {trees.length === 0 && treesLoaded && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              No worktrees yet.
            </div>
          )}
        </div>
      </div>

      {/* TODO Phase 5 backend — list local branches not in any worktree. */}
      <div className="card">
        <div className="card-head">
          <h3>
            Other local branches
            <HelpHint>
              Branches that exist locally but aren't checked out in any
              worktree. Spin one up to start a session on it.
            </HelpHint>
          </h3>
          <span className="aside">— branches · not in any worktree</span>
        </div>
        <div className="card-body compact">
          <span style={{ padding: '6px 12px', color: 'var(--text-3)', fontSize: 11, fontStyle: 'italic' }}>
            Backend support coming soon
          </span>
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
    </>
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
  const state = tree.isDirty ? 'dirty' : 'clean';
  const branchLabel = tree.branch ?? tree.label;
  const sessionLabel = tree.session
    ? (tree.session.name ?? tree.session.id.slice(0, 6))
    : null;
  return (
    <div className="wt-row">
      <span className="wt-ico">
        {isMain ? <Icon d={I.folder} size={15} /> : <BranchIcon size={14} />}
      </span>
      <div className="wt-branch">
        {branchLabel}
        {isMain && <span className="main-tag">main tree</span>}
      </div>
      <button
        className={`wt-claude ${tree.claudeMd.exists ? '' : 'empty'}`}
        title={tree.claudeMd.exists ? 'Edit CLAUDE.md' : 'Create CLAUDE.md'}
        onClick={onOpenClaudeMd}
        disabled={!onOpenClaudeMd}
        style={{ background: 'none', border: 0, padding: 0, cursor: onOpenClaudeMd ? 'pointer' : 'default', font: 'inherit', color: 'inherit', textAlign: 'left' }}
      >
        {tree.claudeMd.exists ? `CLAUDE.md · ${tree.claudeMd.lines} lines` : '+ CLAUDE.md'}
      </button>
      <div className={`wt-state ${state}`}>
        <span className="dot" />
        {state === 'clean' ? 'clean' : `${tree.modifiedCount} changed`}
      </div>
      {sessionLabel ? (
        <a className="wt-session" href="#" onClick={e => e.preventDefault()}>{sessionLabel}</a>
      ) : (
        <span className="wt-session none">—</span>
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
        className="wt-kebab"
        onClick={() => setOpen(o => !o)}
        title="More"
        aria-label="More actions"
      >
        <Icon d={I.kebabV} size={14} />
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
    <>
      <div style={{ font: 'var(--fz-12)/1.5 var(--font-sans)', color: 'var(--text-2)', marginTop: -4, marginBottom: 14, display: 'inline-flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }}>
        <span>
          Sessions discovered on disk under <span className="mono">~/.claude</span> / <span className="mono">~/.codex</span>. <b>Adopt</b> a session to manage it from Gian.
        </span>
        <HelpHint>
          The Claude / Codex CLIs each keep their own session history. Gian
          can <b>adopt</b> them — import the transcript and start tracking
          new turns — without changing where the CLI writes them.
        </HelpHint>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div className="segm">
          <button className={`segm-item${executor === 'all' ? ' active' : ''}`} onClick={() => setExecutor('all')}>All</button>
          <button className={`segm-item${executor === 'claude' ? ' active' : ''}`} onClick={() => setExecutor('claude')}>Claude</button>
          <button className={`segm-item${executor === 'codex' ? ' active' : ''}`} onClick={() => setExecutor('codex')}>Codex</button>
        </div>
        <div className="segm">
          <button className={`segm-item${status === 'all' ? ' active' : ''}`} onClick={() => setStatus('all')}>All</button>
          <button className={`segm-item${status === 'adopted' ? ' active' : ''}`} onClick={() => setStatus('adopted')}>Adopted</button>
          <button className={`segm-item${status === 'available' ? ' active' : ''}`} onClick={() => setStatus('available')}>Available</button>
        </div>
        <span style={{ marginLeft: 'auto', font: '500 10.5px/1 var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)' }}>
          {filtered.length} sessions
        </span>
      </div>

      {error && <p className="spaces-error">{error}</p>}

      <div className="card">
        <div className="card-body compact">
          {loading && (
            <div style={{ padding: '12px 12px', color: 'var(--text-3)' }}>Loading…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: '12px 12px', color: 'var(--text-3)' }}>
              No native sessions in this workspace.
            </div>
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
    </>
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
  const adoptedName = session.adoptedBy?.gianSessionName ?? session.adoptedBy?.gianSessionId.slice(0, 8);
  return (
    <div
      className="wt-row"
      style={{ gridTemplateColumns: '18px 1fr auto 110px 22px', alignItems: 'start' }}
    >
      <span className="wt-ico" style={{ paddingTop: 2 }}>
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: session.executor === 'claude' ? 'var(--claude)' : 'var(--codex)',
          }}
        />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ font: 'var(--fz-13)/1.3 var(--font-sans)', fontWeight: 500, color: 'var(--text)' }}>
            {adopted ? adoptedName : (
              <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>unadopted session</span>
            )}
          </span>
          {session.gitBranch && (
            <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>{session.gitBranch}</span>
          )}
          <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>
            · {relTime(session.updatedAt)} · {session.turnCount} turns · {fmtBytes(session.fileSize)}
          </span>
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.firstUserMessage || '(no user message)'}
        </div>
      </div>
      <span />
      {adopted ? (
        <span style={{ font: '500 12px/1.4 var(--font-sans)', color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon d={I.check} size={12} stroke={2.4} /> Adopted
        </span>
      ) : (
        <button className="btn primary sm" onClick={onAdopt}>Adopt</button>
      )}
      <div className="ws-kebab-anchor" ref={ref}>
        <button
          className="wt-kebab"
          onClick={() => setMenuOpen(o => !o)}
          title="More"
          aria-label="More actions"
        >
          <Icon d={I.kebabV} size={14} />
        </button>
        {menuOpen && (
          <div className="ws-kebab-pop">
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
