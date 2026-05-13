import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalCategory, ApprovalMode, ApprovalStatus, Bot, EventEnvelope, ServerToClientMessage, Session, Workspace } from '@gian/shared';
import { LocaleProvider } from './i18n/index.js';
import type { WsState } from './ws.js';
import { GianWs } from './ws.js';
import { makeWsUrl, loadWorkspaces, loadSessions, loadEvents, loadSettings, loadWorkingTrees, whoAmI, loadBots, reconnectComponent, fetchWsToken } from './api.js';
import type { WorkingTree } from './api.js';
import { applyEnvelope, parseTokenUsage } from './transcript/apply.js';
import { DiffOpenContext, FileLinkOpenContext, PlanOpenContext } from './transcript/items.js';
import type { PreviewTarget } from './components/FilePreviewDrawer.js';
import { Topbar } from './components/Topbar.js';
import { MainNav, pendingCount } from './components/MainNav.js';
import { CodingView } from './views/CodingView.js';
import { FilesView } from './views/FilesView.js';
import { SpacesView } from './views/SpacesView.js';
import { LoginView } from './views/LoginView.js';
import { BotsView } from './views/BotsView.js';
import { ComingSoonView } from './views/ComingSoonView.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { CommandPalette } from './components/CommandPalette.js';
import type { SystemConfig } from '@gian/shared';
import type { QueueEntry, TokenUsage, TranscriptItem, View } from './types.js';

export interface PendingApproval {
  id: string;
  session_id: string;
  category: ApprovalCategory;
  description: string;
  status: ApprovalStatus;
}

