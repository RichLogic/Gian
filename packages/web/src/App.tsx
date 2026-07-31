import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Bot, RunnerInfo, Session, Task, Workspace } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import { EN } from './i18n/en.js';
import { ZH } from './i18n/zh.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import {
  fetchWsToken,
  loadBots,
  loadSettings,
  loadWorkingTrees,
  loadWorkspaces,
  makeWsUrl,
  reopenSubtask,
} from './api.js';
import { injectComposerDraft } from './components/Composer.js';
import type { WorkingTree } from './api.js';
import { FileRefRehypeContext } from './transcript/items.js';
import type { PlanLifecycleState } from './transcript/apply.js';
import { DiffOpenContext, FileLinkOpenContext, ImageZoomContext, PlanOpenContext } from './transcript/items.js';
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
import { BrowserBody, browserHostOf } from './components/BrowserBody.js';
import { ChatContextPanel } from './components/ChatContextPanel.js';
import { SessionSurface } from './views/SessionSurface.js';
import { NewWorkspacePanel } from './views/workspace-create.js';
import { TasksView, ManagerInspector } from './views/TasksView.js';
import type { SystemConfig } from '@gian/shared';
import type { QueueEntry, TranscriptItem } from './types.js';
import { applyGianIconAppearance } from './brand-icon.js';
import {
  BrowserLinkOpenContext,
  ChatPanelOpenContext,
} from './presentation/chat-panel.js';
import { useSessionCommands } from './controllers/use-session-commands.js';
import { useAppAuth } from './controllers/use-app-auth.js';
import { useAppSocket } from './controllers/use-app-socket.js';
import { useTranscriptHydration } from './controllers/use-transcript-hydration.js';
import { useTopbarModel } from './controllers/use-topbar-model.js';
import { useTaskManager } from './controllers/use-task-manager.js';
import { useWorkbench } from './controllers/use-workbench.js';
import { useAppShortcuts } from './controllers/use-app-shortcuts.js';
import { useSessionSelection } from './controllers/use-session-selection.js';
import { useWorkbenchLayout } from './controllers/use-workbench-layout.js';

const CodingView = lazy(() =>
  import('./views/CodingView.js').then(module => ({ default: module.CodingView })));
const SpacesView = lazy(() =>
  import('./views/SpacesView.js').then(module => ({ default: module.SpacesView })));
const BotsView = lazy(() =>
  import('./views/BotsView.js').then(module => ({ default: module.BotsView })));
const FilesView = lazy(() =>
  import('./views/FilesView.js').then(module => ({ default: module.FilesView })));
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

