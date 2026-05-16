import { useEffect, useRef, useState } from 'react';
import { loadFile, loadTree, loadChanged, loadDiff, loadFileMeta } from '../api.js';
import type { TreeEntry, ChangedEntry, FileMeta, WorkingTree } from '../api.js';
import { useT } from '../i18n/index.js';
import { useResizableWidth, RailSplitter } from '../components/RailLayout.js';

type ViewMode = 'tree' | 'changed';
type PreviewPane = 'content' | 'diff';

interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface ParsedDiff {
  hunks: DiffHunk[];
}

function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@ ')) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
    } else if (cur) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        cur.lines.push({ kind: 'add', text: line.slice(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        cur.lines.push({ kind: 'del', text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        cur.lines.push({ kind: 'ctx', text: line.slice(1) });
      }
    }
  }
  return { hunks };
}

function kindBadge(kind: ChangedEntry['kind']): { label: string; cls: string } {
  if (kind === 'create') return { label: 'A', cls: 'files-badge-add' };
  if (kind === 'delete') return { label: 'D', cls: 'files-badge-del' };
  if (kind === 'rename') return { label: 'R', cls: 'files-badge-mod' };
  return { label: 'M', cls: 'files-badge-mod' };
}

// ---------------------------------------------------------------------------
// Minimal regex-based syntax highlighter
// Covers .ts/.tsx/.js/.jsx, .py, .json, .md
// Returns HTML string with <span class="hl-*"> tokens.
// ---------------------------------------------------------------------------

type HlToken = { cls: string; rx: RegExp };

const ESCAPE = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LANG_LABEL: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python',
  json: 'JSON', jsonc: 'JSON',
  md: 'Markdown', mdx: 'Markdown',
  css: 'CSS',
  sh: 'Shell', bash: 'Shell',
};

function langLabel(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_LABEL[ext] ?? 'Plain text';
}

// Language detection from extension
function detectLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'js';
  if (ext === 'py') return 'py';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (ext === 'md' || ext === 'mdx') return 'md';
  if (ext === 'css') return 'css';
  if (ext === 'sh' || ext === 'bash') return 'sh';
  return 'plain';
}

