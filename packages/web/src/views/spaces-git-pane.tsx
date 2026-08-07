import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Workspace } from '@gian/shared';
import {
  loadBranches,
  loadRepoInfo,
  loadWorkspaceTrees,
} from '../api.js';
import type {
  LocalBranch,
  PendingGitOp,
  RepoInfo,
  WorkspaceTree,
} from '../api.js';
import { confirm } from '../feedback.js';
import {
  gitAbortEntityKey,
  gitFetchEntityKey,
} from '../operations/git.js';
import {
  useOperationDispatch,
  useOperationPending,
  useOperationRun,
} from '../operations/use-operations.js';
import type { OperationName } from '../operations/types.js';
import { useT } from '../i18n/index.js';
import type { GianWs } from '../ws.js';

const I = {
  kebabV: 'M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02',
  github: 'M9 19c-4.5 1.5-4.5-2.5-6-3 m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6 0C6.7 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
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
}: {
  workspace: Workspace;
  ws: GianWs;
  onOpenClaudeMd: () => void;
  onChange: () => void;
}) {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [branches, setBranches] = useState<LocalBranch[]>([]);
  const [trees, setTrees] = useState<WorkspaceTree[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const t = useT();
  const dispatch = useOperationDispatch();
  // Fetch busy state is the in-flight git.fetch run (Phase 3b); the tracked
  // run id lets the settle effect pick up the fetchedAt result / error.
  const fetching = useOperationPending(gitFetchEntityKey(workspace.id), 'git.fetch');
  const [fetchRunId, setFetchRunId] = useState<string>();
  const fetchRun = useOperationRun(fetchRunId);

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

  // Live refresh: host pushes `workspace:git-updated` after fetch / branch /
  // merge / drop / session-delete. Filter by workspace_id so other workspaces'
  // events don't trigger re-fetches in this pane.
  useEffect(() => {
    const off = ws.onMessage(msg => {
      if (msg.type === 'workspace:git-updated' && msg.workspace_id === workspace.id) {
        void refresh();
      }
    });
    return off;
  }, [ws, workspace.id, refresh]);

  // Worktree-side info (dirty count, CLAUDE.md) lives in `trees`; key by path.
  const treesByPath = useMemo(() => {
    const m = new Map<string, WorkspaceTree>();
    for (const t of trees) m.set(t.path, t);
    return m;
  }, [trees]);

  // Main worktree first, then other worktrees, then bare branches.
  const filtered = useMemo(() => {
    return [...branches].sort((a, b) => {
      const aIsMain = a.worktreePath === workspace.path ? 0 : 1;
      const bIsMain = b.worktreePath === workspace.path ? 0 : 1;
      if (aIsMain !== bIsMain) return aIsMain - bIsMain;
      const aHasTree = a.worktreePath ? 0 : 1;
      const bHasTree = b.worktreePath ? 0 : 1;
      if (aHasTree !== bHasTree) return aHasTree - bHasTree;
      return a.name.localeCompare(b.name);
    });
  }, [branches, workspace.path]);

  function handleFetch() {
    setFetchError(null);
    setFetchRunId(dispatch('git.fetch', { workspaceId: workspace.id }).id);
  }

  // Fetch settle: on confirm, stamp the fetch time and refresh the pane (the
  // host also broadcasts workspace:git-updated); on failure, inline the
  // run's error (the definition deliberately does not toast — see
  // operations/git.ts).
  useEffect(() => {
    if (!fetchRun) return;
    if (fetchRun.phase === 'confirmed') {
      setFetchedAt((fetchRun.result as { fetchedAt?: string } | undefined)?.fetchedAt ?? new Date().toISOString());
      setFetchRunId(undefined);
      void refresh();
    } else if (fetchRun.phase === 'failed') {
      setFetchError(fetchRun.error ?? t('spaces.git.fetchFailed'));
      setFetchRunId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchRun?.phase]);

  const remoteHref = repo?.git.remote
    ? (repo.git.remote.startsWith('http') ? repo.git.remote : `https://${repo.git.remote}`)
    : null;

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
          <h3>{t('spaces.git.branches')}</h3>
        </div>
        <div className="card-body compact">
          {filtered.map(b => (
            <BranchRow
              key={b.name}
              branch={b}
              tree={b.worktreePath ? treesByPath.get(b.worktreePath) ?? null : null}
              isMainTree={b.worktreePath === workspace.path}
              workspacePath={workspace.path}
              onOpenClaudeMd={b.worktreePath === workspace.path ? onOpenClaudeMd : undefined}
              onRefresh={() => { void refresh(); onChange(); }}
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
        </div>
      </div>
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
  const dispatch = useOperationDispatch();
  // Busy = the in-flight git.abortPendingOp run (Phase 3b); the tracked run
  // id surfaces the failure inline.
  const busy = useOperationPending(gitAbortEntityKey(workspaceId), 'git.abortPendingOp');
  const [abortRunId, setAbortRunId] = useState<string>();
  const abortRun = useOperationRun(abortRunId);
  const [error, setError] = useState<string | null>(null);
  const verb: Record<PendingGitOp['kind'], string> = {
    'merge': 'Merge',
    'rebase': 'Rebase',
    'cherry-pick': 'Cherry-pick',
    'revert': 'Revert',
  };
  const opName = verb[op.kind];

  useEffect(() => {
    if (abortRun?.phase !== 'failed') return;
    setError(abortRun.error ?? 'Abort failed');
    setAbortRunId(undefined);
  }, [abortRun?.phase, abortRun?.error]);

  async function handleAbort() {
    if (!(await confirm({
      message: `Run "git ${op.kind} --abort" in ${workspacePath}?\nThis discards conflict resolution work in progress and rewinds the index.`,
      danger: true,
    }))) return;
    setError(null);
    setAbortRunId(dispatch('git.abortPendingOp', { workspaceId }).id);
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
}: {
  branch: LocalBranch;
  tree: WorkspaceTree | null;
  isMainTree: boolean;
  workspacePath: string;
  onOpenClaudeMd?: () => void;
  onRefresh: () => void;
}) {
  void workspacePath;
  const t = useT();
  const onWorktree = !!branch.worktreePath;
  const isDirty = tree?.isDirty ?? false;
  const state = isDirty ? 'dirty' : 'clean';
  const modifiedCount = tree?.modifiedCount ?? 0;
  return (
    <div className="wt-row">
      <span className="wt-ico">
        <BranchIcon size={14} />
      </span>
      <span
        style={{ font: 'var(--fz-12)/1.3 var(--font-sans)', color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={branch.worktreePath ?? undefined}
      >
        {tree?.label ?? '—'}
      </span>
      <div className="wt-branch">
        {branch.name}
        {isMainTree && <span className="main-tag">{t('spaces.git.mainTree')}</span>}
        {onWorktree && !isMainTree && <span className="main-tag">{t('spaces.git.worktree')}</span>}
      </div>
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
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const dispatch = useOperationDispatch();
  // Phase 3b: every action dispatches an operation. The tracked run drives
  // the item busy labels and the settle behavior (close + refresh on
  // confirm). Busy is derived from the run, not a local flag.
  const [action, setAction] = useState<{ runId: string; kind: 'reveal' | 'merge' | 'drop' | 'delete' } | null>(null);
  const actionRun = useOperationRun(action?.runId);
  const busy = actionRun?.phase === 'pending' || actionRun?.phase === 'optimistic' ? (action?.kind ?? null) : null;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!action || !actionRun) return;
    if (actionRun.phase === 'confirmed') {
      setAction(null);
      setOpen(false);
      onRefresh();
      return;
    }
    if (actionRun.phase === 'failed') {
      // merge/drop failures toast from their definitions (operations/session.ts)
      // and a reveal failure toasts from files.openExternal — only the
      // session.delete failure (WS, no definition toast) renders inline here.
      if (action.kind === 'delete') setError(actionRun.error ?? t('spaces.git.deleteFailed'));
      setAction(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionRun?.phase]);

  function dispatchAction(kind: 'reveal' | 'merge' | 'drop' | 'delete', name: OperationName, input: unknown): void {
    setError(null);
    setAction({ runId: dispatch(name, input).id, kind });
  }

  function handleReveal() {
    if (!tree) return;
    dispatchAction('reveal', 'files.openExternal', {
      workingTreeId: tree.id,
      path: '',
      target: { kind: 'reveal' },
    });
  }

  async function handleMerge() {
    if (!branch.session) return;
    const sid = branch.session.id;
    if (!(await confirm({
      message: `${t('spaces.git.confirmMerge')} "${branch.name}"?\n${t('spaces.git.confirmMergeHelp')}`,
      confirmLabel: t('spaces.git.confirmMerge'),
    }))) return;
    dispatchAction('merge', 'session.merge', { sessionId: sid });
  }

  async function handleDrop() {
    if (!branch.session) return;
    const sid = branch.session.id;
    if (!(await confirm({
      message: `${t('spaces.git.confirmDiscard')} "${branch.name}"?\n${t('spaces.git.confirmDiscardHelp')}`,
      danger: true,
      confirmLabel: t('spaces.git.confirmDiscard'),
    }))) return;
    dispatchAction('drop', 'session.drop', { sessionId: sid });
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
    // Phase 3b dedupe (inventory §4.1): the pre-migration inline DELETE fetch
    // duplicated the session-delete transport — this pane renders inside the
    // App's operation providers, so it dispatches the same WS-backed
    // session.delete operation as every other delete entry point.
    dispatchAction('delete', 'session.delete', { sessionId: sid });
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
