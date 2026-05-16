import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalCategory, ApprovalStatus, Bot, EventEnvelope, RunnerInfo, ServerToClientMessage, Session, Workspace } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import { makeWsUrl, loadWorkspaces, loadSessions, loadEvents, loadSettings, loadWorkingTrees, loadBots, loadFile, loadDiff, fetchWsToken } from './api.js';
import type { WorkingTree } from './api.js';
import { applyEnvelope, parseTokenUsage } from './transcript/apply.js';
import { DiffOpenContext, FileLinkOpenContext, PlanOpenContext } from './transcript/items.js';
import { Topbar } from './components/Topbar.js';
import type { Mode, ViewState } from './components/Topbar.js';
import type { PathSegment, SessionMenuActions } from './components/PathBreadcrumb.js';
import { Dock } from './components/Dock.js';
import { Sheet } from './components/Sheet.js';
import type { SheetTab, FileViewMode } from './components/Sheet.js';
import { Splitter } from './components/Splitter.js';
import { Inspector } from './components/Inspector.js';
import type { InspectorTab } from './components/Inspector.js';
import { SettingsBody } from './components/SettingsBody.js';
import { Terminal, makeWorkbenchWire } from './components/Terminal.js';
import { CodingView } from './views/CodingView.js';
import { SpacesView } from './views/SpacesView.js';
import { BotsView } from './views/BotsView.js';
import { CommandPalette } from './components/CommandPalette.js';
import type { SystemConfig } from '@gian/shared';
import type { QueueEntry, TokenUsage, TranscriptItem } from './types.js';

export interface PendingApproval {
  id: string;
  session_id: string;
  category: ApprovalCategory;
  description: string;
  status: ApprovalStatus;
}

