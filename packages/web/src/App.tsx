import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunnerInfo, Session, Task, Workspace } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import { EN } from './i18n/en.js';
import { ZH } from './i18n/zh.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import {
  fetchWsToken,
  loadSettings,
  loadAgents,
  loadSessions,
  loadTasks,
  loadWorkingTrees,
  loadWorkspaces,
  makeWsUrl,
} from './api.js';
import { injectComposerDraft } from './components/Composer.js';
import type { WorkingTree, ChangeScope } from './api.js';
import { FileRefRehypeContext } from './transcript/items.js';
import type { PlanLifecycleState } from './transcript/apply.js';
import { DiffOpenContext, FileLinkOpenContext, ImageZoomContext, PlanOpenContext, RelativeLinkOpenContext } from './transcript/items.js';
import { ImageLightbox, type ZoomImage } from './components/ImageLightbox.js';
import { Topbar } from './components/Topbar.js';
import type { Mode } from './components/Topbar.js';
import { Dock } from './components/Dock.js';
import { Toaster } from './components/Toaster.js';
import { toast } from './feedback.js';
import { Splitter } from './components/Splitter.js';
import { Inspector } from './components/Inspector.js';
import { SettingsBody, SettingsNavInspector } from './components/SettingsBody.js';
import type { NavKey } from './components/SettingsBody.js';
import { makeWorkbenchWire } from './components/terminal-wire.js';
import { ChatContextPanel } from './components/ChatContextPanel.js';
import { SessionSurface } from './views/SessionSurface.js';
import { NewWorkspacePanel } from './views/workspace-create.js';
import { TasksView } from './views/TasksView.js';
// The primary view is imported statically: lazy-loading it served no purpose
// (it renders on every launch) and its suspension used to tear down the whole
// shell via the root Suspense boundary (the "full-screen flash" bug).
import { CodingView } from './views/CodingView.js';
import type { SystemConfig } from '@gian/shared';
import type { QueueEntry, TranscriptItem } from './types.js';
import { applyGianIconAppearance } from './brand-icon.js';
import { ChatPanelOpenContext } from './presentation/chat-panel.js';
import { readWtAutoApplied, writeWtAutoApplied } from './presentation/wt-view.js';
import { useSessionCommands } from './controllers/use-session-commands.js';
import { useAppAuth } from './controllers/use-app-auth.js';
import { useOnboarding } from './controllers/use-onboarding.js';
import { useAppSocket } from './controllers/use-app-socket.js';
import { useTranscriptHydration } from './controllers/use-transcript-hydration.js';
import { useTopbarModel } from './controllers/use-topbar-model.js';
import { useWorkbench } from './controllers/use-workbench.js';
import { useAppShortcuts } from './controllers/use-app-shortcuts.js';
import { useSessionSelection } from './controllers/use-session-selection.js';
import { useWorkbenchLayout } from './controllers/use-workbench-layout.js';
import { useViewNav } from './controllers/use-view-nav.js';
import { createOperationDispatcher, type OperationDispatcher } from './operations/dispatcher.js';
// Importing the operations modules registers the operation definitions on
// the product registry as a side effect (session.js directly here;
// message/queue/approval via use-session-commands.js below; task/workspace
// via the entity-key/sink imports here and via use-operations.js; auth via
// use-app-auth.js; settings via use-operations.js; agents/git via
// SettingsBody/Inspector; native via spaces-native-sessions). terminal.js
// and files.js have no importing call site that pulls the definitions in
// (their dispatches are by name), so they are imported here explicitly.
import './operations/terminal.js';
import './operations/files.js';
import './operations/onboarding.js';
import { sessionEntityKey } from './operations/session.js';
import { wireMessageEchoSink } from './operations/message.js';
import { QUEUE_OVERLAY_FIELD, wireCanonicalQueueReader } from './operations/queue.js';
import { wireSubtaskCanonicalSink } from './operations/task.js';
import { SETTINGS_ENTITY_KEY, wireSettingsSink } from './operations/settings.js';
import {
  applyWorkspaceOrderOverlay,
  wireWorkspaceCanonicalSink,
  WORKSPACE_LIST_ENTITY_KEY,
  WORKSPACE_ORDER_FIELD,
} from './operations/workspace.js';
import { createOperationStore, entityFieldKey, type OperationStore } from './operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
  useStorePendingOperations,
  useStoreSessionsWithOverlays,
  useStoreSettingsWithOverlays,
  useStoreTasksWithOverlays,
  useStoreWorkspacesWithOverlays,
} from './operations/use-operations.js';

// Lazy surfaces each get their OWN Suspense boundary at the usage site below.
// A single root boundary used to wrap the whole shell: the first render of
// any of these after a click suspended it and unmounted everything (Topbar,
// Dock, sidebar) in favor of an unstyled empty fallback — the full-screen
// flash. Local boundaries confine the fallback to the surface that's loading.
const SpacesView = lazy(() =>
  import('./views/SpacesView.js').then(module => ({ default: module.SpacesView })));
const CommandPalette = lazy(() =>
  import('./components/CommandPalette.js').then(module => ({ default: module.CommandPalette })));
const Sheet = lazy(() =>
  import('./components/Sheet.js').then(module => ({ default: module.Sheet })));
const Terminal = lazy(() =>
  import('./components/Terminal.js').then(module => ({ default: module.Terminal })));
const WorkspacesInspector = lazy(() =>
  import('./components/WorkspacesPanel.js').then(module => ({ default: module.WorkspacesInspector })));
const WorkspaceDetailBody = lazy(() =>
  import('./components/WorkspacesPanel.js').then(module => ({ default: module.WorkspaceDetailBody })));
const LoginView = lazy(() =>
  import('./views/LoginView.js').then(module => ({ default: module.LoginView })));
const OnboardingView = lazy(() =>
  import('./views/OnboardingView.js').then(module => ({ default: module.OnboardingView })));