export function App() {
  // The token getter runs every reconnect, so a successful login → ws-token
  // fetch propagates without rebuilding GianWs. fetchWsToken returns
  // 'dev-token' when AUTH_REQUIRED is off (the WS handler accepts any
  // non-empty token in that mode), and the real session token when it's on.
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
  const [view, setView] = useState<View>('coding');
  const [workingTrees, setWorkingTrees] = useState<WorkingTree[]>([]);
  const [filesWorkingTreeId, setFilesWorkingTreeId] = useState<string | null>(null);
  const [filesInitialPath, setFilesInitialPath] = useState<string | null>(null);
  const [filesInitialMode, setFilesInitialMode] = useState<'tree' | 'changed' | null>(null);
  // 4th-level inline preview drawer (Coding view). Set by either a
  // transcript FileLink click (file mode) or a DiffCard click (diff mode);
  // either way keeps the user in Coding view instead of jumping to the
  // top-level Files page.
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [systemConfig, setSystemConfig] = useState<SystemConfig | null>(null);
  const [loggedIn, setLoggedIn] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState<string | undefined>(undefined);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const pendingFirstMessageRef = useRef<string | null>(null);

  useEffect(() => {
    if (!systemConfig) return;
    document.body.setAttribute('data-theme', systemConfig.theme);
    document.body.setAttribute('data-accent', systemConfig.accent);
    document.body.setAttribute('data-density', systemConfig.density);
    document.documentElement.setAttribute('lang', systemConfig.locale);
  }, [systemConfig?.theme, systemConfig?.accent, systemConfig?.density, systemConfig?.locale]);

  useEffect(() => {
    void whoAmI().then(res => {
      setLoggedIn(res !== null);
    });
  }, []);

  useEffect(() => {
    void loadSettings().then(cfg => { if (cfg) setSystemConfig(cfg); });
  }, []);

  useEffect(() => {
    void loadBots().then(setBots);
  }, []);

  // "Open in new tab" from FilesView opens `/?wt=<id>&path=<rel>&view=files`.
  // Read those once on mount and route accordingly.
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    if (sp.get('view') === 'files') setView('files');
    const wtParam = sp.get('wt');
    if (wtParam) setFilesWorkingTreeId(wtParam);
    const pathParam = sp.get('path');
    if (pathParam) setFilesInitialPath(pathParam);
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
          setItemsBySession(prev => ({ ...prev, [msg.session.id]: [] }));
          const pendingMsg = pendingFirstMessageRef.current;
          if (pendingMsg) {
            pendingFirstMessageRef.current = null;
            ws.send({ type: 'message:send', session_id: msg.session.id, text: pendingMsg });
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
        case 'error':
          // Server-side dispatch failure (e.g. message:send threw before any
          // turn was persisted). Alert the user so the failure isn't silent.
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

  // Open Files view in Changed mode for a specific session's working tree.
  function openSessionChanges(sess: Session): void {
    const id = defaultWorkingTreeIdFor(sess);
    if (id) setFilesWorkingTreeId(id);
    setFilesInitialPath(null);
    setFilesInitialMode('changed');
    setView('files');
  }

  /**
   * Open a file referenced by an absolute path inside the **4th-level
   * preview drawer** that lives within Coding view. Keeps the transcript
   * visible alongside so users don't lose context. Falls back to `vscode://`
   * for paths outside any known working tree so the link is never useless.
   */
  function openFileInPreview(absPath: string, line?: number): void {
    const sess = activeSessionId
      ? sessions.find(s => s.id === activeSessionId) ?? null
      : null;
    const wtId = sess ? defaultWorkingTreeIdFor(sess) : null;
    const wt = wtId ? workingTrees.find(t => t.id === wtId) : null;
    if (wt && absPath.startsWith(wt.path)) {
      const rel = absPath.slice(wt.path.length).replace(/^\/+/, '');
      setPreviewTarget({ kind: 'file', workingTreeId: wt.id, path: rel, ...(line ? { line } : {}) });
      return;
    }
    // Path outside the active working tree (or no tree resolved): degrade
    // to the system editor handler. Better than swallowing the click.
    const enc = encodeURI(absPath);
    const href = line ? `vscode://file/${enc}:${line}` : `vscode://file/${enc}`;
    window.open(href, '_blank', 'noopener');
  }

  const locale = systemConfig?.locale ?? 'en';

  if (!loggedIn) {
    return (
      <LocaleProvider locale={locale}>
        <LoginView onLoginOk={() => setLoggedIn(true)} />
      </LocaleProvider>
    );
  }

  const disconnected = wsState === 'closed' || wsState === 'connecting';

  return (
    <LocaleProvider locale={locale}>
    <div className="session-app">
      {disconnected && (
        <div className="ws-disconnect-banner" role="alert">
          <span className="ws-disconnect-icon" aria-hidden="true" />
          {wsState === 'connecting'
            ? `Reconnecting (attempt ${wsAttempt})…`
            : 'Disconnected · Reconnecting…'}
        </div>
      )}
      <Topbar
        wsState={wsState}
        wsAttempt={wsAttempt}
        authed={authed}
        bots={bots}
        activeWorkspace={activeWorkspace}
        workspaces={workspaces}
        pendingApprovals={pendingApprovals}
        onJumpToSession={sid => { setActiveSessionId(sid); setView('coding'); }}
        onSettingsClick={() => setShowSettings(true)}
        onReconnect={c => reconnectComponent(c).then(() => {})}
        onPaletteOpen={(q?: string) => { setPaletteInitialQuery(q); setPaletteOpen(true); }}
        onPickWorkspace={wsId => {
          const recent = sessions.find(s => s.workspace_id === wsId);
          if (recent) {
            setActiveSessionId(recent.id);
          } else {
            setActiveSessionId(null);
          }
          setView('coding');
        }}
      />
      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        config={systemConfig}
        onChange={(cfg: SystemConfig) => setSystemConfig(cfg)}
        onLogout={() => { setShowSettings(false); setLoggedIn(false); }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => { setPaletteOpen(false); setPaletteInitialQuery(undefined); }}
        sessions={sessions}
        workspaces={workspaces}
        activeSessionId={activeSessionId}
        activeWorkingTreeId={defaultWorkingTreeIdFor(activeSession)}
        transcriptItems={activeSessionId ? (itemsBySession[activeSessionId] ?? []) : []}
        onJumpToSession={sid => { setActiveSessionId(sid); setView('coding'); setPaletteOpen(false); }}
        onOpenFile={(wtId, path) => { setFilesWorkingTreeId(wtId); setFilesInitialPath(path); setView('files'); setPaletteOpen(false); }}
        initialQuery={paletteInitialQuery}
      />
      <div className="body">
        <MainNav view={view} onSwitch={setView} runningCount={pendingCount(pendingBySession)} />
        <main className="stage">
          {view === 'coding' && (
          <FileLinkOpenContext.Provider value={openFileInPreview}>
          <DiffOpenContext.Provider value={(diff) => setPreviewTarget({ kind: 'diff', diff })}>
          <PlanOpenContext.Provider value={(approval) => setPreviewTarget({
            kind: 'plan',
            approvalId: approval.approvalId,
            plan: approval.cmd,
            status: approval.status === 'pending'
              ? 'pending'
              : approval.status === 'declined'
                ? 'rejected'
                : 'accepted',
          })}>
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
              onSend={(sessionId, text, opts) =>
                ws.send({
                  type: 'message:send',
                  session_id: sessionId,
                  text,
                  ...(opts?.oneShotBypass ? { oneShotBypass: true } : {}),
                })
              }
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
              onShowChanges={openSessionChanges}
              activeWorkingTreeId={defaultWorkingTreeIdFor(activeSession)}
              activeBranch={
                workingTrees.find(wt => wt.id === defaultWorkingTreeIdFor(activeSession))?.branch
                ?? null
              }
              previewTarget={previewTarget}
              onClosePreview={() => setPreviewTarget(null)}
            />
          </PlanOpenContext.Provider>
          </DiffOpenContext.Provider>
          </FileLinkOpenContext.Provider>
          )}
          {view === 'files' && (
            <FilesView
              workingTrees={workingTrees}
              workingTreeId={
                filesWorkingTreeId
                ?? defaultWorkingTreeIdFor(activeSession)
                ?? workingTrees[0]?.id
                ?? null
              }
              onPickWorkingTree={setFilesWorkingTreeId}
              initialPath={filesInitialPath}
              initialMode={filesInitialMode}
            />
          )}
          {view === 'workspaces' && (
            <SpacesView
              workspaces={workspaces}
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
          )}
          {view === 'bots' && (
            <BotsView
              bots={bots}
              sessions={sessions}
              workspaces={workspaces}
              onChange={() => void loadBots().then(setBots)}
            />
          )}
        </main>
      </div>
    </div>
    </LocaleProvider>
  );
}
