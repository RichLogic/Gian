import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '@gian/shared';
import {
  abortPendingGitOp,
  createLocalBranch,
  dropSession,
  fetchRemotes,
  loadBranches,
  loadRemoteBranches,
  loadRepoInfo,
  loadWorkspaceTrees,
  mergeSession,
} from '../api.js';
import type {
  LocalBranch,
  PendingGitOp,
  RemoteBranch,
  RepoInfo,
  WorkspaceTree,
} from '../api.js';
import { confirm } from '../feedback.js';
import { useT } from '../i18n/index.js';
import type { GianWs } from '../ws.js';
import type { CreateWorktreeSessionInput } from './SpacesView.js';
import { NewWorktreeDialog } from './new-worktree-dialog.js';

const I = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  plus: 'M12 5v14 M5 12h14',
  github: 'M9 19c-4.5 1.5-4.5-2.5-6-3 m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6 0C6.7 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v.01 M11 12h1v5h1',
};

function Icon({ d, size = 16, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
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
    >
      <path d={d} />
    </svg>
  );
}

function BranchIcon({ size = 11 }: { size?: number }) {
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

function shortId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

function relTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function GitPane({
  workspace,
  ws,
  onOpenClaudeMd,
  onChange,
  onCreateWorktreeSession,
}: {
  workspace: Workspace;
  ws: GianWs;
  onOpenClaudeMd: () => void;
  onChange: () => void;
  onCreateWorktreeSession: (input: CreateWorktreeSessionInput) => void;
}) {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [branches, setBranches] = useState<LocalBranch[]>([]);
  const [trees, setTrees] = useState<WorkspaceTree[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState<'all' | 'on-worktree' | 'off-worktree' | 'worktree-sessions'>('all');
  const [remoteSearch, setRemoteSearch] = useState('');
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranch[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const t = useT();

  const refresh = useCallback(async () => {
    const [r, b, tr] = await Promise.all([
      loadRepoInfo(workspace.id),
      loadBranches(workspace.id),
      loadWorkspaceTrees(workspace.id),
    ]);
    setRepo(r);
    setBranches(b);
    setTrees(tr);
    setBranchesLoaded(true);
  }, [workspace.id]);

  useEffect(() => {
    setBranchesLoaded(false);
    void refresh();
  }, [refresh]);

  const doRemoteSearch = useCallback(async (q: string) => {
    setRemoteLoading(true);
    const list = await loadRemoteBranches(workspace.id, q || undefined);
    setRemoteBranches(list);
    setRemoteLoading(false);
  }, [workspace.id]);

  // Live refresh: host pushes `workspace:git-updated` after fetch / branch /
  // merge / drop / session-delete. Filter by workspace_id so other workspaces'
  // events don't trigger re-fetches in this pane.
  useEffect(() => {
    const off = ws.onMessage(msg => {
      if (msg.type === 'workspace:git-updated' && msg.workspace_id === workspace.id) {
        void refresh();
        // Keep the remote-branches panel in sync only if it's been populated —
        // otherwise wait for the user to open it.
        if (remoteBranches.length > 0 || remoteSearch) {
          void doRemoteSearch(remoteSearch);
        }
      }
    });
    return off;
  }, [ws, workspace.id, refresh, doRemoteSearch, remoteBranches.length, remoteSearch]);

  // Worktree-side info (dirty count, CLAUDE.md) lives in `trees`; key by path.
  const treesByPath = useMemo(() => {
    const m = new Map<string, WorkspaceTree>();
    for (const t of trees) m.set(t.path, t);
    return m;
  }, [trees]);

  // Filter chips drive what shows up in the unified branches list.
  const filtered = useMemo(() => {
    return branches.filter(b => {
      switch (branchFilter) {
        case 'on-worktree': return !!b.worktreePath;
        case 'off-worktree': return !b.worktreePath;
        case 'worktree-sessions': return b.isWorktreeBranch;
        default: return true;
      }
    }).sort((a, b) => {
      // Main worktree first, then other worktrees, then bare branches.
      const aIsMain = a.worktreePath === workspace.path ? 0 : 1;
      const bIsMain = b.worktreePath === workspace.path ? 0 : 1;
      if (aIsMain !== bIsMain) return aIsMain - bIsMain;
      const aHasTree = a.worktreePath ? 0 : 1;
      const bHasTree = b.worktreePath ? 0 : 1;
      if (aHasTree !== bHasTree) return aHasTree - bHasTree;
      return a.name.localeCompare(b.name);
    });
  }, [branches, branchFilter, workspace.path]);

  async function handleFetch() {
    setFetching(true);
    setFetchError(null);
    const result = await fetchRemotes(workspace.id);
    setFetching(false);
    if (!result.ok) {
      setFetchError(result.error ?? t('spaces.git.fetchFailed'));
      return;
    }
    setFetchedAt(result.fetchedAt ?? new Date().toISOString());
    void refresh();
    // If the user has the remote panel open, refresh it too.
    if (remoteSearch || remoteBranches.length > 0) void doRemoteSearch(remoteSearch);
  }

  // Debounce remote-branch search so we don't hammer git on each keystroke.
  useEffect(() => {
    const handle = setTimeout(() => { void doRemoteSearch(remoteSearch); }, 220);
    return () => clearTimeout(handle);
  }, [remoteSearch, doRemoteSearch]);

  const remoteHref = repo?.git.remote
    ? (repo.git.remote.startsWith('http') ? repo.git.remote : `https://${repo.git.remote}`)
    : null;

  const onWorktreeCount = branches.filter(b => b.worktreePath).length;
  const dirtyCount = trees.filter(tr => tr.isDirty).length;

  return (
    <>
      {repo?.git.pendingOp && (
        <PendingOpBanner
          op={repo.git.pendingOp}
          workspaceId={workspace.id}
          workspacePath={workspace.path}
        />
      )}
      <div className="card">
        <div className="card-head">
          <h3>{t('spaces.git.remote')}</h3>
          <span className="aside">{repo?.git.remote || t('spaces.git.noRemote')}</span>
          <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {fetchedAt && (
              <span style={{ font: 'var(--fz-12)/1 var(--font-sans)', color: 'var(--text-3)' }}>
                {t('spaces.git.fetched')} {relTime(fetchedAt)}
              </span>
            )}
            {remoteHref && (
              <a className="btn ghost sm" href={remoteHref} target="_blank" rel="noreferrer">
                <Icon d={I.github} size={13} />{t('spaces.git.viewGitHub')}
              </a>
            )}
            <button
              className="btn sm"
              disabled={fetching || !repo?.git.isRepo}
              onClick={() => void handleFetch()}
              title="git fetch --prune --all"
            >
              {fetching ? t('spaces.git.fetching') : t('spaces.git.fetch')}
            </button>
          </div>
        </div>
        {fetchError && (
          <div className="card-body" style={{ color: 'var(--danger)', fontSize: 12 }}>{fetchError}</div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            {t('spaces.git.branches')}
            <HelpHint>
              {t('spaces.git.branches.help')}
            </HelpHint>
          </h3>
          <span className="aside">
            {branches.length} {t('spaces.git.local')} · {onWorktreeCount} {t('spaces.git.onWorktree')}{dirtyCount > 0 ? ` · ${dirtyCount} ${t('spaces.git.dirty')}` : ''}
          </span>
          {repo?.git.isRepo && (
            <div className="right">
              <button className="btn primary sm" onClick={() => setNewWorktreeOpen(true)}>
                <Icon d={I.plus} size={11} stroke={2.4} />{t('spaces.git.newWorktree')}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--hairline-2)' }}>
          <div className="segm sm">
            <button className={`segm-item${branchFilter === 'all' ? ' active' : ''}`} onClick={() => setBranchFilter('all')}>{t('spaces.git.filter.all')}</button>
            <button className={`segm-item${branchFilter === 'on-worktree' ? ' active' : ''}`} onClick={() => setBranchFilter('on-worktree')}>{t('spaces.git.filter.onWorktree')}</button>
            <button className={`segm-item${branchFilter === 'off-worktree' ? ' active' : ''}`} onClick={() => setBranchFilter('off-worktree')}>{t('spaces.git.filter.offWorktree')}</button>
            <button className={`segm-item${branchFilter === 'worktree-sessions' ? ' active' : ''}`} onClick={() => setBranchFilter('worktree-sessions')}>{t('spaces.git.filter.worktreeSessions')}</button>
          </div>
        </div>
        <div className="card-body compact">
          {filtered.map(b => (
            <BranchRow
              key={b.name}
              branch={b}
              tree={b.worktreePath ? treesByPath.get(b.worktreePath) ?? null : null}
              isMainTree={b.worktreePath === workspace.path}
              workspaceId={workspace.id}
              workspacePath={workspace.path}
              onOpenClaudeMd={b.worktreePath === workspace.path ? onOpenClaudeMd : undefined}
              onRefresh={() => { void refresh(); onChange(); }}
              onCreateWorktreeSession={onCreateWorktreeSession}
            />
          ))}
          {branches.length === 0 && !branchesLoaded && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              <span className="spinner" aria-hidden="true" />
              <span>{t('spaces.git.loadingBranches')}</span>
            </div>
          )}
          {branches.length === 0 && branchesLoaded && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              {t('spaces.git.noLocalBranches')}
            </div>
          )}
          {branches.length > 0 && filtered.length === 0 && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              {t('spaces.git.noBranchMatches')}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            {t('spaces.git.remoteBranches')}
            <HelpHint>
              {t('spaces.git.remoteBranches.help')}
            </HelpHint>
          </h3>
          <span className="aside">{remoteBranches.length} {t('spaces.git.match')}{remoteLoading ? ` · ${t('spaces.git.loading')}` : ''}</span>
        </div>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--hairline-2)' }}>
          <input
            className="input"
            placeholder={t('spaces.git.searchRemoteBranches')}
            value={remoteSearch}
            onChange={e => setRemoteSearch(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="card-body compact">
          {remoteBranches.map(rb => (
            <RemoteBranchRow
              key={rb.fullName}
              branch={rb}
              workspaceId={workspace.id}
              onRefresh={() => { void refresh(); void doRemoteSearch(remoteSearch); }}
              onCreateWorktreeSession={() => onCreateWorktreeSession({
                workspaceId: workspace.id,
                executor: 'codex',
                baseBranch: rb.fullName,
                branch: `worktree/${shortId()}`,
              })}
            />
          ))}
          {remoteBranches.length === 0 && !remoteLoading && (
            <div className="wt-row" style={{ color: 'var(--text-3)' }}>
              {remoteSearch ? t('spaces.git.noRemoteBranchMatches') : t('spaces.git.noRemoteBranches')}
            </div>
          )}
        </div>
      </div>

      {newWorktreeOpen && (
        <NewWorktreeDialog
          workspace={workspace}
          defaultBranch={repo?.git.defaultBranch ?? null}
          branches={branches}
          remoteBranches={remoteBranches}
          onCancel={() => setNewWorktreeOpen(false)}
          onCreate={(input) => {
            onCreateWorktreeSession({
              workspaceId: workspace.id,
              executor: input.executor,
              ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
              ...(input.branch ? { branch: input.branch } : {}),
            });
            setNewWorktreeOpen(false);
            // Host broadcasts workspace:git-updated once the worktree is
            // wired up — the useEffect above re-pulls. The onChange() ping
            // refreshes the outer workspaces list so the session count tick
            // updates in the sidebar.
            onChange();
          }}
        />
      )}
    </>
  );
}

function PendingOpBanner({
  op,
  workspaceId,
  workspacePath,
}: {
  op: PendingGitOp;
  workspaceId: string;
  workspacePath: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verb: Record<PendingGitOp['kind'], string> = {
    'merge': 'Merge',
    'rebase': 'Rebase',
    'cherry-pick': 'Cherry-pick',
    'revert': 'Revert',
  };
  const opName = verb[op.kind];

  async function handleAbort() {
    if (!(await confirm({
      message: `Run "git ${op.kind} --abort" in ${workspacePath}?\nThis discards conflict resolution work in progress and rewinds the index.`,
      danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    const res = await abortPendingGitOp(workspaceId);
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'Abort failed'); return; }
    // Host broadcasts workspace:git-updated → GitPane refreshes; banner
    // disappears once `repo.git.pendingOp` flips to null.
  }

  return (
    <div
      role="alert"
      style={{
        background: 'color-mix(in oklab, var(--warn) 12%, transparent)',
        border: '1px solid color-mix(in oklab, var(--warn) 45%, transparent)',
        borderRadius: 'var(--r-2)',
        padding: '12px 14px',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: '600 var(--fz-13)/1.3 var(--font-sans)', color: 'var(--warn)' }}>
          {opName} in progress
        </div>
        <div style={{ font: 'var(--fz-12)/1.4 var(--font-sans)', color: 'var(--text-2)', marginTop: 2 }}>
          The workspace tree is in the middle of a <span className="mono">git {op.kind}</span> that
          hit conflicts. Resolve the conflicts in your editor and commit, or abort to rewind.
          {' '}New Gian sessions on this workspace will see the half-merged state.
        </div>
        {error && (
          <div style={{ font: 'var(--fz-12)/1.3 var(--font-sans)', color: 'var(--danger)', marginTop: 6 }}>
            {error}
          </div>
        )}
      </div>
      <button
        className="btn sm"
        onClick={() => void handleAbort()}
        disabled={busy}
        title={`git ${op.kind} --abort`}
      >
        {busy ? 'Aborting…' : `Abort ${op.kind}`}
      </button>
    </div>
  );
}

function BranchRow({
  branch,
  tree,
  isMainTree,
  workspacePath,
  onOpenClaudeMd,
  onRefresh,
  onCreateWorktreeSession,
  workspaceId,
}: {
  branch: LocalBranch;
  tree: WorkspaceTree | null;
  isMainTree: boolean;
  workspaceId: string;
  workspacePath: string;
  onOpenClaudeMd?: () => void;
  onRefresh: () => void;
  onCreateWorktreeSession: (input: CreateWorktreeSessionInput) => void;
}) {
  void workspacePath;
  const t = useT();
  const onWorktree = !!branch.worktreePath;
  const isDirty = tree?.isDirty ?? false;
  const state = isDirty ? 'dirty' : 'clean';
  const modifiedCount = tree?.modifiedCount ?? 0;
  const sessionLabel = branch.session
    ? (branch.session.name ?? branch.session.id.slice(0, 6))
    : null;
  const trackingLabel = branch.upstream
    ? (branch.gone ? `${branch.upstream} · ${t('spaces.git.gone')}` : branch.upstream)
    : t('spaces.git.noUpstream');
  const aheadBehind = branch.ahead || branch.behind
    ? `${branch.ahead ? '↑' + branch.ahead : ''}${branch.behind ? '↓' + branch.behind : ''}`
    : '';
  return (
    <div className="wt-row">
      <span className="wt-ico">
        {isMainTree ? <Icon d={I.folder} size={15} /> : <BranchIcon size={14} />}
      </span>
      <div className="wt-branch">
        {branch.name}
        {isMainTree && <span className="main-tag">{t('spaces.git.mainTree')}</span>}
        {onWorktree && !isMainTree && <span className="main-tag">{t('spaces.git.worktree')}</span>}
      </div>
      <span style={{ font: 'var(--fz-12)/1.3 var(--font-mono)', color: 'var(--text-3)' }} title={trackingLabel}>
        {trackingLabel}{aheadBehind && <span style={{ marginLeft: 6, color: branch.gone ? 'var(--danger)' : 'var(--text-2)' }}>{aheadBehind}</span>}
      </span>
      {onWorktree ? (
        <div className={`wt-state ${state}`}>
          <span className="dot" />
          {state === 'clean' ? t('spaces.git.clean') : `${modifiedCount} ${t('spaces.git.changed')}`}
        </div>
      ) : (
        <span style={{ font: 'var(--fz-12)/1.3 var(--font-sans)', color: 'var(--text-3)' }}>
          {branch.lastCommit?.age || '—'}
        </span>
      )}
      {sessionLabel ? (
        <a className="wt-session" href="#" onClick={e => e.preventDefault()}>{sessionLabel}</a>
      ) : !onWorktree ? (
        <button
          className="btn xs ghost"
          onClick={() => onCreateWorktreeSession({
            workspaceId,
            executor: 'codex',
            baseBranch: branch.name,
            branch: `worktree/${shortId()}`,
          })}
          title={`${t('spaces.git.openWorktreeFrom')} ${branch.name}`}
        >
          {t('spaces.git.open')}
        </button>
      ) : (
        <span className="wt-session none">—</span>
      )}
      <BranchRowKebab
        branch={branch}
        tree={tree}
        isMainTree={isMainTree}
        onOpenClaudeMd={onOpenClaudeMd}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function BranchRowKebab({
  branch,
  tree,
  isMainTree,
  onOpenClaudeMd,
  onRefresh,
}: {
  branch: LocalBranch;
  tree: WorkspaceTree | null;
  isMainTree: boolean;
  onOpenClaudeMd?: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'reveal' | 'merge' | 'drop' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  async function handleReveal() {
    if (!tree) return;
    setBusy('reveal');
    setError(null);
    try {
      const res = await fetch(`/api/working_trees/${tree.id}/reveal`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `${t('spaces.git.revealFailed')} (${res.status})`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleMerge() {
    if (!branch.session) return;
    const sid = branch.session.id;
    if (!(await confirm({
      message: `${t('spaces.git.confirmMerge')} "${branch.name}"?\n${t('spaces.git.confirmMergeHelp')}`,
      confirmLabel: t('spaces.git.confirmMerge'),
    }))) return;
    setBusy('merge');
    setError(null);
    const res = await mergeSession(sid);
    setBusy(null);
    if (!res.ok) { setError(res.error ?? t('spaces.git.mergeFailed')); return; }
    setOpen(false);
    onRefresh();
  }

  async function handleDrop() {
    if (!branch.session) return;
    const sid = branch.session.id;
    if (!(await confirm({
      message: `${t('spaces.git.confirmDiscard')} "${branch.name}"?\n${t('spaces.git.confirmDiscardHelp')}`,
      danger: true,
      confirmLabel: t('spaces.git.confirmDiscard'),
    }))) return;
    setBusy('drop');
    setError(null);
    const res = await dropSession(sid);
    setBusy(null);
    if (!res.ok) { setError(res.error ?? t('spaces.git.discardFailed')); return; }
    setOpen(false);
    onRefresh();
  }

  async function handleDelete() {
    if (!branch.session) return;
    const sid = branch.session.id;
    const label = branch.name;
    if (!(await confirm({
      message: `${t('spaces.git.confirmDelete')} "${label}"?\n${t('spaces.git.confirmDeleteHelp')} (${sid.slice(0, 8)}…)`,
      danger: true,
      confirmLabel: t('spaces.git.confirmDelete'),
    }))) return;
    setBusy('delete');
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        setError(body.error ?? `${t('spaces.git.deleteFailed')} (${res.status})`);
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

  const hasTree = !!tree;
  const isGianSession = !!branch.session;

  return (
    <div className="ws-kebab-anchor" ref={ref}>
      <button
        className="wt-kebab"
        onClick={() => setOpen(o => !o)}
        title={t('spaces.git.more')}
        aria-label={t('spaces.git.moreActions')}
      >
        <Icon d={I.kebabV} size={14} />
      </button>
      {open && (
        <div className="ws-kebab-pop">
          {hasTree && (
            <button
              className="ws-kebab-item"
              disabled={busy !== null}
              onClick={() => { setOpen(false); void handleReveal(); }}
            >
              {busy === 'reveal' ? t('spaces.git.opening') : t('spaces.git.openInFinder')}
            </button>
          )}
          {isMainTree && onOpenClaudeMd && (
            <button
              className="ws-kebab-item"
              onClick={() => { setOpen(false); onOpenClaudeMd(); }}
            >
              {t('spaces.git.editClaudeMd')}
            </button>
          )}
          {isGianSession && (
            <>
              <div className="ws-kebab-divider" />
              <button
                className="ws-kebab-item"
                disabled={busy !== null}
                onClick={() => { void handleMerge(); }}
                title="git checkout base && git merge --no-ff"
              >
                {busy === 'merge' ? t('spaces.git.merging') : t('spaces.git.mergeToBase')}
              </button>
              <button
                className="ws-kebab-item"
                disabled={busy !== null}
                onClick={() => { void handleDrop(); }}
                title={t('spaces.git.discardWorktreeTitle')}
              >
                {busy === 'drop' ? t('spaces.git.discarding') : t('spaces.git.discardWorktree')}
              </button>
              <div className="ws-kebab-divider" />
              <button
                className="ws-kebab-item danger"
                disabled={busy !== null}
                onClick={() => { void handleDelete(); }}
                title={t('spaces.git.deleteWorktreeTitle')}
              >
                {busy === 'delete' ? t('common.deleting') : t('spaces.git.deleteWorktreeSession')}
              </button>
            </>
          )}
          {error && (
            <>
              <div className="ws-kebab-divider" />
              <div className="ws-kebab-item" style={{ color: 'var(--danger)', cursor: 'default', whiteSpace: 'normal' }}>
                {error}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RemoteBranchRow({
  branch,
  workspaceId,
  onCreateWorktreeSession,
  onRefresh,
}: {
  branch: RemoteBranch;
  workspaceId: string;
  onCreateWorktreeSession: () => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<'track' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  async function handleTrack() {
    setBusy('track');
    setError(null);
    const res = await createLocalBranch(workspaceId, { name: branch.branch, base: branch.fullName });
    setBusy(null);
    if (!res.ok) { setError(res.error ?? t('spaces.git.createFailed')); return; }
    onRefresh();
  }

  return (
    <div className="wt-row" style={{ gridTemplateColumns: '18px 1fr 1fr auto auto', gap: 8 }}>
      <span className="wt-ico"><BranchIcon size={14} /></span>
      <div className="wt-branch">
        {branch.fullName}
        {branch.hasLocalTracking && <span className="main-tag">{t('spaces.git.tracked')}</span>}
      </div>
      <span style={{ font: 'var(--fz-12)/1.3 var(--font-sans)', color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {branch.lastCommit.subject} · {branch.lastCommit.age}
      </span>
      {!branch.hasLocalTracking ? (
        <button
          className="btn xs ghost"
          onClick={() => void handleTrack()}
          disabled={busy !== null}
          title={`git branch --track ${branch.branch} ${branch.fullName}`}
        >
          {busy === 'track' ? t('spaces.git.adding') : t('spaces.git.addTracking')}
        </button>
      ) : <span />}
      <button
        className="btn xs ghost"
        onClick={onCreateWorktreeSession}
        title={`${t('spaces.git.openWorktreeFrom')} ${branch.fullName}`}
      >
        {t('spaces.git.openInNewWorktree')}
      </button>
      {error && (
        <div style={{ gridColumn: '1 / -1', color: 'var(--danger)', font: 'var(--fz-12)/1.3 var(--font-sans)', paddingLeft: 30 }}>
          {error}
        </div>
      )}
    </div>
  );
}
