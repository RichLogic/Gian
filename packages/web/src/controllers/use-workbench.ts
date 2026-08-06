import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Workspace } from '@gian/shared';
import {
  loadAllFiles,
  loadApps,
  loadDiff,
  loadFile,
  openFileBuiltin,
  openFileWith,
  openFileWithApp,
  type ChangeScope,
  type WorkingTree,
} from '../api.js';
import {
  IMAGE_EXTS,
  openCategoryFor,
  type FileViewMode,
  type RailId,
  type SheetGroup,
  type SheetOpenWith,
  type SheetTab,
} from '../components/sheet-model.js';
import { buildFileRefIndex, makeFileLinkifyRehype } from '../transcript/linkify-files.js';
import type { DiffItem } from '../types.js';
import { longestRootMatch } from '../utils/paths.js';
import { resolveFilePanelRoute } from '../presentation/file-panel.js';
import type { ChatPanelRequest, ChatPanelTarget } from '../presentation/chat-panel.js';
import type { GianWs } from '../ws.js';
import type { AppAuthStatus } from './use-app-auth.js';

interface UseWorkbenchInput {
  authStatus: AppAuthStatus;
  ws: GianWs;
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
  ws,
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
  const [wtView, setWtView] = useState<{ sessionId: string; wtId: string } | null>(null);
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

  // View-level working-tree override (breadcrumb branch picker): affects only
  // what the Diffs/Files rails, the diff sheet, and the breadcrumb label show.
  // Execution cwd, terminal cwd, and file-mention stay bound to the session's
  // own worktree. Keyed by session id so a stale override never leaks across
  // sessions.
  function viewedWorkingTreeId(sess: Session | null): string | null {
    if (sess && wtView && wtView.sessionId === sess.id) return wtView.wtId;
    return defaultWorkingTreeIdFor(sess);
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
  // Dispatch a resolved open target for a known (wt, rel).
  function dispatchOpen(wt: { id: string }, rel: string, target: SheetOpenWith): void {
    if (target.kind === 'editor') { void openFileWith(wt.id, rel, target.id); return; }
    if (target.kind === 'app') { void openFileWithApp(wt.id, rel, target.app); return; }
    if (target.name === 'browser') {
      window.open(`/api/working_trees/${encodeURIComponent(wt.id)}/raw?path=${encodeURIComponent(rel)}`, '_blank', 'noopener');
      return;
    }
    void openFileBuiltin(wt.id, rel, target.name); // 'default' | 'finder' | 'terminal'
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
    const wtId = defaultWorkingTreeIdFor(activeSession);
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
  }, [activeSessionId, workingTrees]);
  const fileRehype = fileIndexAbs?.rehype ?? null;

  // ─── Sheet (Workbench) actions ──────────────────────────────────────────
  // V2's openFileInSheet from design/gian-design-v2/js/app.jsx: single-click
  // a file = preview tab (one at a time, italic name); double-click or pin =
  // permanent. Settings/Terminal are singleton tabs.

  // Force viewState back to 'main' when wbTabs goes empty.
  useEffect(() => {
    if (viewState !== 'main' && wbTabs.length === 0) {
      setViewState('main');
    }
  }, [viewState, wbTabs.length]);

