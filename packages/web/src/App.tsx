import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalMode, Bot, EventEnvelope, RemoteControlState, RunnerInfo, RuntimeMode, ServerToClientMessage, Session, Task, TtySurface, Workspace } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import { EN } from './i18n/en.js';
import { ZH } from './i18n/zh.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import { makeWsUrl, loadWorkspaces, loadSessions, loadTasks, loadEvents, loadSettings, loadWorkingTrees, loadBots, loadFile, loadDiff, fetchWsToken, loadRepoInfo, loadApps, loadAllFiles, openFileWith, openFileWithApp, openFileBuiltin } from './api.js';
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
import { WorkspacesInspector, WorkspaceDetailBody } from './components/WorkspacesPanel.js';
import { SettingsBody } from './components/SettingsBody.js';
import { Terminal, makeWorkbenchWire } from './components/Terminal.js';
import { CodingView, SessionMain } from './views/CodingView.js';
import { SpacesView, NewWorkspacePanel } from './views/SpacesView.js';
import { TasksView, ManagerInspector, managerCardContextNote, type NewSubtaskDraft, type ManagerSubtaskCard, type ManagerComposerHandlers } from './views/TasksView.js';
import { BotsView } from './views/BotsView.js';
import { FilesView } from './views/FilesView.js';
import { CommandPalette } from './components/CommandPalette.js';
import type { SystemConfig } from '@gian/shared';
import { stripManagerSystemPrefix, parseCreateSubtaskProposal, stripCreateSubtaskBlocks, wrapManagerContextNote, stripGianRolePrefix, stripGianActionBlocks } from '@gian/shared';
import type { QueueEntry, TokenUsage, TranscriptItem } from './types.js';
import { planBetaComposerSend, planCreatedSessionFirstMessage, resolveChatView } from './session-routing.js';

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
  // ─── Tasks (PRD-v3) ───────────────────────────────────────────────────────
  // Tasks group Subtasks (sessions with type==='subtask' + a matching task_id).
  // Seeded from state_sync, kept fresh via the WS task:* handlers below.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeSubtaskId, setActiveSubtaskId] = useState<string | null>(null);
  // Per-Task static "subtask action" cards (created / dismissed) that live in
  // the Manager conversation (PRD-v3 §A2 follow-up). App-level so they survive
  // ManagerPanel unmount when you navigate between tasks/subtasks. Each card's
  // `acked` flag tracks whether its context note has been folded into a Manager
  // message yet.
  const [managerCardsByTask, setManagerCardsByTask] = useState<Record<string, ManagerSubtaskCard[]>>({});
  // Debug switch (early Manager bring-up): when ON, the Manager transcript shows
  // the raw "plumbing" — the first-turn system prompt and the create_subtask
  // proposal blocks — instead of stripping them. Defaults ON; flip OFF once the
  // Manager UX is trusted to restore the clean render. Persisted in localStorage.
  const [showManagerRaw, setShowManagerRaw] = useState<boolean>(() => {
    try { return localStorage.getItem('gian.manager.debugRaw') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('gian.manager.debugRaw', showManagerRaw ? '1' : '0'); } catch { /* ignore */ }
  }, [showManagerRaw]);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
  const [usageBySession, setUsageBySession] = useState<Record<string, TokenUsage>>({});
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueEntry[]>>({});
  const [ttyLockBySession, setTtyLockBySession] = useState<Record<string, { owner: boolean; reason?: string; alive?: boolean }>>({});
  const [remoteControlBySession, setRemoteControlBySession] = useState<Record<string, RemoteControlState>>({});
  const [mode, setMode] = useState<Mode>('tasks');
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
    // ⌘⇧K toggles the command palette (plain ⌘K was reassigned to "create Codex
    // child" — see the action-shortcuts effect below).
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
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

  // Action shortcuts (documented in Settings → Shortcuts):
  //   ⌘⏎  send the queued message now (active session, or the Task's Manager)
  //   ⌘U  mark the active session as unread
  //   ⌘J  spawn a Claude child — a subtask (Tasks/Manager view) or a fork of the
  //   ⌘K  spawn a Codex child  active session ("fork from" semantics) otherwise
  useEffect(() => {
    // Fork the active session into a child of `executor`, OR (in the Manager
    // view) open the create-subtask form preset to that executor.
    function spawnChild(executor: 'claude' | 'codex') {
      if (mode === 'tasks' && activeTaskId && !activeSubtaskId) {
        window.dispatchEvent(new CustomEvent('gian:new-subtask', { detail: { executor } }));
        return;
      }
      const session = activeSessionId
        ? sessionsRef.current.find(s => s.id === activeSessionId) ?? null
        : null;
      if (!session) return;
      const baseName = session.name && session.name.length > 0
        ? session.name
        : `session ${session.id.slice(0, 6)}`;
      const isWorktree = session.worktree_path !== null;
      setCreatingSession(true);
      setForkingSession(true);
      ws.send({
        type: 'session:create',
        workspace_id: session.workspace_id,
        executor,
        approval_mode: session.approval_mode,
        name: `${baseName} copy`,
        ...(isWorktree
          ? { mode: 'worktree', ...(session.base_branch ? { base_branch: session.base_branch } : {}) }
          : { mode: 'regular' }),
      });
    }
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      if (e.key === 'Enter') {
        const sid = activeSessionId
          ?? (mode === 'tasks' && activeTaskId && !activeSubtaskId
            ? (sessionsRef.current.find(s => s.type === 'manager' && s.task_id === activeTaskId)?.id ?? null)
            : null);
        if (sid) { e.preventDefault(); ws.send({ type: 'queue:send_now', session_id: sid }); }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'u') {
        if (activeSessionId) { e.preventDefault(); ws.send({ type: 'session:set_unread', session_id: activeSessionId, unread: true }); }
      } else if (k === 'j') {
        e.preventDefault(); spawnChild('claude');
      } else if (k === 'k') {
        e.preventDefault(); spawnChild('codex');
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, activeSessionId, activeTaskId, activeSubtaskId, ws]);

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
          setTasks(msg.tasks);
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
          const firstMessagePlan = planCreatedSessionFirstMessage(
            msg.session.executor,
            pendingMsg,
            resolveChatView(systemConfigRef.current).claude_chat_surface,
          );
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
          // A background turn that finished while the user is already viewing
          // this session shouldn't stay unread — clear it straight back. (The
          // sidebar dot is also suppressed for the active row, but this keeps
          // the persisted DB flag correct after a reload.) The resulting
          // unread:0 broadcast merges harmlessly and doesn't re-trigger.
          //
          // Gate on a terminal status so this ONLY undoes auto-unread from turn
          // completion (which always carries status). A manual "Mark as unread"
          // broadcasts `unread:1` alone — that must persist on the active
          // session so the dot appears once the user navigates away.
          const fromTurnEnd = partial.status === 'done' || partial.status === 'error';
          if (partial.unread === 1 && fromTurnEnd && partial.id === activeSessionIdRef.current) {
            ws.send({ type: 'session:set_unread', session_id: partial.id, unread: false });
          }
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
              // The claim broadcasts owner first, then a follow-up with `alive`.
              // Carry the last-known aliveness forward across owner-only updates.
              alive: msg.alive !== undefined ? msg.alive : prev[msg.session_id]?.alive,
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
        // ── Tasks (PRD-v3) — mirror the session:* handlers above. ──
        case 'task:created':
          setTasks(prev => [msg.task, ...prev.filter(t => t.id !== msg.task.id)]);
          setActiveTaskId(msg.task.id);
          setActiveSubtaskId(null);
          return;
        case 'task:updated': {
          const partial = msg.task;
          setTasks(prev => prev.map(t => (t.id === partial.id ? { ...t, ...partial } : t)));
          return;
        }
        case 'task:deleted':
          setTasks(prev => prev.filter(t => t.id !== msg.task_id));
          setActiveTaskId(prev => (prev === msg.task_id ? null : prev));
          setActiveSubtaskId(null);
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
    void Promise.all([loadWorkspaces(), loadSessions(), loadTasks()]).then(([w, ss, ts]) => {
      setWorkspaces(prev => prev.length > 0 ? prev : w);
      setSessions(prev => prev.length > 0 ? prev : ss);
      setTasks(prev => prev.length > 0 ? prev : ts);
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
  const workspacesRef = useRef<Workspace[]>([]);
  useEffect(() => { workspacesRef.current = workspaces; }, [workspaces]);
  // Latest Manager cards for the stable onManagerSend callback (reads unacked
  // cards to fold into the next message's hidden context).
  const managerCardsByTaskRef = useRef(managerCardsByTask);
  useEffect(() => { managerCardsByTaskRef.current = managerCardsByTask; }, [managerCardsByTask]);
  // Latest config for the create handler — it reads the Claude chat surface to
  // decide whether a new Claude session switches to TTY or stays structured.
  const systemConfigRef = useRef<SystemConfig | null>(systemConfig);
  useEffect(() => { systemConfigRef.current = systemConfig; }, [systemConfig]);
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

    // Only pdf truly can't render in-app — it opens externally via its
    // category target. Everything else (code, web, AND unknown extensions
    // 'other') is shown as source text here: clicking an unknown-suffix file
    // should preview it, not jump to Finder. The Open button still routes by
    // category, so 'other' files default to "reveal in Finder" there. Images
    // render inline below.
    if (!isImage && openCategoryFor(name) === 'pdf') {
      dispatchOpen(wt, rel, resolveOpenTarget('pdf', systemConfig?.open_apps));
      return;
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
        // The workbench sheet renders in ANY workbench-active view — Sessions
        // AND Tasks (the Manager view and subtasks alike) — so toggling the
        // terminal should just show/hide it in place. The old check only
        // counted Sessions + subtasks as "session view", so toggling from the
        // Tasks Manager view wrongly yanked the user into Sessions mode.
        const wbActiveNow = mode === 'sessions' || mode === 'tasks';
        const terminalVisible = wbActiveNow && viewState !== 'main' && !termHidden;
        if (terminalVisible) {
          setTermHidden(true);
        } else {
          // Only fall back to Sessions from a non-workbench view (spaces/bots),
          // where the sheet can't render anyway. The dock button is disabled
          // there, so this is just a safety net.
          if (!wbActiveNow) setMode('sessions');
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

  /** Open a workspace's detail as a Workbench tab (zone 3). The list lives in
   *  the Inspector (zone 4); clicking a row opens/activates its detail tab here.
   *  One tab per workspace, keyed by id, so re-clicking re-activates. Mirrors
   *  design/gian-design-v2/js/app.jsx → openWorkspaceInSheet. */
  function openWorkspaceInSheet(wsId: string): void {
    const ws = workspaces.find(w => w.id === wsId);
    if (!ws) return;
    const id = `tab-ws-${wsId}`;
    setWbTabs(prev => {
      const existing = prev.find(t => t.id === id);
      if (existing) {
        setWbActive(a => ({ ...a, [existing.pane]: id }));
        setViewState(v => v === 'main' ? 'both' : v);
        return prev;
      }
      const tab: SheetTab = { id, pane: 0, name: ws.name, kind: 'workspace', icoKind: 'grid', ico: '▣', wsId };
      setWbActive(a => ({ ...a, 0: id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return [...prev, tab];
    });
  }

  /** Open the "new workspace" form as a Workbench tab (singleton) instead of
   *  jumping to the now-hidden `spaces` mode. */
  function openNewWorkspaceInSheet(): void {
    const id = 'tab-new-workspace';
    setWbTabs(prev => {
      if (prev.some(t => t.id === id)) {
        setWbActive(a => ({ ...a, 0: id }));
        setViewState(v => v === 'main' ? 'both' : v);
        return prev;
      }
      const tab: SheetTab = { id, pane: 0, name: 'New workspace', kind: 'new-workspace', icoKind: 'grid', ico: '+' };
      setWbActive(a => ({ ...a, 0: id }));
      setViewState(v => v === 'main' ? 'both' : v);
      return [...prev, tab];
    });
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
    // Subtasks reuse the session breadcrumb (Workspace › Branch › Subtask):
    // a subtask IS a session and activeSession is already synced to it.
    if (mode === 'sessions' || (mode === 'tasks' && activeSubtaskId)) {
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
    // Task (Manager view): a single-level breadcrumb — just the task name ▾.
    if (mode === 'tasks' && activeTaskId) {
      const task = tasks.find(t => t.id === activeTaskId);
      if (!task) return [];
      return [{
        kind: 'session',
        label: task.name || appT('coding.session.untitled'),
        copyHint: appT('coding.session.actions'),
        editing: pathRenameActive,
      }];
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
  }, [mode, activeTaskId, tasks, activeSubtaskId, activeSession, activeWorkspace, activeBranch, activeListedWs, activeBot, pathRenameActive, appT]);

  // Session-menu actions (Rename / Copy / Recover / Archive / Delete)
  const sessionMenu: SessionMenuActions | null = useMemo(() => {
    // Task (Manager view): a one-level menu — Rename / Copy name ┊ Remove (red).
    if (mode === 'tasks' && !activeSubtaskId && activeTaskId) {
      const task = tasks.find(t => t.id === activeTaskId);
      if (!task) return null;
      return {
        kind: 'task' as const,
        onRename: () => setPathRenameActive(true),
        onCopyName: () => {
          try { void navigator.clipboard?.writeText(task.name || ''); } catch (_) { /* ignore */ }
        },
        // A task's "unread" is its Manager session's unread (the task row-end
        // shows the Manager StatusIcon), so mark the Manager unread.
        onMarkUnread: () => {
          const mgr = sessionsRef.current.find(s => s.type === 'manager' && s.task_id === task.id);
          if (mgr) ws.send({ type: 'session:set_unread', session_id: mgr.id, unread: true });
        },
        // Pin toggles `tasks.pinned_at` on the host (task:update{pinned}). We
        // optimistically stamp/clear it locally so the row re-sorts instantly
        // (the host echoes task:updated with the authoritative timestamp).
        pinned: task.pinned_at != null,
        onPin: () => {
          const willPin = task.pinned_at == null;
          const optimistic = willPin ? new Date().toISOString() : null;
          setTasks(prev => prev.map(x => (x.id === task.id ? { ...x, pinned_at: optimistic } : x)));
          ws.send({ type: 'task:update', task_id: task.id, pinned: willPin });
        },
        // Force recover = unwedge the Task's Manager session (it's headless, so
        // its recover lives on the Task menu).
        onForceRecover: () => {
          const mgr = sessionsRef.current.find(s => s.type === 'manager' && s.task_id === task.id);
          if (!mgr) return;
          ttySwitchRef.current.clear(mgr.id);
          ws.send({ type: 'session:recover', session_id: mgr.id });
        },
        onDelete: async () => {
          const ok = await confirmDialog({
            message: `${appT('tasks.remove.confirmPrefix')} "${task.name || appT('tasks.untitled')}"? ${appT('tasks.remove.confirmSuffix')}`,
            danger: true,
            confirmLabel: appT('common.delete'),
          });
          if (ok) ws.send({ type: 'task:delete', task_id: task.id });
        },
      };
    }
    // Subtasks get the same menu MINUS fork / archive / delete — a subtask's
    // lifecycle is managed via its parent Task, not its own session.
    const isSubtask = mode === 'tasks' && !!activeSubtaskId;
    if ((mode !== 'sessions' && !isSubtask) || !activeSession) return null;
    return {
      kind: (isSubtask ? 'subtask' : 'session') as 'subtask' | 'session',
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
      onMarkUnread: () => {
        ws.send({ type: 'session:set_unread', session_id: activeSession.id, unread: true });
      },
      // Delete is available for both subtasks and sessions (a subtask IS a
      // session). Fork / archive stay session-only (below).
      onDelete: async () => {
        const ok = await confirmDialog({
          message: `${appT('coding.session.deleteConfirmPrefix')} "${activeSession.name || appT('coding.session.untitled')}"? ${appT('coding.session.deleteConfirmSuffix')}`,
          danger: true,
          confirmLabel: appT('common.delete'),
        });
        if (ok) ws.send({ type: 'session:delete', session_id: activeSession.id });
      },
      // Subtask completion (spec §B) lives here now (the row's square toggle was
      // removed). Toggles the user `completed_at` flag, separate from turn status.
      ...(isSubtask ? {
        completed: activeSession.completed_at != null,
        onToggleComplete: () => {
          const done = activeSession.completed_at != null;
          void import('./api.js').then(m =>
            done ? m.reopenSubtask(activeSession.id) : m.completeSubtask(activeSession.id),
          );
        },
      } : {}),
      ...(isSubtask ? {} : {
      onFork: (executor: 'claude' | 'codex') => {
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
      }),
    };
  }, [mode, activeTaskId, tasks, activeSubtaskId, activeSession, ws, appT]);

  const handleRenameSubmit = useCallback((value: string) => {
    setPathRenameActive(false);
    const trimmed = value.trim();
    if (!trimmed) return;
    // Task rename (Manager view) vs session/subtask rename.
    if (mode === 'tasks' && !activeSubtaskId && activeTaskId) {
      const task = tasks.find(t => t.id === activeTaskId);
      if (!task || trimmed === task.name) return;
      ws.send({ type: 'task:update', task_id: activeTaskId, name: trimmed });
      return;
    }
    if (!activeSession || trimmed === activeSession.name) return;
    ws.send({ type: 'session:rename', session_id: activeSession.id, name: trimmed });
  }, [mode, activeTaskId, activeSubtaskId, tasks, activeSession, ws]);

  const handleRenameCancel = useCallback(() => setPathRenameActive(false), []);

  // Opening/viewing a session clears its unread marker (mark-read). Guarded on
  // the current flag so we don't spam the host with no-op set_unread on every
  // click. Looks in both active and archived lists.
  const markSessionViewed = useCallback((id: string) => {
    const s = sessionsRef.current.find(x => x.id === id)
      ?? archivedSessionsRef.current.find(x => x.id === id);
    if (s?.unread === 1) ws.send({ type: 'session:set_unread', session_id: id, unread: false });
  }, [ws]);

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    markSessionViewed(id);
  }, [markSessionViewed]);

  // A Subtask IS a Session. When a subtask is selected in Tasks mode we render
  // the full SessionMain view for it inline, which means `activeSession`,
  // `itemsBySession[id]`, the workbench Sheet, and the Inspector must all
  // resolve to that subtask's session. Sync `activeSessionId` to the active
  // subtask (and mark it viewed) so all of that machinery — shared with
  // Sessions mode — targets the subtask. When no subtask is selected the
  // Manager panel is shown and we leave `activeSessionId` untouched.
  useEffect(() => {
    if (mode !== 'tasks' || !activeSubtaskId) return;
    if (activeSessionIdRef.current === activeSubtaskId) return;
    setActiveSessionId(activeSubtaskId);
    markSessionViewed(activeSubtaskId);
  }, [mode, activeSubtaskId, markSessionViewed]);

  // Tasks-mode Manager view (no subtask selected) views no session. If
  // `activeSessionId` still points at a subtask from an earlier visit, clear it
  // — otherwise that stale subtask stays falsely "active", which (a) auto-clears
  // its unread when a background turn finishes there (so a finished subtask
  // wrongly shows as read) and (b) makes re-selecting it skip mark-read (the
  // sync effect's `=== activeSubtaskId` guard short-circuits). Only resets when
  // the lingering active session is itself a subtask, so a normal session
  // selected in Sessions mode is preserved across a mode switch.
  useEffect(() => {
    if (mode !== 'tasks' || activeSubtaskId) return;
    const cur = activeSessionIdRef.current;
    if (cur && sessionsRef.current.find(s => s.id === cur)?.type === 'subtask') {
      setActiveSessionId(null);
    }
  }, [mode, activeSubtaskId]);

  // ─── Per-session SessionMain callbacks (shared) ──────────────────────────
  // These are the App-level handlers <SessionMain> needs, each keyed by an
  // explicit session id. CodingView (Sessions mode) and the inline subtask
  // SessionMain (Tasks mode) both bind to these identical handlers — the only
  // difference is which session id they're bound to. Defining them once here
  // (instead of inline in the CodingView JSX) is what lets the Tasks-mode
  // subtask view reuse the exact same wiring.
  const sessionMainHandlers = {
    onSend: (
      sessionId: string,
      text: string,
      opts?: {
        oneShotBypass?: boolean;
        attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }>;
      },
    ) => {
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
    },
    onBetaSend: (
      sessionId: string,
      text: string,
      opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> },
    ) => {
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
    },
    onSendSkill: (sessionId: string, name: string, path: string) =>
      ws.send({
        type: 'message:send',
        session_id: sessionId,
        text: `/${name}`,
        items: [{ type: 'skill', name, path }],
      }),
    onStop: (sessionId: string) => ws.send({ type: 'session:stop', session_id: sessionId }),
    onApprove: (
      sessionId: string,
      approvalId: string,
      decision: ApprovalDecision,
      answers?: Record<string, string | string[]>,
    ) =>
      ws.send({
        type: 'approval:resolve',
        session_id: sessionId,
        approval_id: approvalId,
        decision,
        ...(answers ? { answers } : {}),
      }),
    onLocalApprovalResolve: (
      sessionId: string,
      approvalId: string,
      decision: ApprovalDecision,
      answers?: Record<string, string | string[]>,
    ) => {
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
    },
    onQueueAdd: (sessionId: string, text: string) =>
      ws.send({ type: 'queue:add', session_id: sessionId, text }),
    onQueueRemove: (sessionId: string, queueId: string) =>
      ws.send({ type: 'queue:remove', session_id: sessionId, queue_id: queueId }),
    onQueueReorder: (sessionId: string, order: string[]) =>
      ws.send({ type: 'queue:reorder', session_id: sessionId, order }),
    onQueueClear: (sessionId: string) => ws.send({ type: 'queue:clear', session_id: sessionId }),
    onQueueSendNow: (sessionId: string) => {
      // Beta/TTY (claude): send_now pastes the queue head straight
      // into the PTY. Mid-turn, Claude's TUI holds it as a queued
      // message and only writes it to the JSONL — where the watcher
      // can surface it in Beta — once the running turn ends. So the
      // bubble would vanish from the queue yet not appear in the
      // transcript until much later. Seed an optimistic echo of the
      // head so it shows immediately; the watcher's `user_message`
      // reconciles it by text (apply.ts), so no duplicate. Structured
      // send_now already echoes via the host-broadcast user_message,
      // so we only patch the TTY gap here.
      const session = sessionsRef.current.find(s => s.id === sessionId);
      if (session?.executor === 'claude' && session.runtime_mode === 'tty') {
        const head = (queueBySession[sessionId] ?? [])[0];
        if (head) {
          const optimistic = createOptimisticEcho({ sessionId, text: head.text, exec: 'claude' });
          setItemsBySession(prev => ({
            ...prev,
            [sessionId]: [...(prev[sessionId] ?? []), optimistic],
          }));
          setPendingBySession(p => ({ ...p, [sessionId]: true }));
        }
      }
      ws.send({ type: 'queue:send_now', session_id: sessionId });
    },
    onSetMode: (sessionId: string, approvalMode: ApprovalMode, turns?: number) =>
      ws.send({ type: 'session:set_mode', session_id: sessionId, approval_mode: approvalMode, turns }),
    onSetModel: (sessionId: string, model: string) =>
      ws.send({ type: 'session:set_model', session_id: sessionId, model }),
    onSetEffort: (sessionId: string, effort: import('@gian/shared').ThinkingEffort | null) =>
      ws.send({ type: 'session:set_effort', session_id: sessionId, effort }),
    onArchive: (id: string, archived: boolean) =>
      ws.send({ type: 'session:archive', session_id: id, archived }),
    onDelete: (id: string) => ws.send({ type: 'session:delete', session_id: id }),
    onRecover: (id: string) => { ttySwitchRef.current.clear(id); ws.send({ type: 'session:recover', session_id: id }); },
    onMerge: async (id: string) => {
      const { mergeSession } = await import('./api.js');
      const r = await mergeSession(id);
      if (!r.ok) toast({ kind: 'error', message: r.error ?? 'merge failed' });
    },
    onDrop: async (id: string) => {
      const { dropSession } = await import('./api.js');
      const r = await dropSession(id);
      if (!r.ok) toast({ kind: 'error', message: r.error ?? 'drop failed' });
    },
    onRename: (id: string, name: string) =>
      ws.send({ type: 'session:rename', session_id: id, name }),
    onSwitchRuntime: (sessionId: string, target: RuntimeMode, surface?: TtySurface, opts?: { force?: boolean }) =>
      ws.send({
        type: 'session:switch-runtime',
        session_id: sessionId,
        target,
        ...(surface ? { surface } : {}),
        ...(opts?.force ? { force: true } : {}),
      }),
    onClaimTty: (sessionId: string, surface: TtySurface, takeover?: boolean) =>
      ws.send({
        type: 'tty:claim',
        session_id: sessionId,
        surface,
        ...(takeover ? { takeover: true } : {}),
      }),
    onRequestRemote: (sessionId: string) => {
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
    },
    onCancelRemote: (sessionId: string) => {
      setArmedRemoteSwitch(prev => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    },
    onToggleRemoteControl: (sessionId: string) => {
      ws.send({ type: 'session:remote-control', session_id: sessionId });
    },
  };

  // ─── Per-Task Manager (PRD-v3 P3) ────────────────────────────────────────
  // The Manager is a session (type='manager') bound to a Task. Its transcript
  // lives in the same itemsBySession map as any session, keyed by its session
  // id. We resolve the active Task's Manager session, hand its items/pending
  // down to TasksView, and provide ensure/send/create-subtask callbacks.
  const activeManagerSession = useMemo(
    () => (activeTaskId
      ? sessions.find(s => s.type === 'manager' && s.task_id === activeTaskId) ?? null
      : null),
    [sessions, activeTaskId],
  );
  // The Task object behind the active Manager — fed to the compact
  // ManagerInspector (zone 4) shown while a subtask is selected.
  const activeManagerTask = useMemo(
    () => (activeTaskId ? tasks.find(t => t.id === activeTaskId) ?? null : null),
    [tasks, activeTaskId],
  );
  const rawManagerItems = activeManagerSession
    ? (itemsBySession[activeManagerSession.id] ?? [])
    : [];
  // Display: strip the system prefix (user msg) and the create_subtask proposal
  // blocks (assistant msg) so the transcript reads as clean prose (spec §A2) —
  // UNLESS the debug `showManagerRaw` switch is on, which surfaces the raw
  // plumbing for early bring-up. The create_subtask confirm card still renders
  // either way (it's parsed from rawManagerItems below, independent of this).
  const managerItems = showManagerRaw
    ? rawManagerItems
    : rawManagerItems.map(it =>
        it.kind === 'user' ? { ...it, text: stripGianRolePrefix(stripManagerSystemPrefix(it.text)) }
          : it.kind === 'assistant' ? { ...it, text: stripGianActionBlocks(stripCreateSubtaskBlocks(it.text)) }
          : it,
      );
  // Latest Manager `create_subtask` proposal (spec §A2), parsed from the RAW
  // assistant text and resolved to a prefilled subtask draft for the confirm
  // card. workspace name/path → id: exact path first, then a UNIQUE name match
  // (names aren't unique — ambiguous/0 → leave unset, user picks). Codex R2 #6.
  const managerProposal = useMemo<Partial<NewSubtaskDraft> | null>(() => {
    for (let i = rawManagerItems.length - 1; i >= 0; i--) {
      const it = rawManagerItems[i];
      if (!it || it.kind !== 'assistant') continue;
      const p = parseCreateSubtaskProposal(it.text);
      if (!p) continue;
      const visible = workspaces.filter(w => w.hidden !== 1);
      let wsId: string | undefined;
      if (p.workspace) {
        const byPath = visible.find(w => w.path === p.workspace);
        if (byPath) wsId = byPath.id;
        else {
          const lower = p.workspace.toLowerCase();
          const byName = visible.filter(w => w.name.toLowerCase() === lower);
          if (byName.length === 1) wsId = byName[0]!.id;
        }
      }
      return {
        prompt: p.prompt,
        ...(p.name ? { name: p.name } : {}),
        ...(p.executor ? { executor: p.executor } : {}),
        ...(wsId ? { workspace_id: wsId } : {}),
      };
    }
    return null;
  }, [rawManagerItems, workspaces]);
  const managerPending = activeManagerSession
    ? (pendingBySession[activeManagerSession.id] ?? activeManagerSession.status === 'running')
    : false;
  // The Manager IS a session, so its (now full) composer reuses the exact same
  // App-level session handlers, bound to the manager session id — model / mode /
  // effort / slash / queue / approvals all work like a normal session.
  const managerSessionId = activeManagerSession?.id ?? null;
  const managerQueue = managerSessionId ? (queueBySession[managerSessionId] ?? []) : [];
  const managerHandlers = useMemo<ManagerComposerHandlers | null>(() => {
    if (!managerSessionId) return null;
    return {
      onSetModel: (model) => sessionMainHandlers.onSetModel(managerSessionId, model),
      onSetMode: (mode, turns) => sessionMainHandlers.onSetMode(managerSessionId, mode, turns),
      onSetEffort: (effort) => sessionMainHandlers.onSetEffort(managerSessionId, effort),
      onSendSkill: (name, path) => sessionMainHandlers.onSendSkill(managerSessionId, name, path),
      onQueueAdd: (t) => sessionMainHandlers.onQueueAdd(managerSessionId, t),
      onQueueRemove: (queueId) => sessionMainHandlers.onQueueRemove(managerSessionId, queueId),
      onQueueReorder: (order) => sessionMainHandlers.onQueueReorder(managerSessionId, order),
      onQueueClear: () => sessionMainHandlers.onQueueClear(managerSessionId),
      onQueueSendNow: () => sessionMainHandlers.onQueueSendNow(managerSessionId),
      onApprove: (approvalId, decision, answers) =>
        sessionMainHandlers.onApprove(managerSessionId, approvalId, decision, answers),
    };
    // sessionMainHandlers is a fresh object each render but closes only over
    // stable refs/setters, so keying the memo on the session id is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerSessionId]);

  // Hydrate a session's transcript from the REST event log if not loaded yet.
  // Shared shape with the activeSessionId hydration effect above.
  const hydrateTranscript = useCallback((sessionId: string, exec: 'claude' | 'codex') => {
    if (itemsBySession[sessionId] !== undefined) return;
    void loadEvents(sessionId).then(events => {
      const items = events.reduce<TranscriptItem[]>(
        (acc, e) => applyEnvelope(acc, e, exec),
        [],
      );
      setItemsBySession(prev =>
        prev[sessionId] !== undefined ? prev : { ...prev, [sessionId]: items });
    });
  }, [itemsBySession]);

  // Ensure the Manager session exists for a Task, then hydrate its transcript.
  // Clear the Manager's unread once its panel is actually on screen — the full
  // panel (task open, no subtask) or the compact inspector (subtask open with
  // the Manager rail showing). Without this the task row's row-end StatusIcon
  // (driven by the Manager's unread) would stay lit forever, since the Manager
  // is never the `activeSessionId` that markSessionViewed clears.
  const managerPanelVisible = mode === 'tasks' && (
    (!activeSubtaskId && !!activeTaskId) ||
    (!!activeSubtaskId && inspectorTab === 'manager')
  );
  // Clear ONCE per view, on the transition into the panel (mark-read-on-open).
  // Re-runs while the same Manager stays on screen are no-ops, so an unread the
  // user sets via the task menu's "Mark as unread" — or a turn that completes
  // while they watch — is not auto-cleared out from under them. Reset when the
  // panel hides so re-opening the task reads it again.
  const mgrViewClearedRef = useRef<string | null>(null);
  useEffect(() => {
    const mgr = activeManagerSession;
    if (!managerPanelVisible || !mgr) { mgrViewClearedRef.current = null; return; }
    if (mgrViewClearedRef.current === mgr.id) return;
    mgrViewClearedRef.current = mgr.id;
    if (mgr.unread === 1) ws.send({ type: 'session:set_unread', session_id: mgr.id, unread: false });
  }, [managerPanelVisible, activeManagerSession, ws]);

  const onManagerMount = useCallback((taskId: string) => {
    const existing = sessionsRef.current.find(
      s => s.type === 'manager' && s.task_id === taskId,
    );
    if (existing) {
      hydrateTranscript(existing.id, existing.executor);
      return;
    }
    void import('./api.js').then(m => m.ensureManagerSession(taskId)).then(session => {
      // session:created arrives via WS and updates `sessions`; seed an empty
      // transcript so the panel renders the placeholder until the user sends.
      if (session) {
        setItemsBySession(prev =>
          prev[session.id] !== undefined ? prev : { ...prev, [session.id]: [] });
      }
    });
  }, [hydrateTranscript]);

  const onManagerSend = useCallback((
    taskId: string,
    text: string,
    opts?: { attachments?: Array<{ path: string; name: string; mime: string; previewUrl: string }> },
  ) => {
    // §A2 follow-up: fold any not-yet-acknowledged subtask-action notes into a
    // hidden, sentinel-wrapped context block prepended to the message — so the
    // Manager learns "the user created/dismissed subtask X" without a separate
    // turn. The optimistic echo uses the BARE text; the reconciler strips the
    // wrapper (and so does managerItems unless showManagerRaw is on).
    const cards = managerCardsByTaskRef.current[taskId] ?? [];
    const unacked = cards.filter(c => !c.acked);
    const sentText = wrapManagerContextNote(unacked.map(managerCardContextNote), text);
    const mgr = sessionsRef.current.find(
      s => s.type === 'manager' && s.task_id === taskId,
    );
    if (!mgr) return;
    const attachments = opts?.attachments ?? [];
    // Optimistic echo against the manager session. The real user_message
    // reconciles via applyEnvelope (stripped-text match).
    const echo = createOptimisticEcho({
      sessionId: mgr.id,
      text,
      exec: mgr.executor,
      attachments: attachments.length > 0
        ? attachments.map(a => ({ name: a.name, mime: a.mime, url: a.previewUrl }))
        : undefined,
    });
    setItemsBySession(prev => ({ ...prev, [mgr.id]: [...(prev[mgr.id] ?? []), echo] }));
    setPendingBySession(p => ({ ...p, [mgr.id]: true }));
    // Send over the SAME structured message:send the session composer uses —
    // the host prepends the Manager system prompt on the first turn (keyed on
    // type==='manager'), so the Manager composer no longer needs the bespoke
    // REST path. Carries text + any image attachments as structured items.
    const items: Array<
      | { type: 'text'; text: string }
      | { type: 'localImage'; path: string; name?: string; mime?: string }
    > = [];
    if (sentText.trim()) items.push({ type: 'text', text: sentText });
    for (const a of attachments) items.push({ type: 'localImage', path: a.path, name: a.name, mime: a.mime });
    ws.send({
      type: 'message:send',
      session_id: mgr.id,
      text: sentText,
      ...(items.length > 0 ? { items } : {}),
    });
    // Ack the folded cards (best-effort — the structured send is reliable, and
    // unlike the old REST call there's no response to await).
    if (unacked.length > 0) {
      const ackedIds = new Set(unacked.map(c => c.id));
      setManagerCardsByTask(prev => ({
        ...prev,
        [taskId]: (prev[taskId] ?? []).map(c => ackedIds.has(c.id) ? { ...c, acked: true } : c),
      }));
    }
  }, [ws]);

  // Stop the Manager's in-flight turn — same `session:stop` path a normal
  // session's Composer Stop button uses, resolved to the manager session id.
  const onManagerStop = useCallback((taskId: string) => {
    const mgr = sessionsRef.current.find(
      s => s.type === 'manager' && s.task_id === taskId,
    );
    if (mgr) ws.send({ type: 'session:stop', session_id: mgr.id });
  }, [ws]);

  const onCreateSubtask = useCallback((taskId: string, draft: NewSubtaskDraft) => {
    void import('./api.js').then(m => m.createSubtask(taskId, {
      workspace_id: draft.workspace_id,
      executor: draft.executor,
      ...(draft.name ? { name: draft.name } : {}),
    })).then(session => {
      if (!session) {
        toast({ kind: 'error', message: 'create subtask failed' });
        return;
      }
      const prompt = draft.prompt?.trim() ?? '';
      // Issue #5: prefill the first prompt into the new subtask's composer draft
      // instead of auto-sending it. Robust for Claude (whose first turn must go
      // through the TTY, where the staged-first-message routing was unreliable)
      // and lets the user review before pressing Enter. Works even though the
      // subtask's Composer isn't mounted yet — injectComposerDraft persists to
      // localStorage, which the Composer reads on mount.
      if (prompt) injectComposerDraft(session.id, prompt);
      // §A2 follow-up: leave a static "created" card in the Manager conversation
      // and queue its context for the Manager's next turn.
      const wsLabel = workspacesRef.current.find(w => w.id === draft.workspace_id)?.name;
      setManagerCardsByTask(prev => ({
        ...prev,
        [taskId]: [...(prev[taskId] ?? []), {
          id: session.id,
          status: 'created',
          executor: draft.executor,
          prompt,
          ...(draft.name ? { name: draft.name } : {}),
          ...(wsLabel ? { workspaceLabel: wsLabel } : {}),
          ts: Date.now(),
          acked: false,
        }],
      }));
      setActiveSubtaskId(session.id);
    });
  }, []);

  // §A2 follow-up: the user declined a subtask proposal. Leave a static
  // "dismissed" card in the conversation and queue its context for the Manager.
  const onDismissSubtaskProposal = useCallback((taskId: string, draft: NewSubtaskDraft) => {
    const wsLabel = workspacesRef.current.find(w => w.id === draft.workspace_id)?.name;
    setManagerCardsByTask(prev => ({
      ...prev,
      [taskId]: [...(prev[taskId] ?? []), {
        id: `dismissed:${taskId}:${crypto.randomUUID()}`,
        status: 'dismissed',
        executor: draft.executor,
        prompt: draft.prompt?.trim() ?? '',
        ...(draft.name ? { name: draft.name } : {}),
        ...(wsLabel ? { workspaceLabel: wsLabel } : {}),
        ts: Date.now(),
        acked: false,
      }],
    }));
  }, []);

  // ─── Dock state (Phase 1: only Search + Inbox are wired) ─────────────────
  const onJumpToSessionFromInbox = (sid: string) => {
    setActiveSessionId(sid);
    setMode('sessions');
    setInboxItems(prev => markSessionRead(prev, sid));
    markSessionViewed(sid);
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
  // A Subtask IS a Session: when one is selected in Tasks mode the main area
  // renders the full SessionMain view, so the workbench Sheet / Inspector /
  // terminal must work there exactly as they do in Sessions mode. We treat
  // "Sessions mode" OR "Tasks mode with an active subtask" as a single
  // "session view active" condition for every gate below.
  const subtaskActive = mode === 'tasks' && !!activeSubtaskId && !!activeSession;
  const sessionViewActive = mode === 'sessions' || subtaskActive;
  // The Manager inspector tab only makes sense for a subtask. If the subtask
  // context is lost (deselected, or you leave Tasks mode) while it's open,
  // close the rail rather than leave an empty splitter behind.
  useEffect(() => {
    if (inspectorTab === 'manager' && !subtaskActive) setInspectorTab(null);
  }, [inspectorTab, subtaskActive]);
  // Keep terminal tabs mounted even when the workbench is hidden by the
  // main/session view toggle or by switching to another top-level section.
  // The PTY is closed only by the tab close action above.
  // Global workbench tools (Settings, Terminal, Workspaces inspector) are
  // available in BOTH Sessions and Tasks (incl. the Manager view) — they aren't
  // tied to an active session. Only the Files / Changes inspector is
  // session-specific (gated on sessionViewActive below).
  const workbenchActive = mode === 'sessions' || mode === 'tasks';
  const sheetMounted = wbTabs.length > 0 && (hasWbTermTabs || (workbenchActive && viewState !== 'main'));
  const sheetVisible = workbenchActive
    && viewState !== 'main'
    && (hasWbNonTermTabs || (hasWbTermTabs && !termHidden));
  const terminalDockActive = hasWbTermTabs && workbenchActive && viewState !== 'main' && !termHidden;

  // Workspace tabs in the Workbench (zone 3) drive the active-row highlight in
  // the WorkspacesInspector (zone 4). Derived from wbTabs/wbActive so it can't
  // drift out of sync with the tab strip.
  const openWsIds = new Set(
    wbTabs.filter(t => t.kind === 'workspace' && t.wsId).map(t => t.wsId as string),
  );
  const activeWorkspaceTab = ([wbActive[0], wbActive[1]] as Array<string | null>)
    .map(id => wbTabs.find(t => t.id === id))
    .find(t => t?.kind === 'workspace');
  const selectedWsId = activeWorkspaceTab?.wsId ?? null;

  // A Subtask IS a Session. When one is selected in Tasks mode we render the
  // exact same <SessionMain> that CodingView renders in Sessions mode — wired
  // to the identical App-level handlers (rebound to the subtask's id) and the
  // same transcript context providers. The activeSessionId-sync effect above
  // keeps `activeSession`, `itemsBySession`, the Sheet, and the Inspector all
  // pointed at this subtask. TasksView renders this element where the old
  // "Open in Sessions" placeholder used to live (inside its own `.main`).
  const subtask = subtaskActive ? activeSession : null;
  const subtaskWorkspace = subtask
    ? workspaces.find(w => w.id === subtask.workspace_id) ?? null
    : null;
  const subtaskWorkingTreeId = defaultWorkingTreeIdFor(subtask);
  const subtaskMain = subtask ? (
    <FileLinkOpenContext.Provider value={(absPath, line) => { void openFileInSheet(absPath, false, line); }}>
    <FileRefRehypeContext.Provider value={fileRehype}>
    <DiffOpenContext.Provider value={() => { /* §C — diff not clickable */ }}>
    <PlanOpenContext.Provider value={(payload) => openPlanInSheet(payload.id, payload.markdown)}>
      <SessionMain
        session={subtask}
        chatView={resolveChatView(systemConfig)}
        workspace={subtaskWorkspace}
        items={itemsBySession[subtask.id] ?? []}
        pending={pendingBySession[subtask.id] ?? false}
        ttyLock={ttyLockBySession[subtask.id]}
        usage={usageBySession[subtask.id] ?? null}
        queue={queueBySession[subtask.id] ?? []}
        codexPlanText={planBySession[subtask.id]}
        onSend={(text, opts) => sessionMainHandlers.onSend(subtask.id, text, opts)}
        onBetaSend={(text, opts) => sessionMainHandlers.onBetaSend(subtask.id, text, opts)}
        onSendSkill={(name, path) => sessionMainHandlers.onSendSkill(subtask.id, name, path)}
        onStop={() => sessionMainHandlers.onStop(subtask.id)}
        onApprove={(approvalId, decision, answers) => sessionMainHandlers.onApprove(subtask.id, approvalId, decision, answers)}
        onLocalApprovalResolve={(approvalId, decision, answers) => sessionMainHandlers.onLocalApprovalResolve(subtask.id, approvalId, decision, answers)}
        onQueueAdd={text => sessionMainHandlers.onQueueAdd(subtask.id, text)}
        onQueueRemove={queueId => sessionMainHandlers.onQueueRemove(subtask.id, queueId)}
        onQueueReorder={order => sessionMainHandlers.onQueueReorder(subtask.id, order)}
        onQueueClear={() => sessionMainHandlers.onQueueClear(subtask.id)}
        onQueueSendNow={() => sessionMainHandlers.onQueueSendNow(subtask.id)}
        onSetMode={(approvalMode, turns) => sessionMainHandlers.onSetMode(subtask.id, approvalMode, turns)}
        onSetModel={model => sessionMainHandlers.onSetModel(subtask.id, model)}
        onSetEffort={effort => sessionMainHandlers.onSetEffort(subtask.id, effort)}
        onMerge={() => sessionMainHandlers.onMerge(subtask.id)}
        onDrop={() => sessionMainHandlers.onDrop(subtask.id)}
        onArchive={archived => sessionMainHandlers.onArchive(subtask.id, archived)}
        onDelete={() => sessionMainHandlers.onDelete(subtask.id)}
        onRecover={() => sessionMainHandlers.onRecover(subtask.id)}
        onReopen={() => { void import('./api.js').then(m => m.reopenSubtask(subtask.id)); }}
        onRename={name => sessionMainHandlers.onRename(subtask.id, name)}
        onShowChanges={() => { toggleInspector('changes'); }}
        workingTreeId={subtaskWorkingTreeId}
        branch={workingTrees.find(wt => wt.id === subtaskWorkingTreeId)?.branch ?? null}
        ws={ws}
        onSwitchRuntime={(target, surface, opts) => sessionMainHandlers.onSwitchRuntime(subtask.id, target, surface, opts)}
        onClaimTty={(surface, takeover) => sessionMainHandlers.onClaimTty(subtask.id, surface, takeover)}
        armedRemote={armedRemoteSwitch.has(subtask.id)}
        onRequestRemote={() => sessionMainHandlers.onRequestRemote(subtask.id)}
        onCancelRemote={() => sessionMainHandlers.onCancelRemote(subtask.id)}
        remoteControl={remoteControlBySession[subtask.id]}
        onToggleRemoteControl={() => sessionMainHandlers.onToggleRemoteControl(subtask.id)}
      />
    </PlanOpenContext.Provider>
    </DiffOpenContext.Provider>
    </FileRefRehypeContext.Provider>
    </FileLinkOpenContext.Provider>
  ) : null;

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
        showViewSeg={workbenchActive && wbTabs.length > 0}
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
              chatView={resolveChatView(systemConfig)}
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
              onSelectSession={selectSession}
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
              onArchive={sessionMainHandlers.onArchive}
              onDelete={sessionMainHandlers.onDelete}
              onRecover={sessionMainHandlers.onRecover}
              onMerge={sessionMainHandlers.onMerge}
              onDrop={sessionMainHandlers.onDrop}
              onSend={sessionMainHandlers.onSend}
              onBetaSend={sessionMainHandlers.onBetaSend}
              onSendSkill={sessionMainHandlers.onSendSkill}
              onStop={sessionMainHandlers.onStop}
              onApprove={sessionMainHandlers.onApprove}
              onLocalApprovalResolve={sessionMainHandlers.onLocalApprovalResolve}
              onQueueAdd={sessionMainHandlers.onQueueAdd}
              onQueueRemove={sessionMainHandlers.onQueueRemove}
              onQueueReorder={sessionMainHandlers.onQueueReorder}
              onQueueClear={sessionMainHandlers.onQueueClear}
              onQueueSendNow={sessionMainHandlers.onQueueSendNow}
              onSetMode={sessionMainHandlers.onSetMode}
              onSetModel={sessionMainHandlers.onSetModel}
              onSetEffort={sessionMainHandlers.onSetEffort}
              onRename={sessionMainHandlers.onRename}
              onShowChanges={() => { toggleInspector('changes'); }}
              activeWorkingTreeId={defaultWorkingTreeIdFor(activeSession)}
              activeBranch={
                workingTrees.find(wt => wt.id === defaultWorkingTreeIdFor(activeSession))?.branch
                ?? null
              }
              previewTarget={null}
              onClosePreview={() => { /* no-op — replaced by Sheet */ }}
              ws={ws}
              onSwitchRuntime={sessionMainHandlers.onSwitchRuntime}
              onClaimTty={sessionMainHandlers.onClaimTty}
              armedRemoteSwitch={armedRemoteSwitch}
              onRequestRemote={sessionMainHandlers.onRequestRemote}
              onCancelRemote={sessionMainHandlers.onCancelRemote}
              onToggleRemoteControl={sessionMainHandlers.onToggleRemoteControl}
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
          {mode === 'tasks' && (
            <TasksView
              tasks={tasks}
              sessions={sessions}
              workspaces={workspaces}
              ws={ws}
              activeTaskId={activeTaskId}
              activeSubtaskId={activeSubtaskId}
              managerSession={activeManagerSession}
              managerItems={managerItems}
              managerPending={managerPending}
              managerProposal={managerProposal}
              managerCards={activeTaskId ? (managerCardsByTask[activeTaskId] ?? []) : []}
              managerHandlers={managerHandlers}
              managerQueue={managerQueue}
              showManagerRaw={showManagerRaw}
              onToggleManagerRaw={() => setShowManagerRaw(v => !v)}
              onManagerMount={onManagerMount}
              onManagerSend={onManagerSend}
              onManagerStop={onManagerStop}
              onCreateSubtask={onCreateSubtask}
              onDismissSubtaskProposal={onDismissSubtaskProposal}
              onSelectTask={(taskId) => { setActiveTaskId(taskId); setActiveSubtaskId(null); }}
              onSelectSubtask={(taskId, subtaskId) => { setActiveTaskId(taskId); setActiveSubtaskId(subtaskId); }}
              subtaskMain={subtaskMain}
              onOpenSubtaskSession={(subtaskId) => {
                // Secondary affordance: pop the subtask out into full Sessions
                // mode. The default is the inline SessionMain (`subtaskMain`).
                setActiveSessionId(subtaskId);
                markSessionViewed(subtaskId);
                setMode('sessions');
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
              <Splitter side="right" varName="--sheet-w" base={600} min={420} max={1080} invert />
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
                if (t.kind === 'new-workspace') {
                  return (
                    <NewWorkspacePanel
                      workspaceRoot={systemConfig?.workspace_root ?? '~/Coding'}
                      onChange={() => void loadWorkspaces().then(setWorkspaces)}
                      onClose={() => sheetActions.closeTab(t.id)}
                    />
                  );
                }
                if (t.kind === 'workspace') {
                  const wsForTab = workspaces.find(w => w.id === t.wsId) ?? null;
                  return (
                    <WorkspaceDetailBody
                      workspace={wsForTab}
                      ws={ws}
                      systemConfig={systemConfig}
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
                  );
                }
                return null;
              }}
            />
          </>
          );
        })()}
        {((sessionViewActive || inspectorTab === 'workspaces' || inspectorTab === 'manager') && workbenchActive) && inspectorTab !== null && (
          <>
            <Splitter side="right" varName="--inspector-w" base={280} min={220} max={500} invert />
            {inspectorTab === 'manager' && subtaskActive && activeManagerTask ? (
              <ManagerInspector
                task={activeManagerTask}
                session={activeManagerSession}
                workspaces={workspaces}
                items={managerItems}
                pending={managerPending}
                handlers={managerHandlers}
                queue={managerQueue}
                onMount={onManagerMount}
                onSend={onManagerSend}
                onStop={onManagerStop}
              />
            ) : inspectorTab === 'workspaces' ? (
              <WorkspacesInspector
                workspaces={workspaces}
                selectedWsId={selectedWsId}
                openWsIds={openWsIds}
                onOpenWorkspace={openWorkspaceInSheet}
                onChange={() => void loadWorkspaces().then(setWorkspaces)}
                onNewWorkspace={openNewWorkspaceInSheet}
              />
            ) : inspectorTab === 'manager' ? (
              // Manager tab but no subtask/task context yet — render nothing
              // (the dock button only appears for subtasks, so this is rare).
              null
            ) : (
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
            )}
          </>
        )}
        <Dock
          inspectorTab={inspectorTab}
          onToggleInspector={toggleInspector}
          inspectorDisabled={!sessionViewActive}
          workspacesDisabled={!workbenchActive}
          managerVisible={subtaskActive}
          hasTerminal={terminalDockActive}
          hasSettings={wbTabs.some(t => t.kind === 'settings')}
          onToggleWbTab={toggleWbTabKind}
          wbDisabled={!workbenchActive}
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
