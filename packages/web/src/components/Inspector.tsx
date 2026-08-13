import { Fragment, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { loadTree, loadCommits, loadAllFiles } from '../api.js';
import type { TreeEntry, ChangedEntry, BranchCommit, WorkingTree, ChangeScope } from '../api.js';
import {
  ensureChangesDiffLoaded,
  refreshChangesDiff,
  requestChangesDiffAnchor,
  saveChangesInspectorScroll,
  setChangesDiffBase,
  setChangesDiffCommit,
  setChangesDiffScope,
  setChangesDiffSession,
  toggleChangesFolder,
  useChangesDiffState,
} from '../controllers/use-changes-diff.js';
import {
  filesInspectorOwnerKey,
  refreshFilesInspector,
  saveFilesInspectorScroll,
  setFilesFolderOpen,
  setFilesInspectorQuery,
  toggleFilesFolder,
  useFilesInspectorState,
} from '../controllers/use-files-inspector.js';
import { gitIndexEntityKey } from '../operations/git.js';
import { useOperationDispatch, useOperationRun, usePendingOperations } from '../operations/use-operations.js';
import { useT } from '../i18n/index.js';

// App.tsx routes the 'workspaces' / 'settings' inspector kinds to dedicated
// components; the generic Inspector below only handles the working-tree-scoped
// 'files' / 'changes' tabs.
export type InspectorTab = 'files' | 'changes';

function Icon({ d, size = 13, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}

const I = {
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4',
  chev: 'M9 5l7 7-7 7',
  search: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M19.5 19.5l-4.6-4.6',
};

// Per-extension badge swatch shared by the tree files and the search hits.
const EXT_COLORS: Record<string, string> = {
  md: 'oklch(0.55 0.04 250)',
  ts: 'oklch(0.55 0.13 260)',
  tsx: 'oklch(0.55 0.13 260)',
  json: 'oklch(0.55 0.11 80)',
  css: 'oklch(0.55 0.13 320)',
};

function extBadge(name: string): { bg: string; label: string } {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'txt').toLowerCase();
  return { bg: EXT_COLORS[ext] || 'oklch(0.55 0.01 280)', label: ext.toUpperCase().slice(0, 2) };
}

interface Props {
  tab: InspectorTab;
  workingTreeId: string | null;
  /** Used to resolve the root folder's display name (basename of the
   *  working tree's path). Without this the root would have to fall back
   *  to its UUID, which reads as noise. */
  workingTrees: WorkingTree[];
  /** Files tab: open file source in Sheet. permanent=true for double-click. */
  onOpenFile: (path: string, permanent: boolean) => void;
  /** Files tab: expand, select, and scroll to a file opened from elsewhere. */
  revealFile?: { workingTreeId: string; path: string; requestId: number } | null;
  /** Active session — forwarded to the host on the Last-turn scope, whose
   *  `ws:`/`ext:` trees don't carry a session of their own. */
  activeSessionId?: string | null;
  /** True when an active session is bound to this working tree, so git-action
   *  prompts can be dropped into its composer. False → footer buttons disabled. */
  canCommit: boolean;
  /** Drop a prompt into the active session's composer (NOT auto-sent — the user
   *  reviews/edits before sending). Used by Commit / Push / Create PR. */
  onComposePrompt: (text: string) => void;
}

export function Inspector({ tab, workingTreeId, workingTrees, onOpenFile, revealFile, activeSessionId, canCommit, onComposePrompt }: Props) {
  if (tab === 'files') {
    return (
      <FilesInspector
        workingTreeId={workingTreeId}
        activeSessionId={activeSessionId}
        workingTrees={workingTrees}
        onOpenFile={onOpenFile}
        revealFile={revealFile}
      />
    );
  }
  return <ChangesInspector workingTreeId={workingTreeId} activeSessionId={activeSessionId} canCommit={canCommit} onComposePrompt={onComposePrompt} />;
}

// ─── Files Inspector ────────────────────────────────────────────────────────
function FilesInspector({
  workingTreeId,
  activeSessionId,
  workingTrees,
  onOpenFile,
  revealFile,
}: {
  workingTreeId: string | null;
  activeSessionId?: string | null;
  workingTrees: WorkingTree[];
  onOpenFile: (p: string, perm: boolean) => void;
  revealFile?: { workingTreeId: string; path: string; requestId: number } | null;
}) {
  const t = useT();
  const ownerKey = filesInspectorOwnerKey(activeSessionId, workingTreeId)
    ?? (workingTreeId ? JSON.stringify([null, workingTreeId]) : null);
  const viewState = useFilesInspectorState(ownerKey);
  const { query, reloadRevision } = viewState;
  // Whole-tree file index, fetched lazily the first time the user searches.
  // null = not loaded yet; [] = loaded-and-empty.
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wt = workingTreeId ? workingTrees.find(w => w.id === workingTreeId) : null;
  const rootName = wt ? (wt.path.split('/').pop() || wt.path) : 'Root';
  const q = query.trim().toLowerCase();
  const revealPath = revealFile?.workingTreeId === workingTreeId ? revealFile.path : null;

  // Cross-panel reveals use the hierarchical tree, not a stale search result.
  useEffect(() => {
    if (revealPath && ownerKey) setFilesInspectorQuery(ownerKey, '');
  }, [revealPath, revealFile?.requestId, ownerKey]);

  // Invalidate the cached index when the working tree changes or the user
  // hits refresh — the previous tree's paths no longer apply.
  useEffect(() => { setAllFiles(null); }, [workingTreeId, reloadRevision]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = viewState.scrollTop;
  }, [ownerKey]);

  // Fetch the recursive index on first search for the current tree.
  useEffect(() => {
    if (!q || !workingTreeId || allFiles !== null) return;
    let cancelled = false;
    setLoadingAll(true);
    void loadAllFiles(workingTreeId).then(list => {
      if (cancelled) return;
      setAllFiles(list);
      setLoadingAll(false);
    });
    return () => { cancelled = true; };
  }, [q, workingTreeId, allFiles]);

  const matches = q && allFiles
    ? allFiles.filter(p => p.toLowerCase().includes(q)).slice(0, 500)
    : [];

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="label">{t('dock.files')}</span>
        <button className="iconbtn" title={t('common.refresh')} onClick={() => {
          if (ownerKey) refreshFilesInspector(ownerKey);
        }}>
          <Icon d={I.refresh} />
        </button>
      </div>
      <div className="insp-search">
        <Icon d={I.search} size={12} stroke={1.7} />
        <input
          value={query}
          onChange={e => { if (ownerKey) setFilesInspectorQuery(ownerKey, e.target.value); }}
          placeholder={t('inspector.files.search')}
          aria-label={t('inspector.files.search')}
          spellCheck={false}
        />
        {query && (
          <button className="insp-search-x" aria-label={t('common.clear')} onClick={() => {
            if (ownerKey) setFilesInspectorQuery(ownerKey, '');
          }}>
            ✕
          </button>
        )}
      </div>
      <div className="insp-scroll" ref={scrollRef}
           onScroll={e => { if (ownerKey) saveFilesInspectorScroll(ownerKey, e.currentTarget.scrollTop); }}>
        {!workingTreeId ? (
          <div style={{ padding: '12px', color: 'var(--text-3)', fontSize: 'var(--fz-12)', fontStyle: 'italic' }}>
            No active working tree.
          </div>
        ) : q ? (
          <div className="tree">
            {loadingAll && allFiles === null ? (
              <div className="insp-note">{t('inspector.files.searching')}</div>
            ) : matches.length === 0 ? (
              <div className="insp-note">{t('inspector.files.noMatch')}</div>
            ) : (
              matches.map(p => <SearchHit key={p} path={p} onOpenFile={onOpenFile} />)
            )}
          </div>
        ) : (
          <div className="tree">
            <TreeFolder
              // Key on the working tree (not just reloadKey) so switching
              // workspace remounts the whole tree — otherwise the root folder
              // keeps the previous tree's cached `entries` and never reloads.
              key={`${ownerKey}:${reloadRevision}`}
              ownerKey={ownerKey!}
              workingTreeId={workingTreeId}
              relPath=""
              name={rootName}
              depth={0}
              openInitial
              onOpenFile={onOpenFile}
              revealPath={revealPath}
              revealRequestId={revealFile?.requestId}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

// Flat search result: file badge + name with a dimmed directory prefix.
function SearchHit({ path, onOpenFile }: { path: string; onOpenFile: (p: string, perm: boolean) => void }) {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const { bg, label } = extBadge(name);
  return (
    <div
      className="tree-item"
      onClick={() => onOpenFile(path, false)}
      onDoubleClick={() => onOpenFile(path, true)}
      title={path}
    >
      <span className="tree-caret" />
      <span className="tree-ico" style={{
        width: 14, height: 14, borderRadius: 2,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: bg, color: 'white', font: '700 7.5px/1 var(--font-mono)',
      }}>{label}</span>
      <span className="tree-name"><span className="hit-dir">{dir}</span>{name}</span>
    </div>
  );
}

function TreeFolder({
  ownerKey,
  workingTreeId,
  relPath,
  name,
  depth,
  openInitial = false,
  onOpenFile,
  revealPath,
  revealRequestId,
}: {
  ownerKey: string;
  workingTreeId: string;
  relPath: string;
  name: string;
  depth: number;
  openInitial?: boolean;
  onOpenFile: (path: string, permanent: boolean) => void;
  revealPath: string | null;
  revealRequestId?: number;
}) {
  const t = useT();
  const viewState = useFilesInspectorState(ownerKey);
  const open = viewState.folderOpen[relPath] ?? openInitial;
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const containsReveal = !!revealPath && (
    relPath === '' || revealPath.startsWith(`${relPath}/`)
  );

  useEffect(() => {
    if (containsReveal) setFilesFolderOpen(ownerKey, relPath, true);
  }, [containsReveal, revealRequestId, ownerKey, relPath]);

  useEffect(() => {
    if (!open || entries !== null) return;
    let cancelled = false;
    void loadTree(workingTreeId, relPath).then(list => {
      if (!cancelled) {
        const sorted = list.slice().sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
      }
    });
    return () => { cancelled = true; };
  }, [open, entries, workingTreeId, relPath]);

  return (
    <>
      <div className={`tree-item folder ${open ? 'open' : ''}`}
           style={{ paddingLeft: 6 + depth * 10 }}
           onClick={() => toggleFilesFolder(ownerKey, relPath, openInitial)}>
        <span className="tree-caret"><Icon d={I.chev} size={10} /></span>
        <span className="tree-name">{name}</span>
      </div>
      {/* Row-level loader while loadTree is in flight (proposal §4.5) — the
          expand must not wait silently. */}
      {open && entries === null && (
        <div className="tree-item tree-loading" style={{ paddingLeft: 6 + (depth + 1) * 10 }}>
          <span className="tree-caret" />
          <span className="spinner" aria-hidden="true" />
          <span className="tree-name" style={{ color: 'var(--text-3)' }}>{t('inspector.files.loading')}</span>
        </div>
      )}
      {open && entries && (
        <div className="tree-children">
          {entries.map(e => e.type === 'dir' ? (
            <TreeFolder
              key={e.path}
              ownerKey={ownerKey}
              workingTreeId={workingTreeId}
              relPath={e.path}
              name={e.name}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              revealPath={revealPath}
              revealRequestId={revealRequestId}
            />
          ) : (
            <TreeFile
              key={e.path}
              name={e.name}
              path={e.path}
              depth={depth + 1}
              onOpenFile={onOpenFile}
              selected={e.path === revealPath}
              revealRequestId={revealRequestId}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TreeFile({
  name,
  path,
  depth,
  onOpenFile,
  selected,
  revealRequestId,
}: {
  name: string;
  path: string;
  depth: number;
  onOpenFile: (p: string, perm: boolean) => void;
  selected: boolean;
  revealRequestId?: number;
}) {
  const { bg, label } = extBadge(name);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, revealRequestId]);

  return (
    <div ref={ref}
         className={`tree-item${selected ? ' active' : ''}`}
         data-file-path={path}
         style={{ paddingLeft: 6 + depth * 10 }}
         onClick={() => onOpenFile(path, false)}
         onDoubleClick={() => onOpenFile(path, true)}
         title={path}>
      <span className="tree-caret" />
      <span className="tree-ico" style={{
        width: 14, height: 14, borderRadius: 2,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: bg, color: 'white', font: '700 7.5px/1 var(--font-mono)',
      }}>{label}</span>
      <span className="tree-name">{name}</span>
    </div>
  );
}

// ─── Changes Inspector ──────────────────────────────────────────────────────
// Click a changed file → panel 2's singleton Changes multi-diff view jumps to
// that file's block (expand + scroll). All scope/list state lives in the
// use-changes-diff store (keyed by working tree); this component is a view
// over it. The changed files are presented as a collapsible file tree (built
// client-side from the flat /changed list), reusing the FILES tree chrome.

function sigBadge(kind: ChangedEntry['kind']) {
  if (kind === 'create') return { cls: 'add', txt: 'A' };
  if (kind === 'delete') return { cls: 'del', txt: 'D' };
  return { cls: 'mod', txt: 'M' };
}

interface ChangeNode {
  /** Path segment (folder or file basename). */
  name: string;
  /** Full relative path up to and including this node. */
  path: string;
  /** Set only on file leaves. */
  entry?: ChangedEntry;
  children: ChangeNode[];
}

/** Build a nested folder/file tree from the flat changed-file list. */
function buildChangeTree(entries: ChangedEntry[]): ChangeNode {
  const root: ChangeNode = { name: '', path: '', children: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.children.find(c => c.name === seg);
      if (!child) {
        child = { name: seg, path: acc, children: [] };
        node.children.push(child);
      }
      if (i === parts.length - 1) child.entry = e;
      node = child;
    }
  }
  sortChangeNodes(root.children);
  return root;
}

/** Folders (no entry) first, then files; each group alphabetical. Recurses. */
function sortChangeNodes(nodes: ChangeNode[]): void {
  nodes.sort((a, b) => {
    const af = a.entry ? 1 : 0;
    const bf = b.entry ? 1 : 0;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });
  for (const n of nodes) if (!n.entry) sortChangeNodes(n.children);
}

interface ChangeTreeProps {
  workingTreeId: string;
  ownerSessionId?: string | null;
  folderOpen: Readonly<Record<string, boolean>>;
  scope: ChangeScope;
  busyPath: string | null;
  /** Jump panel 2's Changes multi-diff view to this file's diff block. */
  onReveal: (path: string) => void;
  onToggleStage: (e: ReactMouseEvent, c: ChangedEntry) => void;
  t: (key: string) => string;
}

function ChangeTreeNode({ node, depth, ctx }: { node: ChangeNode; depth: number; ctx: ChangeTreeProps }) {
  if (node.entry) return <ChangeLeaf entry={node.entry} name={node.name} depth={depth} ctx={ctx} />;
  return <ChangeFolder node={node} depth={depth} ctx={ctx} />;
}

function ChangeFolder({ node, depth, ctx }: { node: ChangeNode; depth: number; ctx: ChangeTreeProps }) {
  const open = ctx.folderOpen[node.path] ?? true;
  return (
    <>
      <div
        className={`tree-item folder ${open ? 'open' : ''}`}
        style={{ paddingLeft: 6 + depth * 10 }}
        onClick={() => toggleChangesFolder(ctx.workingTreeId, node.path, ctx.ownerSessionId)}
        title={node.path}
      >
        <span className="tree-caret"><Icon d={I.chev} size={10} /></span>
        <span className="tree-name">{node.name}</span>
      </div>
      {open && node.children.map(ch => (
        <ChangeTreeNode key={ch.path} node={ch} depth={depth + 1} ctx={ctx} />
      ))}
    </>
  );
}

function ChangeLeaf({ entry, name, depth, ctx }: { entry: ChangedEntry; name: string; depth: number; ctx: ChangeTreeProps }) {
  const { cls, txt } = sigBadge(entry.kind);
  return (
    <div
      className={`tree-item changes-leaf ${entry.staged ? 'staged' : ''}`}
      style={{ paddingLeft: 6 + depth * 10 }}
      title={entry.path}
      onClick={() => ctx.onReveal(entry.path)}
      onDoubleClick={() => ctx.onReveal(entry.path)}
    >
      <span className="tree-caret" />
      <span className={`files-badge ${cls}`}>{txt}</span>
      <span className="tree-name">{name}</span>
      <span className="stat">
        {entry.added > 0 && <span className="add">+{entry.added}</span>}
        {entry.removed > 0 && <span className="del">−{entry.removed}</span>}
      </span>
      {/* Stage/unstage only applies to the working-tree scopes — committed
          (commit/branch) and last-turn diffs have no staging concept. */}
      {(ctx.scope === 'unstaged' || ctx.scope === 'staged') && (
        <button
          className="changes-stage"
          type="button"
          disabled={ctx.busyPath === entry.path}
          title={entry.staged ? ctx.t('changes.unstage') : ctx.t('changes.stage')}
          onClick={e => ctx.onToggleStage(e, entry)}
        >
          {entry.staged ? ctx.t('changes.unstage') : ctx.t('changes.stage')}
        </button>
      )}
    </div>
  );
}

// The diff-source scopes offered in the Changes picker, in the user's order:
// Last Turn pinned first, then the working-tree slices (All changes / Added /
// Unadded), then the history scopes (Committed, Branch). The menu is FLAT —
// commit/base picking happens on a second row under the header (Codex's
// two-row Review UI), not in a nested submenu.
const SCOPE_OPTIONS: ReadonlyArray<{ value: ChangeScope; key: string }> = [
  { value: 'lastturn', key: 'changes.scope.lastTurn' },
  { value: 'all', key: 'changes.scope.uncommitted' },
  { value: 'staged', key: 'changes.scope.staged' },
  { value: 'unstaged', key: 'changes.scope.unstaged' },
  { value: 'commit', key: 'changes.scope.commit' },
  { value: 'branch', key: 'changes.scope.branch' },
];
// Scope groups separated by a hairline in the menu: Last Turn | working-tree
// slices | history scopes.
const SCOPE_SEP_BEFORE: ReadonlySet<ChangeScope> = new Set(['all', 'commit']);

function ChangesInspector({
  workingTreeId,
  activeSessionId,
  canCommit,
  onComposePrompt,
}: {
  workingTreeId: string | null;
  activeSessionId?: string | null;
  canCommit: boolean;
  onComposePrompt: (text: string) => void;
}) {
  const t = useT();
  const dispatch = useOperationDispatch();
  // Scope, pinned commit/base, last-turn target and the changed-file list all
  // live in the use-changes-diff store (keyed by Session + working tree) —
  // shared with panel 2's multi-diff view and surviving inspector unmounts.
  const diffState = useChangesDiffState(workingTreeId, activeSessionId);
  const { scope, commitSha, baseBranch, branchList: branches } = diffState;
  const changes = diffState.files;
  // Stage/unstage busy state is derived from the in-flight git.stage /
  // git.unstage runs (Phase 3b — the runs replaced the local busyPath flag);
  // the tracked run reloads the changed list once the index write confirms.
  const [stageRunId, setStageRunId] = useState<string>();
  const stageRun = useOperationRun(stageRunId);
  const pendingRuns = usePendingOperations();
  // `git:<wt>:` — the entity-key prefix for this tree's stage/unstage runs
  // (see gitIndexEntityKey in operations/git.ts).
  const indexPrefix = workingTreeId ? gitIndexEntityKey(workingTreeId, '') : null;
  const busyRun = pendingRuns.find(run =>
    (run.name === 'git.stage' || run.name === 'git.unstage')
    && (indexPrefix ? run.entityKey.startsWith(indexPrefix) : false));
  const busyPath = busyRun && indexPrefix
    ? busyRun.entityKey.slice(indexPrefix.length)
    : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  // Second-row pickers (Codex's two-row Review UI — no nested dropdowns): the
  // Committed row pins a commit (null = HEAD's delta), the Branch row pins a
  // compare base (null = repository remote default). Commit choices are local
  // picker data; branch choices and pinned values live in the shared store.
  const [commits, setCommits] = useState<BranchCommit[]>([]);
  const [commitsLoaded, setCommitsLoaded] = useState(false);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  const [rowSearch, setRowSearch] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Forward the active session — the Last-turn scope's fallback for trees
  // that carry no session of their own. Declared BEFORE the ensure effect so
  // the first list load already carries it (store updates are synchronous).
  useEffect(() => {
    if (workingTreeId) {
      setChangesDiffSession(
        workingTreeId,
        activeSessionId ?? null,
        activeSessionId,
      );
    }
  }, [workingTreeId, activeSessionId]);

  useEffect(() => {
    if (workingTreeId) ensureChangesDiffLoaded(workingTreeId, activeSessionId);
  }, [workingTreeId, activeSessionId]);

  useEffect(() => {
    setCommits([]);
    setCommitsLoaded(false);
  }, [workingTreeId, activeSessionId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = diffState.inspectorScrollTop;
  }, [workingTreeId, activeSessionId]);

  useEffect(() => {
    if (scope !== 'commit' || !workingTreeId || commitsLoaded) return;
    let cancelled = false;
    void loadCommits(workingTreeId).then(list => {
      if (cancelled) return;
      setCommits(list);
      setCommitsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [scope, workingTreeId, commitsLoaded]);

  function pickScope(next: ChangeScope) {
    if (!workingTreeId) return;
    setChangesDiffScope(workingTreeId, next, activeSessionId);
  }

  function pickBase(branch: string | null) {
    if (!workingTreeId) return;
    setChangesDiffBase(workingTreeId, branch, activeSessionId);
    setRowMenuOpen(false);
  }

  const tree = buildChangeTree(changes);
  const defaultBaseSelected = baseBranch === null || baseBranch === branches?.base;

  // Stage/unstage settle: the confirmed index write reloads the changed-file
  // list (the pre-migration await-then-reload); failures toast from the
  // definition (operations/git.ts) and just clear the tracked run here.
  useEffect(() => {
    if (!stageRun) return;
    if (stageRun.phase === 'confirmed') {
      setStageRunId(undefined);
      if (workingTreeId) refreshChangesDiff(workingTreeId, activeSessionId);
    } else if (stageRun.phase === 'failed' || stageRun.phase === 'timed-out') {
      setStageRunId(undefined);
    }
  }, [stageRun?.phase]);

  function toggleStage(e: ReactMouseEvent, c: ChangedEntry) {
    e.stopPropagation();
    if (!workingTreeId) return;
    setStageRunId(dispatch(c.staged ? 'git.unstage' : 'git.stage', {
      workingTreeId,
      path: c.path,
    }).id);
  }

  // Compose a git-action prompt and drop it into the active session composer.
  // Never auto-sent — the selected executor runs git once the user
  // reviews and sends. Keeps Gian's Changes panel free of any git write path.
  function fire(promptKey: string) {
    onComposePrompt(t(promptKey));
    setMenuOpen(false);
  }

  return (
    <aside className="inspector changes-inspector">
      <div className="insp-head">
        <span className="label">{t('inspector.changes')}</span>
        <div className="changes-scope">
          <button
            className="changes-scope-btn"
            type="button"
            title={t('changes.scope.title')}
            onClick={() => setScopeMenuOpen(o => !o)}
          >
            {t(SCOPE_OPTIONS.find(o => o.value === scope)?.key ?? 'changes.scope.branch')}
            <span className="caret">▾</span>
          </button>
          {scopeMenuOpen && (
            <>
              <div className="changes-menu-backdrop" onClick={() => setScopeMenuOpen(false)} />
              <div className="changes-scope-menu" role="menu">
                {SCOPE_OPTIONS.map(opt => (
                  <Fragment key={opt.value}>
                    {SCOPE_SEP_BEFORE.has(opt.value) && <div className="changes-scope-sep" role="separator" />}
                    <button
                      role="menuitemradio"
                      aria-checked={scope === opt.value}
                      type="button"
                      className={scope === opt.value ? 'active' : ''}
                      onClick={() => { pickScope(opt.value); setScopeMenuOpen(false); }}
                    >
                      <span className="ck">{scope === opt.value ? '✓' : ''}</span>
                      {t(opt.key)}
                    </button>
                  </Fragment>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {/* Contextual second row for Branch / Committed, right-aligned. */}
      {(scope === 'branch' || scope === 'commit') && (
        <div className="changes-controls">
          <div className="changes-base-row">
            {scope === 'branch' && <span className="base-head">{branches?.head ?? '…'}</span>}
            {scope === 'branch' && <span className="base-arrow">→</span>}
            <div className="changes-base">
              <button
                className="changes-base-btn"
                type="button"
                onClick={() => { setRowMenuOpen(o => !o); setRowSearch(''); }}
              >
                <span className="changes-base-label">
                  {scope === 'branch'
                    ? (baseBranch ?? branches?.base ?? '…')
                    : (commitSha
                        ? `${commitSha.slice(0, 7)} ${commits.find(cm => cm.sha === commitSha)?.subject ?? ''}`.trim()
                        : t('changes.scope.latestCommit'))}
                </span>
                <span className="caret">▾</span>
              </button>
              {rowMenuOpen && (
                <>
                  <div className="changes-menu-backdrop" onClick={() => setRowMenuOpen(false)} />
                  <div className="changes-base-menu" role="menu">
                    <input
                      autoFocus
                      className="changes-base-search"
                      placeholder={t(scope === 'branch' ? 'changes.scope.searchBranches' : 'changes.scope.searchCommits')}
                      value={rowSearch}
                      onChange={e => setRowSearch(e.target.value)}
                    />
                    {scope === 'branch' ? (
                      <>
                        <button
                          role="menuitemradio"
                          aria-checked={defaultBaseSelected}
                          type="button"
                          className={defaultBaseSelected ? 'active' : ''}
                          title={branches?.base ?? undefined}
                          onClick={() => pickBase(null)}
                        >
                          <span className="ck">{defaultBaseSelected ? '✓' : ''}</span>
                          <span className="branch-name">{branches?.base ?? '…'}</span>
                        </button>
                        {(branches?.branches ?? [])
                          .filter(b => b !== branches?.base)
                          .filter(b => !rowSearch || b.toLowerCase().includes(rowSearch.toLowerCase()))
                          .map(b => (
                            <button
                              key={b}
                              role="menuitemradio"
                              aria-checked={(baseBranch ?? branches?.base) === b}
                              type="button"
                              className={(baseBranch ?? branches?.base) === b ? 'active' : ''}
                              title={b}
                              onClick={() => pickBase(b)}
                            >
                              <span className="ck">{(baseBranch ?? branches?.base) === b ? '✓' : ''}</span>
                              <span className="branch-name">{b}</span>
                            </button>
                          ))}
                      </>
                    ) : (
                      <>
                        <button
                          role="menuitemradio"
                          aria-checked={commitSha === null}
                          type="button"
                          className={commitSha === null ? 'active' : ''}
                          onClick={() => { if (workingTreeId) setChangesDiffCommit(workingTreeId, null, activeSessionId); setRowMenuOpen(false); }}
                        >
                          <span className="ck">{commitSha === null ? '✓' : ''}</span>
                          <span className="subj">{t('changes.scope.latestCommit')}</span>
                        </button>
                        {commitsLoaded && commits.length === 0 && (
                          <div className="changes-commit-empty">{t('changes.scope.noCommits')}</div>
                        )}
                        {commits
                          .filter(cm => !rowSearch || cm.subject.toLowerCase().includes(rowSearch.toLowerCase()) || cm.sha.startsWith(rowSearch.toLowerCase()))
                          .map(cm => (
                            <button
                              key={cm.sha}
                              role="menuitemradio"
                              aria-checked={commitSha === cm.sha}
                              type="button"
                              className={commitSha === cm.sha ? 'active' : ''}
                              title={cm.sha}
                              onClick={() => { if (workingTreeId) setChangesDiffCommit(workingTreeId, cm.sha, activeSessionId); setRowMenuOpen(false); }}
                            >
                              <span className="ck">{commitSha === cm.sha ? '✓' : ''}</span>
                              <span className="subj">{cm.subject}</span>
                              <span className="rel">{cm.rel}</span>
                            </button>
                          ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="insp-scroll" ref={scrollRef}
           onScroll={e => {
             if (workingTreeId) saveChangesInspectorScroll(
               workingTreeId,
               e.currentTarget.scrollTop,
               activeSessionId,
             );
           }}>
        {diffState.status === 'error' ? (
          <div className="changes-empty">
            {t('changes.diff.loadFailed')}{' '}
            <button className="btn sm secondary" type="button"
                    onClick={() => { if (workingTreeId) refreshChangesDiff(workingTreeId, activeSessionId); }}>
              {t('common.retry')}
            </button>
          </div>
        ) : changes.length === 0 ? (
          <div className="changes-empty">{t('changes.empty')}</div>
        ) : (
          <div className="tree">
            {tree.children.map(node => (
              <ChangeTreeNode
                key={node.path}
                node={node}
                depth={0}
                ctx={{
                  workingTreeId: workingTreeId!,
                  ownerSessionId: activeSessionId,
                  folderOpen: diffState.folderOpen,
                  scope,
                  busyPath,
                  onReveal: path => { if (workingTreeId) requestChangesDiffAnchor(workingTreeId, path, activeSessionId); },
                  onToggleStage: (e, c) => { void toggleStage(e, c); },
                  t,
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="changes-foot">
        <div className="changes-actions">
          <div className="changes-commit">
            <button
              className="btn primary sm"
              type="button"
              disabled={!canCommit}
              title={canCommit ? undefined : t('changes.needSession')}
              onClick={() => setMenuOpen(o => !o)}
            >
              {t('changes.commitOrPush')} ▾
            </button>
            {menuOpen && (
              <>
                <div className="changes-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="changes-commit-menu" role="menu">
                  <button role="menuitem" type="button" onClick={() => fire('changes.prompt.commit')}>
                    {t('changes.commit')}
                  </button>
                  <button role="menuitem" type="button" onClick={() => fire('changes.prompt.commitAndPush')}>
                    {t('changes.commitAndPush')}
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            className="btn secondary sm"
            type="button"
            disabled={!canCommit}
            title={canCommit ? undefined : t('changes.needSession')}
            onClick={() => fire('changes.prompt.createPr')}
          >
            {t('changes.createPr')}
          </button>
        </div>
      </div>
    </aside>
  );
}