/**
 * Unresolved-reload reconcile (Phase 3a, proposal §4.3): after a targeted
 * canonical reload that is causally after the command, unresolved overlays
 * whose value matches the fresh canonical field absorb silently; mismatches
 * are dropped and surfaced as "change may not have been applied" warnings.
 * Whole-array overlays (queue, workspace order) never Object.is-match a
 * fresh canonical array, so their contents are deep-compared and the
 * overlay's own reference is fed back when equal — that absorbs instead of
 * false-mismatching.
 */
function reconcileUnresolvedEntity(
  store: OperationStore,
  entityKey: string,
  fresh: (field: string) => unknown,
  t: (key: string) => string,
): void {
  const provider = (field: string) => {
    const overlay = store.getOverlay(entityFieldKey(entityKey, field));
    const value = fresh(field);
    if (overlay && Array.isArray(overlay.value) && Array.isArray(value)) {
      if (JSON.stringify(value) === JSON.stringify(overlay.value)) {
        return overlay.value;
      }
    }
    return value;
  };
  const report = store.reconcileUnresolved(entityKey, provider);
  if (report.dropped.length > 0) {
    toast({ kind: 'warning', message: t('operations.mayNotHaveApplied') });
  }
}

export function App() {
  // useAppAuth needs the operation dispatcher (auth.logout), which is created
  // below — bind it lazily through a ref. The dispatch is only ever invoked
  // from user actions (sign-out click), long after the dispatcher exists.
  const opsDispatchRef = useRef<OperationDispatcher['dispatch'] | null>(null);
  const authDispatch = useCallback<OperationDispatcher['dispatch']>((name, input) => {
    const dispatch = opsDispatchRef.current;
    if (!dispatch) throw new Error('operation dispatcher not ready');
    return dispatch(name, input);
  }, []);
  const { status: authStatus, identity, signOut } = useAppAuth(authDispatch);
  const onboarding = useOnboarding(authStatus);
  const runtimeAuthStatus = authStatus === 'authenticated' && onboarding.status === 'complete'
    ? 'authenticated'
    : 'checking';
  // The token getter runs every reconnect, after the HTTP login boundary has
  // admitted the app shell.
  const ws = useMemo(
    () => new GianWs(makeWsUrl(), async () => (await fetchWsToken()) ?? ''),
    [],
  );
  // UI Operation Layer (Phase 2a): the store holds transient run/overlay
  // state; the dispatcher below binds it to the real socket. Canonical
  // entities still live in the useState collections underneath.
  const [operationStore] = useState(() => createOperationStore());
  const [wsState, setWsState] = useState<WsState>('closed');
  const [wsAttempt, setWsAttempt] = useState(0);
  const [authed, setAuthed] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Maps workspace_id → current HEAD branch name, populated lazily for each
  // workspace. Regular (non-worktree) sessions ride on the workspace's HEAD,
  // so SessionRow falls through to this when session.branch itself is null.
  // Refreshed on `workspace:git-updated` so external branch switches show up.
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // ─── Tasks (PRD-v3) ───────────────────────────────────────────────────────
  // Tasks group Subtasks (sessions with type==='subtask' + a matching task_id).
  // Seeded from state_sync, kept fresh via the WS task:* handlers below.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeSubtaskId, setActiveSubtaskId] = useState<string | null>(null);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueEntry[]>>({});
  const [mode, setMode] = useState<Mode>('tasks');
  const [workingTrees, setWorkingTrees] = useState<WorkingTree[]>([]);
  // Active Settings section — owned here (controlled into SettingsBody +
  // SettingsNavInspector) so it survives rail collapse/restore.
  const [settingsSection, setSettingsSection] = useState<NavKey>('appearance');
  // Mirror of the left sidebar's collapsed state for the Topbar icon. The
  // views own the real state and listen for `gian.toggle-rail`; this button
  // is the only dispatcher, so the mirror can't drift.
  const [sidebarCollapsedUi, setSidebarCollapsedUi] = useState(false);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  // Canonical config for the operation layer's overlay `previous` values —
  // read via ref, never the overlaid render value.
  const systemConfigRef = useRef<SystemConfig | null>(null);
  useEffect(() => { systemConfigRef.current = systemConfig; }, [systemConfig]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState<string | undefined>(undefined);
  // Image tapped in a transcript bubble → shown in the in-app lightbox
  // (ImageZoomContext below), instead of opening a new browser tab.
  const [zoomImage, setZoomImage] = useState<ZoomImage | null>(null);
  const [runner, setRunner] = useState<RunnerInfo | null>(null);
  const pendingFirstMessageRef = useRef<string | null>(null);
  // Streamed plan text plus its turn-end lifecycle. Keeping completion beside
  // the text lets a successful turn hide the shortcut without deleting the
  // plan that an already-open/history detail view may still need.
  const [planStateBySession, setPlanStateBySession] = useState<
    Record<string, PlanLifecycleState>
  >({});

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadSettings().then(cfg => { if (cfg) setSystemConfig(cfg); });
    void loadAgents().catch(() => undefined);
  }, [authStatus]);


  // We need the latest sessions list when handling events (to look up executor).
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const workspacesRef = useRef<Workspace[]>([]);
  useEffect(() => { workspacesRef.current = workspaces; }, [workspaces]);
  const tasksRef = useRef<Task[]>([]);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  // Canonical queues by session — read by the operation layer for queue
  // overlay `previous` values and expected-array computation.
  const queueBySessionRef = useRef<Record<string, QueueEntry[]>>({});
  useEffect(() => { queueBySessionRef.current = queueBySession; }, [queueBySession]);

  // The unresolved-reload handler (Phase 3a) is wired via a ref because it
  // needs appT (declared below) for the mismatch warning toast.
  const unresolvedReloadRef = useRef<(entityKey: string) => void>(() => {});

  // Operation dispatcher bound to the real socket. readCanonicalField reads
  // the CANONICAL sessions/queues/tasks/workspaces (via the refs, never the
  // overlaid render values) so overlay `previous` values roll back to Host
  // truth. onUnresolved is the Phase 3a unresolved-reload hook: a timed-out
  // run triggers a targeted canonical reload + reconcile (wired below).
  const ops = useMemo(
    () => createOperationDispatcher({
      store: operationStore,
      transport: ws,
      readCanonicalField: (entityKey, field) => {
        if (entityKey === SETTINGS_ENTITY_KEY) {
          return systemConfigRef.current?.[field as keyof SystemConfig];
        }
        if (entityKey.startsWith('session:')) {
          const sessionId = entityKey.slice('session:'.length);
          // The queue overlay is a whole-array value keyed `session:<id>:queue`
          // (operations/queue.ts); canonical queues live outside Session.
          if (field === QUEUE_OVERLAY_FIELD) return queueBySessionRef.current[sessionId] ?? [];
          const session = sessionsRef.current.find(s => s.id === sessionId);
          return session?.[field as keyof Session];
        }
        if (entityKey.startsWith('task:')) {
          const task = tasksRef.current.find(t => t.id === entityKey.slice('task:'.length));
          return task?.[field as keyof Task];
        }
        if (entityKey === WORKSPACE_LIST_ENTITY_KEY) {
          // The reorder overlay is the full ordered id array
          // (`workspace:list:order`, see operations/workspace.ts).
          if (field === WORKSPACE_ORDER_FIELD) return workspacesRef.current.map(w => w.id);
          return undefined;
        }
        if (entityKey.startsWith('workspace:')) {
          // Keys may carry a sub-suffix (`workspace:<id>:claude-md`).
          const workspaceId = entityKey.slice('workspace:'.length).split(':')[0];
          const workspace = workspacesRef.current.find(w => w.id === workspaceId);
          return workspace?.[field as keyof Workspace];
        }
        return undefined;
      },
      onUnresolved: entityKey => unresolvedReloadRef.current(entityKey),
    }),
    [operationStore, ws],
  );
  useEffect(() => () => ops.dispose(), [ops]);
  // Late-bound dispatch for useAppAuth (see the declaration above).
  useEffect(() => { opsDispatchRef.current = ops.dispatch; }, [ops]);

  // Operation-layer wiring for transcript- and queue-adjacent state (Phase
  // 2b): the echo sink appends send echoes / marks them failed in place
  // (proposal §9), and the canonical queue reader feeds the whole-array
  // queue overlay — it reads the RENDERED queue (canonical + any in-flight
  // queue overlay) so two rapid queue edits compose (see operations/queue.ts).
  useEffect(() => {
    wireMessageEchoSink({
      append: (sessionId, item) => {
        setItemsBySession(previous => ({
          ...previous,
          [sessionId]: [...(previous[sessionId] ?? []), item],
        }));
        setPendingBySession(previous => ({ ...previous, [sessionId]: true }));
      },
      markFailed: runId => {
        setItemsBySession(previous => {
          let touched = false;
          const next: Record<string, TranscriptItem[]> = { ...previous };
          for (const [sessionId, items] of Object.entries(previous)) {
            if (!items.some(it => it.kind === 'user' && it.sendRunId === runId)) continue;
            touched = true;
            next[sessionId] = items.map(it =>
              it.kind === 'user' && it.sendRunId === runId ? { ...it, pending: false, failed: true } : it);
          }
          return touched ? next : previous;
        });
      },
    });
    wireCanonicalQueueReader(sessionId => {
      const overlay = operationStore.getOverlay(
        entityFieldKey(sessionEntityKey(sessionId), QUEUE_OVERLAY_FIELD),
      );
      return overlay ? (overlay.value as QueueEntry[]) : (queueBySessionRef.current[sessionId] ?? []);
    });
    return () => {
      wireMessageEchoSink(null);
      wireCanonicalQueueReader(null);
    };
  }, [operationStore]);

  // REST canonical convergence sinks (Phase 3a, inventory §4 note 7): the
  // host does NOT broadcast workspace PATCH/reorder/claude_md PUT, and the
  // subtask complete/reopen REST handlers broadcast over a different channel
  // than the HTTP response — so the workspace/task operation definitions
  // patch canonical client state directly on success through these sinks
  // (and refetch, preserving the pre-migration onChange() semantics).
  useEffect(() => {
    wireWorkspaceCanonicalSink({
      upsert: workspace => setWorkspaces(previous =>
        previous.some(w => w.id === workspace.id)
          ? previous.map(w => (w.id === workspace.id ? workspace : w))
          : [...previous, workspace]),
      remove: workspaceId => setWorkspaces(previous => previous.filter(w => w.id !== workspaceId)),
      applyOrder: ids => setWorkspaces(previous => applyWorkspaceOrderOverlay(previous, ids)),
      refetch: () => { void loadWorkspaces().then(setWorkspaces); },
    });
    wireSubtaskCanonicalSink((sessionId, partial) => {
      setSessions(previous => previous.map(s => (s.id === sessionId ? { ...s, ...partial } : s)));
    });
    // Settings convergence (Phase 3b, same no-broadcast rule): the settings
    // PATCH response IS the canonical successor — patch it in so the
    // absorbed overlay leaves Host truth behind.
    wireSettingsSink({ saved: config => setSystemConfig(config) });
    return () => {
      wireWorkspaceCanonicalSink(null);
      wireSubtaskCanonicalSink(null);
      wireSettingsSink(null);
    };
  }, []);

  // In-flight operation runs drive the create/fork busy UX: true from
  // dispatch until the operation:result lands (session:created still
  // populates canonical state and arrives first, host-side).
  const pendingRuns = useStorePendingOperations(operationStore);
  const creatingSession = pendingRuns.some(run => run.name === 'session.create');
  const forkingSession = pendingRuns.some(run => run.name === 'session.fork');
  // Rendered sessions = canonical + overlays (proposal §4.3). Canonical
  // `sessions` stays untouched for refs, effects, and the reload paths.
  const displaySessions = useStoreSessionsWithOverlays(operationStore, sessions);
  // Same merge for tasks (rename/done/pin overlays) and workspaces
  // (rename/hidden/pin overlays + the whole-list reorder overlay).
  const displayTasks = useStoreTasksWithOverlays(operationStore, tasks);
  const displayWorkspaces = useStoreWorkspacesWithOverlays(operationStore, workspaces);
  // Rendered settings = canonical + settings.save overlays (Phase 3b):
  // SettingsBody, the theme/density side-effect, and the Sheet's editor/app
  // lists all read the merged config so optimistic writes apply in the same
  // task they dispatch.
  const displayConfig = useStoreSettingsWithOverlays(operationStore, systemConfig);

  // Theme/density side-effect reads the RENDERED config (canonical +
  // settings.save overlays) so an optimistic theme switch applies in the
  // same task it dispatches, and a rollback visibly reverts it.
  useEffect(() => {
    if (!displayConfig) return;
    document.body.setAttribute('data-theme', displayConfig.theme);
    document.body.setAttribute('data-accent', displayConfig.accent);
    document.body.setAttribute('data-density', displayConfig.density);
    document.body.setAttribute('data-scale-chrome', displayConfig.font_scale_chrome);
    document.body.setAttribute('data-scale-chat', displayConfig.font_scale_chat);
    document.body.setAttribute('data-scale-code', displayConfig.font_scale_code);
    document.documentElement.setAttribute('lang', displayConfig.locale);
    applyGianIconAppearance(displayConfig.theme, displayConfig.accent);
  }, [displayConfig?.theme, displayConfig?.accent, displayConfig?.density,
      displayConfig?.font_scale_chrome, displayConfig?.font_scale_chat,
      displayConfig?.font_scale_code, displayConfig?.locale]);
  // Shared "workspace created" handler — append-if-missing so the operation
  // layer's reconcile sink (which already upserts) and the view callback
  // never double-append the same workspace.
  const upsertWorkspace = useCallback((workspace: Workspace) => {
    setWorkspaces(previous =>
      previous.some(w => w.id === workspace.id) ? previous : [...previous, workspace]);
  }, []);
  // Latest active session id for stable event and unread handlers.
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => {
    if (runtimeAuthStatus !== 'authenticated') return;
    ws.send({ type: 'events:subscribe', session_id: activeSessionId });
  }, [activeSessionId, runtimeAuthStatus, ws]);

  useAppShortcuts({
    authenticated: runtimeAuthStatus === 'authenticated',
    mode,
    activeSessionId,
    activeTaskId,
    activeSubtaskId,
    sessionsRef,
    ops,
    paletteOpen,
    setPaletteOpen,
  });
  // Active-session transcript hydration effect. (The returned hydrate
  // callback was only consumed by the retired per-Task Manager mount.)
  const { historyBySession, loadOlder, markLive: markSessionHistoryLive } = useTranscriptHydration({
    activeSessionId,
    sessions,
    itemsBySession,
    setItemsBySession,
    setPlanStateBySession,
  });

  const activeSession =
    displaySessions.find(s => s.id === activeSessionId)
    ?? null;
  const activeWorkspace = activeSession
    ? displayWorkspaces.find(w => w.id === activeSession.workspace_id) ?? null
    : null;

  // Refresh working trees whenever the workspace or session set changes —
  // a new session with a worktree, or a merged/dropped one, changes the list.
  const workingTreeShape = useMemo(() => JSON.stringify({
    workspaces: workspaces.map(workspace => [workspace.id, workspace.name, workspace.path]),
    sessions: sessions
      .filter(session => session.worktree_path)
      .map(session => [
        session.id,
        session.name,
        session.workspace_id,
        session.worktree_path,
        session.branch,
        session.archived,
      ]),
  }), [workspaces, sessions]);
  useEffect(() => {
    if (runtimeAuthStatus !== 'authenticated' || workspaces.length === 0) return;
    void loadWorkingTrees().then(setWorkingTrees);
  }, [runtimeAuthStatus, workingTreeShape]);

  // Tracks the last auto-applied worktree detection — see the auto-switch
  // effect next to appT below (appT is declared late in this component).
  const wtAutoAppliedRef = useRef<{ sessionId: string; path: string } | null>(null);

  // Default working tree for the Files view: follow the focused session.
  // If a session has a live worktree, use it; otherwise use that session's
  // workspace primary tree; otherwise the first workspace.
  const locale = displayConfig?.locale ?? 'en';
  const appT = useCallback((key: string) => {
    const messages = locale === 'zh-CN' ? ZH : EN;
    return messages[key] ?? EN[key] ?? key;
  }, [locale]);

  // Unresolved-reload wiring (Phase 3a, proposal §4.3): a timed-out run
  // (timeout expiry or socket close — fired by the dispatcher's onUnresolved)
  // triggers a targeted canonical reload of the affected entity, causally
  // after the command, then reconciles the run's unresolved overlays against
  // the fresh values: matches absorb silently, mismatches drop with a
  // "change may not have been applied" warning. Covers the session (incl.
  // queue), task, and workspace entity prefixes; `pending:` create keys and
  // `approval:` runs have no overlays to reconcile.
  const reloadUnresolvedEntity = useCallback(async (entityKey: string) => {
    if (entityKey.startsWith('session:')) {
      const sessionId = entityKey.slice('session:'.length).split(':')[0]!;
      const fresh = await loadSessions();
      const session = fresh.find(s => s.id === sessionId);
      reconcileUnresolvedEntity(operationStore, entityKey, field =>
        // Canonical queues live outside Session (no targeted queue loader —
        // read the latest canonical queue state).
        field === QUEUE_OVERLAY_FIELD
          ? queueBySessionRef.current[sessionId] ?? []
          : session?.[field as keyof Session], appT);
      setSessions(fresh);
      return;
    }
    if (entityKey.startsWith('task:')) {
      const taskId = entityKey.slice('task:'.length);
      const fresh = await loadTasks();
      const task = fresh.find(t => t.id === taskId);
      reconcileUnresolvedEntity(operationStore, entityKey,
        field => task?.[field as keyof Task], appT);
      setTasks(fresh);
      return;
    }
    if (entityKey === WORKSPACE_LIST_ENTITY_KEY || entityKey.startsWith('workspace:')) {
      const fresh = await loadWorkspaces();
      if (entityKey === WORKSPACE_LIST_ENTITY_KEY) {
        reconcileUnresolvedEntity(operationStore, entityKey, () => fresh.map(w => w.id), appT);
      } else {
        const workspaceId = entityKey.slice('workspace:'.length).split(':')[0];
        const workspace = fresh.find(w => w.id === workspaceId);
        reconcileUnresolvedEntity(operationStore, entityKey,
          field => workspace?.[field as keyof Workspace], appT);
      }
      setWorkspaces(fresh);
    }
  }, [operationStore, appT]);
  useEffect(() => {
    unresolvedReloadRef.current = entityKey => { void reloadUnresolvedEntity(entityKey); };
  }, [reloadUnresolvedEntity]);

  const {
    wtView,
    setWtView,
    apps,
    wbTabs,
    setWbTabs,
    activeTabByGroup,
    viewState,
    activeRail,
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
    activateRail,
    toggleRail,
    openFileInSheet,
    openRelativeFileHref,
    openDiffInSheet,
    openTranscriptDiffInSheet,
    openChatPanel,
    addTerminalTab,
    openWorkspaceInSheet,
    openNewWorkspaceInSheet,
  } = useWorkbench({
    authStatus: runtimeAuthStatus,
    dispatch: ops.dispatch,
    sessions,
    activeSessionId,
    activeSession,
    activeWorkspace,
    workspaces,
    workingTrees,
    mode,
    activeSubtaskId,
    t: appT,
  });

  // The top-right GitBadge reports the All-changes numbers, so clicking it
  // must land the Changes inspector on that same scope (requestId forces a
  // re-apply even when the inspector is already mounted on another scope).
  const [changesScopeRequest, setChangesScopeRequest] = useState<{ scope: ChangeScope; requestId: number } | null>(null);
  const showChanges = (scope: ChangeScope) => {
    setChangesScopeRequest({ scope, requestId: Date.now() });
    activateRail('diffs');
  };
  const showAllChanges = () => showChanges('all');
  // The transcript underbar's Last-turn chip jumps straight to the Diffs
  // inspector pinned to that scope (no inline file-list panel).
  const showLastTurnChanges = () => showChanges('lastturn');

  useAppSocket({
    authStatus: runtimeAuthStatus,
    ws,
    sessionsRef,
    activeSessionIdRef,
    pendingFirstMessageRef,
    setWsState,
    setWsAttempt,
    setAuthed,
    setWorkspaces,
    setWorkingTrees,
    setSessions,
    setTasks,
    setSystemConfig,
    setRunner,
    setActiveSessionId,
    setActiveTaskId,
    setActiveSubtaskId,
    setItemsBySession,
    setPendingBySession,
    setQueueBySession,
    setPlanStateBySession,
    markSessionHistoryLive,
    operationStore,
    ops,
  });

  const selectSession = useSessionSelection({
    mode,
    activeSubtaskId,
    sessionsRef,
    activeSessionIdRef,
    setActiveSessionId,
    setChatPanel,
    ops,
  });

  // Worktree auto-switch: when the host detects the agent created its own
  // worktree mid-session (`git worktree add` → session.detected_worktree_path),
  // switch the VIEW-level working tree to it. The ref makes this fire exactly
  // once per (session, detected path) pair — the host only updates the stored
  // path when it changes — so a later manual pick in the branch dropdown wins
  // until the next detection. The applied-path marker is also persisted
  // (`gian.wt.auto.<sid>`): without it a reload forgot the pair and re-applied
  // a stale detection over the user's newer manual pick. workingTrees is a
  // dep so a listing refresh that discovers the new tree re-fires the effect.
  useEffect(() => {
    const detected = activeSession?.detected_worktree_path;
    if (!activeSession || !detected) return;
    const last = wtAutoAppliedRef.current;
    if (last && last.sessionId === activeSession.id && last.path === detected) return;
    if (readWtAutoApplied(activeSession.id) === detected) {
      // Already applied before a reload — keep the ref in sync and leave any
      // newer manual pick alone.
      wtAutoAppliedRef.current = { sessionId: activeSession.id, path: detected };
      return;
    }
    const tree = workingTrees.find(t => t.path === detected);
    if (!tree) return;
    wtAutoAppliedRef.current = { sessionId: activeSession.id, path: detected };
    writeWtAutoApplied(activeSession.id, detected);
    setWtView({ sessionId: activeSession.id, wtId: tree.id });
    toast({
      kind: 'success',
      message: appT('worktree.autoSwitched').replace('{name}', tree.branch ?? tree.label),
    });
  }, [activeSession?.id, activeSession?.detected_worktree_path, workingTrees, appT]);

  useEffect(() => {
    setWbTabs(prev => prev.map(tab => {
      if (tab.kind === 'settings') return { ...tab, name: appT('sheet.tab.settings') };
      if (tab.kind === 'plan') return { ...tab, name: appT('sheet.tab.plan') };
      return tab;
    }));
  }, [appT]);

  // ─── Path breadcrumb (V2 topbar) ─────────────────────────────────────────
  // The breadcrumb (and the Diffs/Files rails) follow the VIEWED working tree
  // — the branch picker's override included.
  const activeWtForSession = activeSession
    ? workingTrees.find(t => t.id === viewedWorkingTreeId(activeSession))
    : null;
  // An overridden tree may have no branch (detached / primary); fall back to
  // its label so the segment still has something to show.
  const activeBranch = activeWtForSession?.branch ?? activeWtForSession?.label ?? null;
  const {
    pathSegments,
    sessionMenu,
    branchMenu,
    onRenameSubmit: handleRenameSubmit,
    onRenameCancel: handleRenameCancel,
  } = useTopbarModel({
    mode,
    activeTaskId,
    activeSubtaskId,
    activeSession,
    activeWorkspace,
    activeBranch,
    workingTrees,
    wtView,
    setWtView,
    viewedWorkingTreeId,
    activeSessionRecovering: activeSessionId != null
      && pendingRuns.some(run => run.name === 'session.recover'
        && run.entityKey === sessionEntityKey(activeSessionId)),
    ops,
    t: appT,
  });


  const sessionMainHandlers = useSessionCommands({
    ops,
    sessionsRef,
  });

  const subtaskActive = mode === 'tasks' && !!activeSubtaskId && !!activeSession;
  const {
    sessionViewActive,
    workbenchActive,
    activeGroup,
    sheetMounted,
    sheetVisible,
    inspectorKind,
    inspectorAvailable,
    inspectorVisible,
    openWorkspaceIds: openWsIds,
    selectedWorkspaceId: selectedWsId,
  } = useWorkbenchLayout({
    mode,
    subtaskActive,
    activeRail,
    tabs: wbTabs,
    activeTabByGroup,
    viewState,
    chatPanel,
    filesInspectorSuppressed,
    p3Collapsed,
    setP3Collapsed,
    groupOfRail: GROUP_OF_RAIL,
  });

  // Topbar ‹ › history: sidebar view (mode) + conversation selection only.
  const { canGoBack, canGoForward, navigate: navGo } = useViewNav({
    mode,
    activeSessionId,
    activeTaskId,
    activeSubtaskId,
    setMode,
    setActiveSessionId,
    setActiveTaskId,
    setActiveSubtaskId,
  });

  /** Panel-3 settings nav click: make sure the settings tab exists and is
   *  visible, then switch panel 2 to the chosen section. */
  function onSettingsNavSelect(key: NavKey): void {
    activateRail('settings');
    setSettingsSection(key);
  }

  // A Subtask IS a Session. When one is selected in Tasks mode we render the
  // exact same <SessionMain> that CodingView renders in Sessions mode — wired
  // to the identical App-level handlers (rebound to the subtask's id) and the
  // same transcript context providers. The activeSessionId-sync effect above
  // keeps `activeSession`, `itemsBySession`, the Sheet, and the Inspector all
  // pointed at this subtask. TasksView renders this element where the old
  // "Open in Sessions" placeholder used to live (inside its own `.main`).
  const subtask = subtaskActive ? activeSession : null;
  const subtaskWorkspace = subtask
    ? displayWorkspaces.find(w => w.id === subtask.workspace_id) ?? null
    : null;
  const subtaskWorkingTreeId = defaultWorkingTreeIdFor(subtask);
  const subtaskMain = subtask ? (
    <SessionSurface
      session={subtask}
      workspace={subtaskWorkspace}
      items={itemsBySession[subtask.id] ?? []}
      hydrated={historyBySession[subtask.id]?.phase === 'page'
        || historyBySession[subtask.id]?.phase === 'complete'}
      history={historyBySession[subtask.id]}
      onLoadOlder={() => loadOlder(subtask.id, subtask.executor)}
      pending={pendingBySession[subtask.id] ?? false}
      queue={queueBySession[subtask.id] ?? []}
      planText={planStateBySession[subtask.id]?.text}
      planCompleted={planStateBySession[subtask.id]?.completed}
      commands={sessionMainHandlers}
      workingTreeId={subtaskWorkingTreeId}
      branch={workingTrees.find(tree => tree.id === subtaskWorkingTreeId)?.branch ?? null}
      onOpenFile={(absolutePath, line) => { void openFileInSheet(absolutePath, false, line); }}
      onOpenRelativeFile={openRelativeFileHref}
      onOpenDiff={item => { void openTranscriptDiffInSheet(item); }}
      onOpenPlan={payload => openChatPanel(subtask.id, { kind: 'plan', id: payload.id })}
      onOpenChat={request => openChatPanel(subtask.id, request)}
      fileRehype={fileRehype}
      onReopen={() => { ops.dispatch('task.reopenSubtask', { sessionId: subtask.id }); }}
      onShowChanges={showAllChanges}
      onShowLastTurnChanges={showLastTurnChanges}
    />
  ) : null;

  if (authStatus === 'checking') {
    return (
      <LocaleProvider locale={locale}>
        <div className="app-loading" role="status" data-testid="auth-checking" />
      </LocaleProvider>
    );
  }

  if (authStatus === 'login') {
    // Login dispatches auth.login / auth.githubLogin operations (Phase 3b),
    // so it renders inside the operation providers even though the rest of
    // the app shell is not mounted yet.
    return (
      <LocaleProvider locale={locale}>
      <OperationStoreProvider store={operationStore}>
      <OperationDispatcherProvider dispatcher={ops}>
        <Suspense fallback={<div className="app-loading" role="status" />}>
          <LoginView />
        </Suspense>
      </OperationDispatcherProvider>
      </OperationStoreProvider>
      </LocaleProvider>
    );
  }

  if (onboarding.status === 'checking') {
    return (
      <LocaleProvider locale={locale}>
        <div className="app-loading" role="status" data-testid="onboarding-checking" />
      </LocaleProvider>
    );
  }

  if (onboarding.status === 'required') {
    // Onboarding dispatches agent.*/onboarding.*/workspace.pickFolder
    // operations (Phase 3b) — providers for the same reason as login.
    return (
      <LocaleProvider locale={locale}>
      <OperationStoreProvider store={operationStore}>
      <OperationDispatcherProvider dispatcher={ops}>
        <Suspense fallback={<div className="app-loading" role="status" />}>
          <OnboardingView
            identity={identity}
            initialState={onboarding.state}
            initialError={onboarding.error}
            onComplete={onboarding.complete}
          />
        </Suspense>
      </OperationDispatcherProvider>
      </OperationStoreProvider>
      </LocaleProvider>
    );
  }

  return (
    <LocaleProvider locale={locale}>
    <OperationStoreProvider store={operationStore}>
    <OperationDispatcherProvider dispatcher={ops}>
    <ImageZoomContext.Provider value={(src, alt) => setZoomImage({ src, alt })}>
    <div
      className="app"
      data-testid="app-shell"
      data-connection={wsState === 'open' && authed ? 'ready' : wsState}
    >
      <Topbar
        pathSegments={pathSegments}
        sessionMenu={sessionMenu}
        branchMenu={branchMenu}
        onRenameSubmit={handleRenameSubmit}
        onRenameCancel={handleRenameCancel}
        sidebarCollapsed={sidebarCollapsedUi}
        onToggleSidebar={() => {
          window.dispatchEvent(new CustomEvent('gian.toggle-rail'));
          setSidebarCollapsedUi(c => !c);
        }}
        p3Available={sheetVisible && inspectorAvailable}
        p3Visible={inspectorVisible}
        onToggleP3={() => setP3Collapsed(c => !c)}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={() => navGo(-1)}
        onGoForward={() => navGo(1)}
      />
      <ImageLightbox image={zoomImage} onClose={() => setZoomImage(null)} />
      {paletteOpen && <Suspense fallback={null}><CommandPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false); setPaletteInitialQuery(undefined); }}
        sessions={displaySessions}
        workspaces={displayWorkspaces}
        onJumpToSession={sid => { selectSession(sid); setMode('sessions'); setPaletteOpen(false); }}
        initialQuery={paletteInitialQuery}
      /></Suspense>}
      <div className={`body ${viewState === 'workbench' ? 'wb-only' : ''}`}>
          {mode === 'sessions' && (
          <FileLinkOpenContext.Provider value={(absPath, line) => { void openFileInSheet(absPath, false, line); }}>
          <RelativeLinkOpenContext.Provider value={openRelativeFileHref}>
          <FileRefRehypeContext.Provider value={fileRehype}>
          <DiffOpenContext.Provider value={(item) => { void openTranscriptDiffInSheet(item); }}>
          <PlanOpenContext.Provider value={(payload) => {
            if (activeSessionId) openChatPanel(activeSessionId, { kind: 'plan', id: payload.id });
          }}>
          <ChatPanelOpenContext.Provider value={(request) => {
            if (activeSessionId) openChatPanel(activeSessionId, request);
          }}>
            <CodingView
              mode={mode}
              onSetAppMode={(m) => { startTransition(() => setMode(m)); }}
              onOpenSearch={() => setPaletteOpen(true)}
              workspaces={displayWorkspaces}
              sessions={displaySessions}
              activeSession={activeSession}
              activeWorkspace={activeWorkspace}
              activeSessionId={activeSessionId}
              itemsBySession={itemsBySession}
              pendingBySession={pendingBySession}
              queueBySession={queueBySession}
              planStateBySession={planStateBySession}
              historyBySession={historyBySession}
              onLoadOlder={(sessionId, executor) => loadOlder(sessionId, executor)}
              onSelectSession={selectSession}
              onWorkspaceCreated={upsertWorkspace}
              onCreateSession={(input) => {
                ops.dispatch('session.create', {
                  workspaceId: input.workspaceId,
                  executor: input.executor,
                  ...(input.name ? { name: input.name } : {}),
                });
              }}
              creatingSession={creatingSession}
              onDelete={sessionMainHandlers.onDelete}
              onPinSession={sessionMainHandlers.onPin}
              onArchiveSession={sessionId => sessionMainHandlers.onArchive(sessionId, true)}
              onToggleWorkspacePin={(workspace) => {
                ops.dispatch('workspace.pin', { workspaceId: workspace.id, pinned: workspace.pinned !== 1 });
              }}
              onSend={sessionMainHandlers.onSend}
              onSendSkill={sessionMainHandlers.onSendSkill}
              onStop={sessionMainHandlers.onStop}
              onApprove={sessionMainHandlers.onApprove}
              onQueueAdd={sessionMainHandlers.onQueueAdd}
              onQueueRemove={sessionMainHandlers.onQueueRemove}
              onQueueUpdate={sessionMainHandlers.onQueueUpdate}
              onQueueClear={sessionMainHandlers.onQueueClear}
              onQueueSendNow={sessionMainHandlers.onQueueSendNow}
              onSteer={sessionMainHandlers.onSteer}
              onSetMode={sessionMainHandlers.onSetMode}
              onSetModel={sessionMainHandlers.onSetModel}
              onSetEffort={sessionMainHandlers.onSetEffort}
              onSetServiceTier={sessionMainHandlers.onSetServiceTier}
              onSetNativeConfig={sessionMainHandlers.onSetNativeConfig}
              onShowChanges={showAllChanges}
              onShowLastTurnChanges={showLastTurnChanges}
              activeWorkingTreeId={viewedWorkingTreeId(activeSession)}
              activeBranch={
                workingTrees.find(wt => wt.id === viewedWorkingTreeId(activeSession))?.branch
                ?? null
              }
            />
          </ChatPanelOpenContext.Provider>
          </PlanOpenContext.Provider>
          </DiffOpenContext.Provider>
          </FileRefRehypeContext.Provider>
          </RelativeLinkOpenContext.Provider>
          </FileLinkOpenContext.Provider>
          )}
          {mode === 'spaces' && (
            <Suspense fallback={null}>
            <SpacesView
              workspaces={displayWorkspaces}
              systemConfig={systemConfig}
              ws={ws}
              onChange={() => void loadWorkspaces().then(setWorkspaces)}
            />
            </Suspense>
          )}
          {mode === 'tasks' && (
            <TasksView
              mode={mode}
              onSetMode={(m) => { startTransition(() => setMode(m)); }}
              onOpenSearch={() => setPaletteOpen(true)}
              tasks={displayTasks}
              sessions={displaySessions}
              workspaces={displayWorkspaces}
              activeTaskId={activeTaskId}
              activeSubtaskId={activeSubtaskId}
              onSelectSubtask={(taskId, subtaskId) => { setActiveTaskId(taskId); setActiveSubtaskId(subtaskId); }}
              onWorkspaceCreated={upsertWorkspace}
              subtaskMain={subtaskMain}
            />
          )}
        {chatPanel && workbenchActive && (
          <>
            <Splitter side="right" varName="--sheet-w" base={600} min={360} max={1080} invert />
            <FileLinkOpenContext.Provider value={(absPath, line) => {
              void openFileInSheet(absPath, false, line);
            }}>
            <RelativeLinkOpenContext.Provider value={openRelativeFileHref}>
            <FileRefRehypeContext.Provider value={fileRehype}>
              <ChatContextPanel
                target={chatPanel}
                items={itemsBySession[chatPanel.sessionId] ?? []}
                planText={planStateBySession[chatPanel.sessionId]?.text}
                planCompleted={planStateBySession[chatPanel.sessionId]?.completed}
                onClose={() => setChatPanel(null)}
              />
            </FileRefRehypeContext.Provider>
            </RelativeLinkOpenContext.Provider>
            </FileLinkOpenContext.Provider>
          </>
        )}
        {sheetMounted && (
          <>
            {sheetVisible && viewState !== 'workbench' && (
              <Splitter side="right" varName="--sheet-w" base={600} min={420} max={1080} invert />
            )}
            <Suspense fallback={null}>
            <Sheet
              tabs={wbTabs}
              activeByGroup={activeTabByGroup}
              activeGroup={activeGroup}
              actions={sheetActions}
              onAddTab={(g) => {
                if (g === 'term') addTerminalTab();
              }}
              hidden={!sheetVisible}
              externalEditors={displayConfig?.external_editors ?? []}
              openApps={displayConfig?.open_apps}
              onOpenWith={handleOpenWith}
              onConfigureEditors={() => activateRail('settings')}
              renderTab={(t) => {
                if (t.kind === 'settings') {
                  return (
                    <SettingsBody
                      config={displayConfig}
                      apps={apps}
                      activeSection={settingsSection}
                      identity={identity}
                      onSignOut={signOut}
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
                      <Suspense fallback={null}>
                      <Terminal
                        instanceKey={`term:${t.id}`}
                        wire={makeWorkbenchWire(ws, t.id, wbCwd ? { cwd: wbCwd } : {}, ops.dispatch)}
                      />
                      </Suspense>
                    </div>
                  );
                }
                if (t.kind === 'new-workspace') {
                  return (
                    <NewWorkspacePanel
                      projectRoot={systemConfig?.workspace_root ?? '~/Coding'}
                      onChange={() => void loadWorkspaces().then(setWorkspaces)}
                      onClose={() => sheetActions.closeTab(t.id)}
                    />
                  );
                }
                if (t.kind === 'workspace') {
                  const wsForTab = displayWorkspaces.find(w => w.id === t.wsId) ?? null;
                  return (
                    <Suspense fallback={null}>
                    <WorkspaceDetailBody
                      workspace={wsForTab}
                      ws={ws}
                      systemConfig={systemConfig}
                      onChange={() => void loadWorkspaces().then(setWorkspaces)}
                    />
                    </Suspense>
                  );
                }
                return null;
              }}
            />
            </Suspense>
          </>
        )}
        {inspectorVisible && inspectorKind !== null && (
          <>
            <Splitter side="right" varName="--inspector-w" base={280} min={220} max={500} invert />
            {inspectorKind === 'workspaces' ? (
              <Suspense fallback={null}>
              <WorkspacesInspector
                workspaces={displayWorkspaces}
                selectedWsId={selectedWsId}
                openWsIds={openWsIds}
                onOpenWorkspace={openWorkspaceInSheet}
                onNewWorkspace={openNewWorkspaceInSheet}
              />
              </Suspense>
            ) : inspectorKind === 'settings' ? (
              <SettingsNavInspector active={settingsSection} onSelect={onSettingsNavSelect} />
            ) : (
              <Inspector
                tab={inspectorKind}
                workingTreeId={viewedWorkingTreeId(activeSession)}
                workingTrees={workingTrees}
                revealFile={fileReveal}
                scopeRequest={changesScopeRequest}
                activeSessionId={activeSessionId}
                onOpenFile={(rel, perm) => {
                  const sess = activeSession;
                  const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
                  const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
                  if (!wt) return;
                  const abs = `${wt.path}/${rel}`;
                  void openFileInSheet(abs, perm);
                }}
                onOpenDiff={(rel, perm, scope, sha, base) => { void openDiffInSheet(rel, perm, scope, sha, base); }}
                canCommit={!!activeSession}
                onComposePrompt={text => { if (activeSessionId) injectComposerDraft(activeSessionId, text); }}
              />
            )}
          </>
        )}
        <Dock
          activeRail={chatPanel ? null : activeRail}
          onToggleRail={toggleRail}
          sessionRailsDisabled={!sessionViewActive}
          workbenchDisabled={!workbenchActive}
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
    </ImageZoomContext.Provider>
    </OperationDispatcherProvider>
    </OperationStoreProvider>
    </LocaleProvider>
  );
}
