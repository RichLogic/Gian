import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Workspace } from '@gian/shared';
import {
  loadAllFiles,
  loadApps,
  loadDiff,
  loadFile,
  type WorkingTree,
} from '../api.js';
import {
  IMAGE_EXTS,
  insertGroupPreviewTab,
  openCategoryFor,
  type FileViewMode,
  type RailId,
  type SheetGroup,
  type SheetOpenWith,
  type SheetTab,
} from '../components/sheet-model.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { buildFileRefIndex, makeFileLinkifyRehype } from '../transcript/linkify-files.js';
import { transcriptItemIdentity } from '../transcript/identity.js';
import type { DiffItem } from '../types.js';
import { longestRootMatch } from '../utils/paths.js';
import { resolveFilePanelRoute } from '../presentation/file-panel.js';
import { desktopBridge } from '../desktop-bridge.js';
import { readWtViewOverride, resolveViewedTreeId, writeWtViewOverride } from '../presentation/wt-view.js';
import type { ChatPanelRequest, ChatPanelTarget } from '../presentation/chat-panel.js';
import type { AppAuthStatus } from './use-app-auth.js';

let browserTabSequence = 0;
let terminalTabSequence = 0;

function createBrowserTab(existingCount: number): SheetTab {
  browserTabSequence += 1;
  return {
    id: `tab-browser-${Date.now()}-${browserTabSequence}`,
    group: 'browser',
    name: existingCount === 0 ? 'Browser' : `Browser #${existingCount + 1}`,
    kind: 'browser',
    icoKind: 'browser',
    ico: '◎',
  };
}

interface UseWorkbenchInput {
  authStatus: AppAuthStatus;
  /** Operation dispatcher (Phase 3b): `term.close` on Sheet tab close and
   *  `files.openExternal` for the "Open with…" menu. */
  dispatch: OperationDispatcher['dispatch'];
  sessions: Session[];
  activeSessionId: string | null;
  activeSession: Session | null;
  activeWorkspace: Workspace | null;
  workspaces: Workspace[];
  workingTrees: WorkingTree[];
  mode: string;
  activeSubtaskId: string | null;
  t(key: string): string;
}

