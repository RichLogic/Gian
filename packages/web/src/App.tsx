import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, EventEnvelope, RemoteControlState, RunnerInfo, ServerToClientMessage, Session, Workspace } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import { EN } from './i18n/en.js';
import { ZH } from './i18n/zh.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import { makeWsUrl, loadWorkspaces, loadSessions, loadEvents, loadSettings, loadWorkingTrees, loadBots, loadFile, loadDiff, fetchWsToken, loadRepoInfo, loadApps, loadAllFiles, openFileWith, openFileWithApp, openFileBuiltin } from './api.js';
import type { ChangeScope } from './api.js';
import { injectComposerDraft } from './components/Composer.js';
import type { WorkingTree } from './api.js';
import type { SheetOpenWith } from './components/Sheet.js';
import { buildFileRefIndex, makeFileLinkifyRehype } from './transcript/linkify-files.js';
import { FileRefRehypeContext } from './transcript/items.js';
import { isWithinRoot, longestRootMatch } from './utils/paths.js';
import { applyEnvelope, applyErrorEnvelopeToSession, applyPlanUpdate, createOptimisticEcho, nextPendingFromEnvelope, parseTokenUsage } from './transcript/apply.js';
import { loadNotificationPrefs, maybeNotifyForEnvelope } from './notifications.js';
import {
  applyApprovalCreated,
  clearSessionError,
  ingestEnvelope,
  markAllRead,
  markSessionRead,
  reconcileFromSync,
  removeApproval,
  removeSession as removeInboxSession,
  clearFyi as clearInboxFyi,
  type InboxItem,
} from './inbox.js';
import { PendingTtySwitch } from './tty-switch.js';
import { DiffOpenContext, FileLinkOpenContext, PlanOpenContext } from './transcript/items.js';
import { Topbar } from './components/Topbar.js';
import type { Mode, ViewState } from './components/Topbar.js';
import type { PathSegment, SessionMenuActions } from './components/PathBreadcrumb.js';
import { Dock } from './components/Dock.js';
import { Toaster } from './components/Toaster.js';
import { confirm as confirmDialog, toast } from './feedback.js';
import { Sheet, IMAGE_EXTS, openCategoryFor, resolveOpenTarget } from './components/Sheet.js';
import type { SheetTab, FileViewMode } from './components/Sheet.js';
import { Splitter } from './components/Splitter.js';
import { Inspector } from './components/Inspector.js';
import type { InspectorTab } from './components/Inspector.js';
import { SettingsBody } from './components/SettingsBody.js';
import { Terminal, makeWorkbenchWire } from './components/Terminal.js';
import { CodingView } from './views/CodingView.js';
import { SpacesView } from './views/SpacesView.js';
import { BotsView } from './views/BotsView.js';
import { FilesView } from './views/FilesView.js';
import { CommandPalette } from './components/CommandPalette.js';
import type { SystemConfig } from '@gian/shared';
import type { QueueEntry, TokenUsage, TranscriptItem } from './types.js';
import { planBetaComposerSend, planCreatedSessionFirstMessage } from './session-routing.js';

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
  // Maps workspace_id → current HEAD branch name, populated lazily for each
  // workspace. Regular (non-worktree) sessions ride on the workspace's HEAD,
  // so SessionRow falls through to this when session.branch itself is null.
  // Refreshed on `workspace:git-updated` so external branch switches show up.
  const [workspaceBranches, setWorkspaceBranches] = useState<Record<string, string | null>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
  const [usageBySession, setUsageBySession] = useState<Record<string, TokenUsage>>({});
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueEntry[]>>({});
  const [ttyLockBySession, setTtyLockBySession] = useState<Record<string, { owner: boolean; reason?: string }>>({});
  const [remoteControlBySession, setRemoteControlBySession] = useState<Record<string, RemoteControlState>>({});
  const [mode, setMode] = useState<Mode>('sessions');
  const [workingTrees, setWorkingTrees] = useState<WorkingTree[]>([]);
  // Installed apps for the Sheet's "Open with…" menu (macOS; [] elsewhere).
  // Fetched once — the list is stable for a session.
  const [apps, setApps] = useState<string[]>([]);
  // ─── V2 Workbench (Sheet) state ─────────────────────────────────────────
  const [wbTabs, setWbTabs] = useState<SheetTab[]>([]);
  const [wbActive, setWbActive] = useState<{ 0: string | null; 1: string | null }>({ 0: null, 1: null });
  const [viewState, setViewState] = useState<ViewState>('main');
  // Dock's terminal button toggles this; existing terminals stay mounted
  // (ttys keep running) while hidden. Reset to false when no term tabs
  // remain so the next dock click creates a fresh, visible terminal.
  const [termHidden, setTermHidden] = useState(false);
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
  // Tracks the "switch to TTY + flush staged first message" dance for the Beta
  // surface. Lifecycle methods make the stale-ref leak that broke post-recover
  // sends impossible — see PendingTtySwitch.
  const ttySwitchRef = useRef<PendingTtySwitch>(new PendingTtySwitch());
  // True from `session:create` dispatch until `session:created` arrives. Drives
  // the "Creating…" busy state in NewSessionView so the form doesn't look dead
  // while the host spins up a session + worktree.
  const [creatingSession, setCreatingSession] = useState(false);
  // Same lifecycle as creatingSession but only set during a fork. Drives a
  // global "Forking session…" toast — the user is mid-session when they
  // fork, so without feedback the click looks like a no-op.
  const [forkingSession, setForkingSession] = useState(false);
  // Sessions for which the user clicked "Remote" while a turn was still
  // running. The Composer locks input + shows a banner while the id is
  // here; an effect listens to session:updated and fires the actual
  // switch-runtime dispatch when status leaves 'running'. Keyed on
  // session id so two sessions can be armed independently.
  const [armedRemoteSwitch, setArmedRemoteSwitch] = useState<Set<string>>(() => new Set());
  // Codex plan-mode plan markdown per session — populated by plan_update
  // events. PlanChip reads from here when there's no exit_plan_mode approval
  // to surface (the codex flow doesn't go through approval cards).
  const [planBySession, setPlanBySession] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!systemConfig) return;
    document.body.setAttribute('data-theme', systemConfig.theme);
    document.body.setAttribute('data-accent', systemConfig.accent);
    document.body.setAttribute('data-density', systemConfig.density);
    document.body.setAttribute('data-scale-chrome', systemConfig.font_scale_chrome);
    document.body.setAttribute('data-scale-chat', systemConfig.font_scale_chat);
    document.body.setAttribute('data-scale-code', systemConfig.font_scale_code);
    document.documentElement.setAttribute('lang', systemConfig.locale);
  }, [systemConfig?.theme, systemConfig?.accent, systemConfig?.density,
      systemConfig?.font_scale_chrome, systemConfig?.font_scale_chat,
      systemConfig?.font_scale_code, systemConfig?.locale]);

  useEffect(() => {
    void loadSettings().then(cfg => { if (cfg) setSystemConfig(cfg); });
  }, []);

  useEffect(() => {
    void loadBots().then(setBots);
  }, []);

  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);

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
    const notifyingSession = sessionsRef.current.find(s => s.id === env.session_id) ?? null;
    maybeNotifyForEnvelope(env, {
      session: notifyingSession,
      onClick: () => setActiveSessionId(env.session_id),
    });
    // Persistent in-app mirror of the same taxonomy: approval / error / done.
    // Reads live prefs so Settings toggles take effect immediately; skips
    // `done` for the session you're already looking at.
    setInboxItems(prev => ingestEnvelope(prev, env, {
      prefs: loadNotificationPrefs(),
      activeSessionId: activeSessionIdRef.current,
    }));

    const nextPending = nextPendingFromEnvelope(env);
    if (nextPending !== null) {
      setPendingBySession(p => ({ ...p, [env.session_id]: nextPending }));
    }
    if (env.event === 'token_usage.updated') {
      const usage = parseTokenUsage(env.data);
      if (usage) setUsageBySession(prev => ({ ...prev, [env.session_id]: usage }));
    }
    // Codex plan-mode: plan_update either streams (delta:true → append) or
    // finalizes (delta:false → replace). PlanChip subscribes to this state.
    if (env.event === 'plan_update') {
      setPlanBySession(prev => ({
        ...prev,
        [env.session_id]: applyPlanUpdate(prev[env.session_id], env),
      }));
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
          // Rebuild actionable inbox items (pending approvals + errored
          // sessions) from the snapshot. `done` is FYI and not reconstructed.
          setInboxItems(reconcileFromSync(msg.approvals, msg.sessions));
          return;
        case 'session:created': {
          setSessions(prev => [msg.session, ...prev.filter(s => s.id !== msg.session.id)]);
          setActiveSessionId(msg.session.id);
          setCreatingSession(false);
          setForkingSession(false);
          const pendingMsg = pendingFirstMessageRef.current;
          pendingFirstMessageRef.current = null;
          const firstMessagePlan = planCreatedSessionFirstMessage(msg.session.executor, pendingMsg);
          if (firstMessagePlan.switchToTty) {
            setItemsBySession(prev => ({ ...prev, [msg.session.id]: [] }));
            setPendingBySession(p => ({ ...p, [msg.session.id]: false }));
            ttySwitchRef.current.stage(msg.session.id, firstMessagePlan.ttyText);
            ws.send({ type: 'session:switch-runtime', session_id: msg.session.id, target: 'tty', surface: 'beta' });
            return;
          }
          if (firstMessagePlan.structuredText) {
            // Seed the transcript with an optimistic echo of the first message
            // so the user sees it immediately — the real `user_message` event
            // reconciles it via applyEnvelope.
            const optimistic = createOptimisticEcho({
              sessionId: msg.session.id,
              text: firstMessagePlan.structuredText,
              exec: msg.session.executor,
            });
            setItemsBySession(prev => ({ ...prev, [msg.session.id]: [optimistic] }));
            setPendingBySession(p => ({ ...p, [msg.session.id]: true }));
            ws.send({ type: 'message:send', session_id: msg.session.id, text: firstMessagePlan.structuredText });
          } else {
            setItemsBySession(prev => ({ ...prev, [msg.session.id]: [] }));
          }
          return;
        }
        case 'session:updated': {
          const partial = msg.session;
          if (partial.status === 'running' || partial.status === 'pending') {
            setPendingBySession(p => ({ ...p, [partial.id]: true }));
            // Recovered out of the error state — drop its inbox error row.
            setInboxItems(prev => clearSessionError(prev, partial.id));
          } else if (partial.status === 'done' || partial.status === 'error') {
            setPendingBySession(p => ({ ...p, [partial.id]: false }));
            if (partial.status === 'done') setInboxItems(prev => clearSessionError(prev, partial.id));
          }
          if (partial.runtime_mode === 'tty') {
            const { flush } = ttySwitchRef.current.onTty(partial.id);
            if (flush !== null) {
              setPendingBySession(p => ({ ...p, [partial.id]: true }));
              ws.send({ type: 'pty:input', session_id: partial.id, text: flush });
            }
          } else if (partial.runtime_mode === 'structured') {
            // Back to structured (force-recover, or manual switch to Chat).
            // Any pending switch-to-TTY for this session is now moot — drop the
            // bookkeeping so the next Beta send re-initiates a fresh switch
            // instead of being silently suppressed by a stale in-flight flag.
            ttySwitchRef.current.clear(partial.id);
          }
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
        case 'tty:lock':
          setTtyLockBySession(prev => ({
            ...prev,
            [msg.session_id]: {
              owner: msg.owner,
              ...(msg.reason ? { reason: msg.reason } : {}),
            },
          }));
          return;
        case 'tty:remote-control':
          setRemoteControlBySession(prev => ({ ...prev, [msg.session_id]: msg.state }));
          return;
        case 'session:deleted':
          setSessions(prev => prev.filter(s => s.id !== msg.session_id));
          setArchivedSessions(prev => prev.filter(s => s.id !== msg.session_id));
          setActiveSessionId(prev => (prev === msg.session_id ? null : prev));
          setInboxItems(prev => removeInboxSession(prev, msg.session_id));
          return;
        case 'queue:updated':
          setQueueBySession(prev => ({ ...prev, [msg.session_id]: msg.queue }));
          return;
        case 'approval:created':
          // Structured approvals also flow as `approval_requested` envelopes;
          // both converge on the same approvalId so this self-dedups. Carries
          // the authoritative status so auto-approved ones don't linger.
          setInboxItems(prev => applyApprovalCreated(prev, msg.approval, loadNotificationPrefs(), Date.now()));
          return;
        case 'approval:updated':
          setInboxItems(prev => removeApproval(prev, msg.approval.id));
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
            const sid = msg.session_id;
            ttySwitchRef.current.clear(sid);
            setItemsBySession(prev => {
              const delta = applyErrorEnvelopeToSession(prev[sid], sid);
              if (!delta || delta.items === prev[sid]) return prev;
              return { ...prev, [sid]: delta.items };
            });
            setPendingBySession(p => ({ ...p, [sid]: false }));
          }
          if (msg.code === 'SESSION_CREATE_FAILED') {
            setCreatingSession(false);
            setForkingSession(false);
          }
          toast({ kind: 'error', title: msg.code, message: msg.message });
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

  // Workspace current_branch fetcher — hits /repo-info for each workspace and
  // caches into workspaceBranches. Used by SessionRow as a fallback when the
  // session itself isn't a worktree.
  const fetchWorkspaceBranch = useCallback(async (wsId: string) => {
    const info = await loadRepoInfo(wsId);
    setWorkspaceBranches(prev => ({ ...prev, [wsId]: info?.git?.currentBranch ?? null }));
  }, []);

  // Backfill branches for every known workspace whenever the list changes.
  // The fetcher itself deduplicates by overwriting, so re-runs are cheap.
  useEffect(() => {
    for (const w of workspaces) void fetchWorkspaceBranch(w.id);
  }, [workspaces, fetchWorkspaceBranch]);

  // Refresh on `workspace:git-updated` (fetch / branch-created / merge / drop /
  // session-deleted / worktree-created). Any of those can change HEAD.
  useEffect(() => {
    const off = ws.onMessage(msg => {
      if (msg.type === 'workspace:git-updated') {
        void fetchWorkspaceBranch(msg.workspace_id);
      }
    });
    return off;
  }, [ws, fetchWorkspaceBranch]);

  // We need the latest sessions list when handling events (to look up executor).
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const archivedSessionsRef = useRef<Session[]>([]);
  useEffect(() => { archivedSessionsRef.current = archivedSessions; }, [archivedSessions]);
  // Latest active session id for the inbox's "don't ping the session you're
  // watching" rule — read inside the stable handleEnvelope callback.
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // Fire queued remote-control switches once their turn lands. Watches the
  // `sessions` list — when an armed session's status leaves 'running' /
  // 'pending', dispatch session:switch-runtime with remote_control=true and
  // drop the armed flag. SWITCH_BLOCKED errors come back through the normal
  // 'error' message channel; we don't silence them.
  useEffect(() => {
    if (armedRemoteSwitch.size === 0) return;
    const toFire: string[] = [];
    for (const id of armedRemoteSwitch) {
      const s = sessions.find(x => x.id === id);
      if (!s) { toFire.push(id); continue; } // session vanished — clear
      if (s.status === 'running' || s.status === 'pending') continue;
      toFire.push(id);
      ws.send({
        type: 'session:switch-runtime',
        session_id: id,
        target: 'tty',
        remote_control: true,
      });
    }
    if (toFire.length > 0) {
      setArmedRemoteSwitch(prev => {
        const next = new Set(prev);
        for (const id of toFire) next.delete(id);
        return next;
      });
    }
  }, [sessions, armedRemoteSwitch, ws]);

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

  // Load the installed-apps list once for the Sheet "Open with…" menu.
  useEffect(() => { void loadApps().then(setApps); }, []);

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
  const [fileIndexAbs, setFileIndexAbs] = useState<{ wtId: string; rehype: () => (tree: any) => void } | null>(null);
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
      setFileIndexAbs({ wtId, rehype: makeFileLinkifyRehype(index, rel => `${base}/${rel}`) });
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

  // Drop the hide flag once the last terminal is gone — otherwise the
  // next dock click would create a terminal that's immediately hidden.
  useEffect(() => {
    if (termHidden && !wbTabs.some(t => t.kind === 'term')) {
      setTermHidden(false);
    }
  }, [termHidden, wbTabs]);

  const sheetActions = useMemo(() => ({
    activateTab: (pane: 0 | 1, id: string) =>
      setWbActive(a => ({ ...a, [pane]: id })),
    closeTab: (id: string) => {
      const tab = wbTabs.find(t => t.id === id);
      if (tab?.kind === 'term') {
        ws.send({ type: 'term:close', term_id: id });
      }
      setWbTabs(prev => {
        const closing = prev.find(t => t.id === id);
        const next = prev.filter(t => t.id !== id);
        if (closing) {
          setWbActive(a => {
            if (a[closing.pane] !== id) return a;
            const sib = next.find(t => t.pane === closing.pane);
            return { ...a, [closing.pane]: sib ? sib.id : null };
          });
        }
        return next;
      });
    },
    pinTab: (id: string) =>
      setWbTabs(prev => prev.map(t => t.id === id ? { ...t, preview: false } : t)),
    setTabViewMode: (id: string, viewMode: FileViewMode) =>
      setWbTabs(prev => prev.map(t => t.id === id ? { ...t, viewMode } : t)),
  }), [wbTabs, ws]);

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
  async function openFileInSheet(absPath: string, permanent: boolean = false, line?: number): Promise<void> {
    const sess = activeSessionId
      ? sessions.find(s => s.id === activeSessionId) ?? null
      : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt || !isWithinRoot(wt.path, absPath)) {
      const enc = encodeURI(absPath);
      window.open(`vscode://file/${enc}${line ? ':' + line : ''}`, '_blank', 'noopener');
      return;
    }
    const rel = absPath.slice(wt.path.replace(/\/+$/, '').length).replace(/^\/+/, '');
    const name = rel.split('/').pop() || rel;
    const fullPath = absPath;
    const icoKind = extOf(name);
    const ico = icoTextOf(name);
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    const rawUrl = `/api/working_trees/${encodeURIComponent(wt.id)}/raw?path=${encodeURIComponent(rel)}`;
    const isImage = IMAGE_EXTS.has(ext);

    // Files we can't view in-app (pdf, binaries, unknown) open externally via
    // their category's configured target (Settings → Default apps). Code/web are
    // viewed as source in-app here; the Open button still uses the category.
    if (!isImage) {
      const cat = openCategoryFor(name);
      if (cat !== 'code' && cat !== 'web') {
        dispatchOpen(wt, rel, resolveOpenTarget(cat, systemConfig?.open_apps));
        return;
      }
    }

    // Try to promote existing tab. Re-set scrollLine so a fresh click on a
    // file-link (possibly a different line) re-jumps in the already-open tab.
    const existingPerm = wbTabs.find(t => t.kind === 'file' && t.fullPath === fullPath && !t.preview);
    if (existingPerm) {
      setWbTabs(prev => prev.map(t => t.id === existingPerm.id ? { ...t, scrollLine: line } : t));
      setWbActive(a => ({ ...a, [existingPerm.pane]: existingPerm.id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return;
    }

    // Images render straight from `/raw` via an <img> (no text load); everything
    // else loads its source lines.
    let tabContent;
    if (isImage) {
      tabContent = { name, kind: 'file' as const, icoKind: 'img' as const, ico: '', rawSrc: rawUrl, fullPath, workingTreeId: wt.id };
    } else {
      const file = await loadFile(wt.id, rel);
      const lines = fileToLines(file?.content ?? '');
      // Preview-capable files (md) open with the rendered view by default —
      // but a line jump forces source view so the target line is visible.
      const initialViewMode: FileViewMode = line != null ? 'source' : icoKind === 'md' ? 'preview' : 'source';
      tabContent = { name, kind: 'file' as const, icoKind, ico, lines, viewMode: initialViewMode, fullPath, scrollLine: line, workingTreeId: wt.id };
    }

    setWbTabs(prev => {
      const existingPrev = prev.find(t => t.kind === 'file' && t.preview);
      let tabs = [...prev];
      // Replace preview tab in place.
      if (existingPrev) {
        if (permanent && existingPrev.fullPath === fullPath) {
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...t, preview: false, scrollLine: line } : t);
          setWbActive(a => ({ ...a, [existingPrev.pane]: existingPrev.id }));
          setViewState(v => v === 'main' ? 'both' : v);
          return tabs;
        }
        if (!permanent) {
          // Replace the preview tab's content WITHOUT spreading the old tab —
          // otherwise stale fields (e.g. an image tab's `rawSrc` or a text
          // tab's `lines`) leak into the new content and the body mis-renders.
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...tabContent, id: t.id, pane: t.pane, preview: true } : t);
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
  async function openDiffInSheet(rel: string, permanent: boolean = false, scope: ChangeScope = 'all'): Promise<void> {
    const sess = activeSessionId ? sessions.find(s => s.id === activeSessionId) ?? null : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (!wt) return;
    const name = rel.split('/').pop() || rel;
    const fullPath = `${wt.path}/${rel}`;
    const diffText = await loadDiff(wt.id, rel, scope);

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
        workingTreeId: wt.id,
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
      const tab: SheetTab = { id, pane: 0, name: appT('sheet.tab.plan'), kind: 'plan', icoKind: 'plan', ico: '✓', planBody: planMarkdown };
      setWbActive(a => ({ ...a, 0: id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return [...prev, tab];
    });
  }

  /** Dock workbench buttons.
   *  - 'term': lifecycle is split from visibility. With no terminals,
   *    creates the first one. With terminals present, toggles a hide
   *    flag so the xterm stays mounted (tty keeps running) across
   *    show/hide cycles. The only paths that destroy a tty are the
   *    per-tab `×` button and closing the last tab.
   *  - 'settings': singleton toggle (open / close the one settings tab). */
  function toggleWbTabKind(kind: 'term' | 'settings'): void {
    if (kind === 'term') {
      const hasTerm = wbTabs.some(t => t.kind === 'term');
      if (hasTerm) {
        const terminalVisible = mode === 'sessions' && viewState !== 'main' && !termHidden;
        if (terminalVisible) {
          setTermHidden(true);
        } else {
          setMode('sessions');
          setTermHidden(false);
          setViewState(v => v === 'main' ? 'both' : v);
        }
        return;
      }
      setTermHidden(false);
      setWbTabs(prev => {
        const id = 'tab-term-' + Date.now();
        const tab: SheetTab = { id, pane: 1, name: terminalTabName(), kind: 'term', icoKind: 'term', ico: '$' };
        setWbActive(a => ({ ...a, 1: id }));
        setViewState(v => v === 'main' ? 'both' : v);
        return [...prev, tab];
      });
      return;
    }
    setWbTabs(prev => {
      const existing = prev.filter(t => t.kind === kind);
      if (existing.length > 0) {
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
      const id = 'tab-settings';
      const tab: SheetTab = { id, pane: 0, name: appT('sheet.tab.settings'), kind: 'settings', icoKind: 'gear', ico: '⚙' };
      const next = [...prev, tab];
      setWbActive(a => ({ ...a, [tab.pane]: tab.id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return next;
    });
  }

  /** Add a new terminal tab to the terminal pane (pane 1). Called by the
   *  `+` button at the right end of the terminal tabs strip. Always
   *  additive — does not toggle off existing terminals, and always
   *  surfaces the pane (un-hiding if the dock had collapsed it). */
  function addTerminalTab(): void {
    setTermHidden(false);
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
  const appT = useCallback((key: string) => {
    const messages = locale === 'zh-CN' ? ZH : EN;
    return messages[key] ?? EN[key] ?? key;
  }, [locale]);

  useEffect(() => {
    setWbTabs(prev => prev.map(tab => {
      if (tab.kind === 'settings') return { ...tab, name: appT('sheet.tab.settings') };
      if (tab.kind === 'plan') return { ...tab, name: appT('sheet.tab.plan') };
      return tab;
    }));
  }, [appT]);

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
        copyHint: `${appT('common.copy')} "${activeWorkspace?.name ?? activeSession.workspace_id}"`,
      });
      if (activeBranch) {
        segs.push({
          kind: 'branch',
          label: activeBranch,
          copyHint: `${appT('common.copy')} "${activeBranch}"`,
        });
      }
      segs.push({
        kind: 'session',
        label: activeSession.name || appT('coding.session.untitled'),
        copyHint: appT('coding.session.actions'),
        editing: pathRenameActive,
      });
      return segs;
    }
    if (mode === 'spaces') {
      if (!activeListedWs) return [];
      return [{
        kind: 'workspace',
        label: activeListedWs.name,
        copyHint: `${appT('common.copy')} "${activeListedWs.name}"`,
      }];
    }
    if (mode === 'bots') {
      if (!activeBot) return [];
      return [{
        kind: 'session',
        label: activeBot.label,
        copyHint: `${appT('common.copy')} "${activeBot.label}"`,
      }];
    }
    return [];
  }, [mode, activeSession, activeWorkspace, activeBranch, activeListedWs, activeBot, pathRenameActive, appT]);

  // Session-menu actions (Rename / Copy / Recover / Archive / Delete)
  const sessionMenu: SessionMenuActions | null = useMemo(() => {
    if (mode !== 'sessions' || !activeSession) return null;
    return {
      onRename: () => setPathRenameActive(true),
      onCopyName: () => {
        try { void navigator.clipboard?.writeText(activeSession.name || ''); } catch (_) { /* ignore */ }
      },
      onForceRecover: () => {
        // Recover is the unwedge path — a TTY switch that hung is the common
        // reason to reach for it. Clear stale switch/staged-message bookkeeping
        // so the next send isn't suppressed (see PendingTtySwitch).
        ttySwitchRef.current.clear(activeSession.id);
        ws.send({ type: 'session:recover', session_id: activeSession.id });
      },
      onFork: (executor) => {
        // Clone every property the host accepts on session:create except
        // `branch` (worktrees must own a unique branch — let the host
        // auto-generate). Name = original + " copy". Executor is the
        // user's choice from the menu.
        const baseName = activeSession.name && activeSession.name.length > 0
          ? activeSession.name
          : `session ${activeSession.id.slice(0, 6)}`;
        const isWorktree = activeSession.worktree_path !== null;
        setCreatingSession(true);
        setForkingSession(true);
        ws.send({
          type: 'session:create',
          workspace_id: activeSession.workspace_id,
          executor,
          approval_mode: activeSession.approval_mode,
          name: `${baseName} copy`,
          ...(isWorktree
            ? {
                mode: 'worktree',
                ...(activeSession.base_branch ? { base_branch: activeSession.base_branch } : {}),
              }
            : { mode: 'regular' }
          ),
        });
      },
      onArchive: () => {
        const next = activeSession.archived !== 1;
        ws.send({ type: 'session:archive', session_id: activeSession.id, archived: next });
      },
      onDelete: async () => {
        const ok = await confirmDialog({
          message: `${appT('coding.session.deleteConfirmPrefix')} "${activeSession.name || appT('coding.session.untitled')}"? ${appT('coding.session.deleteConfirmSuffix')}`,
          danger: true,
          confirmLabel: appT('common.delete'),
        });
        if (ok) ws.send({ type: 'session:delete', session_id: activeSession.id });
      },
    };
  }, [mode, activeSession, ws, appT]);

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
    setInboxItems(prev => markSessionRead(prev, sid));
  };

  // URL-param driven Files view: /?view=files&wt=<id>&path=<rel>
  // Opened by FilesView's "Open in new tab" href for non-renderable file types.
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('view') === 'files') {
    const filesWtId = urlParams.get('wt');
    const filesPath = urlParams.get('path');
    return (
      <LocaleProvider locale={locale}>
        <FilesView
          workingTrees={workingTrees}
          workingTreeId={filesWtId}
          onPickWorkingTree={id => { window.location.search = `?view=files&wt=${encodeURIComponent(id)}`; }}
          initialPath={filesPath}
          externalEditors={systemConfig?.external_editors ?? []}
          onOpenSettings={() => toggleWbTabKind('settings')}
        />
      </LocaleProvider>
    );
  }

  const hasWbTermTabs = wbTabs.some(t => t.kind === 'term');
  const hasWbNonTermTabs = wbTabs.some(t => t.kind !== 'term');
  // Keep terminal tabs mounted even when the workbench is hidden by the
  // main/session view toggle or by switching to another top-level section.
  // The PTY is closed only by the tab close action above.
  const sheetMounted = wbTabs.length > 0 && (hasWbTermTabs || (mode === 'sessions' && viewState !== 'main'));
  const sheetVisible = mode === 'sessions'
    && viewState !== 'main'
    && (hasWbNonTermTabs || (hasWbTermTabs && !termHidden));
  const terminalDockActive = hasWbTermTabs && mode === 'sessions' && viewState !== 'main' && !termHidden;

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
          <FileLinkOpenContext.Provider value={(absPath, line) => { void openFileInSheet(absPath, false, line); }}>
          <FileRefRehypeContext.Provider value={fileRehype}>
          <DiffOpenContext.Provider value={() => { /* §C — diff not clickable */ }}>
          <PlanOpenContext.Provider value={(payload) => openPlanInSheet(payload.id, payload.markdown)}>
            <CodingView
              workspaces={workspaces}
              workspaceBranches={workspaceBranches}
              sessions={sessions}
              archivedSessions={archivedSessions}
              archivedLoaded={archivedLoaded}
              activeSession={activeSession}
              activeWorkspace={activeWorkspace}
              activeSessionId={activeSessionId}
              itemsBySession={itemsBySession}
              pendingBySession={pendingBySession}
              ttyLockBySession={ttyLockBySession}
              remoteControlBySession={remoteControlBySession}
              usageBySession={usageBySession}
              queueBySession={queueBySession}
              planBySession={planBySession}
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
                  ...(input.branch ? { branch: input.branch } : {}),
                });
              }}
              creatingSession={creatingSession}
              onArchive={(id, archived) => ws.send({ type: 'session:archive', session_id: id, archived })}
              onDelete={id => ws.send({ type: 'session:delete', session_id: id })}
              onRecover={id => { ttySwitchRef.current.clear(id); ws.send({ type: 'session:recover', session_id: id }); }}
              onMerge={async id => {
                const { mergeSession } = await import('./api.js');
                const r = await mergeSession(id);
                if (!r.ok) toast({ kind: 'error', message: r.error ?? 'merge failed' });
              }}
              onDrop={async id => {
                const { dropSession } = await import('./api.js');
                const r = await dropSession(id);
                if (!r.ok) toast({ kind: 'error', message: r.error ?? 'drop failed' });
              }}
              onSend={(sessionId, text, opts) => {
                // Optimistic echo: append a pending user msg to the transcript
                // and arm the thinking ticker before the server confirms. The
                // real `user_message` event reconciles in applyEnvelope.
                const exec = sessionsRef.current.find(s => s.id === sessionId)?.executor ?? 'claude';
                const attachments = opts?.attachments ?? [];
                const optimistic = createOptimisticEcho({
                  sessionId,
                  text,
                  exec,
                  // Reuse the composer's blob URL as the <img src> for the
                  // pending bubble — ownership transferred on send; the
                  // user_message reconciler revokes it after swapping in
                  // the server URL.
                  attachments: attachments.length > 0
                    ? attachments.map(a => ({ name: a.name, mime: a.mime, url: a.previewUrl }))
                    : undefined,
                });
                setItemsBySession(prev => ({
                  ...prev,
                  [sessionId]: [...(prev[sessionId] ?? []), optimistic],
                }));
                setPendingBySession(p => ({ ...p, [sessionId]: true }));

                const items: Array<
                  | { type: 'text'; text: string }
                  | { type: 'localImage'; path: string; name?: string; mime?: string }
                > = [];
                if (text.trim()) items.push({ type: 'text', text });
                for (const a of attachments) {
                  items.push({ type: 'localImage', path: a.path, name: a.name, mime: a.mime });
                }

                ws.send({
                  type: 'message:send',
                  session_id: sessionId,
                  text,
                  ...(items.length > 0 ? { items } : {}),
                  ...(opts?.oneShotBypass ? { oneShotBypass: true } : {}),
                });
              }}
              onBetaSend={(sessionId, text, opts) => {
                const attachments = opts?.attachments ?? [];
                const session = sessionsRef.current.find(s => s.id === sessionId);
                const plan = planBetaComposerSend(session?.runtime_mode ?? 'structured', text, attachments);
                if (plan.channel === 'noop') return;
                setPendingBySession(p => ({ ...p, [sessionId]: true }));
                if (plan.channel === 'stage_for_tty') {
                  const { sendSwitch } = ttySwitchRef.current.stage(sessionId, plan.text);
                  if (sendSwitch) {
                    ws.send({ type: 'session:switch-runtime', session_id: sessionId, target: 'tty', surface: 'beta' });
                  }
                  return;
                }
                ws.send({ type: 'pty:input', session_id: sessionId, text: plan.text });
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
              onLocalApprovalResolve={(sessionId, approvalId, decision, answers) => {
                // TTY-mode AskUserQuestion answers are pasted into the PTY
                // rather than resolved over the structured approval bridge —
                // the bridge isn't wired in TTY (cc-proxy would 404). Synthesize
                // an approval_resolved envelope so the QuestionCard transitions
                // out of `pending` immediately. Carry the picked answers so the
                // resolved card can show "answered with …". Any later duplicate
                // from the JSONL watcher is harmless: apply.ts dedupes by
                // approvalId, preserves status, and won't blank answeredWith.
                const session = sessionsRef.current.find(s => s.id === sessionId);
                const executor = session?.executor === 'codex' ? 'codex' : 'claude';
                handleEnvelope({
                  session_id: sessionId,
                  turn: 0,
                  call_id: approvalId,
                  event: 'approval_resolved',
                  ts: Date.now(),
                  data: { approvalId, decision, auto: false, ...(answers ? { answers } : {}) },
                }, executor);
              }
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
              onSwitchRuntime={(sessionId, target, surface) =>
                ws.send({
                  type: 'session:switch-runtime',
                  session_id: sessionId,
                  target,
                  ...(surface ? { surface } : {}),
                })
              }
              onClaimTty={(sessionId, surface, takeover) =>
                ws.send({
                  type: 'tty:claim',
                  session_id: sessionId,
                  surface,
                  ...(takeover ? { takeover: true } : {}),
                })
              }
              armedRemoteSwitch={armedRemoteSwitch}
              onRequestRemote={(sessionId) => {
                const s = sessionsRef.current.find(x => x.id === sessionId);
                const busy = s?.status === 'running' || s?.status === 'pending';
                if (busy) {
                  // Arm; the effect above fires the switch when status flips.
                  setArmedRemoteSwitch(prev => {
                    const next = new Set(prev);
                    next.add(sessionId);
                    return next;
                  });
                  return;
                }
                ws.send({
                  type: 'session:switch-runtime',
                  session_id: sessionId,
                  target: 'tty',
                  remote_control: true,
                });
              }}
              onCancelRemote={(sessionId) => {
                setArmedRemoteSwitch(prev => {
                  if (!prev.has(sessionId)) return prev;
                  const next = new Set(prev);
                  next.delete(sessionId);
                  return next;
                });
              }}
              onToggleRemoteControl={(sessionId) => {
                ws.send({ type: 'session:remote-control', session_id: sessionId });
              }}
              onOpenSpaces={() => setMode('spaces')}
            />
          </PlanOpenContext.Provider>
          </DiffOpenContext.Provider>
          </FileRefRehypeContext.Provider>
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
        {sheetMounted && (() => {
          return (
          <>
            {sheetVisible && viewState !== 'workbench' && (
              <Splitter side="right" varName="--sheet-w" base={440} min={300} max={800} invert />
            )}
            <Sheet
              tabs={wbTabs}
              active={wbActive}
              actions={sheetActions}
              onAddTab={() => addTerminalTab()}
              hideTerm={termHidden}
              hidden={!sheetVisible}
              externalEditors={systemConfig?.external_editors ?? []}
              openApps={systemConfig?.open_apps}
              onOpenWith={handleOpenWith}
              onConfigureEditors={() => toggleWbTabKind('settings')}
              renderTab={(t) => {
                if (t.kind === 'settings') {
                  return (
                    <SettingsBody
                      config={systemConfig}
                      apps={apps}
                      onChange={cfg => setSystemConfig(cfg)}
                    />
                  );
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
          );
        })()}
        {mode === 'sessions' && inspectorTab !== null && (
          <>
            <Splitter side="right" varName="--inspector-w" base={280} min={220} max={500} invert />
            <Inspector
              tab={inspectorTab}
              workingTreeId={defaultWorkingTreeIdFor(activeSession)}
              workingTrees={workingTrees}
              onOpenFile={(rel, perm) => {
                const sess = activeSession;
                const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
                const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
                if (!wt) return;
                const abs = `${wt.path}/${rel}`;
                void openFileInSheet(abs, perm);
              }}
              onOpenDiff={(rel, perm, scope) => { void openDiffInSheet(rel, perm, scope); }}
              canCommit={!!activeSession}
              onComposePrompt={text => { if (activeSessionId) injectComposerDraft(activeSessionId, text); }}
            />
          </>
        )}
        <Dock
          inspectorTab={inspectorTab}
          onToggleInspector={toggleInspector}
          inspectorDisabled={mode !== 'sessions'}
          hasTerminal={terminalDockActive}
          hasSettings={wbTabs.some(t => t.kind === 'settings')}
          onToggleWbTab={toggleWbTabKind}
          wbDisabled={mode !== 'sessions'}
          onOpenSearch={() => setPaletteOpen(true)}
          inboxItems={inboxItems}
          sessionName={sid => {
            const s = sessions.find(x => x.id === sid) ?? archivedSessions.find(x => x.id === sid);
            return s?.name?.trim() || `session ${sid.slice(0, 6)}`;
          }}
          onJumpToSession={onJumpToSessionFromInbox}
          onMarkInboxRead={() => setInboxItems(prev => markAllRead(prev))}
          onClearInboxDone={() => setInboxItems(prev => clearInboxFyi(prev))}
          wsState={wsState}
          wsAttempt={wsAttempt}
          authed={authed}
          runner={runner}
        />
      </div>
      {forkingSession && (
        <div className="fork-toast" role="status" aria-live="polite">
          <span className="spinner" />
          <span>{appT('coding.forking')}</span>
        </div>
      )}
      <Toaster />
    </div>
    </LocaleProvider>
  );
}
