import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RunnerInfo, Session, Task, TerminalOptions, Workspace } from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import { EN } from './i18n/en.js';
import { ZH } from './i18n/zh.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import {
  fetchWsToken,
  loadSettings,
  loadTerminalOptions,
  loadAgents,
  loadSessions,
  loadTasks,
  loadWorkspaces,
  makeWsUrl,
} from './api.js';
import { injectComposerDraft } from './components/Composer.js';
import type { ChangeScope } from './api.js';
import { GitHistoryRequestError, loadGitHistoryCommitReachability } from './api.js';
import { useHistoryMovementRevision } from './controllers/use-history.js';
import { applyChangesScopeRequest, requestChangesDiffAnchor } from './controllers/use-changes-diff.js';
import './operations/git-history.js';
import { FileRefRehypeContext } from './transcript/items.js';
import type { PlanLifecycleState } from './transcript/apply.js';
import { DiffOpenContext, FileLinkOpenContext, ImageZoomContext, PlanOpenContext, RelativeLinkOpenContext } from './transcript/items.js';
import { ImageLightbox, type ZoomImage } from './components/ImageLightbox.js';
import { AssignSessionTaskDialog } from './components/AssignSessionTaskDialog.js';
import { Topbar } from './components/Topbar.js';
import type { Mode } from './components/Topbar.js';
import { Dock } from './components/Dock.js';
import { Toaster } from './components/Toaster.js';
import { getSnapshot as getFeedbackSnapshot, subscribe as subscribeFeedback, toast } from './feedback.js';
import { Splitter } from './components/Splitter.js';
import { Inspector } from './components/Inspector.js';
import { SettingsBody, SettingsNavInspector } from './components/SettingsBody.js';
import { BrowserPanel } from './components/BrowserPanel.js';
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
import { readWtAutoApplied, worktreeDisplayName, writeWtAutoApplied } from './presentation/wt-view.js';
import { useSessionCommands } from './controllers/use-session-commands.js';
import { reloadFailedSessionMetadata } from './controllers/session-failure-reload.js';
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
import { useWorkingTrees } from './controllers/use-working-trees.js';
import { usePanelLayout } from './controllers/use-panel-layout.js';
import { useAppZoom } from './display-prefs.js';
import { createOperationDispatcher, type OperationDispatcher } from './operations/dispatcher.js';
import {
  desktopBridge,
  type GianDesktopNavigationTarget,
} from './desktop-bridge.js';
import { subscribeDesktopNavigation } from './desktop-navigation.js';
import {
  nativeNotificationPreferencesForMigration,
  visibleSessionForNativeNotification,
} from './notifications.js';
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
import './operations/browser.js';
import './operations/onboarding.js';
import { sessionEntityKey } from './operations/session.js';
import {
  createMessageEchoSink,
  dispatchAttachmentUpload,
  wireMessageEchoSink,
} from './operations/message.js';
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
  useStoreOperationRun,
  useStorePendingOperations,
  useStoreSessionsWithOverlays,
  useStoreSettingsWithOverlays,
  useStoreTasksWithOverlays,
  useStoreWorkspacesWithOverlays,
} from './operations/use-operations.js';
import type { PendingFirstMessageValue } from './pending-first-message.js';
import { routeScreenshotCapture } from './screenshot-routing.js';

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
const HistoryInspector = lazy(() =>
  import('./components/HistoryInspector.js').then(module => ({ default: module.HistoryInspector })));
const HistoryCommitBody = lazy(() =>
  import('./components/HistoryCommitBody.js').then(module => ({ default: module.HistoryCommitBody })));