export function App() {
  const { status: authStatus, onLoginOk } = useAppAuth();
  // The token getter runs every reconnect, after the HTTP login boundary has
  // admitted the app shell.
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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // ─── Tasks (PRD-v3) ───────────────────────────────────────────────────────
  // Tasks group Subtasks (sessions with type==='subtask' + a matching task_id).
  // Seeded from state_sync, kept fresh via the WS task:* handlers below.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeSubtaskId, setActiveSubtaskId] = useState<string | null>(null);
  // Per-Task static manual subtask-created cards that live in the Manager
  // conversation. App-level so they survive
  // ManagerPanel unmount when you navigate between tasks/subtasks. Each card's
  // `acked` flag tracks whether its context note has been folded into a Manager
  // message yet.
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
  const [bots, setBots] = useState<Bot[]>([]);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState<string | undefined>(undefined);
  // Image tapped in a transcript bubble → shown in the in-app lightbox
  // (ImageZoomContext below), instead of opening a new browser tab.
  const [zoomImage, setZoomImage] = useState<ZoomImage | null>(null);
  const [runner, setRunner] = useState<RunnerInfo | null>(null);
  const pendingFirstMessageRef = useRef<string | null>(null);
  // True from `session:create` dispatch until `session:created` arrives. Drives
  // the "Creating…" busy state in NewSessionView so the form doesn't look dead
  // while the host spins up a session + worktree.
  const [creatingSession, setCreatingSession] = useState(false);
  // Same lifecycle as creatingSession but only set during a fork. Drives a
  // global "Forking session…" toast — the user is mid-session when they
  // fork, so without feedback the click looks like a no-op.
  const [forkingSession, setForkingSession] = useState(false);
  // Streamed plan text plus its turn-end lifecycle. Keeping completion beside
  // the text lets a successful turn hide the shortcut without deleting the
  // plan that an already-open/history detail view may still need.
  const [planStateBySession, setPlanStateBySession] = useState<
    Record<string, PlanLifecycleState>
  >({});

  useEffect(() => {
    if (!systemConfig) return;
    document.body.setAttribute('data-theme', systemConfig.theme);
    document.body.setAttribute('data-accent', systemConfig.accent);
    document.body.setAttribute('data-density', systemConfig.density);
    document.body.setAttribute('data-scale-chrome', systemConfig.font_scale_chrome);
    document.body.setAttribute('data-scale-chat', systemConfig.font_scale_chat);
    document.body.setAttribute('data-scale-code', systemConfig.font_scale_code);
    document.documentElement.setAttribute('lang', systemConfig.locale);
    applyGianIconAppearance(systemConfig.theme, systemConfig.accent);
  }, [systemConfig?.theme, systemConfig?.accent, systemConfig?.density,
      systemConfig?.font_scale_chrome, systemConfig?.font_scale_chat,
      systemConfig?.font_scale_code, systemConfig?.locale]);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadSettings().then(cfg => { if (cfg) setSystemConfig(cfg); });
  }, [authStatus]);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadBots().then(setBots);
  }, [authStatus]);


  // We need the latest sessions list when handling events (to look up executor).
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const workspacesRef = useRef<Workspace[]>([]);
  useEffect(() => { workspacesRef.current = workspaces; }, [workspaces]);
  // Latest active session id for stable event and unread handlers.
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  useAppShortcuts({
    authenticated: authStatus === 'authenticated',
    mode,
    activeSessionId,
    activeTaskId,
    activeSubtaskId,
    sessionsRef,
    ws,
    paletteOpen,
    setPaletteOpen,
    setCreatingSession,
    setForkingSession,
  });
  const hydrateTranscript = useTranscriptHydration({
    activeSessionId,
    sessions,
    itemsBySession,
    setItemsBySession,
    setPlanStateBySession,
  });

  const activeSession =
    sessions.find(s => s.id === activeSessionId)
    ?? null;
  const activeWorkspace = activeSession
    ? workspaces.find(w => w.id === activeSession.workspace_id) ?? null
    : null;

  // Refresh working trees whenever the workspace or session set changes —
  // a new session with a worktree, or a merged/dropped one, changes the list.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadWorkingTrees().then(setWorkingTrees);
  }, [workspaces, sessions, authStatus]);

  // Tracks the last auto-applied worktree detection — see the auto-switch
  // effect next to appT below (appT is declared late in this component).
  const wtAutoAppliedRef = useRef<{ sessionId: string; path: string } | null>(null);

  // Default working tree for the Files view: follow the focused session.
  // If a session has a live worktree, use it; otherwise use that session's
  // workspace primary tree; otherwise the first workspace.
  const locale = systemConfig?.locale ?? 'en';
  const appT = useCallback((key: string) => {
    const messages = locale === 'zh-CN' ? ZH : EN;
    return messages[key] ?? EN[key] ?? key;
  }, [locale]);

  const {
    wtView,
    setWtView,
    apps,
    wbTabs,
    setWbTabs,
    activeTabByGroup,
    viewState,
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
    openSidechatTab,
    createSidechat,
    addBrowserTab,
    openWorkspaceInSheet,
    openNewWorkspaceInSheet,
  } = useWorkbench({
    authStatus,
    ws,
    sessions,
    sessionsRef,
    activeSessionId,
    activeSession,
    activeWorkspace,
    workspaces,
    workingTrees,
    setCreatingSession,
    mode,
    activeSubtaskId,
    t: appT,
  });

  useAppSocket({
    authStatus,
    ws,
    sessionsRef,
    activeSessionIdRef,
    pendingFirstMessageRef,
    openSidechat: openSidechatTab,
    setWsState,
    setWsAttempt,
    setAuthed,
    setWorkspaces,
    setSessions,
    setTasks,
    setBots,
    setSystemConfig,
    setRunner,
    setActiveSessionId,
    setActiveTaskId,
    setActiveSubtaskId,
    setItemsBySession,
    setPendingBySession,
    setQueueBySession,
    setPlanStateBySession,
    setCreatingSession,
    setForkingSession,
  });

  const selectSession = useSessionSelection({
    mode,
    activeSubtaskId,
    sessionsRef,
    activeSessionIdRef,
    setActiveSessionId,
    setChatPanel,
    ws,
  });

  // Worktree auto-switch: when the host detects the agent created its own
  // worktree mid-session (`git worktree add` → session.detected_worktree_path),
  // switch the VIEW-level working tree to it. The ref makes this fire exactly
  // once per (session, detected path) pair — the host only updates the stored
  // path when it changes — so a later manual pick in the branch dropdown wins
  // until the next detection. workingTrees is a dep so a listing refresh that
  // discovers the new tree re-fires the effect.
  useEffect(() => {
    const detected = activeSession?.detected_worktree_path;
    if (!activeSession || !detected) return;
    const last = wtAutoAppliedRef.current;
    if (last && last.sessionId === activeSession.id && last.path === detected) return;
    const tree = workingTrees.find(t => t.path === detected);
    if (!tree) return;
    wtAutoAppliedRef.current = { sessionId: activeSession.id, path: detected };
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
    tasks,
    setTasks,
    sessions,
    sessionsRef,
    workingTrees,
    wtView,
    setWtView,
    viewedWorkingTreeId,
    activateDiffsRail: () => activateRail('diffs'),
    setCreatingSession,
    setForkingSession,
    ws,
    t: appT,
  });


  const sessionMainHandlers = useSessionCommands({
    ws,
    sessionsRef,
    setItemsBySession,
    setPendingBySession,
  });

  const {
    activeManagerSession,
    activeManagerTask,
    managerItems,
    managerPending,
    managerQueue,
    managerHandlers,
    managerCardsByTask,
    showManagerRaw,
    setShowManagerRaw,
    onManagerMount,
    onManagerSend,
    onManagerStop,
    onCreateSubtask,
  } = useTaskManager({
    mode,
    activeTaskId,
    activeSubtaskId,
    activeRail,
    tasks,
    sessions,
    sessionsRef,
    workspacesRef,
    itemsBySession,
    setItemsBySession,
    pendingBySession,
    setPendingBySession,
    queueBySession,
    sessionCommands: sessionMainHandlers,
    hydrateTranscript,
    setActiveSubtaskId,
    ws,
  });

  // URL-param driven Files view: /?view=files&wt=<id>&path=<rel>
  // Opened by FilesView's "Open in new tab" href for non-renderable file types.
  const urlParams = new URLSearchParams(window.location.search);
  const filesRouteActive = urlParams.get('view') === 'files';
  const filesWtId = urlParams.get('wt');
  const filesPath = urlParams.get('path');

  const subtaskActive = mode === 'tasks' && !!activeSubtaskId && !!activeSession;
  const {
    sessionViewActive,
    workbenchActive,
    activeGroup,
    managerPanelVisible: managerP2,
    sheetMounted,
    sheetVisible,
    inspectorKind,
    inspectorVisible,
    openWorkspaceIds: openWsIds,
    selectedWorkspaceId: selectedWsId,
    canGoBack,
    canGoForward,
    navigate: navGo,
  } = useWorkbenchLayout({
    mode,
    subtaskActive,
    hasManagerTask: !!activeManagerTask,
    activeRail,
    setActiveRail,
    tabs: wbTabs,
    activeTabByGroup,
    viewState,
    chatPanel,
    filesInspectorSuppressed,
    p3Collapsed,
    setP3Collapsed,
    groupOfRail: GROUP_OF_RAIL,
    activateRail,
    revealTab: revealSheetTab,
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
    ? workspaces.find(w => w.id === subtask.workspace_id) ?? null
    : null;
  const subtaskWorkingTreeId = defaultWorkingTreeIdFor(subtask);
  const subtaskMain = subtask ? (
    <SessionSurface
      session={subtask}
      workspace={subtaskWorkspace}
      items={itemsBySession[subtask.id] ?? []}
      pending={pendingBySession[subtask.id] ?? false}
      queue={queueBySession[subtask.id] ?? []}
      planText={planStateBySession[subtask.id]?.text}
      planCompleted={planStateBySession[subtask.id]?.completed}
      commands={sessionMainHandlers}
      workingTreeId={subtaskWorkingTreeId}
      branch={workingTrees.find(tree => tree.id === subtaskWorkingTreeId)?.branch ?? null}
      onOpenFile={(absolutePath, line) => { void openFileInSheet(absolutePath, false, line); }}
      onOpenDiff={item => { void openTranscriptDiffInSheet(item); }}
      onOpenPlan={payload => openChatPanel(subtask.id, { kind: 'plan', id: payload.id })}
      onOpenChat={request => openChatPanel(subtask.id, request)}
      fileRehype={fileRehype}
      onReopen={() => { void reopenSubtask(subtask.id); }}
      onShowChanges={() => activateRail('diffs')}
    />
  ) : null;

  /** Sidechat tab body (Sheet kind 'chat'): the same SessionMain the main
   *  column uses, rebound to the picked session. v1 simplification
   *  (plan 阶段 5): the panel follows the
   *  MAIN session's working-tree context (GitBadge + file-link routing via
   *  openFileInSheet, which resolves against activeSessionId) instead of
   *  plumbing a separate defaultWorkingTreeId chain. */
  function renderSidechatPanel(session: Session) {
    const mainWorkingTreeId = defaultWorkingTreeIdFor(activeSession);
    return (
      <SessionSurface
        containerClassName="sheet-chat"
        session={session}
        workspace={workspaces.find(workspace => workspace.id === session.workspace_id) ?? null}
        items={itemsBySession[session.id] ?? []}
        pending={pendingBySession[session.id] ?? false}
        queue={queueBySession[session.id] ?? []}
        planText={planStateBySession[session.id]?.text}
        planCompleted={planStateBySession[session.id]?.completed}
        commands={sessionMainHandlers}
        workingTreeId={mainWorkingTreeId}
        branch={mainWorkingTreeId
          ? (workingTrees.find(tree => tree.id === mainWorkingTreeId)?.branch ?? null)
          : null}
        onOpenFile={(absolutePath, line) => { void openFileInSheet(absolutePath, false, line); }}
        onOpenDiff={item => { void openTranscriptDiffInSheet(item); }}
        onOpenPlan={payload => openChatPanel(session.id, { kind: 'plan', id: payload.id })}
        onOpenChat={request => openChatPanel(session.id, request)}
        fileRehype={fileRehype}
        onShowChanges={() => activateRail('diffs')}
      />
    );
  }

  if (authStatus === 'checking') {
    return (
      <LocaleProvider locale={locale}>
        <div className="app-loading" role="status" data-testid="auth-checking" />
      </LocaleProvider>
    );
  }

  if (authStatus === 'login') {
    return (
      <LocaleProvider locale={locale}>
        <Suspense fallback={<div className="app-loading" role="status" />}>
          <LoginView onLoginOk={onLoginOk} />
        </Suspense>
      </LocaleProvider>
    );
  }

  if (filesRouteActive) {
    return (
      <LocaleProvider locale={locale}>
        <Suspense fallback={<div className="app-loading" role="status" />}>
          <FilesView
            workingTrees={workingTrees}
            workingTreeId={filesWtId}
            onPickWorkingTree={id => {
              window.location.search = `?view=files&wt=${encodeURIComponent(id)}`;
            }}
            initialPath={filesPath}
            externalEditors={systemConfig?.external_editors ?? []}
            onOpenSettings={() => activateRail('settings')}
          />
        </Suspense>
      </LocaleProvider>
    );
  }

  return (
    <LocaleProvider locale={locale}>
    <Suspense fallback={<div className="app-loading" role="status" />}>
    <ImageZoomContext.Provider value={(src, alt) => setZoomImage({ src, alt })}>
    <BrowserLinkOpenContext.Provider value={(url) => addBrowserTab(url)}>
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
        p3Available={sheetVisible && inspectorVisible}
        p3Visible={inspectorVisible}
        onToggleP3={() => setP3Collapsed(c => !c)}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={() => navGo(-1)}
        onGoForward={() => navGo(1)}
      />
      <ImageLightbox image={zoomImage} onClose={() => setZoomImage(null)} />
      {paletteOpen && <CommandPalette
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
      />}
      <div className={`body ${viewState === 'workbench' ? 'wb-only' : ''}`}>
          {mode === 'sessions' && (
          <FileLinkOpenContext.Provider value={(absPath, line) => { void openFileInSheet(absPath, false, line); }}>
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
              onSetAppMode={(m) => { setMode(m); }}
              onOpenSearch={() => setPaletteOpen(true)}
              workspaces={workspaces}
              sessions={sessions}
              activeSession={activeSession}
              activeWorkspace={activeWorkspace}
              activeSessionId={activeSessionId}
              itemsBySession={itemsBySession}
              pendingBySession={pendingBySession}
              queueBySession={queueBySession}
              planStateBySession={planStateBySession}
              onSelectSession={selectSession}
              onWorkspaceCreated={w => setWorkspaces(prev => [...prev, w])}
              onCreateSession={(input) => {
                pendingFirstMessageRef.current = input.firstMessage?.trim() || null;
                setCreatingSession(true);
                ws.send({
                  type: 'session:create',
                  workspace_id: input.workspaceId,
                  executor: input.executor,
                  ...(input.executor !== 'kimi' && input.approvalMode
                    ? { approval_mode: input.approvalMode }
                    : {}),
                  ...(input.name ? { name: input.name } : {}),
                  ...(input.mode ? { mode: input.mode } : {}),
                  ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
                  ...(input.branch ? { branch: input.branch } : {}),
                });
              }}
              creatingSession={creatingSession}
              onDelete={sessionMainHandlers.onDelete}
              onSend={sessionMainHandlers.onSend}
              onSendSkill={sessionMainHandlers.onSendSkill}
              onStop={sessionMainHandlers.onStop}
              onApprove={sessionMainHandlers.onApprove}
              onQueueAdd={sessionMainHandlers.onQueueAdd}
              onQueueRemove={sessionMainHandlers.onQueueRemove}
              onQueueReorder={sessionMainHandlers.onQueueReorder}
              onQueueClear={sessionMainHandlers.onQueueClear}
              onQueueSendNow={sessionMainHandlers.onQueueSendNow}
              onSteer={sessionMainHandlers.onSteer}
              onSetMode={sessionMainHandlers.onSetMode}
              onSetModel={sessionMainHandlers.onSetModel}
              onSetEffort={sessionMainHandlers.onSetEffort}
              onSetServiceTier={sessionMainHandlers.onSetServiceTier}
              onSetNativeConfig={sessionMainHandlers.onSetNativeConfig}
              onShowChanges={() => { activateRail('diffs'); }}
              activeWorkingTreeId={viewedWorkingTreeId(activeSession)}
              activeBranch={
                workingTrees.find(wt => wt.id === viewedWorkingTreeId(activeSession))?.branch
                ?? null
              }
              onOpenSpaces={() => setMode('spaces')}
            />
          </ChatPanelOpenContext.Provider>
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
                  ...(input.executor === 'kimi' ? {} : { approval_mode: 'auto' as const }),
                  mode: 'worktree',
                  ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
                  ...(input.branch ? { branch: input.branch } : {}),
                });
              }}
            />
          )}
          {mode === 'tasks' && (
            <TasksView
              mode={mode}
              onSetMode={(m) => { setMode(m); }}
              onOpenSearch={() => setPaletteOpen(true)}
              tasks={tasks}
              sessions={sessions}
              workspaces={workspaces}
              ws={ws}
              defaultTaskExecutor={systemConfig?.default_task_executor ?? 'claude'}
              activeTaskId={activeTaskId}
              activeSubtaskId={activeSubtaskId}
              managerSession={activeManagerSession}
              managerItems={managerItems}
              managerPending={managerPending}
              managerCards={activeTaskId ? (managerCardsByTask[activeTaskId] ?? []) : []}
              managerHandlers={managerHandlers}
              managerQueue={managerQueue}
              showManagerRaw={showManagerRaw}
              onToggleManagerRaw={() => setShowManagerRaw(v => !v)}
              onManagerMount={onManagerMount}
              onManagerSend={onManagerSend}
              onManagerStop={onManagerStop}
              onCreateSubtask={onCreateSubtask}
              onSelectTask={(taskId) => { setActiveTaskId(taskId); setActiveSubtaskId(null); }}
              onSelectSubtask={(taskId, subtaskId) => { setActiveTaskId(taskId); setActiveSubtaskId(subtaskId); }}
              subtaskMain={subtaskMain}
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
        {chatPanel && workbenchActive && (
          <>
            <Splitter side="right" varName="--sheet-w" base={600} min={360} max={1080} invert />
            <FileLinkOpenContext.Provider value={(absPath, line) => {
              void openFileInSheet(absPath, false, line);
            }}>
            <FileRefRehypeContext.Provider value={fileRehype}>
              <ChatContextPanel
                target={chatPanel}
                items={itemsBySession[chatPanel.sessionId] ?? []}
                planText={planStateBySession[chatPanel.sessionId]?.text}
                planCompleted={planStateBySession[chatPanel.sessionId]?.completed}
                onClose={() => setChatPanel(null)}
              />
            </FileRefRehypeContext.Provider>
            </FileLinkOpenContext.Provider>
          </>
        )}
        {(sheetMounted || managerP2 || (activeRail === 'sidechat' && workbenchActive)) && (
          <>
            {sheetVisible && viewState !== 'workbench' && (
              <Splitter side="right" varName="--sheet-w" base={600} min={420} max={1080} invert />
            )}
            {(sheetMounted || (activeRail === 'sidechat' && workbenchActive)) && (
            <Sheet
              tabs={wbTabs}
              activeByGroup={activeTabByGroup}
              activeGroup={managerP2 ? null : activeGroup}
              actions={sheetActions}
              onAddTab={(g) => {
                if (g === 'term') addTerminalTab();
                else if (g === 'browser') addBrowserTab();
                else if (g === 'sidechat') createSidechat();
              }}
              renderEmpty={(g) => g === 'sidechat' ? (
                <div className="sidechat-empty">
                  <div className="sidechat-intro">
                    <div className="sidechat-intro-title">{appT('sidechat.intro.title')}</div>
                    <div className="sidechat-intro-desc">{appT('sidechat.intro.desc')}</div>
                    {activeSession?.executor === 'claude' ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={creatingSession}
                        onClick={createSidechat}
                      >
                        {appT('sheet.newChat')}
                      </button>
                    ) : (
                      <div className="sidechat-intro-note">{appT('sidechat.claudeOnly')}</div>
                    )}
                  </div>
                </div>
              ) : null}
              hidden={!sheetVisible || managerP2}
              externalEditors={systemConfig?.external_editors ?? []}
              openApps={systemConfig?.open_apps}
              onOpenWith={handleOpenWith}
              onConfigureEditors={() => activateRail('settings')}
              renderTab={(t) => {
                if (t.kind === 'settings') {
                  return (
                    <SettingsBody
                      config={systemConfig}
                      apps={apps}
                      onChange={cfg => setSystemConfig(cfg)}
                      activeSection={settingsSection}
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
                          ...(input.executor === 'kimi' ? {} : { approval_mode: 'auto' as const }),
                          mode: 'worktree',
                          ...(input.baseBranch ? { base_branch: input.baseBranch } : {}),
                          ...(input.branch ? { branch: input.branch } : {}),
                        });
                      }}
                    />
                  );
                }
                if (t.kind === 'chat') {
                  const chatSession = sessions.find(s => s.id === t.sessionId)
                    ?? null;
                  if (!chatSession) {
                    return <div className="sheet-chat-missing">{appT('sidechat.sessionGone')}</div>;
                  }
                  return renderSidechatPanel(chatSession);
                }
                if (t.kind === 'browser') {
                  return (
                    <BrowserBody
                      initialUrl={t.url}
                      onNavigate={url => sheetActions.setTabName(t.id, browserHostOf(url))}
                    />
                  );
                }
                return null;
              }}
            />
            )}
            {managerP2 && activeManagerTask && (
              <div className="sheet-manager" style={sheetVisible ? undefined : { display: 'none' }}>
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
              </div>
            )}
          </>
        )}
        {inspectorVisible && inspectorKind !== null && (
          <>
            <Splitter side="right" varName="--inspector-w" base={280} min={220} max={500} invert />
            {inspectorKind === 'workspaces' ? (
              <WorkspacesInspector
                workspaces={workspaces}
                selectedWsId={selectedWsId}
                openWsIds={openWsIds}
                onOpenWorkspace={openWorkspaceInSheet}
                onChange={() => void loadWorkspaces().then(setWorkspaces)}
                onNewWorkspace={openNewWorkspaceInSheet}
              />
            ) : inspectorKind === 'settings' ? (
              <SettingsNavInspector active={settingsSection} onSelect={onSettingsNavSelect} />
            ) : (
              <Inspector
                tab={inspectorKind}
                workingTreeId={viewedWorkingTreeId(activeSession)}
                workingTrees={workingTrees}
                revealFile={fileReveal}
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
          activeRail={chatPanel ? null : activeRail}
          onToggleRail={toggleRail}
          sessionRailsDisabled={!sessionViewActive}
          workbenchDisabled={!workbenchActive}
          managerVisible={subtaskActive}
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
    </BrowserLinkOpenContext.Provider>
    </ImageZoomContext.Provider>
    </Suspense>
    </LocaleProvider>
  );
}