  const sheetActions = useMemo(() => {
    function syncFilesInspectorToTab(tab: SheetTab | undefined): void {
      if (tab?.group !== 'files' || tab.kind !== 'file') return;
      const currentWtId = defaultWorkingTreeIdFor(activeSession);
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
          ws.send({ type: 'term:close', term_id: id });
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
  }, [activeSession, activeTabByGroup.files, wbTabs, workspaces, ws]);

  /** Rail → Sheet group mapping. */
  const GROUP_OF_RAIL: Record<RailId, SheetGroup | null> = {
    files: 'files',
    diffs: 'diffs',
    terminal: 'term',
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
   *  diffs rail's flat all-files diff. */
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

  /** Open a file in the Sheet workbench (Phase 3+ replacement for the old
   *  preview drawer). Files in the current Files index also reveal their tree
   *  row; hidden/other-tree/unknown files keep the inspector closed. */
  async function openFileInSheet(absPath: string, permanent: boolean = false, line?: number): Promise<void> {
    setChatPanel(null);
    const sess = activeSessionId
      ? sessions.find(s => s.id === activeSessionId) ?? null
      : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
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
    const fullPath = absPath;
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

    // Images render straight from `/raw` via an <img> (no text load); everything
    // else loads its source lines.
    let tabContent;
    if (!wt || !rel || openCategoryFor(name) === 'pdf') {
      tabContent = {
        name,
        kind: 'file' as const,
        icoKind,
        ico: '',
        fullPath,
        fileTreePath: route.revealRel ?? undefined,
        workingTreeId: wt?.id,
        loadError: appT('sheet.binary.notice'),
      };
    } else if (isImage && rawUrl) {
      tabContent = {
        name,
        kind: 'file' as const,
        icoKind: 'img' as const,
        ico: '',
        rawSrc: rawUrl,
        fullPath,
        fileTreePath: route.revealRel ?? undefined,
        workingTreeId: wt.id,
      };
    } else {
      const file = await loadFile(wt.id, rel);
      // Preview-capable files (md) open with the rendered view by default —
      // but a line jump forces source view so the target line is visible.
      const initialViewMode: FileViewMode = line != null ? 'source' : icoKind === 'md' ? 'preview' : 'source';
      tabContent = {
        name,
        kind: 'file' as const,
        icoKind,
        ico: '',
        lines: file ? fileToLines(file.content) : undefined,
        viewMode: initialViewMode,
        fullPath,
        scrollLine: line,
        fileTreePath: route.revealRel ?? undefined,
        workingTreeId: wt.id,
        loadError: file ? undefined : appT('sheet.binary.notice'),
      };
    }

    setActiveRail('files');
    setWbTabs(prev => {
      const existingPrev = prev.find(t => t.group === 'files' && t.kind === 'file' && t.preview);
      let tabs = [...prev];
      // Replace preview tab in place.
      if (existingPrev) {
        if (permanent && existingPrev.fullPath === fullPath) {
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

  /** Open a unified diff for a changed file in the Sheet workbench. The
   *  Changes inspector routes row clicks here so the diff lands in the
   *  workbench (full width) rather than crammed into the narrow inspector. */
  async function openDiffInSheet(rel: string, permanent: boolean = false, scope: ChangeScope = 'all', sha?: string | null, base?: string | null): Promise<void> {
    setChatPanel(null);
    const sess = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null;
    // Follows the view-level override (branch picker) — the diff sheet shows
    // the tree the user is LOOKING at.
    const wtId = sess ? viewedWorkingTreeId(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt) return;
    const name = rel.split('/').pop() || rel;
    const fullPath = `${wt.path}/${rel}`;
    const diffText = await loadDiff(wt.id, rel, scope, sha, base);

    setActiveRail('diffs');
    setWbTabs(prev => {
      let tabs = [...prev];
      // If a non-permanent diff preview tab is already open, replace it in place.
      const existingPreview = tabs.find(t => t.group === 'diffs' && t.kind === 'diff' && t.preview);
      if (existingPreview) {
        tabs = tabs.filter(t => t.id !== existingPreview.id);
      }
      // Promote: if a permanent diff tab for this exact path exists, just activate.
      const existingPerm = tabs.find(t => t.group === 'diffs' && t.kind === 'diff' && t.fullPath === fullPath && !t.preview);
      if (existingPerm) {
        revealSheetTab('diffs', existingPerm.id);
        return tabs;
      }
      const id = 'tab-diff-' + Date.now();
      const tab: SheetTab = {
        id,
        group: 'diffs',
        name,
        kind: 'diff',
        icoKind: 'diff',
        ico: '±',
        diffText,
        fullPath,
        workingTreeId: wt.id,
        preview: !permanent,
      };
      tabs.push(tab);
      revealSheetTab('diffs', id);
      return tabs;
    });
  }

  /** Route a transcript diff to the Diffs rail. Native file_change events may
   *  contain full hunks or only changed paths; load missing text from the
   *  working tree so both shapes land in the same diff viewer. */
  async function openTranscriptDiffInSheet(item: DiffItem): Promise<void> {
    setChatPanel(null);
    const sess = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt || item.files.length === 0) return;

    const chunks = await Promise.all(item.files.map(async file => {
      if (file.hunks.length === 0) return loadDiff(wt.id, file.path, 'all');
      return [
        `diff --git a/${file.path} b/${file.path}`,
        `--- a/${file.path}`,
        `+++ b/${file.path}`,
        ...file.hunks.flatMap(hunk => [
          hunk.header,
          ...hunk.lines.map(line =>
            `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`),
        ]),
      ].join('\n');
    }));
    const diffText = chunks.filter(Boolean).join('\n');
    const single = item.files.length === 1 ? item.files[0]! : null;
    const fullPath = single ? `${wt.path}/${single.path}` : undefined;
    const name = single
      ? single.path.split('/').pop() || single.path
      : `${item.files.length} files`;

    setActiveRail('diffs');
    setWbTabs(prev => {
      const preview = prev.find(tab =>
        tab.group === 'diffs' && tab.kind === 'diff' && tab.preview);
      const tabs = preview ? prev.filter(tab => tab.id !== preview.id) : [...prev];
      const id = `tab-diff-event-${item.id}`;
      const tab: SheetTab = {
        id,
        group: 'diffs',
        name,
        kind: 'diff',
        icoKind: 'diff',
        ico: '±',
        diffText,
        fullPath,
        workingTreeId: wt.id,
        preview: true,
      };
      revealSheetTab('diffs', id);
      return [...tabs, tab];
    });
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
    setActiveRail('terminal');
    setWbTabs(prev => {
      const existingTerms = prev.filter(t => t.kind === 'term').length;
      const id = 'tab-term-' + Date.now();
      const base = terminalTabName();
      const name = existingTerms === 0 ? base : `${base} #${existingTerms + 1}`;
      const tab: SheetTab = { id, group: 'term', name, kind: 'term', icoKind: 'term', ico: '$' };
      revealSheetTab('term', id);
      return [...prev, tab];
    });
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
    openDiffInSheet,
    openTranscriptDiffInSheet,
    openChatPanel,
    addTerminalTab,
    openWorkspaceInSheet,
    openNewWorkspaceInSheet,
  };
}