export function useWorkbench({
  authStatus,
  dispatch,
  sessions,
  activeSessionId,
  activeSession,
  activeWorkspace,
  workspaces,
  workingTrees,
  mode,
  activeSubtaskId,
  t: appT,
}: UseWorkbenchInput) {
  const [wtView, setWtViewState] = useState<{ sessionId: string; wtId: string } | null>(null);
  /** Sets the view-level working-tree override AND persists it per session —
   *  an in-memory-only pick silently reverted to the primary checkout on
   *  reload (2026-08-06 user report). */
  const setWtView = useCallback((v: { sessionId: string; wtId: string } | null) => {
    setWtViewState(v);
    if (v) writeWtViewOverride(v.sessionId, v.wtId);
  }, []);
  const [apps, setApps] = useState<string[]>([]);
  const [wbTabs, setWbTabs] = useState<SheetTab[]>([]);
  const [activeTabByGroup, setActiveTabByGroup] =
    useState<Partial<Record<SheetGroup, string | null>>>({});
  const [viewState, setViewState] = useState<'main' | 'workbench' | 'both'>('main');
  const [activeRail, setActiveRail] = useState<RailId | null>(null);
  const [railMemory, setRailMemory] =
    useState<Partial<Record<RailId, { tabId: string | null }>>>({});
  const [p3Collapsed, setP3Collapsed] = useState(false);
  const [filesInspectorSuppressed, setFilesInspectorSuppressed] = useState(false);
  const [fileReveal, setFileReveal] = useState<{
    workingTreeId: string;
    path: string;
    requestId: number;
  } | null>(null);
  const fileRevealSeqRef = useRef(0);
  const [chatPanel, setChatPanel] = useState<ChatPanelTarget | null>(null);

  useEffect(() => {
    setChatPanel(null);
  }, [mode, activeSessionId, activeSubtaskId]);

  useEffect(() => {
    setFilesInspectorSuppressed(false);
    setFileReveal(null);
  }, [activeSessionId]);

  function defaultWorkingTreeIdFor(sess: Session | null): string | null {
    if (sess) {
      if (sess.worktree_path) return `wt:${sess.id}`;
      return `ws:${sess.workspace_id}`;
    }
    if (workspaces.length > 0) return `ws:${workspaces[0]!.id}`;
    return null;
  }

  // View-level working-tree override (breadcrumb picker): affects Diffs,
  // Files, file previews/mentions, and the breadcrumb label. Execution and
  // terminal cwd stay bound to the session's own tree. Keyed by session id so
  // a stale override never leaks across sessions; the in-memory pick wins,
  // then the persisted override, then the session default.
  function viewedWorkingTreeId(sess: Session | null): string | null {
    if (!sess) return defaultWorkingTreeIdFor(null);
    return resolveViewedTreeId({
      sessionId: sess.id,
      inMemory: wtView,
      stored: readWtViewOverride(sess.id),
      trees: workingTrees,
      defaultId: defaultWorkingTreeIdFor(sess),
    });
  }

  // Load the installed-apps list once for the Sheet "Open with…" menu.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadApps().then(setApps);
  }, [authStatus]);

  // Resolve a Sheet file tab's absolute path back to a (working tree, rel)
  // pair, then route it to the host's open endpoint. Falls back to the
  // `vscode://` handler for paths outside any known tree (mirrors
  // openFileInSheet's own fallback).
  // Dispatch a resolved open target for a known (wt, rel) — Phase 3b: the
  // files.openExternal pending operation (a launch failure toasts from the
  // definition). Built-in Browser navigation stays a local desktop-view
  // action; opening an OS application remains an operation.
  function dispatchOpen(wt: { id: string }, rel: string, target: SheetOpenWith): void {
    if (target.kind === 'editor') {
      dispatch('files.openExternal', { workingTreeId: wt.id, path: rel, target: { kind: 'editor', editorId: target.id } });
      return;
    }
    if (target.kind === 'app') {
      dispatch('files.openExternal', { workingTreeId: wt.id, path: rel, target: { kind: 'app', app: target.app } });
      return;
    }
    if (target.name === 'browser') {
      window.open(`/api/working_trees/${encodeURIComponent(wt.id)}/raw?path=${encodeURIComponent(rel)}`, '_blank', 'noopener');
      return;
    }
    if (target.name === 'gian-browser') {
      openProjectInBrowser(wt.id, rel);
      return;
    }
    dispatch('files.openExternal', { workingTreeId: wt.id, path: rel, target: { kind: 'builtin', builtin: target.name } }); // 'default' | 'finder' | 'terminal'
  }

  function handleOpenWith(tab: SheetTab, target: SheetOpenWith): void {
    const abs = tab.fullPath;
    if (!abs) return;
    // Authoritative: the tab's own working tree id. Fallback: the longest root
    // that actually contains `abs` (boundary-aware, longest wins) so a sibling
    // root can never shadow the real one.
    const wt = (tab.workingTreeId ? workingTrees.find(w => w.id === tab.workingTreeId) : undefined)
      ?? longestRootMatch(workingTrees, abs);
    if (!wt) {
      window.open(`vscode://file/${encodeURI(abs)}`, '_blank', 'noopener');
      return;
    }
    const rel = abs.slice(wt.path.replace(/\/+$/, '').length).replace(/^\/+/, '');
    dispatchOpen(wt, rel, target);
  }

  // File index for the active working tree — powers auto-linkification of file
  // mentions in transcript prose. Loaded once per working tree (the list is
  // stable enough within a session; created/deleted files refresh on switch).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [fileIndexAbs, setFileIndexAbs] = useState<{
    wtId: string;
    paths: ReadonlySet<string>;
    rehype: () => (tree: any) => void;
  } | null>(null);
  const fileIndexWtRef = useRef<string | null>(null);
  useEffect(() => {
    const wtId = viewedWorkingTreeId(activeSession);
    const wt = wtId ? workingTrees.find(w => w.id === wtId) : null;
    if (!wtId || !wt) { fileIndexWtRef.current = null; setFileIndexAbs(null); return; }
    if (fileIndexWtRef.current === wtId) return;
    fileIndexWtRef.current = wtId;
    const base = wt.path.replace(/\/+$/, '');
    let cancelled = false;
    void loadAllFiles(wtId).then(files => {
      if (cancelled || fileIndexWtRef.current !== wtId) return;
      const index = buildFileRefIndex(files, base);
      setFileIndexAbs({
        wtId,
        paths: new Set(files),
        rehype: makeFileLinkifyRehype(index, rel => `${base}/${rel}`),
      });
    });
    return () => { cancelled = true; };
  }, [activeSessionId, workingTrees, wtView]);
  const fileRehype = fileIndexAbs?.rehype ?? null;

  // ─── Sheet (Workbench) actions ──────────────────────────────────────────
  // V2's openFileInSheet from design/gian-design-v2/js/app.jsx: single-click
  // a file = preview tab (one at a time, italic name); double-click or pin =
  // permanent. Settings is singleton; Terminal and Browser are additive.

  // Force viewState back to 'main' when wbTabs goes empty.
  useEffect(() => {
    if (viewState !== 'main' && wbTabs.length === 0) {
      setViewState('main');
    }
  }, [viewState, wbTabs.length]);

  /** Create the singleton Changes multi-diff tab if the diffs group doesn't
   *  have one. Non-stealing: an already-active text detail tab keeps the
   *  foreground; the new tab is only selected when the group has no
   *  selection. */
  function ensureChangesTab(): void {
    if (wbTabs.some(t => t.group === 'diffs' && t.kind === 'changes')) {
      setViewState(v => v === 'main' ? 'both' : v);
      return;
    }
    const tab: SheetTab = {
      id: 'tab-changes',
      group: 'diffs',
      name: appT('inspector.changes'),
      kind: 'changes',
      icoKind: 'diff',
      ico: '±',
      preview: false,
    };
    setWbTabs(prev => prev.some(t => t.group === 'diffs' && t.kind === 'changes') ? prev : [...prev, tab]);
    setActiveTabByGroup(a => ({ ...a, diffs: a.diffs ?? tab.id }));
    setViewState(v => v === 'main' ? 'both' : v);
  }

  /** Diffs-rail entry (GitBadge, transcript "show changes" entries): opens
   *  the rail and puts the singleton Changes multi-diff tab in front,
   *  creating it on first use. The tab is a shell — its body reads the
   *  use-changes-diff store for the viewed working tree. */
  function showChangesDiff(): void {
    setChatPanel(null);
    setActiveRail('diffs');
    const existing = wbTabs.find(t => t.group === 'diffs' && t.kind === 'changes');
    if (existing) {
      revealSheetTab('diffs', existing.id);
      return;
    }
    const tab: SheetTab = {
      id: 'tab-changes',
      group: 'diffs',
      name: appT('inspector.changes'),
      kind: 'changes',
      icoKind: 'diff',
      ico: '±',
      preview: false,
    };
    setWbTabs(prev => prev.some(t => t.group === 'diffs' && t.kind === 'changes') ? prev : [...prev, tab]);
    revealSheetTab('diffs', tab.id);
  }

  // Auto-ensure the singleton Changes tab while the diffs rail is active with
  // a working tree — e.g. after the user closed it from a [Changes][text…]
  // strip. Without a working tree the rail keeps its ordinary empty state.
  useEffect(() => {
    if (activeRail !== 'diffs') return;
    if (!viewedWorkingTreeId(activeSession)) return;
    if (wbTabs.some(t => t.group === 'diffs' && t.kind === 'changes')) return;
    ensureChangesTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRail, wbTabs, activeSession, workingTrees]);

  const sheetActions = useMemo(() => {
    function syncFilesInspectorToTab(tab: SheetTab | undefined): void {
      if (tab?.group !== 'files' || tab.kind !== 'file') return;
      const currentWtId = viewedWorkingTreeId(activeSession);
      const locatable = !!tab.fileTreePath && tab.workingTreeId === currentWtId;
      setFilesInspectorSuppressed(!locatable);
      if (locatable && tab.fileTreePath && currentWtId) {
        setFileReveal({
          workingTreeId: currentWtId,
          path: tab.fileTreePath,
          requestId: ++fileRevealSeqRef.current,
        });
      } else {
        setFileReveal(null);
      }
    }

    return {
      activateTab: (id: string) => {
        const tab = wbTabs.find(t => t.id === id);
        if (!tab) return;
        syncFilesInspectorToTab(tab);
        setActiveTabByGroup(a => ({ ...a, [tab.group]: id }));
      },
      closeTab: (id: string) => {
        const tab = wbTabs.find(t => t.id === id);
        if (tab?.kind === 'term') {
          // Phase 3b: the PTY close dispatches the term.close operation; the
          // tab removal below stays local (tab close is policy `local`,
          // inventory §3).
          dispatch('term.close', { termId: id });
        }
        if (tab?.kind === 'browser') {
          void desktopBridge()?.browser?.closeTab(id);
        }
        if (tab?.group === 'files' && activeTabByGroup.files === id) {
          const sibling = wbTabs.find(t => t.group === 'files' && t.id !== id);
          if (sibling) syncFilesInspectorToTab(sibling);
          else {
            setFilesInspectorSuppressed(false);
            setFileReveal(null);
          }
        }
        setWbTabs(prev => {
          const closing = prev.find(t => t.id === id);
          const next = prev.filter(t => t.id !== id);
          if (closing) {
            setActiveTabByGroup(a => {
              if (a[closing.group] !== id) return a;
              const sib = next.find(t => t.group === closing.group);
              return { ...a, [closing.group]: sib ? sib.id : null };
            });
          }
          return next;
        });
      },
      pinTab: (id: string) =>
        setWbTabs(prev => prev.map(t => t.id === id ? { ...t, preview: false } : t)),
      setTabViewMode: (id: string, viewMode: FileViewMode) =>
        setWbTabs(prev => prev.map(t => t.id === id ? { ...t, viewMode } : t)),
      setTabName: (id: string, name: string) =>
        setWbTabs(prev => prev.map(t => (t.id === id && t.name !== name) ? { ...t, name } : t)),
    };
  }, [activeSession, activeTabByGroup.files, wbTabs, workspaces, dispatch]);

  /** Rail → Sheet group mapping. */
  const GROUP_OF_RAIL: Record<RailId, SheetGroup | null> = {
    files: 'files',
    diffs: 'diffs',
    history: 'history',
    terminal: 'term',
    browser: 'browser',
    workspaces: 'workspaces',
    settings: 'settings',
  };

  /** Activate a tab in its group and make sure the Sheet is visible. */
  function revealSheetTab(group: SheetGroup, id: string): void {
    setActiveTabByGroup(a => ({ ...a, [group]: id }));
    setViewState(v => v === 'main' ? 'both' : v);
  }

  /** Open a rail (no-op if already active). Lazily seeds the singleton
   *  content some rails need: the first terminal, the settings tab, the
   *  diffs rail's Changes multi-diff tab. */
  function activateRail(rail: RailId): void {
    setChatPanel(null);
    if (rail === 'files') setFilesInspectorSuppressed(false);
    setActiveRail(rail);
    if (rail === 'terminal' && !wbTabs.some(t => t.group === 'term')) {
      const id = 'tab-term-' + Date.now();
      const tab: SheetTab = { id, group: 'term', name: terminalTabName(), kind: 'term', icoKind: 'term', ico: '$' };
      setWbTabs(prev => [...prev, tab]);
      revealSheetTab('term', id);
      return;
    }
    if (rail === 'settings' && !wbTabs.some(t => t.group === 'settings')) {
      const tab: SheetTab = { id: 'tab-settings', group: 'settings', name: appT('sheet.tab.settings'), kind: 'settings', icoKind: 'gear', ico: '⚙' };
      setWbTabs(prev => [...prev, tab]);
      revealSheetTab('settings', tab.id);
      return;
    }
    if (rail === 'browser' && !wbTabs.some(t => t.group === 'browser')) {
      const tab = createBrowserTab(0);
      setWbTabs(prev => [...prev, tab]);
      revealSheetTab('browser', tab.id);
      return;
    }
    if (rail === 'diffs') {
      // Ensure the singleton Changes tab exists — but a plain rail activation
      // (dock click, railMemory restore) must NOT steal the active tab from
      // a text detail the user is reading; showChangesDiff() is the stealing
      // entry and is called explicitly by the show-changes flows.
      ensureChangesTab();
      return;
    }
    if (rail === 'history') {
      // History keeps panel 2 mounted even with zero commit tabs (the empty
      // state is designed, not absent) — make sure the workbench is visible.
      setViewState(v => v === 'main' ? 'both' : v);
      return;
    }
    const group = GROUP_OF_RAIL[rail];
    if (group && wbTabs.some(t => t.group === group)) {
      setViewState(v => v === 'main' ? 'both' : v);
    }
  }

  /** Dock click: re-clicking the active rail collapses its panels and
   *  snapshots the scene into railMemory; clicking a rail opens/restores it. */
  function toggleRail(rail: RailId): void {
    if (chatPanel) {
      setChatPanel(null);
      if (activeRail !== rail) activateRail(rail);
      else setViewState(v => v === 'main' ? 'both' : v);
      return;
    }
    if (activeRail === rail) {
      if (rail === 'files' && filesInspectorSuppressed) {
        setFilesInspectorSuppressed(false);
        setP3Collapsed(false);
        return;
      }
      const group = GROUP_OF_RAIL[rail];
      setRailMemory(m => ({ ...m, [rail]: { tabId: group ? (activeTabByGroup[group] ?? null) : null } }));
      setActiveRail(null);
      return;
    }
    const group = GROUP_OF_RAIL[rail];
    const snap = railMemory[rail];
    if (group && snap?.tabId && wbTabs.some(t => t.id === snap.tabId)) {
      setActiveTabByGroup(a => ({ ...a, [group]: snap.tabId! }));
    }
    activateRail(rail);
  }

  function fileToLines(content: string): Array<[string, string]> {
    return content.split('\n').map((line, i) => [String(i + 1), line]);
  }

  function extOf(name: string): SheetTab['icoKind'] {
    const m = name.match(/\.([a-z0-9]+)$/i);
    const ext = (m?.[1] ?? '').toLowerCase();
    if (ext === 'md' || ext === 'ts' || ext === 'tsx' || ext === 'json' || ext === 'css') return ext;
    return 'ts';
  }

  /** Insert a files-group tab with V2 preview semantics (single-click
   *  preview tab replaced in place; double-click/permanent promotes or
   *  stacks). */
  function insertFileTab(tabContent: Omit<SheetTab, 'id' | 'group' | 'preview'>, permanent: boolean, line?: number): void {
    setActiveRail('files');
    setWbTabs(prev => {
      const existingPrev = prev.find(t => t.group === 'files' && t.kind === 'file' && t.preview);
      let tabs = [...prev];
      // Replace preview tab in place.
      if (existingPrev) {
        if (permanent && existingPrev.fullPath === tabContent.fullPath) {
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...t, preview: false, scrollLine: line } : t);
          revealSheetTab('files', existingPrev.id);
          return tabs;
        }
        if (!permanent) {
          // Replace the preview tab's content WITHOUT spreading the old tab —
          // otherwise stale fields (e.g. an image tab's `rawSrc` or a text
          // tab's `lines`) leak into the new content and the body mis-renders.
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...tabContent, id: t.id, group: t.group, preview: true } : t);
          revealSheetTab('files', existingPrev.id);
          return tabs;
        }
        // Permanent open of a different file: drop preview tab.
        tabs = tabs.filter(t => t.id !== existingPrev.id);
      }
      const id = 'tab-' + Date.now();
      const tab: SheetTab = { id, group: 'files', ...tabContent, preview: !permanent };
      tabs.push(tab);
      revealSheetTab('files', id);
      return tabs;
    });
  }

  /** Which tab an async fill belongs to. File previews use kind + path;
   *  transcript text fills use the stable event tab id. This prevents late
   *  loads from clobbering the same path under another tab. */
  interface TabMatch {
    kind: 'file' | 'text';
    fullPath?: string;
    id?: string;
  }

  function tabMatches(t: SheetTab, match: TabMatch): boolean {
    if (t.kind !== match.kind || t.fullPath !== match.fullPath) return false;
    return !match.id || t.id === match.id;
  }

  /** Re-enter the loading state and re-run an async tab fill — the Sheet
   *  error body's retry affordance (proposal §4.5). */
  function retryTabLoad(match: TabMatch, fill: () => Promise<void>): void {
    setWbTabs(prev => prev.map(t => tabMatches(t, match) && t.loadError
      ? { ...t, loading: true, loadError: undefined, retryLoad: undefined }
      : t));
    void fill();
  }

  interface FileTabFill {
    wtId: string;
    rel: string;
    line?: number;
    icoKind: SheetTab['icoKind'];
    fullPath: string;
  }

  /** Async fill of a file tab created in the loading state: lines on
   *  success, an error state with retry on failure. Fills ONLY the tab this
   *  load belongs to (same kind + path, still loading — see TabMatch). */
  async function fillFileTab(fill: FileTabFill): Promise<void> {
    const match: TabMatch = { kind: 'file', fullPath: fill.fullPath };
    const file = await loadFile(fill.wtId, fill.rel);
    setWbTabs(prev => prev.map(t => {
      if (!tabMatches(t, match) || !t.loading) return t;
      if (file) {
        // Preview-capable files (md) open with the rendered view by default —
        // but a line jump forces source view so the target line is visible.
        const initialViewMode: FileViewMode = fill.line != null ? 'source' : fill.icoKind === 'md' ? 'preview' : 'source';
        return { ...t, loading: undefined, lines: fileToLines(file.content), viewMode: initialViewMode, scrollLine: fill.line, loadError: undefined };
      }
      return {
        ...t,
        loading: undefined,
        loadError: appT('sheet.loadFailed'),
        retryLoad: () => retryTabLoad(match, () => fillFileTab(fill)),
      };
    }));
  }

  /** Open a file in the Sheet workbench (Phase 3+ replacement for the old
   *  preview drawer). Files in the current Files index also reveal their tree
   *  row; hidden/other-tree/unknown files keep the inspector closed.
   *
   *  Query timing (Phase 3b, proposal §4.5): the tab is created and selected
   *  IMMEDIATELY with a loading body, then filled (or failed, with retry) —
   *  no silent wait for loadFile before the destination surface exists. */
  async function openFileInSheet(absPath: string, permanent: boolean = false, line?: number): Promise<void> {
    setChatPanel(null);
    const sess = activeSessionId
      ? sessions.find(s => s.id === activeSessionId) ?? null
      : null;
    const wtId = sess ? viewedWorkingTreeId(sess) : null;
    const currentWt = wtId ? workingTrees.find(t => t.id === wtId) ?? null : null;
    let currentFiles: ReadonlySet<string> = new Set();
    if (currentWt) {
      currentFiles = fileIndexAbs?.wtId === currentWt.id
        ? fileIndexAbs.paths
        : new Set(await loadAllFiles(currentWt.id));
    }
    let route = resolveFilePanelRoute(absPath, currentWt, workingTrees, currentFiles);
    // Agent turns commonly create a file after the transcript link index was
    // first loaded. A cached miss inside the current tree gets one fresh check
    // before we classify it as panel-only.
    if (
      currentWt
      && fileIndexAbs?.wtId === currentWt.id
      && route.sourceTree?.id === currentWt.id
      && !route.inCurrentFiles
    ) {
      const files = await loadAllFiles(currentWt.id);
      currentFiles = new Set(files);
      const base = currentWt.path.replace(/\/+$/, '');
      const index = buildFileRefIndex(files, base);
      setFileIndexAbs({
        wtId: currentWt.id,
        paths: currentFiles,
        rehype: makeFileLinkifyRehype(index, fileRel => `${base}/${fileRel}`),
      });
      route = resolveFilePanelRoute(absPath, currentWt, workingTrees, currentFiles);
    }
    const wt = route.sourceTree;
    const rel = route.sourceRel;
    const name = (rel ?? absPath).split('/').pop() || absPath;
    const fullPath = wt && rel
      ? `${wt.path.replace(/\/+$/, '')}/${rel}`
      : absPath;
    const icoKind = extOf(name);
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    const rawUrl = wt && rel
      ? `/api/working_trees/${encodeURIComponent(wt.id)}/raw?path=${encodeURIComponent(rel)}`
      : null;
    const isImage = IMAGE_EXTS.has(ext);

    setFilesInspectorSuppressed(!route.inCurrentFiles);
    if (route.inCurrentFiles && currentWt && route.revealRel) {
      setP3Collapsed(false);
      setFileReveal({
        workingTreeId: currentWt.id,
        path: route.revealRel,
        requestId: ++fileRevealSeqRef.current,
      });
    } else {
      setFileReveal(null);
    }

    // Try to promote existing tab. Re-set scrollLine so a fresh click on a
    // file-link (possibly a different line) re-jumps in the already-open tab.
    const existingPerm = wbTabs.find(t => t.group === 'files' && t.kind === 'file' && t.fullPath === fullPath && !t.preview);
    if (existingPerm) {
      setWbTabs(prev => prev.map(t => t.id === existingPerm.id ? {
        ...t,
        scrollLine: line,
        fileTreePath: route.revealRel ?? undefined,
      } : t));
      setActiveRail('files');
      revealSheetTab('files', existingPerm.id);
      return;
    }

    // Images render straight from `/raw` via an <img> (no text load); binary
    // targets get the notice. Both are synchronous — no loading phase.
    if (!wt || !rel || openCategoryFor(name) === 'pdf') {
      insertFileTab({
        name,
        kind: 'file' as const,
        icoKind,
        ico: '',
        fullPath,
        fileTreePath: route.revealRel ?? undefined,
        workingTreeId: wt?.id,
        loadError: appT('sheet.binary.notice'),
      }, permanent, line);
      return;
    }
    if (isImage && rawUrl) {
      insertFileTab({
        name,
        kind: 'file' as const,
        icoKind: 'img' as const,
        ico: '',
        rawSrc: rawUrl,
        fullPath,
        fileTreePath: route.revealRel ?? undefined,
        workingTreeId: wt.id,
      }, permanent, line);
      return;
    }

    // Text file: create the tab NOW with a loading body, then fill it.
    insertFileTab({
      name,
      kind: 'file' as const,
      icoKind,
      ico: '',
      fullPath,
      fileTreePath: route.revealRel ?? undefined,
      workingTreeId: wt.id,
      loading: true,
    }, permanent, line);
    void fillFileTab({ wtId: wt.id, rel, line, icoKind, fullPath });
  }

  /** Click-time fallback for relative-path markdown links that the render-time
   *  linkify pass did not resolve (the file was created after the once-loaded
   *  index, or the index never loaded). Resolves the href against the active
   *  session's working tree and opens it in the Sheet; `openFileInSheet`
   *  re-checks the tree with a fresh file list, so a file that exists on disk
   *  now opens even though the render-time index missed it. Absolute hrefs
   *  (rare in markdown) go straight through. */
  function openRelativeFileHref(href: string): void {
    let decoded: string;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      decoded = href;
    }
    if (!decoded || decoded.startsWith('#')) return;
    // Same trailing `:N` line-suffix convention as linkify's refFromHref.
    const m = decoded.match(/^(.*?)(?::(\d+))?$/);
    const rel = (m?.[1] ?? decoded).replace(/^\.\//, '');
    if (!rel) return;
    const line = m?.[2] ? Number(m[2]) : undefined;
    let abs = rel;
    if (!rel.startsWith('/')) {
      const wtId = viewedWorkingTreeId(activeSession);
      const base = (wtId ? workingTrees.find(w => w.id === wtId)?.path : null)
        ?? activeWorkspace?.path
        ?? workspaces[0]?.path;
      if (!base) return;
      abs = `${base.replace(/\/+$/, '')}/${rel}`;
    }
    void openFileInSheet(abs, false, line);
  }

  /** Async fill of a transcript diff tab. Files whose event carried no hunks
   *  load their text from the working tree; when every needed load failed,
   *  the tab lands in the error state with retry. The assembled unified diff
   *  renders as a mono text body — panel-2 diff REVIEW lives in the singleton
   *  Changes multi-diff view; these tabs are ad-hoc event payloads. */
  async function fillTranscriptDiffTab(tabId: string, item: DiffItem, wtId: string, match: TabMatch): Promise<void> {
    const chunks = await Promise.all(item.files.map(async file => {
      if (file.hunks.length === 0) {
        const result = await loadDiff(wtId, file.path, 'all').catch(() => null);
        return { text: result?.diff ?? null, failed: result === null };
      }
      return {
        failed: false,
        text: [
          `diff --git a/${file.path} b/${file.path}`,
          `--- a/${file.path}`,
          `+++ b/${file.path}`,
          ...file.hunks.flatMap(hunk => [
            hunk.header,
            ...hunk.lines.map(line =>
              `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`),
          ]),
        ].join('\n'),
      } as { text: string | null; failed: boolean };
    }));
    const diffText = chunks.map(chunk => chunk.text).filter(Boolean).join('\n');
    const failed = chunks.some(chunk => chunk.failed);
    setWbTabs(prev => prev.map(t => {
      if (t.id !== tabId || !t.loading) return t;
      if (failed && !diffText) {
        return {
          ...t,
          loading: undefined,
          loadError: appT('sheet.loadFailed'),
          retryLoad: () => retryTabLoad(match, () => fillTranscriptDiffTab(tabId, item, wtId, match)),
        };
      }
      return { ...t, loading: undefined, text: diffText, loadError: undefined };
    }));
  }

  /** Route a transcript diff to the Diffs rail as a preview text tab holding
   *  the assembled unified diff. Native file_change events may contain full
   *  hunks or only changed paths; load missing text from the working tree so
   *  both shapes land in the same viewer.
   *
   *  Query timing (Phase 3b, proposal §4.5): the tab is created and selected
   *  IMMEDIATELY with a loading body, then filled (or failed, with retry). */
  async function openTranscriptDiffInSheet(item: DiffItem): Promise<void> {
    setChatPanel(null);
    const sess = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt || item.files.length === 0) return;

    const single = item.files.length === 1 ? item.files[0]! : null;
    const fullPath = single ? `${wt.path}/${single.path}` : undefined;
    const name = single
      ? single.path.split('/').pop() || single.path
      : `${item.files.length} files`;

    setActiveRail('diffs');
    const id = `tab-diff-event-${activeSessionId ?? 'global'}-${transcriptItemIdentity(item)}`;
    setWbTabs(prev => {
      const existing = prev.find(tab => tab.id === id);
      if (existing) {
        revealSheetTab('diffs', id);
        return prev;
      }
      const tab: SheetTab = {
        id,
        group: 'diffs',
        name,
        kind: 'text',
        textDiff: true,
        icoKind: 'diff',
        ico: '±',
        fullPath,
        workingTreeId: wt.id,
        sessionId: activeSessionId ?? undefined,
        preview: true,
        loading: true,
      };
      revealSheetTab('diffs', id);
      // Preview replacement spans every 'diffs'-group preview tab (transcript
      // diff or level-3 text detail): one preview tab at a time. The
      // singleton Changes tab is never preview, so it always survives.
      return insertGroupPreviewTab(prev, 'diffs', tab);
    });
    void fillTranscriptDiffTab(id, item, wt.id, { kind: 'text', fullPath, id });
  }

  /** Open a commit's change-set review in the Sheet workbench (History rail).
   *  History is a SINGLETON group: at most one commit tab exists — clicking
   *  another commit reuses that tab and replaces its identity in place (stale
   *  fields must not leak into the new commit), so the tab strip is hidden.
   *  Tab identity is {workingTreeId, full sha} — the short sha is only ever a
   *  label (git-history proposal §5). */
  function openCommitInSheet(input: { workingTreeId: string; sha: string; subject?: string }): void {
    setChatPanel(null);
    setActiveRail('history');
    const name = input.subject ? `${input.sha.slice(0, 7)} · ${input.subject}` : input.sha.slice(0, 7);
    setWbTabs(prev => {
      const existing = prev.find(t => t.group === 'history' && t.kind === 'commit');
      if (existing) {
        if (existing.commitSha === input.sha && existing.workingTreeId === input.workingTreeId) {
          revealSheetTab('history', existing.id);
          return prev;
        }
        const tabs = prev.map(t => t.id === existing.id
          ? { ...t, commitSha: input.sha, workingTreeId: input.workingTreeId, name, orphaned: undefined, preview: false }
          : t);
        revealSheetTab('history', existing.id);
        return tabs;
      }
      const id = 'tab-commit-' + Date.now();
      const tab: SheetTab = {
        id,
        group: 'history',
        name,
        kind: 'commit',
        icoKind: 'commit',
        ico: '●',
        preview: false,
        commitSha: input.sha,
        workingTreeId: input.workingTreeId,
      };
      revealSheetTab('history', id);
      return [...prev, tab];
    });
  }

  /** Mark history tabs whose commit is no longer reachable after a fetch
   *  (or clear the flag when it is). Called by App when a fetch reports
   *  refsChanged for the tab's tree. */
  function revalidateHistoryTabs(
    workingTreeId: string,
    unreachable: (sha: string) => boolean | undefined,
  ): void {
    setWbTabs(prev => prev.map(t =>
      t.group === 'history' && t.kind === 'commit' && t.workingTreeId === workingTreeId
        ? (() => {
            if (!t.commitSha) return t;
            const next = unreachable(t.commitSha);
            return next === undefined ? t : { ...t, orphaned: next };
          })()
        : t));
  }

  function openChatPanel(
    sessionId: string,
    request: ChatPanelRequest,
  ): void {
    setChatPanel({ ...request, sessionId });
    setViewState(v => v === 'workbench' ? 'both' : v);
  }

  /** Add a new terminal tab to the terminal group. Called by the `+` button
   *  at the right end of the terminal tabs strip. Always additive, and
   *  surfaces the terminal rail (un-collapsing it if needed). */
  function addTerminalTab(): void {
    terminalTabSequence += 1;
    const existingTerms = wbTabs.filter(t => t.kind === 'term').length;
    const id = `tab-term-${Date.now()}-${terminalTabSequence}`;
    const base = terminalTabName();
    const name = existingTerms === 0 ? base : `${base} #${existingTerms + 1}`;
    const tab: SheetTab = { id, group: 'term', name, kind: 'term', icoKind: 'term', ico: '$' };
    setActiveRail('terminal');
    setWbTabs(prev => [...prev, tab]);
    revealSheetTab('term', id);
  }

  /** Add an independent native Browser tab with its own WebContentsView and
   * navigation history, parallel to Terminal's additive tab behavior. */
  function addBrowserTab(): void {
    const tab = createBrowserTab(wbTabs.filter(item => item.kind === 'browser').length);
    setActiveRail('browser');
    setWbTabs(prev => [...prev, tab]);
    revealSheetTab('browser', tab.id);
  }

  /**
   * Compute a tab label for a new terminal. Picks the most-specific
   * known cwd (worktree path → workspace path → first workspace) and
   * shows its basename, falling back to the shell name when nothing is
   * known. Stays parallel to the actual cwd we send to the server in
   * the `term:spawn` payload below.
   */
  function terminalTabName(): string {
    const wtId = defaultWorkingTreeIdFor(activeSession);
    const wtPath = wtId ? workingTrees.find(w => w.id === wtId)?.path : null;
    const cwd = wtPath ?? activeWorkspace?.path ?? workspaces[0]?.path ?? null;
    if (!cwd) return 'zsh';
    // Tilde-collapse $HOME for prettier display (heuristic — server is
    // the authority on the actual env, but for the tab label this is
    // a reasonable best-effort).
    const home = '/Users/';
    const idx = cwd.indexOf(home);
    const display = idx === 0
      ? cwd.replace(/^\/Users\/[^/]+/, '~')
      : cwd;
    const seg = display.split('/').filter(Boolean).pop() ?? display;
    return `zsh · ${seg}`;
  }

  /** Open a workspace's detail as a Workbench tab (zone 3). The list lives in
   *  the Inspector (zone 4); clicking a row replaces the group's single detail
   *  tab here (singleton — no stacking). */
  function openWorkspaceInSheet(wsId: string): void {
    const ws = workspaces.find(w => w.id === wsId);
    if (!ws) return;
    setActiveRail('workspaces');
    const tab: SheetTab = { id: `tab-ws-${wsId}`, group: 'workspaces', name: ws.name, kind: 'workspace', icoKind: 'grid', ico: '▣', wsId };
    setWbTabs(prev => [...prev.filter(t => t.group !== 'workspaces'), tab]);
    revealSheetTab('workspaces', tab.id);
  }

  /** Open the "new workspace" form as a Workbench tab (singleton in the
   *  workspaces group) instead of jumping to the now-hidden `spaces` mode. */
  function openNewWorkspaceInSheet(): void {
    setActiveRail('workspaces');
    const tab: SheetTab = { id: 'tab-new-workspace', group: 'workspaces', name: 'New workspace', kind: 'new-workspace', icoKind: 'grid', ico: '+' };
    setWbTabs(prev => [...prev.filter(t => t.group !== 'workspaces'), tab]);
    revealSheetTab('workspaces', tab.id);
  }

  /** Open one full static site in the desktop Browser. The HTML file's
   * directory becomes that site's isolated gian-browser origin root. */
  function openProjectInBrowser(workingTreeId: string, path: string): void {
    const browser = desktopBridge()?.browser;
    if (!browser) {
      window.open(`/api/working_trees/${encodeURIComponent(workingTreeId)}/raw?path=${encodeURIComponent(path)}`, '_blank', 'noopener');
      return;
    }
    const selected = activeTabByGroup.browser
      ? wbTabs.find(tab => tab.id === activeTabByGroup.browser && tab.kind === 'browser')
      : undefined;
    const tab = selected ?? createBrowserTab(wbTabs.filter(item => item.kind === 'browser').length);
    if (!selected) {
      setWbTabs(prev => [...prev, tab]);
      revealSheetTab('browser', tab.id);
      setActiveRail('browser');
    } else {
      activateRail('browser');
    }
    void browser.openProject(tab.id, { workingTreeId, path });
  }

  return {
    wtView,
    setWtView,
    apps,
    wbTabs,
    setWbTabs,
    activeTabByGroup,
    setActiveTabByGroup,
    viewState,
    setViewState,
    activeRail,
    setActiveRail,
    p3Collapsed,
    setP3Collapsed,
    filesInspectorSuppressed,
    fileReveal,
    chatPanel,
    setChatPanel,
    fileRehype,
    sheetActions,
    GROUP_OF_RAIL,
    defaultWorkingTreeIdFor,
    viewedWorkingTreeId,
    handleOpenWith,
    revealSheetTab,
    activateRail,
    toggleRail,
    openFileInSheet,
    openRelativeFileHref,
    showChangesDiff,
    openTranscriptDiffInSheet,
    openCommitInSheet,
    revalidateHistoryTabs,
    openChatPanel,
    addTerminalTab,
    addBrowserTab,
    openWorkspaceInSheet,
    openNewWorkspaceInSheet,
    openProjectInBrowser,
  };
}