// Token rules per language family
const JS_TOKENS: HlToken[] = [
  { cls: 'hl-comment', rx: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g },
  { cls: 'hl-string',  rx: /(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g },
  { cls: 'hl-keyword', rx: /\b(import|export|from|type|interface|class|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|const|let|var|function|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|null|undefined|true|false|this|super|default|enum|namespace|abstract|declare|readonly|override|as|satisfies|keyof|infer)\b/g },
  { cls: 'hl-number',  rx: /\b(0x[\da-fA-F]+|\d+\.?\d*)\b/g },
  { cls: 'hl-builtin', rx: /\b(console|Promise|Array|Object|String|Number|Boolean|Map|Set|Error|JSON|Math|Date|RegExp|Symbol|BigInt|globalThis|process|require|module|exports)\b/g },
];

const PY_TOKENS: HlToken[] = [
  { cls: 'hl-comment', rx: /(#[^\n]*)/g },
  { cls: 'hl-string',  rx: /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g },
  { cls: 'hl-keyword', rx: /\b(import|from|as|class|def|return|if|elif|else|for|while|break|continue|pass|try|except|finally|raise|with|lambda|and|or|not|in|is|None|True|False|self|cls|global|nonlocal|yield|async|await|del|assert)\b/g },
  { cls: 'hl-number',  rx: /\b(\d+\.?\d*)\b/g },
];

const JSON_TOKENS: HlToken[] = [
  { cls: 'hl-string',  rx: /("(?:[^"\\]|\\.)*")/g },
  { cls: 'hl-number',  rx: /\b(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\b/g },
  { cls: 'hl-keyword', rx: /\b(true|false|null)\b/g },
];

const CSS_TOKENS: HlToken[] = [
  { cls: 'hl-comment', rx: /(\/\*[\s\S]*?\*\/)/g },
  { cls: 'hl-string',  rx: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g },
  { cls: 'hl-builtin', rx: /(#[0-9a-fA-F]{3,8}|var\(--[^)]+\))/g },
  { cls: 'hl-keyword', rx: /\b(import|@media|@keyframes|@font-face|@layer|@container|@supports)\b/g },
];

const SH_TOKENS: HlToken[] = [
  { cls: 'hl-comment', rx: /(#[^\n]*)/g },
  { cls: 'hl-string',  rx: /("(?:[^"\\]|\\.)*"|'[^']*')/g },
  { cls: 'hl-keyword', rx: /\b(if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|export|local|echo|cd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|source)\b/g },
];

const MD_TOKENS: HlToken[] = [
  { cls: 'hl-keyword', rx: /(^#{1,6} .+)/gm },
  { cls: 'hl-string',  rx: /(`[^`]+`)/g },
  { cls: 'hl-comment', rx: /(^\s*[-*+] )/gm },
  { cls: 'hl-builtin', rx: /(\[.+?\]\(.+?\))/g },
];

function tokensForLang(lang: string): HlToken[] {
  if (lang === 'js') return JS_TOKENS;
  if (lang === 'py') return PY_TOKENS;
  if (lang === 'json') return JSON_TOKENS;
  if (lang === 'css') return CSS_TOKENS;
  if (lang === 'sh') return SH_TOKENS;
  if (lang === 'md') return MD_TOKENS;
  return [];
}

interface Span { start: number; end: number; cls: string }

function highlight(code: string, lang: string): string {
  if (lang === 'plain') return ESCAPE(code);
  const tokens = tokensForLang(lang);
  if (tokens.length === 0) return ESCAPE(code);

  // Collect non-overlapping spans in source order.
  const spans: Span[] = [];
  const covered = new Uint8Array(code.length);

  for (const { cls, rx } of tokens) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(code)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      // Skip if any byte already covered (prevents string/comment overlap).
      let overlap = false;
      for (let i = s; i < e; i++) {
        if (covered[i]) { overlap = true; break; }
      }
      if (overlap) continue;
      spans.push({ start: s, end: e, cls });
      for (let i = s; i < e; i++) covered[i] = 1;
    }
  }

  spans.sort((a, b) => a.start - b.start);

  let out = '';
  let pos = 0;
  for (const sp of spans) {
    if (pos < sp.start) out += ESCAPE(code.slice(pos, sp.start));
    out += `<span class="${sp.cls}">${ESCAPE(code.slice(sp.start, sp.end))}</span>`;
    pos = sp.end;
  }
  if (pos < code.length) out += ESCAPE(code.slice(pos));
  return out;
}

// Line numbers + highlighted HTML for the content pane
function renderHighlighted(content: string, lang: string): string {
  const lines = content.split('\n');
  const rows = lines.map((line, i) => {
    const num = i + 1;
    return `<tr><td class="hl-lnum" data-ln="${num}"></td><td class="hl-code">${highlight(line, lang)}</td></tr>`;
  });
  return `<table class="hl-table"><tbody>${rows.join('')}</tbody></table>`;
}

function TreeNodes({
  entries,
  childrenByPath,
  expanded,
  loadingDirs,
  activePath,
  onToggleDir,
  onPickFile,
}: {
  entries: TreeEntry[];
  childrenByPath: Record<string, TreeEntry[]>;
  expanded: Set<string>;
  loadingDirs: Set<string>;
  activePath: string | null;
  onToggleDir: (path: string) => void;
  onPickFile: (path: string) => void;
}) {
  return (
    <>
      {entries.map(e => {
        if (e.type === 'dir') {
          const isOpen = expanded.has(e.path);
          const kids = childrenByPath[e.path];
          const isLoading = loadingDirs.has(e.path);
          return (
            <div key={e.path}>
              <div
                className={`tree-item folder${isOpen ? ' open' : ''}`}
                onClick={() => onToggleDir(e.path)}
                role="button"
                tabIndex={0}
              >
                <span className="tree-caret">▸</span>
                <svg className="tree-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 4.5a1 1 0 011-1h3l1.5 1.5h5.5a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
                <span className="tree-name">{e.name}</span>
                <span />
              </div>
              {isOpen && (
                <div className="tree-children">
                  {kids === undefined ? (
                    <div className="tree-item" style={{ color: 'var(--text-3)' }}>
                      <span /><span /><span className="tree-name">{isLoading ? 'Loading…' : ''}</span><span />
                    </div>
                  ) : kids.length === 0 ? (
                    <div className="tree-item" style={{ color: 'var(--text-3)' }}>
                      <span /><span /><span className="tree-name">empty</span><span />
                    </div>
                  ) : (
                    <TreeNodes
                      entries={kids}
                      childrenByPath={childrenByPath}
                      expanded={expanded}
                      loadingDirs={loadingDirs}
                      activePath={activePath}
                      onToggleDir={onToggleDir}
                      onPickFile={onPickFile}
                    />
                  )}
                </div>
              )}
            </div>
          );
        }
        const isActive = activePath === e.path;
        return (
          <div
            key={e.path}
            className={`tree-item${isActive ? ' active' : ''}`}
            onClick={() => onPickFile(e.path)}
            role="button"
            tabIndex={0}
          >
            <span />
            <svg className="tree-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 2h5l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            <span className="tree-name">{e.name}</span>
            <span />
          </div>
        );
      })}
    </>
  );
}

export function FilesView({
  workingTrees,
  workingTreeId,
  onPickWorkingTree,
  initialPath,
  initialMode,
}: {
  workingTrees: WorkingTree[];
  workingTreeId: string | null;
  onPickWorkingTree: (id: string) => void;
  /** When set (e.g. from "Open in new tab"), preview this file on mount. */
  initialPath?: string | null;
  /** Force the initial Tree/Changed tab. Updates whenever it changes (so an
   *  external "show changes" trigger from the Coding view can flip the tab). */
  initialMode?: ViewMode | null;
}) {
  const t = useT();
  const rail = useResizableWidth('files.rail.w', 280, 200, 480, 'left');
  const [mode, setMode] = useState<ViewMode>(initialMode ?? 'tree');

  // Lazy expandable tree: children are fetched per-folder on first expand.
  // The root listing lives under the empty-string key.
  const [treeChildren, setTreeChildren] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());

  const [changed, setChanged] = useState<ChangedEntry[]>([]);

  const [openFile, setOpenFile] = useState<{ path: string; content: string; size: number } | null>(null);
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const fileMetaCache = useRef<Map<string, FileMeta>>(new Map());
  const [diffText, setDiffText] = useState<string>('');
  const [previewPane, setPreviewPane] = useState<PreviewPane>('content');
  const [diffLoading, setDiffLoading] = useState(false);

  // Reset cached tree/changed state when the working tree changes — cached
  // children and status belong to the previously selected one.
  useEffect(() => {
    setTreeChildren({});
    setExpanded(new Set());
    setLoadingDirs(new Set());
    setChanged([]);
    setOpenFile(null);
    setDiffText('');
    fileMetaCache.current.clear();
  }, [workingTreeId]);

  // Load the root listing whenever the tree tab is shown for a working tree.
  useEffect(() => {
    if (mode !== 'tree' || !workingTreeId) return;
    if (treeChildren[''] !== undefined) return;
    void loadTree(workingTreeId, '').then(rows => {
      setTreeChildren(prev => ({ ...prev, '': rows }));
    });
  }, [workingTreeId, mode, treeChildren]);

  function toggleDir(path: string): void {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (workingTreeId && treeChildren[path] === undefined && !loadingDirs.has(path)) {
          setLoadingDirs(p => new Set(p).add(path));
          void loadTree(workingTreeId, path).then(rows => {
            setTreeChildren(prev2 => ({ ...prev2, [path]: rows }));
            setLoadingDirs(p => {
              const n = new Set(p);
              n.delete(path);
              return n;
            });
          });
        }
      }
      return next;
    });
  }

  useEffect(() => {
    if (mode === 'changed' && workingTreeId) {
      void loadChanged(workingTreeId).then(setChanged);
    }
  }, [workingTreeId, mode]);

  // External signal (from Coding view's diff button) — flip the tab.
  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);

  // "Open in new tab" entry: preview the requested file once the working tree
  // is known. Only fires when initialPath transitions to a non-empty value.
  useEffect(() => {
    if (!initialPath || !workingTreeId) return;
    void loadFile(workingTreeId, initialPath).then(f => {
      if (f) {
        setOpenFile({ path: initialPath, content: f.content, size: f.size });
        setPreviewPane('content');
      }
    });
  }, [initialPath, workingTreeId]);

  // Fetch file meta whenever the open file changes; cache by path to skip refetch
  useEffect(() => {
    if (!openFile || !workingTreeId) { setFileMeta(null); return; }
    const cached = fileMetaCache.current.get(openFile.path);
    if (cached) { setFileMeta(cached); return; }
    void loadFileMeta(workingTreeId, openFile.path).then(meta => {
      if (meta) fileMetaCache.current.set(openFile.path, meta);
      setFileMeta(meta);
    });
  }, [openFile?.path, workingTreeId]);

  if (!workingTreeId || workingTrees.length === 0) {
    return (
      <div className="session-pane-empty">
        <p>{t('files.workspace.empty')}</p>
      </div>
    );
  }

  function openFileContent(path: string): void {
    void loadFile(workingTreeId!, path).then(f => {
      if (f) {
        setOpenFile({ path, content: f.content, size: f.size });
        setDiffText('');
        setPreviewPane('content');
      }
    });
  }

  function pickChangedEntry(e: ChangedEntry): void {
    if (!workingTreeId) return;
    // Changed-list entries default to the diff pane (most likely intent).
    // Tree picks default to content (handled by openFileContent).
    setPreviewPane('diff');
    setDiffText('');
    setDiffLoading(true);
    void loadDiff(workingTreeId, e.path).then(d => {
      setDiffText(d);
      setDiffLoading(false);
    });
    if (e.kind !== 'delete') {
      void loadFile(workingTreeId, e.path).then(f => {
        if (f) setOpenFile({ path: e.path, content: f.content, size: f.size });
      });
    } else {
      setOpenFile({ path: e.path, content: '', size: 0 });
    }
  }

  function switchToPane(pane: PreviewPane): void {
    setPreviewPane(pane);
    if (pane === 'diff' && openFile && !diffText && workingTreeId) {
      setDiffLoading(true);
      void loadDiff(workingTreeId, openFile.path).then(d => {
        setDiffText(d);
        setDiffLoading(false);
      });
    }
  }

  // For browser-renderable types (html / pdf / images), point at the raw
  // file endpoint so the new tab actually previews it. For everything else,
  // fall back to the in-app Files view (syntax-highlighted).
  const openInNewTabHref = (() => {
    if (!openFile || !workingTreeId) return null;
    const ext = openFile.path.toLowerCase().split('.').pop() ?? '';
    const renderable = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
    if (renderable.has(ext)) {
      return `/api/working_trees/${encodeURIComponent(workingTreeId)}/raw?path=${encodeURIComponent(openFile.path)}`;
    }
    return `/?wt=${encodeURIComponent(workingTreeId)}&path=${encodeURIComponent(openFile.path)}&view=files`;
  })();

  const parsedDiff = diffText ? parseUnifiedDiff(diffText) : null;

  const lang = openFile ? detectLang(openFile.path) : 'plain';
  const hlHtml = openFile ? renderHighlighted(openFile.content, lang) : '';
  const lineCount = openFile ? openFile.content.split('\n').length : 0;
  const displayLang = openFile ? langLabel(openFile.path) : '';

  return (
    <div className="view" style={{ '--rail-w': `${rail.width}px` } as React.CSSProperties}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="sidebar-title">{t('files.title')}</span>
        </div>

        {(() => {
          // Cascading selectors: pick a workspace first, then a working tree
          // (the workspace's primary checkout, or one of its session worktrees).
          const currentWt = workingTrees.find(wt => wt.id === workingTreeId);
          const currentWsId = currentWt?.workspace_id ?? null;
          const uniqueWorkspaces = Array.from(
            workingTrees.reduce((acc, wt) => {
              if (!acc.has(wt.workspace_id)) acc.set(wt.workspace_id, wt.workspace_name);
              return acc;
            }, new Map<string, string>()).entries(),
          ).map(([id, name]) => ({ id, name }));
          const worktreesForWs = workingTrees.filter(wt => wt.workspace_id === currentWsId);
          return (
            <div className="files-ws-picker">
              <label className="files-fchip">
                <span className="rfc-lbl">Workspace</span>
                <select
                  value={currentWsId ?? ''}
                  onChange={e => onPickWorkingTree(`ws:${e.target.value}`)}
                  aria-label="Workspace"
                >
                  {uniqueWorkspaces.map(ws => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
                <span className="rfc-car">▾</span>
              </label>
              <label className="files-fchip">
                <span className="rfc-lbl">Worktree</span>
                <select
                  value={workingTreeId ?? ''}
                  onChange={e => onPickWorkingTree(e.target.value)}
                  aria-label="Working tree"
                >
                  {worktreesForWs.map(wt => {
                    const branch = wt.branch ? ` · ${wt.branch}` : '';
                    const label = wt.kind === 'workspace'
                      ? `${t('files.picker.primary')}${branch}`
                      : `${wt.label}${branch}`;
                    return <option key={wt.id} value={wt.id}>{label}</option>;
                  })}
                </select>
                <span className="rfc-car">▾</span>
              </label>
            </div>
          );
        })()}

        <div className="files-mode-toggle">
          <button
            className={`files-mode-btn${mode === 'changed' ? ' active' : ''}`}
            onClick={() => setMode('changed')}
          >
            {t('files.tab.changed')}
          </button>
          <button
            className={`files-mode-btn${mode === 'tree' ? ' active' : ''}`}
            onClick={() => setMode('tree')}
          >
            {t('files.tab.tree')}
          </button>
        </div>

        <div className="sidebar-scroll">
          {mode === 'tree' && (() => {
            const root = treeChildren[''];
            if (root === undefined) {
              return (
                <p style={{ padding: 'var(--sp-7)', color: 'var(--text-3)', fontSize: 'var(--fz-12)' }}>
                  Loading…
                </p>
              );
            }
            if (root.length === 0) {
              return (
                <p style={{ padding: 'var(--sp-7)', color: 'var(--text-3)', fontSize: 'var(--fz-12)' }}>
                  {t('files.tree.empty')}
                </p>
              );
            }
            return (
              <div className="tree">
                <TreeNodes
                  entries={root}
                  childrenByPath={treeChildren}
                  expanded={expanded}
                  loadingDirs={loadingDirs}
                  activePath={openFile?.path ?? null}
                  onToggleDir={toggleDir}
                  onPickFile={openFileContent}
                />
              </div>
            );
          })()}

          {mode === 'changed' && (
            <>
              {changed.length === 0 ? (
                <p style={{ padding: 'var(--sp-7)', color: 'var(--text-3)', fontSize: 'var(--fz-12)' }}>
                  {t('files.changed.empty')}
                </p>
              ) : (
                <>
                  {/* Summary header — file count + total +/- */}
                  {(() => {
                    let totalAdd = 0, totalDel = 0;
                    for (const e of changed) { totalAdd += e.added; totalDel += e.removed; }
                    return (
                      <div className="files-changed-summary">
                        <span className="fcs-count">{changed.length} file{changed.length === 1 ? '' : 's'}</span>
                        {totalAdd > 0 && <span className="fcs-add">+{totalAdd}</span>}
                        {totalDel > 0 && <span className="fcs-del">−{totalDel}</span>}
                      </div>
                    );
                  })()}
                  {changed.map(e => {
                    const badge = kindBadge(e.kind);
                    return (
                      <button
                        key={e.path}
                        className={`files-changed-row ${openFile?.path === e.path ? 'active' : ''}`}
                        onClick={() => pickChangedEntry(e)}
                        title={e.path}
                      >
                        <span className={`files-badge ${badge.cls}`}>{badge.label}</span>
                        <span className="fcr-path">{e.path}</span>
                        <span className="fcr-stat">
                          {e.added > 0 && <span className="add">+{e.added}</span>}
                          {e.removed > 0 && <span className="del">−{e.removed}</span>}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </aside>

      <RailSplitter onMouseDown={rail.onMouseDown} ariaLabel="Resize file list" />

      <main className="main">
        {openFile ? (
          <>
            <div className="main-head">
              <div className="main-head-l">
                <span className="main-title" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                  {openFile.path}
                </span>
                {fileMeta?.uncommitted && (
                  <span className="files-uncommitted-badge" title="Has uncommitted changes">
                    uncommitted
                  </span>
                )}
                <div className="files-pane-toggle">
                  <button
                    className={`files-pane-btn${previewPane === 'content' ? ' active' : ''}`}
                    onClick={() => switchToPane('content')}
                  >
                    Content
                  </button>
                  <button
                    className={`files-pane-btn${previewPane === 'diff' ? ' active' : ''}`}
                    onClick={() => switchToPane('diff')}
                  >
                    Diff
                  </button>
                </div>
              </div>
              <div className="main-head-r">
                {fileMeta !== null && fileMeta.edit_count_today > 0 && (
                  <span className="files-edit-count" title="File change events recorded today">
                    {fileMeta.edit_count_today} edit{fileMeta.edit_count_today === 1 ? '' : 's'} today
                  </span>
                )}
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
                  {lang !== 'plain' && <span className="files-lang-badge">{lang}</span>}
                  {openFile.size.toLocaleString()} bytes
                </span>
                {openInNewTabHref && (
                  <a
                    className="btn btn-ghost"
                    href={openInNewTabHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11, padding: '3px 8px', textDecoration: 'none' }}
                    title={t('files.openintab.title')}
                  >
                    ↗ {t('files.openintab.title')}
                  </a>
                )}
              </div>
            </div>

            <div className="file-meta">
              <span>{displayLang}</span>
              <span className="file-meta-sep">·</span>
              <span>{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>
              {fileMeta !== null && fileMeta.edit_count_today > 0 && (
                <>
                  <span className="file-meta-sep">·</span>
                  <span>{fileMeta.edit_count_today} {fileMeta.edit_count_today === 1 ? 'edit' : 'edits'} today</span>
                </>
              )}
              {fileMeta?.uncommitted && (
                <>
                  <span className="file-meta-sep">·</span>
                  <span className="file-meta-uncommitted">&#9679; uncommitted</span>
                </>
              )}
            </div>

            {previewPane === 'content' && (
              <div
                className="hl-wrap"
                // Safe: content is escaped inside renderHighlighted; only
                // <span class="hl-*"> and <table>/<tr>/<td> tags are injected.
                dangerouslySetInnerHTML={{ __html: hlHtml }}
              />
            )}

            {previewPane === 'diff' && (
              <div style={{ flex: 1, overflow: 'auto', background: 'var(--surface)' }}>
                {diffLoading && (
                  <p style={{ padding: 'var(--sp-8)', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    Loading diff…
                  </p>
                )}
                {!diffLoading && (!parsedDiff || parsedDiff.hunks.length === 0) && (
                  <p style={{ padding: 'var(--sp-8)', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    No uncommitted changes for this file.
                  </p>
                )}
                {!diffLoading && parsedDiff && parsedDiff.hunks.map((hunk, hi) => (
                  <div key={hi}>
                    <div className="files-hunk-header">{hunk.header}</div>
                    {hunk.lines.map((ln, li) => (
                      <div key={li} className={`files-diff-ln ${ln.kind}`}>
                        <span className="files-diff-sig">
                          {ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '}
                        </span>
                        <span className="files-diff-txt">{ln.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="files-preview-empty">
            <svg className="fpe-icon" viewBox="0 0 64 64" fill="none" aria-hidden="true">
              <path d="M14 12h22l14 14v26a2 2 0 01-2 2H14a2 2 0 01-2-2V14a2 2 0 012-2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <path d="M36 12v14h14" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <path d="M20 36h24M20 42h24M20 48h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
            </svg>
            <p className="fpe-title">{t('files.preview.empty')}</p>
            <p className="fpe-hint">
              <kbd>⌘K</kbd> to jump to a file
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