export function App() {
  // The token getter runs every reconnect. With Auth dropped in Phase 1, this
  // always returns 'dev-token' (the WS handler accepts any non-empty token in
  // unauthenticated mode).
  const ws = useMemo(
    () => new GianWs(makeWsUrl(), async () => (await fetchWsToken()) ?? ''),
    [],
  );
  const [wsState, setWsState] = useState<WsState>('closed');
  const [wsAttempt, setWsAttempt] = useState(0);
  const [authed, setAuthed] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
  const [usageBySession, setUsageBySession] = useState<Record<string, TokenUsage>>({});
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueEntry[]>>({});
  const [mode, setMode] = useState<Mode>('sessions');
  const [workingTrees, setWorkingTrees] = useState<WorkingTree[]>([]);
  // ─── V2 Workbench (Sheet) state ─────────────────────────────────────────
  const [wbTabs, setWbTabs] = useState<SheetTab[]>([]);
  const [wbActive, setWbActive] = useState<{ 0: string | null; 1: string | null }>({ 0: null, 1: null });
  const [viewState, setViewState] = useState<ViewState>('main');
  // ─── V2 Inspector state ─────────────────────────────────────────────────
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState<string | undefined>(undefined);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [pathRenameActive, setPathRenameActive] = useState(false);
  const [runner, setRunner] = useState<RunnerInfo | null>(null);
  const pendingFirstMessageRef = useRef<string | null>(null);
  // True from `session:create` dispatch until `session:created` arrives. Drives
  // the "Creating…" busy state in NewSessionView so the form doesn't look dead
  // while the host spins up a session + worktree.
  const [creatingSession, setCreatingSession] = useState(false);

  useEffect(() => {
    if (!systemConfig) return;
    document.body.setAttribute('data-theme', systemConfig.theme);
    document.body.setAttribute('data-accent', systemConfig.accent);
    document.body.setAttribute('data-density', systemConfig.density);
    document.documentElement.setAttribute('lang', systemConfig.locale);
  }, [systemConfig?.theme, systemConfig?.accent, systemConfig?.density, systemConfig?.locale]);

  useEffect(() => {
    void loadSettings().then(cfg => { if (cfg) setSystemConfig(cfg); });
  }, []);

  useEffect(() => {
    void loadBots().then(setBots);
  }, []);

  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
      if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen]);

  const handleEnvelope = useCallback((env: EventEnvelope, executor: 'claude' | 'codex') => {
    // turn.started comes through the legacy raw passthrough (the unified
    // normalizers drop it). turn_completed / session_error come through the
    // unified pipeline; legacy turn.completed / turn.failed remain for any
    // notification the normalizer hasn't covered yet.
    if (env.event === 'turn.started') {
      setPendingBySession(p => ({ ...p, [env.session_id]: true }));
    }
    if (
      env.event === 'turn_completed' ||
      env.event === 'session_error' ||
      env.event === 'turn.completed' ||
      env.event === 'turn.failed'
    ) {
      setPendingBySession(p => ({ ...p, [env.session_id]: false }));
    }
    if (env.event === 'token_usage.updated') {
      const usage = parseTokenUsage(env.data);
      if (usage) setUsageBySession(prev => ({ ...prev, [env.session_id]: usage }));
    }
    setItemsBySession(prev => {
      const list = prev[env.session_id] ?? [];
      const next = applyEnvelope(list, env, executor);
      return next === list ? prev : { ...prev, [env.session_id]: next };
    });
  }, []);

  useEffect(() => {
    ws.connect();

    const offState = ws.onState((state, attempt) => {
      setWsState(state);
      setWsAttempt(attempt);
      if (state !== 'open') setAuthed(false);
    });

    const off = ws.onMessage((msg: ServerToClientMessage) => {
      switch (msg.type) {
        case 'auth_ok':
          setAuthed(true);
          return;
        case 'state_sync':
          // Replaces the separate loadWorkspaces/loadSessions/loadBots/loadSettings
          // initial fetches. On reconnect this also refreshes all app state.
          setWorkspaces(msg.workspaces);
          setSessions(msg.sessions);
          setBots(msg.bots);
          setSystemConfig(msg.config);
          setRunner(msg.runner);
          setPendingApprovals(
            msg.approvals
              .filter(a => a.status === 'pending')
              .map(a => ({
                id: a.id,
                session_id: a.session_id,
                category: a.category,
                description: a.title,
                status: a.status,
              })),
          );
          return;
        case 'session:created': {
          setSessions(prev => [msg.session, ...prev.filter(s => s.id !== msg.session.id)]);
          setActiveSessionId(msg.session.id);
          setCreatingSession(false);
          const pendingMsg = pendingFirstMessageRef.current;
          if (pendingMsg) {
            pendingFirstMessageRef.current = null;
            // Seed the transcript with an optimistic echo of the first message
            // so the user sees it immediately — the real `user_message` event
            // reconciles it via applyEnvelope.
            const optimistic: TranscriptItem = {
              kind: 'user',
              id: `optimistic:${msg.session.id}:${Date.now()}`,
              text: pendingMsg,
              exec: msg.session.executor,
              ts: Date.now(),
              turn: 0,
              pending: true,
            };
            setItemsBySession(prev => ({ ...prev, [msg.session.id]: [optimistic] }));
            setPendingBySession(p => ({ ...p, [msg.session.id]: true }));
            ws.send({ type: 'message:send', session_id: msg.session.id, text: pendingMsg });
          } else {
            setItemsBySession(prev => ({ ...prev, [msg.session.id]: [] }));
          }
          return;
        }
        case 'session:updated': {
          const partial = msg.session;
          // archive flag flipping moves the row between active and archived
          // lists. We don't have the full session shape on partial updates,
          // so when archived flips we re-fetch the list it's joining.
          const archivingNow = partial.archived === 1;
          const unarchivingNow = partial.archived === 0;
          if (archivingNow) {
            const moved = sessionsRef.current.find(s => s.id === partial.id);
            setSessions(prev => prev.filter(s => s.id !== partial.id));
            if (moved) {
              setArchivedSessions(prev => {
                const merged = { ...moved, ...partial };
                const others = prev.filter(s => s.id !== merged.id);
                return [merged, ...others];
              });
            }
          } else if (unarchivingNow) {
            setArchivedSessions(prev => prev.filter(s => s.id !== partial.id));
            setSessions(prev => {
              const existing = prev.find(s => s.id === partial.id);
              if (existing) return prev.map(s => (s.id === partial.id ? { ...s, ...partial } : s));
              const fromArchived = archivedSessionsRef.current.find(s => s.id === partial.id);
              return fromArchived ? [{ ...fromArchived, ...partial }, ...prev] : prev;
            });
          } else {
            setSessions(prev => prev.map(s => (s.id === partial.id ? { ...s, ...partial } : s)));
            setArchivedSessions(prev => prev.map(s => (s.id === partial.id ? { ...s, ...partial } : s)));
          }
          return;
        }
        case 'session:deleted':
          setSessions(prev => prev.filter(s => s.id !== msg.session_id));
          setArchivedSessions(prev => prev.filter(s => s.id !== msg.session_id));
          setActiveSessionId(prev => (prev === msg.session_id ? null : prev));
          return;
        case 'queue:updated':
          setQueueBySession(prev => ({ ...prev, [msg.session_id]: msg.queue }));
          return;
        case 'approval:created':
          setPendingApprovals(prev => {
            const next = prev.filter(a => a.id !== msg.approval.id);
            if (msg.approval.status === 'pending') {
              next.push(msg.approval as PendingApproval);
            }
            return next;
          });
          return;
        case 'approval:updated':
          setPendingApprovals(prev =>
            prev.filter(a => a.id !== msg.approval.id),
          );
          return;
        case 'event': {
          const sess = sessionsRef.current.find(s => s.id === msg.session_id);
          handleEnvelope(msg, sess?.executor ?? 'claude');
          return;
        }
        case 'runner:updated':
          setRunner(prev => prev ? { ...prev, ...msg.runner } : (msg.runner as RunnerInfo));
          return;
        case 'error':
          // Server-side dispatch failure (e.g. message:send threw before any
          // turn was persisted). Alert the user so the failure isn't silent,
          // and mark any optimistic user echo for this session as failed so
          // the transcript reflects the reject state.
          if (msg.session_id) {
            setItemsBySession(prev => {
              const list = prev[msg.session_id!];
              if (!list) return prev;
              let changed = false;
              const next = list.slice();
              for (let i = next.length - 1; i >= 0; i--) {
                const it = next[i]!;
                if (it.kind === 'user' && it.pending) {
                  next[i] = { ...it, pending: false, failed: true };
                  changed = true;
                  break;
                }
              }
              if (!changed) return prev;
              return { ...prev, [msg.session_id!]: next };
            });
            setPendingBySession(p => ({ ...p, [msg.session_id!]: false }));
          }
          if (msg.code === 'SESSION_CREATE_FAILED') setCreatingSession(false);
          alert(`${msg.code}: ${msg.message}`);
          return;
      }
    });
    // Fallback: if state_sync doesn't arrive (old host), keep REST fetches.
    void Promise.all([loadWorkspaces(), loadSessions()]).then(([w, ss]) => {
      setWorkspaces(prev => prev.length > 0 ? prev : w);
      setSessions(prev => prev.length > 0 ? prev : ss);
    });
    return () => { off(); offState(); };
  }, [ws, handleEnvelope]);

  // We need the latest sessions list when handling events (to look up executor).
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const archivedSessionsRef = useRef<Session[]>([]);
  useEffect(() => { archivedSessionsRef.current = archivedSessions; }, [archivedSessions]);

  // Hydrate transcript on first session view.
  useEffect(() => {
    if (!activeSessionId) return;
    if (itemsBySession[activeSessionId] !== undefined) return;
    const sess =
      sessions.find(s => s.id === activeSessionId)
      ?? archivedSessions.find(s => s.id === activeSessionId);
    const exec = sess?.executor ?? 'claude';
    void loadEvents(activeSessionId).then(events => {
      const items = events.reduce<TranscriptItem[]>(
        (acc, e) => applyEnvelope(acc, e, exec),
        [],
      );
      setItemsBySession(prev => ({ ...prev, [activeSessionId]: items }));
      // Backfill token usage from the latest token_usage.updated event.
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]!.event === 'token_usage.updated') {
          const usage = parseTokenUsage(events[i]!.data);
          if (usage) setUsageBySession(prev => ({ ...prev, [activeSessionId]: usage }));
          break;
        }
      }
    });
  }, [activeSessionId, itemsBySession, sessions, archivedSessions]);

  const activeSession =
    sessions.find(s => s.id === activeSessionId)
    ?? archivedSessions.find(s => s.id === activeSessionId)
    ?? null;
  const activeWorkspace = activeSession
    ? workspaces.find(w => w.id === activeSession.workspace_id) ?? null
    : null;

  // Refresh working trees whenever the workspace or session set changes —
  // a new session with a worktree, or a merged/dropped one, changes the list.
  useEffect(() => {
    void loadWorkingTrees().then(setWorkingTrees);
  }, [workspaces, sessions]);

  // Default working tree for the Files view: follow the focused session.
  // If a session has a live worktree, use it; otherwise use that session's
  // workspace primary tree; otherwise the first workspace.
  function defaultWorkingTreeIdFor(sess: Session | null): string | null {
    if (sess) {
      if (sess.worktree_path) return `wt:${sess.id}`;
      return `ws:${sess.workspace_id}`;
    }
    if (workspaces.length > 0) return `ws:${workspaces[0]!.id}`;
    return null;
  }

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

  const sheetActions = useMemo(() => ({
    activateTab: (pane: 0 | 1, id: string) =>
      setWbActive(a => ({ ...a, [pane]: id })),
    closeTab: (id: string) =>
      setWbTabs(prev => {
        const tab = prev.find(t => t.id === id);
        const next = prev.filter(t => t.id !== id);
        if (tab) {
          setWbActive(a => {
            if (a[tab.pane] !== id) return a;
            const sib = next.find(t => t.pane === tab.pane);
            return { ...a, [tab.pane]: sib ? sib.id : null };
          });
        }
        return next;
      }),
    pinTab: (id: string) =>
      setWbTabs(prev => prev.map(t => t.id === id ? { ...t, preview: false } : t)),
    setTabViewMode: (id: string, viewMode: FileViewMode) =>
      setWbTabs(prev => prev.map(t => t.id === id ? { ...t, viewMode } : t)),
  }), []);

  function fileToLines(content: string): Array<[string, string]> {
    return content.split('\n').map((line, i) => [String(i + 1), line]);
  }

  function extOf(name: string): SheetTab['icoKind'] {
    const m = name.match(/\.([a-z0-9]+)$/i);
    const ext = (m?.[1] ?? '').toLowerCase();
    if (ext === 'md' || ext === 'ts' || ext === 'tsx' || ext === 'json' || ext === 'css') return ext;
    return 'ts';
  }
  function icoTextOf(name: string): string {
    const map: Record<string, string> = { md: 'M', ts: 'TS', tsx: 'TS', json: '{}', css: '#' };
    const m = name.match(/\.([a-z0-9]+)$/i);
    return map[(m?.[1] ?? '').toLowerCase()] ?? 'F';
  }

  /** Open a file in the Sheet workbench (Phase 3+ replacement for the old
   *  preview drawer). Single click = preview tab; double click / context
   *  promote = permanent. Falls back to `vscode://` for paths outside any
   *  known working tree. */
  async function openFileInSheet(absPath: string, permanent: boolean = false): Promise<void> {
    const sess = activeSessionId
      ? sessions.find(s => s.id === activeSessionId) ?? null
      : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt || !absPath.startsWith(wt.path)) {
      const enc = encodeURI(absPath);
      window.open(`vscode://file/${enc}`, '_blank', 'noopener');
      return;
    }
    const rel = absPath.slice(wt.path.length).replace(/^\/+/, '');
    const name = rel.split('/').pop() || rel;
    const fullPath = absPath;
    const icoKind = extOf(name);
    const ico = icoTextOf(name);

    // Try to promote existing tab.
    const existingPerm = wbTabs.find(t => t.kind === 'file' && t.fullPath === fullPath && !t.preview);
    if (existingPerm) {
      setWbActive(a => ({ ...a, [existingPerm.pane]: existingPerm.id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return;
    }

    const file = await loadFile(wt.id, rel);
    const lines = fileToLines(file?.content ?? '');
    // Preview-capable files (md) open with the rendered view by default;
    // source-only formats stay on 'source'.
    const initialViewMode: FileViewMode = icoKind === 'md' ? 'preview' : 'source';
    const tabContent = { name, kind: 'file' as const, icoKind, ico, lines, viewMode: initialViewMode, fullPath };

    setWbTabs(prev => {
      const existingPrev = prev.find(t => t.kind === 'file' && t.preview);
      let tabs = [...prev];
      // Replace preview tab in place.
      if (existingPrev) {
        if (permanent && existingPrev.fullPath === fullPath) {
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...t, preview: false } : t);
          setWbActive(a => ({ ...a, [existingPrev.pane]: existingPrev.id }));
          setViewState(v => v === 'main' ? 'both' : v);
          return tabs;
        }
        if (!permanent) {
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...t, ...tabContent, preview: true } : t);
          setWbActive(a => ({ ...a, [existingPrev.pane]: existingPrev.id }));
          setViewState(v => v === 'main' ? 'both' : v);
          return tabs;
        }
        // Permanent open of a different file: drop preview tab.
        tabs = tabs.filter(t => t.id !== existingPrev.id);
      }
      // If terminal sits in pane 0 alone, push it to pane 1 when a file arrives.
      const hasTermInUpper = tabs.some(t => t.pane === 0 && t.kind === 'term');
      const hasFileAlready = tabs.some(t => t.kind === 'file');
      if (hasTermInUpper && !hasFileAlready) {
        const moved = tabs.filter(t => t.pane === 0 && t.kind === 'term').map(t => t.id);
        tabs = tabs.map(t => moved.includes(t.id) ? { ...t, pane: 1 as 0 | 1 } : t);
        setWbActive(a => ({ ...a, 1: a[0], 0: null }));
      }
      const id = 'tab-' + Date.now();
      const tab: SheetTab = { id, pane: 0, ...tabContent, preview: !permanent };
      tabs.push(tab);
      setWbActive(a => ({ ...a, 0: id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return tabs;
    });
  }

  /** Open a unified diff for a changed file in the Sheet workbench. The
   *  Changes inspector routes row clicks here so the diff lands in the
   *  workbench (full width) rather than crammed into the narrow inspector. */
  async function openDiffInSheet(rel: string, permanent: boolean = false): Promise<void> {
    const sess = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt) return;
    const name = rel.split('/').pop() || rel;
    const fullPath = `${wt.path}/${rel}`;
    const diffText = await loadDiff(wt.id, rel);

    setWbTabs(prev => {
      let tabs = [...prev];
      // If a non-permanent diff preview tab is already open, replace it in place.
      const existingPreview = tabs.find(t => t.kind === 'diff' && t.preview);
      if (existingPreview) {
        tabs = tabs.filter(t => t.id !== existingPreview.id);
      }
      // Promote: if a permanent diff tab for this exact path exists, just activate.
      const existingPerm = tabs.find(t => t.kind === 'diff' && t.fullPath === fullPath && !t.preview);
      if (existingPerm) {
        setWbActive(a => ({ ...a, [existingPerm.pane]: existingPerm.id }));
        setViewState(v => v === 'main' ? 'both' : v);
        return tabs;
      }
      const id = 'tab-diff-' + Date.now();
      const tab: SheetTab = {
        id,
        pane: 0,
        name,
        kind: 'diff',
        icoKind: 'diff',
        ico: '±',
        diffText,
        fullPath,
        preview: !permanent,
      };
      tabs.push(tab);
      setWbActive(a => ({ ...a, 0: id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return tabs;
    });
  }

  /** Open a plan in the Sheet (D1). */
  function openPlanInSheet(approvalId: string, planMarkdown: string): void {
    setWbTabs(prev => {
      const existing = prev.find(t => t.kind === 'plan');
      if (existing) {
        const next = prev.map(t => t.id === existing.id ? { ...t, planBody: planMarkdown } : t);
        setWbActive(a => ({ ...a, [existing.pane]: existing.id }));
        setViewState(v => v === 'main' ? 'both' : v);
        return next;
      }
      const id = 'plan-' + approvalId;
      const tab: SheetTab = { id, pane: 0, name: 'Plan', kind: 'plan', icoKind: 'plan', ico: '✓', planBody: planMarkdown };
      setWbActive(a => ({ ...a, 0: id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return [...prev, tab];
    });
  }

  /** Dock workbench buttons.
   *  - 'term': toggles the terminal pane's *visibility*. If any terminal
   *    already exists, all are closed; otherwise the first one is created.
   *    Adding *more* terminals while the pane is open is done from the
   *    `+` button on the tab strip, not from the dock.
   *  - 'settings': singleton toggle (open / close the one settings tab). */
  function toggleWbTabKind(kind: 'term' | 'settings'): void {
    setWbTabs(prev => {
      const existing = prev.filter(t => t.kind === kind);
      if (existing.length > 0) {
        // Toggle off — remove all of this kind.
        const next = prev.filter(t => t.kind !== kind);
        setWbActive(a => {
          const newA = { ...a };
          [0, 1].forEach(p => {
            const pn = p as 0 | 1;
            if (existing.some(t => t.id === newA[pn])) {
              const sib = next.find(t => t.pane === pn);
              newA[pn] = sib ? sib.id : null;
            }
          });
          return newA;
        });
        return next;
      }
      // Add singleton — terminal in pane 1, settings in pane 0.
      const id = kind === 'term' ? 'tab-term-' + Date.now() : 'tab-settings';
      const tab: SheetTab = kind === 'term'
        ? { id, pane: 1, name: terminalTabName(), kind: 'term', icoKind: 'term', ico: '$' }
        : { id, pane: 0, name: 'Settings', kind: 'settings', icoKind: 'gear', ico: '⚙' };
      const next = [...prev, tab];
      setWbActive(a => ({ ...a, [tab.pane]: tab.id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return next;
    });
  }

  /** Add a new terminal tab to the terminal pane (pane 1). Called by the
   *  `+` button at the right end of the terminal tabs strip. Always
   *  additive — does not toggle off existing terminals. */
  function addTerminalTab(): void {
    setWbTabs(prev => {
      const existingTerms = prev.filter(t => t.kind === 'term').length;
      const id = 'tab-term-' + Date.now();
      const base = terminalTabName();
      const name = existingTerms === 0 ? base : `${base} #${existingTerms + 1}`;
      const tab: SheetTab = { id, pane: 1, name, kind: 'term', icoKind: 'term', ico: '$' };
      setWbActive(a => ({ ...a, 1: id }));
      setViewState(v => v === 'main' ? 'both' : v);
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

  function toggleInspector(kind: InspectorTab): void {
    setInspectorTab(curr => curr === kind ? null : kind);
  }

  const locale = systemConfig?.locale ?? 'en';

  // ─── Path breadcrumb (V2 topbar) ─────────────────────────────────────────
  const activeWtForSession = activeSession
    ? workingTrees.find(t => t.id === defaultWorkingTreeIdFor(activeSession))
    : null;
  const activeBranch = activeWtForSession?.branch ?? null;
  // For Phase 1, Spaces/Bots views manage their own selection internally —
  // the path breadcrumb in those modes falls back to the session-derived
  // workspace (sessions mode) or shows empty. Phase 5/6 lifts selection up.
  const activeBot = null as Bot | null;
  const activeListedWs = activeWorkspace;

  const pathSegments: PathSegment[] = useMemo(() => {
    if (mode === 'sessions') {
      if (!activeSession) return [];
      const segs: PathSegment[] = [];
      segs.push({
        kind: 'workspace',
        label: activeWorkspace?.name ?? activeSession.workspace_id,
        copyHint: `Copy "${activeWorkspace?.name ?? activeSession.workspace_id}"`,
      });
      if (activeBranch) {
        segs.push({
          kind: 'branch',
          label: activeBranch,
          copyHint: `Copy "${activeBranch}"`,
        });
      }
      segs.push({
        kind: 'session',
        label: activeSession.name || 'Untitled',
        copyHint: 'Click for session actions',
        editing: pathRenameActive,
      });
      return segs;
    }
    if (mode === 'spaces') {
      if (!activeListedWs) return [];
      return [{
        kind: 'workspace',
        label: activeListedWs.name,
        copyHint: `Copy "${activeListedWs.name}"`,
      }];
    }
    if (mode === 'bots') {
      if (!activeBot) return [];
      return [{
        kind: 'session',
        label: activeBot.label,
        copyHint: `Copy "${activeBot.label}"`,
      }];
    }
    return [];
  }, [mode, activeSession, activeWorkspace, activeBranch, activeListedWs, activeBot, pathRenameActive]);

  // Session-menu actions (Rename / Copy / Recover / Archive / Delete)
  const sessionMenu: SessionMenuActions | null = useMemo(() => {
    if (mode !== 'sessions' || !activeSession) return null;
    return {
      onRename: () => setPathRenameActive(true),
      onCopyName: () => {
        try { void navigator.clipboard?.writeText(activeSession.name || ''); } catch (_) { /* ignore */ }
      },
      onForceRecover: () => {
        ws.send({ type: 'session:recover', session_id: activeSession.id });
      },
      onArchive: () => {
        const next = activeSession.archived !== 1;
        ws.send({ type: 'session:archive', session_id: activeSession.id, archived: next });
      },
      onDelete: () => {
        if (window.confirm(`Delete session "${activeSession.name || 'Untitled'}"? This cannot be undone.`)) {
          ws.send({ type: 'session:delete', session_id: activeSession.id });
        }
      },
    };
  }, [mode, activeSession, ws]);

  const handleRenameSubmit = useCallback((value: string) => {
    setPathRenameActive(false);
    if (!activeSession) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === activeSession.name) return;
    ws.send({ type: 'session:rename', session_id: activeSession.id, name: trimmed });
  }, [activeSession, ws]);

  const handleRenameCancel = useCallback(() => setPathRenameActive(false), []);

  // ─── Dock state (Phase 1: only Search + Inbox are wired) ─────────────────
  const onJumpToSessionFromInbox = (sid: string) => {
    setActiveSessionId(sid);
    setMode('sessions');
  };

  return (
    <LocaleProvider locale={locale}>
    <div className="app">
      <Topbar
        mode={mode}
        onSetMode={(m) => { setMode(m); }}
        pathSegments={pathSegments}
        sessionMenu={sessionMenu}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={handleRenameCancel}
        showViewSeg={mode === 'sessions' && wbTabs.length > 0}
        viewState={viewState}
        onSetViewState={setViewState}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false); setPaletteInitialQuery(undefined); }}
        sessions={sessions}
        workspaces={workspaces}
        activeSessionId={activeSessionId}
        activeWorkingTreeId={defaultWorkingTreeIdFor(activeSession)}
        transcriptItems={activeSessionId ? (itemsBySession[activeSessionId] ?? []) : []}
        onJumpToSession={sid => { setActiveSessionId(sid); setMode('sessions'); setPaletteOpen(false); }}
        onOpenFile={() => { setPaletteOpen(false); }}
        initialQuery={paletteInitialQuery}
      />
      <div className={`body ${viewState === 'workbench' ? 'wb-only' : ''}`}>
          {mode === 'sessions' && (
          <FileLinkOpenContext.Provider value={(absPath) => { void openFileInSheet(absPath, false); }}>
          <DiffOpenContext.Provider value={() => { /* §C — diff not clickable */ }}>
          <PlanOpenContext.Provider value={(approval) => openPlanInSheet(approval.approvalId, approval.cmd)}>
            <CodingView
              workspaces={workspaces}
              sessions={sessions}
              archivedSessions={archivedSessions}
              archivedLoaded={archivedLoaded}
              activeSession={activeSession}
              activeWorkspace={activeWorkspace}
              activeSessionId={activeSessionId}
              itemsBySession={itemsBySession}
              pendingBySession={pendingBySession}
              usageBySession={usageBySession}
              queueBySession={queueBySession}
              onLoadArchived={async () => {
                if (archivedLoaded) return;
                const list = await import('./api.js').then(m => m.loadArchivedSessions());
                setArchivedSessions(list);
                setArchivedLoaded(true);
              }}
              onSelectSession={setActiveSessionId}
              onWorkspaceCreated={w => setWorkspaces(prev => [...prev, w])}
              onCreateSession={(input) => {
                pendingFirstMessageRef.current = input.firstMessage?.trim() || null;
                setCreatingSession(true);
                ws.send({
                  type: 'session:create',
                  workspace_id: input.workspaceId,
                  executor: input.executor,
                  approval_mode: input.approvalMode,
                  ...(input.name ? { name: input.name } : {}),
                  ...(input.mode ? { mode: input.mode } : {}),
                  ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
                });
              }}
              creatingSession={creatingSession}
              onArchive={(id, archived) => ws.send({ type: 'session:archive', session_id: id, archived })}
              onDelete={id => ws.send({ type: 'session:delete', session_id: id })}
              onRecover={id => ws.send({ type: 'session:recover', session_id: id })}
              onMerge={async id => {
                const { mergeSession } = await import('./api.js');
                const r = await mergeSession(id);
                if (!r.ok) alert(r.error ?? 'merge failed');
              }}
              onDrop={async id => {
                const { dropSession } = await import('./api.js');
                const r = await dropSession(id);
                if (!r.ok) alert(r.error ?? 'drop failed');
              }}
              onSend={(sessionId, text, opts) => {
                // Optimistic echo: append a pending user msg to the transcript
                // and arm the thinking ticker before the server confirms. The
                // real `user_message` event reconciles in applyEnvelope.
                const exec = sessionsRef.current.find(s => s.id === sessionId)?.executor ?? 'claude';
                const optimistic: TranscriptItem = {
                  kind: 'user',
                  id: `optimistic:${sessionId}:${Date.now()}`,
                  text,
                  exec,
                  ts: Date.now(),
                  turn: 0,
                  pending: true,
                };
                setItemsBySession(prev => ({
                  ...prev,
                  [sessionId]: [...(prev[sessionId] ?? []), optimistic],
                }));
                setPendingBySession(p => ({ ...p, [sessionId]: true }));
                ws.send({
                  type: 'message:send',
                  session_id: sessionId,
                  text,
                  ...(opts?.oneShotBypass ? { oneShotBypass: true } : {}),
                });
              }}
              onSendSkill={(sessionId, name, path) =>
                ws.send({
                  type: 'message:send',
                  session_id: sessionId,
                  text: `/${name}`,
                  items: [{ type: 'skill', name, path }],
                })
              }
              onStop={sessionId =>
                ws.send({ type: 'session:stop', session_id: sessionId })
              }
              onApprove={(sessionId, approvalId, decision, answers) =>
                ws.send({
                  type: 'approval:resolve',
                  session_id: sessionId,
                  approval_id: approvalId,
                  decision,
                  ...(answers ? { answers } : {}),
                })
              }
              onQueueAdd={(sessionId, text) =>
                ws.send({ type: 'queue:add', session_id: sessionId, text })
              }
              onQueueRemove={(sessionId, queueId) =>
                ws.send({ type: 'queue:remove', session_id: sessionId, queue_id: queueId })
              }
              onQueueReorder={(sessionId, order) =>
                ws.send({ type: 'queue:reorder', session_id: sessionId, order })
              }
              onQueueClear={sessionId =>
                ws.send({ type: 'queue:clear', session_id: sessionId })
              }
              onQueueSendNow={sessionId =>
                ws.send({ type: 'queue:send_now', session_id: sessionId })
              }
              onSetMode={(sessionId, approvalMode, turns) =>
                ws.send({ type: 'session:set_mode', session_id: sessionId, approval_mode: approvalMode, turns })
              }
              onSetModel={(sessionId, model) =>
                ws.send({ type: 'session:set_model', session_id: sessionId, model })
              }
              onSetEffort={(sessionId, effort) =>
                ws.send({ type: 'session:set_effort', session_id: sessionId, effort })
              }
              onRename={(id, name) =>
                ws.send({ type: 'session:rename', session_id: id, name })
              }
              onShowChanges={() => { toggleInspector('changes'); }}
              activeWorkingTreeId={defaultWorkingTreeIdFor(activeSession)}
              activeBranch={
                workingTrees.find(wt => wt.id === defaultWorkingTreeIdFor(activeSession))?.branch
                ?? null
              }
              previewTarget={null}
              onClosePreview={() => { /* no-op — replaced by Sheet */ }}
              ws={ws}
              onSwitchRuntime={(sessionId, target) =>
                ws.send({ type: 'session:switch-runtime', session_id: sessionId, target })
              }
            />
          </PlanOpenContext.Provider>
          </DiffOpenContext.Provider>
          </FileLinkOpenContext.Provider>
          )}
          {mode === 'spaces' && (
            <SpacesView
              workspaces={workspaces}
              systemConfig={systemConfig}
              ws={ws}
              onChange={() => void loadWorkspaces().then(setWorkspaces)}
              onCreateWorktreeSession={(input) => {
                ws.send({
                  type: 'session:create',
                  workspace_id: input.workspaceId,
                  executor: input.executor,
                  approval_mode: 'auto',
                  mode: 'worktree',
                  ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
                  ...(input.branch ? { branch: input.branch } : {}),
                });
              }}
            />
          )}
          {mode === 'bots' && (
            <BotsView
              bots={bots}
              sessions={sessions}
              workspaces={workspaces}
              onChange={() => void loadBots().then(setBots)}
            />
          )}
        {mode === 'sessions' && wbTabs.length > 0 && viewState !== 'main' && (
          <>
            {viewState !== 'workbench' && (
              <Splitter side="right" varName="--sheet-w" base={440} min={300} max={800} invert />
            )}
            <Sheet
              tabs={wbTabs}
              active={wbActive}
              actions={sheetActions}
              onAddTab={() => addTerminalTab()}
              renderTab={(t) => {
                if (t.kind === 'settings') {
                  return <SettingsBody config={systemConfig} onChange={cfg => setSystemConfig(cfg)} />;
                }
                if (t.kind === 'term') {
                  // Pick the most-specific cwd we can: worktree path
                  // when the active session has one, otherwise the
                  // session's workspace, otherwise the first known
                  // workspace. This matches what GitBadge / Files /
                  // /raw all already use as the "current" tree. The
                  // server falls back to $HOME if everything is null.
                  // Each tab is a distinct PTY keyed by t.id.
                  const wtId = defaultWorkingTreeIdFor(activeSession);
                  const wtPath = wtId ? workingTrees.find(w => w.id === wtId)?.path : null;
                  const wbCwd = wtPath ?? activeWorkspace?.path ?? workspaces[0]?.path ?? null;
                  return (
                    <div className="sheet-term">
                      <Terminal
                        instanceKey={`term:${t.id}`}
                        wire={makeWorkbenchWire(ws, t.id, wbCwd ? { cwd: wbCwd } : {})}
                      />
                    </div>
                  );
                }
                return null;
              }}
            />
          </>
        )}
        {mode === 'sessions' && inspectorTab !== null && (
          <>
            <Splitter side="right" varName="--inspector-w" base={280} min={220} max={500} invert />
            <Inspector
              tab={inspectorTab}
              workingTreeId={defaultWorkingTreeIdFor(activeSession)}
              onOpenFile={(rel, perm) => {
                const sess = activeSession;
                const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
                const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
                if (!wt) return;
                const abs = `${wt.path}/${rel}`;
                void openFileInSheet(abs, perm);
              }}
              onOpenDiff={(rel, perm) => { void openDiffInSheet(rel, perm); }}
            />
          </>
        )}
        <Dock
          inspectorTab={inspectorTab}
          onToggleInspector={toggleInspector}
          inspectorDisabled={mode !== 'sessions'}
          hasTerminal={wbTabs.some(t => t.kind === 'term')}
          hasSettings={wbTabs.some(t => t.kind === 'settings')}
          onToggleWbTab={toggleWbTabKind}
          wbDisabled={mode !== 'sessions'}
          onOpenSearch={() => setPaletteOpen(true)}
          pendingApprovals={pendingApprovals}
          onJumpToSession={onJumpToSessionFromInbox}
          wsState={wsState}
          wsAttempt={wsAttempt}
          authed={authed}
          runner={runner}
        />
      </div>
    </div>
    </LocaleProvider>
  );
}