const ChangesDiffBody = lazy(() =>
  import('./components/ChangesDiffBody.js').then(module => ({ default: module.ChangesDiffBody })));
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
  useAppZoom();
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
  // The exact create attempt is App-owned so an unknown outcome cannot be
  // forgotten by closing the form or switching away from Sessions mode.
  const [sessionCreateRunId, setSessionCreateRunId] = useState<string | undefined>();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // ─── Tasks (PRD-v3) ───────────────────────────────────────────────────────
  // Tasks group Subtasks (sessions with type==='subtask' + a matching task_id).
  // Seeded from state_sync, kept fresh via the WS task:* handlers below.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeSubtaskId, setActiveSubtaskId] = useState<string | null>(null);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const itemsBySessionRef = useRef<Record<string, TranscriptItem[]>>({});
  itemsBySessionRef.current = itemsBySession;
  const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
  const [queueBySession, setQueueBySession] = useState<Record<string, QueueEntry[]>>({});
  const [mode, setMode] = useState<Mode>('tasks');
  const { workingTrees, reloadWorkingTrees } = useWorkingTrees();
  const refreshWorkingTrees = useCallback(() => {
    reloadWorkingTrees({ force: true });
  }, [reloadWorkingTrees]);
  // Active Settings section — owned here (controlled into SettingsBody +
  // SettingsNavInspector) so it survives rail collapse/restore.
  const [settingsSection, setSettingsSection] = useState<NavKey>('appearance');
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [terminalOptions, setTerminalOptions] = useState<TerminalOptions | null>(null);
  // Canonical config for the operation layer's overlay `previous` values —
  // read via ref, never the overlaid render value.
  const systemConfigRef = useRef<SystemConfig | null>(null);
  useEffect(() => { systemConfigRef.current = systemConfig; }, [systemConfig]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState<string | undefined>(undefined);
  const [assignTaskSessionId, setAssignTaskSessionId] = useState<string | null>(null);
  const [assignTaskTargetId, setAssignTaskTargetId] = useState<string | null>(null);
  const [assignTaskRunId, setAssignTaskRunId] = useState<string | undefined>();
  // Image tapped in a transcript bubble → shown in the in-app lightbox
  // (ImageZoomContext below), instead of opening a new browser tab.
  const [zoomImage, setZoomImage] = useState<ZoomImage | null>(null);
  // Native WebContentsView sits above renderer DOM. Hide it whenever a Gian
  // modal is present so confirmations, palette and lightbox remain usable.
  const feedbackState = useSyncExternalStore(
    subscribeFeedback,
    getFeedbackSnapshot,
    getFeedbackSnapshot,
  );
  const [runner, setRunner] = useState<RunnerInfo | null>(null);
  const pendingFirstMessageRef = useRef<PendingFirstMessageValue>(null);
  // New-session → New Workspace sheet round trip (issue #57 v2): the view
  // flags localStorage before opening the sheet; when the sheet's create
  // lands we return to a fresh new-session page with that workspace
  // preselected (the view's own draft restores message/agent/chips).
  const [newSessionForWs, setNewSessionForWs] = useState<string | null>(null);
  const workspaceIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    workspaceIdsRef.current = new Set(workspaces.map(w => w.id));
  }, [workspaces]);

  function handleWorkspaceListChanged() {
    void loadWorkspaces().then(list => {
      setWorkspaces(list);
      let flagged = false;
      try {
        flagged = localStorage.getItem('gian.new-session.return.v1') === '1';
        if (flagged) localStorage.removeItem('gian.new-session.return.v1');
      } catch { /* best-effort */ }
      if (!flagged) return;
      const created = list.find(w => !workspaceIdsRef.current.has(w.id) && w.name !== '__gian_root__');
      startTransition(() => setMode('sessions'));
      // '' still reopens the page (no preselect) when the new row could not
      // be identified — the view falls back to the remembered/first choice.
      setNewSessionForWs(created?.id ?? '');
    });
  }
  // Streamed plan text plus its turn-end lifecycle. Keeping completion beside
  // the text lets a successful turn hide the shortcut without deleting the
  // plan that an already-open/history detail view may still need.
  const [planStateBySession, setPlanStateBySession] = useState<
    Record<string, PlanLifecycleState>
  >({});

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadSettings().then(cfg => { if (cfg) setSystemConfig(cfg); });
    void loadTerminalOptions().then(setTerminalOptions).catch(() => undefined);
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
  const failedReloadRef = useRef<(run: Parameters<typeof reloadFailedSessionMetadata>[0]) => void>(() => {});
  failedReloadRef.current = run => {
    void reloadFailedSessionMetadata(run, setSessions).catch(() => undefined);
  };

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
      onFailed: run => failedReloadRef.current(run),
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
    wireMessageEchoSink(createMessageEchoSink(setItemsBySession, setPendingBySession));
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
  const sessionCreateRun = useStoreOperationRun(operationStore, sessionCreateRunId);
  const assignTaskRun = useStoreOperationRun(operationStore, assignTaskRunId);
  const creatingSession = pendingRuns.some(run => run.name === 'session.create');
  const forkingSession = pendingRuns.some(run => run.name === 'session.fork');
  // A failed / unknown-outcome create must not leave a stale first message in
  // pendingFirstMessageRef — the session:created handler consumes it for ANY
  // create, so an orphan would leak into the next session created anywhere.
  useEffect(() => {
    if (sessionCreateRun?.phase === 'failed' || sessionCreateRun?.phase === 'timed-out') {
      pendingFirstMessageRef.current = null;
    }
  }, [sessionCreateRun?.phase]);
  // Rendered sessions = canonical + overlays (proposal §4.3). Canonical
  // `sessions` stays untouched for refs, effects, and the reload paths.
  const displaySessions = useStoreSessionsWithOverlays(operationStore, sessions);
  // Same merge for tasks (rename/done/pin overlays) and workspaces
  // (rename/hidden/pin overlays + the whole-list reorder overlay).
  const displayTasks = useStoreTasksWithOverlays(operationStore, tasks);
  const displayWorkspaces = useStoreWorkspacesWithOverlays(operationStore, workspaces);
  // Rendered settings = canonical + settings.save overlays (Phase 3b):
  // SettingsBody, the appearance side-effect, and the Sheet's editor/app
  // lists all read the merged config so optimistic writes apply in the same
  // task they dispatch.
  const displayConfig = useStoreSettingsWithOverlays(operationStore, systemConfig);
  const assignTaskSession = assignTaskSessionId
    ? displaySessions.find(session => session.id === assignTaskSessionId) ?? null
    : null;
  const canonicalAssignTaskSession = assignTaskSessionId
    ? sessions.find(session => session.id === assignTaskSessionId) ?? null
    : null;
  useEffect(() => {
    if (assignTaskSessionId === null) return;
    // Host broadcasts canonical state before operation:result. Close on that
    // durable state as well as on confirmation so a dropped result cannot
    // leave a successfully-filed Session in a misleading retry dialog.
    const reachedSelectedTask = assignTaskTargetId !== null
      && canonicalAssignTaskSession?.type === 'subtask'
      && canonicalAssignTaskSession.task_id === assignTaskTargetId;
    const noLongerAssignable = canonicalAssignTaskSession === null
      || canonicalAssignTaskSession.archived !== 0
      || canonicalAssignTaskSession.type !== 'coding'
      || canonicalAssignTaskSession.task_id !== null;
    if (assignTaskRun?.phase !== 'confirmed' && !reachedSelectedTask && !noLongerAssignable) return;
    setAssignTaskSessionId(null);
    setAssignTaskTargetId(null);
    setAssignTaskRunId(undefined);
  }, [
    assignTaskRun?.phase,
    assignTaskSessionId,
    assignTaskTargetId,
    canonicalAssignTaskSession,
  ]);

  // Appearance side-effect reads the RENDERED config (canonical +
  // settings.save overlays) so an optimistic theme switch applies in the
  // same task it dispatches, and a rollback visibly reverts it.
  useEffect(() => {
    if (!displayConfig) return;
    document.body.setAttribute('data-theme', displayConfig.theme);
    document.body.setAttribute('data-accent', displayConfig.accent);
    document.body.setAttribute('data-density', 'cozy');
    document.body.setAttribute('data-scale-chrome', 'md');
    document.body.setAttribute('data-scale-chat', displayConfig.font_scale_chat);
    document.body.setAttribute('data-scale-code', 'md');
    document.documentElement.setAttribute('lang', displayConfig.locale);
    applyGianIconAppearance(displayConfig.theme, displayConfig.accent);
  }, [displayConfig?.theme, displayConfig?.accent,
      displayConfig?.font_scale_chat, displayConfig?.locale]);
  // Latest active session id for stable event and unread handlers.
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => {
    const notifications = desktopBridge()?.notifications;
    if (!notifications?.native) return;
    // Run migration on App startup, not only when the user happens to open
    // Settings, so existing explicitly-authorized 0.4.2 users do not lose
    // alerts during the manual 0.4.3 bridge installation.
    void notifications.updatePreferences(
      nativeNotificationPreferencesForMigration(),
    ).catch(() => undefined);
  }, []);
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
    disabled: assignTaskSessionId !== null,
    setPaletteOpen,
  });
  // Active-session transcript hydration effect. (The returned hydrate
  // callback was only consumed by the retired per-Task Manager mount.)
  const {
    historyBySession,
    loadOlder,
    retry: retryHistory,
    markLive: markSessionHistoryLive,
    rebuild: rebuildSessionHistory,
  } = useTranscriptHydration({
    activeSessionId,
    connectionReady: wsState === 'open' && authed,
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
    reloadWorkingTrees({ force: false });
  }, [reloadWorkingTrees, runtimeAuthStatus, workingTreeShape, workspaces.length]);

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
  } = useWorkbench({
    authStatus: runtimeAuthStatus,
    dispatch: ops.dispatch,
    sessions,
    activeSessionId,
    activeSession,
    activeWorkspace,
    workspaces,
    workingTrees,
    terminalPreferences: displayConfig?.terminal ?? DEFAULT_TERMINAL_PREFERENCES,
    terminalSystemShell: terminalOptions?.system_shell ?? '',
    mode,
    activeSubtaskId,
    t: appT,
  });

  // The top-right GitBadge reports the All-changes numbers, so clicking it
  // must land the Changes surface on that same scope. The scope lives in the
  // use-changes-diff store now (shared by the panel-3 inspector and panel 2's
  // multi-diff view) — these entries write the store and open the rail.
  const showChanges = (
    scope: ChangeScope,
    target?: { sessionId: string; turn: number },
  ) => {
    const wtId = viewedWorkingTreeId(activeSession);
    if (wtId) applyChangesScopeRequest(wtId, scope, target, activeSessionId);
    showChangesDiff();
  };
  const showAllChanges = () => showChanges('all');
  // A file selected from the transcript underbar's Diff panel opens the
  // Diffs rail on that exact turn's scope and jumps panel 2's multi-diff
  // view to the file's block. It intentionally steals the view.
  const showLastTurnChanges = (session: Session, turn: number, path: string) => {
    const wtId = viewedWorkingTreeId(session);
    if (wtId) {
      applyChangesScopeRequest(
        wtId,
        'lastturn',
        { sessionId: session.id, turn },
        session.id,
      );
      requestChangesDiffAnchor(wtId, path, session.id);
    }
    showChangesDiff();
  };

  // Git History (Issue #3): when a fetch reports refsChanged for the viewed
  // tree, the use-history store raises `moved` — revalidate every open commit
  // tab of that tree against the host so a commit that became unreachable
  // gets the ORPHANED tag + snapshot banner instead of silently closing.
  const historyWtId = viewedWorkingTreeId(activeSession);
  const historyMovementRevision = useHistoryMovementRevision(historyWtId, activeSessionId);
  useEffect(() => {
    if (historyMovementRevision === 0 || !historyWtId) return;
    const tabs = wbTabs.filter(t =>
      t.group === 'history' && t.kind === 'commit' && t.workingTreeId === historyWtId && t.commitSha);
    if (tabs.length === 0) return;
    let cancelled = false;
    void Promise.all(tabs.map(async tab => {
      try {
        const result = await loadGitHistoryCommitReachability(historyWtId, tab.commitSha!);
        return { sha: tab.commitSha!, unreachable: !result.reachable };
      } catch (err) {
        return {
          sha: tab.commitSha!,
          // A missing object is conclusively orphaned. Transport/Host errors
          // are inconclusive and must not clear an existing ORPHANED marker.
          unreachable: err instanceof GitHistoryRequestError && err.code === 'history_commit_not_found'
            ? true
            : undefined,
        };
      }
    })).then(results => {
      if (cancelled) return;
      const bySha = new Map(results.map(result => [result.sha, result.unreachable]));
      revalidateHistoryTabs(historyWtId, sha => bySha.get(sha));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyMovementRevision, historyWtId, activeSessionId]);

  useAppSocket({
    authStatus: runtimeAuthStatus,
    ws,
    sessionsRef,
    itemsBySessionRef,
    activeSessionIdRef,
    pendingFirstMessageRef,
    setWsState,
    setWsAttempt,
    setAuthed,
    setWorkspaces,
    refreshWorkingTrees,
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
    rebuildSessionHistory,
    operationStore,
    ops,
    translate: appT,
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

  useEffect(() => {
    const screenshot = desktopBridge()?.screenshot;
    if (!screenshot) return;
    const offCaptured = screenshot.onCaptured(capture => {
      void routeScreenshotCapture(capture, {
        findSession: sessionId =>
          sessionsRef.current.find(session => session.id === sessionId) ?? null,
        upload: (sessionId, blob, filename) =>
          dispatchAttachmentUpload(ops.dispatch, { sessionId, blob, filename }),
        onSelectSession: session => {
          selectSession(session.id);
          setActiveRail(null);
          setViewState('main');
          startTransition(() => setMode('sessions'));
        },
      }).then(result => {
        if (result.ok) return;
        toast({
          kind: 'error',
          message: appT(result.reason === 'missing-target'
            ? 'screenshot.targetMissing'
            : 'screenshot.uploadFailed'),
        });
      }).catch(() => {
        toast({ kind: 'error', message: appT('screenshot.restoreFailed') });
      });
    });
    const offError = screenshot.onError(error => {
      const key = error === 'permission-denied'
        ? 'screenshot.permissionDenied'
        : error === 'shortcut-unavailable'
          ? 'screenshot.shortcutUnavailable'
          : error === 'busy'
            ? 'screenshot.busy'
            : error === 'no-target'
              ? 'screenshot.noTarget'
              : 'screenshot.captureFailed';
      toast({ kind: 'error', message: appT(key) });
    });
    return () => {
      offCaptured();
      offError();
    };
  }, [appT, ops.dispatch, selectSession, setActiveRail, setViewState]);

  const handleDesktopNavigation = useCallback((target: GianDesktopNavigationTarget) => {
    if (target.type === 'settings') {
      setSettingsSection(target.section);
      activateRail('settings');
      return;
    }
    selectSession(target.sessionId);
    setActiveTaskId(null);
    setActiveSubtaskId(null);
    setActiveRail(null);
    setViewState('main');
    startTransition(() => setMode('sessions'));
  }, [activateRail, selectSession, setActiveRail, setViewState]);

  useEffect(() => {
    const navigation = desktopBridge()?.navigation;
    if (!navigation) return;
    return subscribeDesktopNavigation(navigation, handleDesktopNavigation);
  }, [handleDesktopNavigation]);

  const openAdoptedSession = useCallback((session: Session) => {
    // Make the HTTP result available synchronously for selection and unread
    // handling. The Host marks the independent WS broadcast with
    // origin=native-adopt, so either network delivery order is safe.
    sessionsRef.current = [
      session,
      ...sessionsRef.current.filter(candidate => candidate.id !== session.id),
    ];
    setSessions(previous => [
      session,
      ...previous.filter(candidate => candidate.id !== session.id),
    ]);
    selectSession(session.id);
    setActiveRail(null);
    setViewState('main');
    startTransition(() => setMode('sessions'));
  }, [selectSession, setActiveRail, setViewState]);

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
      if (tab.kind === 'changes') return { ...tab, name: appT('inspector.changes') };
      return tab;
    }));
  }, [appT]);

  // ─── Path breadcrumb (V2 topbar) ─────────────────────────────────────────
  // The breadcrumb (and the Diffs/Files rails) follow the VIEWED working tree
  // — the branch picker's override included.
  const activeWtForSession = activeSession
    ? workingTrees.find(t => t.id === viewedWorkingTreeId(activeSession))
    : null;
  const activeWorktreeName = activeWtForSession
    ? worktreeDisplayName(activeWtForSession)
    : null;
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
    activeWorktreeName,
    workingTrees,
    refreshWorkingTrees,
    wtView,
    setWtView,
    viewedWorkingTreeId,
    activeSessionRecovering: activeSessionId != null
      && pendingRuns.some(run => run.name === 'session.recover'
        && run.entityKey === sessionEntityKey(activeSessionId)),
    onAssignSessionTask: session => {
      setAssignTaskRunId(undefined);
      setAssignTaskTargetId(null);
      setAssignTaskSessionId(session.id);
    },
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
    groupOfRail: GROUP_OF_RAIL,
  });

  useEffect(() => {
    const notifications = desktopBridge()?.notifications;
    if (!notifications?.native) return;
    const visibleSessionId = visibleSessionForNativeNotification({
      mode,
      viewState,
      activeSessionId,
      activeSubtaskId,
    });
    const syncContext = () => {
      void notifications.setContext({
        windowFocused: document.hasFocus() && document.visibilityState === 'visible',
        visibleSessionId,
      });
    };
    syncContext();
    window.addEventListener('focus', syncContext);
    window.addEventListener('blur', syncContext);
    document.addEventListener('visibilitychange', syncContext);
    return () => {
      window.removeEventListener('focus', syncContext);
      window.removeEventListener('blur', syncContext);
      document.removeEventListener('visibilitychange', syncContext);
    };
  }, [activeSessionId, activeSubtaskId, mode, viewState]);

  const panelLayout = usePanelLayout({
    enabled: authStatus === 'authenticated' && onboarding.status === 'complete',
    panel1Visible: mode === 'spaces' || viewState !== 'workbench',
    panel2Visible: (chatPanel !== null && workbenchActive) || sheetVisible,
    inspectorVisible,
    p3Collapsed,
    setP3Collapsed,
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
      onRetryHistory={() => retryHistory(subtask.id, subtask.executor)}
      pending={pendingBySession[subtask.id] ?? false}
      queue={queueBySession[subtask.id] ?? []}
      planText={planStateBySession[subtask.id]?.text}
      planCompleted={planStateBySession[subtask.id]?.completed}
      planStatus={planStateBySession[subtask.id]?.status}
      planTurn={planStateBySession[subtask.id]?.turn}
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
      onShowLastTurnChanges={(turn, path) => showLastTurnChanges(subtask, turn, path)}
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
        sidebarCollapsed={panelLayout.railLayout.collapsed}
        onToggleSidebar={panelLayout.toggleSidebar}
        p3Available={sheetVisible && inspectorAvailable}
        p3Visible={inspectorVisible}
        onToggleP3={panelLayout.toggleInspector}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={() => navGo(-1)}
        onGoForward={() => navGo(1)}
      />
      <ImageLightbox image={zoomImage} onClose={() => setZoomImage(null)} />
      {assignTaskSession && (
        <AssignSessionTaskDialog
          sessionName={assignTaskSession.name || appT('coding.session.untitled')}
          tasks={displayTasks}
          pending={assignTaskRun?.phase === 'optimistic' || assignTaskRun?.phase === 'pending'}
          error={assignTaskRun?.phase === 'failed' || assignTaskRun?.phase === 'timed-out'
            ? (assignTaskRun.error || appT('session.assignTask.failed'))
            : null}
          onSelect={taskId => {
            setAssignTaskTargetId(taskId);
            const run = ops.dispatch('session.assignTask', {
              sessionId: assignTaskSession.id,
              taskId,
            });
            setAssignTaskRunId(run.id);
          }}
          onCancel={() => {
            setAssignTaskSessionId(null);
            setAssignTaskTargetId(null);
            setAssignTaskRunId(undefined);
          }}
        />
      )}
      {paletteOpen && <Suspense fallback={null}><CommandPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false); setPaletteInitialQuery(undefined); }}
        sessions={displaySessions}
        workspaces={displayWorkspaces}
        onJumpToSession={sid => { selectSession(sid); setMode('sessions'); setPaletteOpen(false); }}
        initialQuery={paletteInitialQuery}
      /></Suspense>}
      <div
        ref={panelLayout.bodyRef}
        className={`body ${viewState === 'workbench' ? 'wb-only' : ''}`}
        style={panelLayout.bodyStyle}
        data-panel-resizing={panelLayout.resizing ? 'true' : undefined}
      >
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
              onRetryHistory={(sessionId, executor) => retryHistory(sessionId, executor)}
              onSelectSession={selectSession}
              onNewWorkspace={openNewWorkspaceInSheet}
              openNewForWorkspace={newSessionForWs}
              onConsumeOpenNewForWorkspace={() => setNewSessionForWs(null)}
              onCreateSession={(input) => {
                // First message rides the dormant pendingFirstMessage channel:
                // the session:created socket handler consumes it and dispatches
                // the send once the session exists (use-app-socket.ts).
                pendingFirstMessageRef.current = {
                  scope: { kind: 'workspace', id: input.workspaceId },
                  text: input.firstMessage,
                  attachments: input.firstAttachments ?? [],
                };
                const run = ops.dispatch('session.create', {
                  workspaceId: input.workspaceId,
                  executor: input.executor,
                  ...(input.name ? { name: input.name } : {}),
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
                  ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
                  ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
                });
                setSessionCreateRunId(run.id);
                return run;
              }}
              sessionCreateRun={sessionCreateRun}
              creatingSession={creatingSession}
              onClearSessionCreateRun={() => setSessionCreateRunId(undefined)}
              onVerifySessionCreate={async () => {
                const fresh = await loadSessions();
                setSessions(fresh);
                setSessionCreateRunId(undefined);
              }}
              onDelete={sessionMainHandlers.onDelete}
              onReopenSession={sessionId => {
                ops.dispatch('task.reopenSubtask', { sessionId });
              }}
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
              railLayout={panelLayout.railLayout}
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
              railLayout={panelLayout.railLayout}
              onSessionAdopted={openAdoptedSession}
            />
            </Suspense>
          )}
          {mode === 'tasks' && (
            <TasksView
              mode={mode}
              onSetMode={(m) => { startTransition(() => setMode(m)); }}
              tasks={displayTasks}
              sessions={displaySessions}
              workspaces={displayWorkspaces}
              activeTaskId={activeTaskId}
              activeSubtaskId={activeSubtaskId}
              onSelectSubtask={(taskId, subtaskId) => { setActiveTaskId(taskId); setActiveSubtaskId(subtaskId); }}
              onNewWorkspace={openNewWorkspaceInSheet}
              onSetPendingFirstMessage={text => { pendingFirstMessageRef.current = text; }}
              subtaskMain={subtaskMain}
              railLayout={panelLayout.railLayout}
            />
          )}
        {chatPanel && workbenchActive && (
          <>
            <Splitter
              side="right"
              seam="main-sheet"
              ariaLabel="Resize conversation and context panels"
              onMouseDown={panelLayout.onMainSheetMouseDown}
            />
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
                planStatus={planStateBySession[chatPanel.sessionId]?.status}
                planTurn={planStateBySession[chatPanel.sessionId]?.turn}
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
              <Splitter
                side="right"
                seam="main-sheet"
                ariaLabel="Resize main and workbench panels"
                onMouseDown={panelLayout.onMainSheetMouseDown}
              />
            )}
            <Suspense fallback={null}>
            <Sheet
              tabs={wbTabs}
              activeByGroup={activeTabByGroup}
              activeGroup={activeGroup}
              actions={sheetActions}
              onAddTab={(g) => {
                if (g === 'term') addTerminalTab();
                if (g === 'browser') addBrowserTab();
              }}
              hidden={!sheetVisible}
              externalEditors={displayConfig?.external_editors ?? []}
              openApps={displayConfig?.open_apps}
              onOpenWith={handleOpenWith}
              onConfigureEditors={() => activateRail('settings')}
              renderTab={(t) => {
                if (t.kind === 'browser') {
                  return (
                    <BrowserPanel
                      tabId={t.id}
                      visible={sheetVisible
                        && activeGroup === 'browser'
                        && activeTabByGroup.browser === t.id
                        && !paletteOpen
                        && !zoomImage
                        && !assignTaskSession
                        && feedbackState.confirms.length === 0}
                    />
                  );
                }
                if (t.kind === 'settings') {
                  return (
                    <SettingsBody
                      config={displayConfig}
                      apps={apps}
                      terminalOptions={terminalOptions}
                      activeSection={settingsSection}
                      identity={identity}
                      onSignOut={signOut}
                    />
                  );
                }
                if (t.kind === 'term') {
                  return (
                    <div className="sheet-term">
                      <Suspense fallback={null}>
                      <Terminal
                        instanceKey={`term:${t.id}`}
                        preferences={displayConfig?.terminal ?? DEFAULT_TERMINAL_PREFERENCES}
                        wire={makeWorkbenchWire(ws, t.id, t.terminalProfile ?? {}, ops.dispatch)}
                      />
                      </Suspense>
                    </div>
                  );
                }
                if (t.kind === 'new-workspace') {
                  return (
                    <NewWorkspacePanel
                      onChange={handleWorkspaceListChanged}
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
                      onSessionAdopted={openAdoptedSession}
                    />
                    </Suspense>
                  );
                }
                if (t.kind === 'commit') {
                  return (
                    <Suspense fallback={null}>
                    <HistoryCommitBody tab={t} />
                    </Suspense>
                  );
                }
                if (t.kind === 'changes') {
                  return (
                    <Suspense fallback={null}>
                    <ChangesDiffBody
                      workingTreeId={activeWtForSession?.id ?? null}
                      ownerSessionId={activeSessionId}
                    />
                    </Suspense>
                  );
                }
                return null;
              }}
              renderEmpty={(group) => group === 'history' ? (
                <div className="sheet-empty history-empty" data-testid="history-empty-panel">
                  <svg className="fpe-icon" viewBox="0 0 24 24" width="34" height="34" fill="none"
                       stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 12h6 M15 12h6" />
                  </svg>
                  <span className="fpe-title">{appT('history.emptyPanel.title')}</span>
                  <span className="fpe-hint">{appT('history.emptyPanel.hint')}</span>
                </div>
              ) : null}
            />
            </Suspense>
          </>
        )}
        {inspectorVisible && inspectorKind !== null && (
          <>
            <Splitter
              side="right"
              seam="sheet-inspector"
              ariaLabel="Resize workbench and inspector panels"
              onMouseDown={panelLayout.onSheetInspectorMouseDown}
            />
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
            ) : inspectorKind === 'history' ? (
              <Suspense fallback={null}>
              <HistoryInspector
                workingTreeId={historyWtId}
                ownerSessionId={activeSessionId}
                selectedSha={(() => {
                  const tab = wbTabs.find(t => t.id === activeTabByGroup.history);
                  return tab?.kind === 'commit' && tab.workingTreeId === historyWtId
                    ? tab.commitSha ?? null
                    : null;
                })()}
                onOpenCommit={(commit) => {
                  if (historyWtId) openCommitInSheet({ workingTreeId: historyWtId, ...commit });
                }}
              />
              </Suspense>
            ) : (
              <Inspector
                tab={inspectorKind}
                workingTreeId={viewedWorkingTreeId(activeSession)}
                workingTrees={workingTrees}
                revealFile={fileReveal}
                activeSessionId={activeSessionId}
                onOpenFile={(rel, perm) => {
                  const sess = activeSession;
                  const wtId = sess ? viewedWorkingTreeId(sess) : null;
                  const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
                  if (!wt) return;
                  const abs = `${wt.path}/${rel}`;
                  void openFileInSheet(abs, perm);
                }}
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
          browserAvailable={!!window.gianDesktop?.browser}
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
