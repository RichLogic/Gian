import { useEffect, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { loadTree, loadChanged, loadAllFiles, stageFile, unstageFile } from '../api.js';
import type { TreeEntry, ChangedEntry, WorkingTree, ChangeScope } from '../api.js';
import { useT } from '../i18n/index.js';

export type InspectorTab = 'files' | 'changes';

function Icon({ d, size = 13, stroke = 1.6 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}

const I = {
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
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
  /** Changes tab: open the file's diff in Sheet, in the currently-selected
   *  scope so the diff matches what the row represents. */
  onOpenDiff: (path: string, permanent: boolean, scope: ChangeScope) => void;
  /** True when an active session is bound to this working tree, so git-action
   *  prompts can be dropped into its composer. False → footer buttons disabled. */
  canCommit: boolean;
  /** Drop a prompt into the active session's composer (NOT auto-sent — the user
   *  reviews/edits before sending). Used by Commit / Push / Create PR. */
  onComposePrompt: (text: string) => void;
}

export function Inspector({ tab, workingTreeId, workingTrees, onOpenFile, onOpenDiff, canCommit, onComposePrompt }: Props) {
  if (tab === 'files') return <FilesInspector workingTreeId={workingTreeId} workingTrees={workingTrees} onOpenFile={onOpenFile} />;
  return <ChangesInspector workingTreeId={workingTreeId} onOpenDiff={onOpenDiff} canCommit={canCommit} onComposePrompt={onComposePrompt} />;
}

// ─── Files Inspector ────────────────────────────────────────────────────────
function FilesInspector({
  workingTreeId,
  workingTrees,
  onOpenFile,
}: {
  workingTreeId: string | null;
  workingTrees: WorkingTree[];
  onOpenFile: (p: string, perm: boolean) => void;
}) {
  const t = useT();
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  // Whole-tree file index, fetched lazily the first time the user searches.
  // null = not loaded yet; [] = loaded-and-empty.
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const wt = workingTreeId ? workingTrees.find(w => w.id === workingTreeId) : null;
  const rootName = wt ? (wt.path.split('/').pop() || wt.path) : 'Root';
  const q = query.trim().toLowerCase();

  // Invalidate the cached index when the working tree changes or the user
  // hits refresh — the previous tree's paths no longer apply.
  useEffect(() => { setAllFiles(null); }, [workingTreeId, reloadKey]);

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
        <button className="iconbtn" title={t('common.refresh')} onClick={() => setReloadKey(k => k + 1)}>
          <Icon d={I.refresh} />
        </button>
      </div>
      <div className="insp-search">
        <Icon d={I.search} size={12} stroke={1.7} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('inspector.files.search')}
          aria-label={t('inspector.files.search')}
          spellCheck={false}
        />
        {query && (
          <button className="insp-search-x" aria-label={t('common.clear')} onClick={() => setQuery('')}>
            ✕
          </button>
        )}
      </div>
      <div className="insp-scroll">
        {!workingTreeId ? (
          <div style={{ padding: '12px', color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
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
              key={`${workingTreeId}:${reloadKey}`}
              workingTreeId={workingTreeId}
              relPath=""
              name={rootName}
              depth={0}
              openInitial
              onOpenFile={onOpenFile}
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
  workingTreeId,
  relPath,
  name,
  depth,
  openInitial = false,
  onOpenFile,
}: {
  workingTreeId: string;
  relPath: string;
  name: string;
  depth: number;
  openInitial?: boolean;
  onOpenFile: (path: string, permanent: boolean) => void;
}) {
  const [open, setOpen] = useState(openInitial);
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);

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
           style={{ paddingLeft: 6 + depth * 12 }}
           onClick={() => setOpen(o => !o)}>
        <span className="tree-caret">▶</span>
        <Icon d={I.folder} size={13} />
        <span className="tree-name">{name}</span>
      </div>
      {open && entries && (
        <div className="tree-children">
          {entries.map(e => e.type === 'dir' ? (
            <TreeFolder
              key={e.path}
              workingTreeId={workingTreeId}
              relPath={e.path}
              name={e.name}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ) : (
            <TreeFile
              key={e.path}
              name={e.name}
              path={e.path}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TreeFile({ name, path, depth, onOpenFile }: { name: string; path: string; depth: number; onOpenFile: (p: string, perm: boolean) => void }) {
  const { bg, label } = extBadge(name);
  return (
    <div className="tree-item"
         style={{ paddingLeft: 6 + depth * 12 }}
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
// Click a changed file → its diff opens in the Sheet workbench (V1 behavior).
// The changed files are presented as a collapsible file tree (built client-side
// from the flat /changed list), reusing the FILES tree chrome.

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
  scope: ChangeScope;
  busyPath: string | null;
  onOpenDiff: (path: string, permanent: boolean, scope: ChangeScope) => void;
  onToggleStage: (e: ReactMouseEvent, c: ChangedEntry) => void;
  t: (key: string) => string;
}

function ChangeTreeNode({ node, depth, ctx }: { node: ChangeNode; depth: number; ctx: ChangeTreeProps }) {
  if (node.entry) return <ChangeLeaf entry={node.entry} name={node.name} depth={depth} ctx={ctx} />;
  return <ChangeFolder node={node} depth={depth} ctx={ctx} />;
}

function ChangeFolder({ node, depth, ctx }: { node: ChangeNode; depth: number; ctx: ChangeTreeProps }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div
        className={`tree-item folder ${open ? 'open' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => setOpen(o => !o)}
        title={node.path}
      >
        <span className="tree-caret">▶</span>
        <Icon d={I.folder} size={13} />
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
      style={{ paddingLeft: 6 + depth * 12 }}
      title={entry.path}
      onClick={() => ctx.onOpenDiff(entry.path, false, ctx.scope)}
      onDoubleClick={() => ctx.onOpenDiff(entry.path, true, ctx.scope)}
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

// The five diff-source scopes offered in the Changes picker, in Codex's order.
// `all` is intentionally absent — it stays a host-only default for GitBadge.
const SCOPE_OPTIONS: ReadonlyArray<{ value: ChangeScope; key: string }> = [
  { value: 'unstaged', key: 'changes.scope.unstaged' },
  { value: 'staged', key: 'changes.scope.staged' },
  { value: 'commit', key: 'changes.scope.commit' },
  { value: 'branch', key: 'changes.scope.branch' },
  { value: 'lastturn', key: 'changes.scope.lastTurn' },
];

function ChangesInspector({
  workingTreeId,
  onOpenDiff,
  canCommit,
  onComposePrompt,
}: {
  workingTreeId: string | null;
  onOpenDiff: (path: string, permanent: boolean, scope: ChangeScope) => void;
  canCommit: boolean;
  onComposePrompt: (text: string) => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<ChangeScope>(() => {
    try {
      const s = localStorage.getItem('gian.changes.scope');
      // Accept the five Codex-aligned scopes. Legacy stored 'all' (dropped from
      // the picker) falls through to the new default, Branch.
      if (s === 'unstaged' || s === 'staged' || s === 'commit' || s === 'branch' || s === 'lastturn') return s;
    } catch { /* storage disabled */ }
    return 'branch';
  });
  const [changes, setChanges] = useState<ChangedEntry[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);

  useEffect(() => {
    if (!workingTreeId) {
      setChanges([]);
      return;
    }
    let cancelled = false;
    void loadChanged(workingTreeId, scope).then(list => {
      if (!cancelled) setChanges(list);
    });
    return () => { cancelled = true; };
  }, [workingTreeId, scope, reloadKey]);

  function pickScope(next: ChangeScope) {
    setScope(next);
    try { localStorage.setItem('gian.changes.scope', next); } catch { /* storage disabled */ }
  }

  const total = changes.reduce((acc, c) => ({ add: acc.add + c.added, del: acc.del + c.removed }), { add: 0, del: 0 });
  const tree = buildChangeTree(changes);

  async function toggleStage(e: ReactMouseEvent, c: ChangedEntry) {
    e.stopPropagation();
    if (!workingTreeId || busyPath) return;
    setBusyPath(c.path);
    const ok = c.staged
      ? await unstageFile(workingTreeId, c.path)
      : await stageFile(workingTreeId, c.path);
    setBusyPath(null);
    if (ok) setReloadKey(k => k + 1);
  }

  // Compose a git-action prompt and drop it into the active session composer.
  // Never auto-sent — executor (Claude/Codex) runs the git itself once the user
  // reviews and sends. Keeps Gian's Changes panel free of any git write path.
  function fire(promptKey: string) {
    onComposePrompt(t(promptKey));
    setMenuOpen(false);
  }

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="label">{t('inspector.changes')}</span>
        {/* Diff-source picker — the five Codex-aligned scopes, with a ✓ on the
            active one. Custom menu (not a native <select>) to match Codex. */}
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
                  <button
                    key={opt.value}
                    role="menuitemradio"
                    aria-checked={scope === opt.value}
                    type="button"
                    className={scope === opt.value ? 'active' : ''}
                    onClick={() => { pickScope(opt.value); setScopeMenuOpen(false); }}
                  >
                    <span className="ck">{scope === opt.value ? '✓' : ''}</span>
                    {t(opt.key)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button className="iconbtn" title={t('common.refresh')} onClick={() => setReloadKey(k => k + 1)}>
          <Icon d={I.refresh} />
        </button>
      </div>
      <div className="insp-scroll">
        <div className="changes-summary">
          <span className="count">{changes.length} {t('changes.files')}</span>
          <span className="add">+{total.add}</span>
          <span className="del">−{total.del}</span>
        </div>
        {changes.length === 0 ? (
          <div className="changes-empty">{t('changes.empty')}</div>
        ) : (
          <div className="tree">
            {tree.children.map(node => (
              <ChangeTreeNode
                key={node.path}
                node={node}
                depth={0}
                ctx={{ scope, busyPath, onOpenDiff, onToggleStage: (e, c) => { void toggleStage(e, c); }, t }}
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
