// ============================================================
// App root — global state + action handlers + composition.
// ============================================================

const SESSION_PATH_FOR_ID = (id) => {
  const s = SESSIONS.find(x => x.id === id);
  if (!s) return [];
  return [
    { kind: 'workspace', label: WORKSPACES.find(w => w.id === s.ws)?.name || s.ws, copyHint: `Click to copy "${s.ws}"` },
    { kind: 'branch',    label: s.branch, copyHint: `Click to copy "${s.branch}"` },
    { kind: 'session',   label: s.title,  copyHint: 'Click for session actions' },
  ];
};

const TASK_PATH_FOR_ID = (taskId, subtaskId) => {
  const t = TASKS.find(x => x.id === taskId);
  if (!t) return [];
  const segs = [{ kind: 'session', label: t.name, copyHint: 'Click for task actions' }];
  if (subtaskId) {
    const st = SUBTASKS.find(x => x.id === subtaskId);
    if (st) segs.push({ kind: 'session', label: st.name, copyHint: 'Click for subtask actions' });
  }
  return segs;
};

function App() {
  const [state, setState] = React.useState({
    mode: 'sessions',
    modeDropdownOpen: false,

    selectedSessionId: 's-auth',
    sessionsView: 'detail',
    search: '',
    filter: { ws: null, exec: null },
    filterOpen: false,
    groupOpen: false,
    groupBy: 'time',
    archivedOpen: false,
    chatMode: 'chat',
    composerMode: 'auto',

    selectedWsId: 'gian',
    spacesTab: 'config',
    selectedBotId: 'gian-dev',
    botsView: 'detail',

    // Tasks mode
    selectedTaskId: (TASKS.find(t => t.status === 'open') || TASKS[0]).id,
    selectedSubtaskId: null,
    expandedTaskIds: [(TASKS.find(t => t.status === 'open') || TASKS[0]).id],
    pendingProposalByTask: MANAGER_PROPOSALS,
    proposalStatusById: {},
    taskSearch: '',
    taskStatusOverrides: {},        // { [taskId]: 'open' | 'done' | 'archived' }
    subtaskStatusOverrides: {},     // { [subtaskId]: subtask status string }

    inspectorTab: null,
    wbTabs: [],                  // [{ id, pane, name, ico, icoKind, kind, lines? }]
    wbActive: { 0: null, 1: null },

    viewState: 'main',           // 'main' | 'both' | 'workbench'
    railHidden: false,

    paletteOpen: false,
    inboxOpen: false,
    sessionMenuOpen: false,
    tabAddOpenPane: null,

    theme: 'light',
    accent: 'plum',
    density: 'cozy',

    pathRenameIdx: null,
  });

  React.useEffect(() => {
    document.body.dataset.theme = state.theme;
    document.body.dataset.accent = state.accent;
    document.body.dataset.density = state.density;
  }, [state.theme, state.accent, state.density]);

  // If workbench goes empty, force view back to main only
  React.useEffect(() => {
    if (state.viewState !== 'main' && state.wbTabs.length === 0) {
      setState(s => ({ ...s, viewState: 'main' }));
    }
  }, [state.viewState, state.wbTabs]);

  React.useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setState(s => ({ ...s, paletteOpen: true }));
      } else if (e.key === 'Escape') {
        setState(s => ({ ...s, paletteOpen: false, filterOpen: false, groupOpen: false, modeDropdownOpen: false, inboxOpen: false, sessionMenuOpen: false, tabAddOpenPane: null }));
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  React.useEffect(() => {
    const h = (e) => {
      if (e.target.closest('.mode-anchor') || e.target.closest('.mode-pop')) return;
      if (e.target.closest('.filter-pop') || e.target.closest('.group-pop')) return;
      if (e.target.closest('.inbox-anchor') || e.target.closest('.inbox-pop')) return;
      if (e.target.closest('.session-menu') || e.target.closest('.path-seg-anchor')) return;
      if (e.target.closest('.tab-add-anchor') || e.target.closest('.tab-add-pop')) return;
      if (e.target.closest('[title="Filter"]') || e.target.closest('[title*="Group by"]')) return;
      if (state.modeDropdownOpen || state.filterOpen || state.groupOpen || state.inboxOpen || state.sessionMenuOpen || state.tabAddOpenPane !== null) {
        setState(s => ({ ...s, modeDropdownOpen: false, filterOpen: false, groupOpen: false, inboxOpen: false, sessionMenuOpen: false, tabAddOpenPane: null }));
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [state.modeDropdownOpen, state.filterOpen, state.groupOpen, state.inboxOpen, state.sessionMenuOpen, state.tabAddOpenPane]);

  // Ref always points to latest state so memoized read helpers in A don't go stale.
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const A = React.useMemo(() => ({
    set: (k, v) => setState(s => ({ ...s, [k]: v })),

    setMode: (mode) => setState(s => ({
      ...s, mode, filterOpen: false, groupOpen: false, modeDropdownOpen: false, inboxOpen: false,
    })),

    setTheme:   (theme)   => setState(s => ({ ...s, theme })),
    setAccent:  (accent)  => setState(s => ({ ...s, accent })),
    setDensity: (density) => setState(s => ({ ...s, density })),

    selectSession: (id) => setState(s => ({ ...s, selectedSessionId: id, pathRenameIdx: null, inboxOpen: false, sessionsView: 'detail' })),

    setViewState: (vs) => setState(s => ({ ...s, viewState: vs })),

    toggleInspector: (kind) => setState(s => ({
      ...s, inspectorTab: s.inspectorTab === kind ? null : kind,
    })),

    // Toggle a singleton tab kind (terminal or settings) in workbench: add if missing, remove all of that kind if present
    toggleWbTabKind: (kind) => setState(s => {
      const existing = s.wbTabs.filter(t => t.kind === kind);
      if (existing.length > 0) {
        const next = s.wbTabs.filter(t => t.kind !== kind);
        const active = { ...s.wbActive };
        [0, 1].forEach(p => {
          if (existing.some(t => t.id === active[p])) {
            const sib = next.find(t => t.pane === p);
            active[p] = sib ? sib.id : null;
          }
        });
        return { ...s, wbTabs: next, wbActive: active };
      }
      let tab;
      let pane = 0;
      if (kind === 'term') {
        const hasFile = s.wbTabs.some(t => t.kind === 'file');
        pane = hasFile ? 1 : 0;
        tab = { id: 'tab-' + Date.now(), pane, name: 'zsh · ~/gian', kind: 'term', icoKind: 'term', ico: '$' };
      } else if (kind === 'settings') {
        tab = { id: 'tab-settings', pane: 0, name: 'Settings', kind: 'settings', icoKind: 'gear', ico: '⚙' };
      } else return s;
      const wbTabs = [...s.wbTabs, tab];
      const wbActive = { ...s.wbActive, [pane]: tab.id };
      const viewState = (s.viewState === 'main') ? 'both' : s.viewState;
      return { ...s, wbTabs, wbActive, viewState };
    }),

    // Open a workspace as a Workbench tab (zone 3). The list lives in the
    // Inspector (zone 4); clicking a row opens/activates its detail tab here.
    // One tab per workspace, keyed by id so re-clicking re-activates.
    openWorkspaceInSheet: (wsId) => setState(s => {
      const ws = WORKSPACES.find(w => w.id === wsId);
      if (!ws) return s;
      const id = 'tab-ws-' + wsId;
      const existing = s.wbTabs.find(t => t.id === id);
      if (existing) {
        const viewState = s.viewState === 'main' ? 'both' : s.viewState;
        return { ...s, wbActive: { ...s.wbActive, [existing.pane]: id }, viewState, selectedWsId: wsId };
      }
      const tab = { id, pane: 0, name: ws.name, kind: 'workspace', icoKind: 'grid', ico: '▣', wsId };
      const wbTabs = [...s.wbTabs, tab];
      const wbActive = { ...s.wbActive, 0: id };
      const viewState = s.viewState === 'main' ? 'both' : s.viewState;
      return { ...s, wbTabs, wbActive, viewState, selectedWsId: wsId };
    }),

    activateSheetTab: (paneIdx, id) => setState(s => ({
      ...s, wbActive: { ...s.wbActive, [paneIdx]: id },
    })),

    closeSheetTab: (id) => setState(s => {
      const tab = s.wbTabs.find(t => t.id === id);
      const next = s.wbTabs.filter(t => t.id !== id);
      const active = { ...s.wbActive };
      if (tab && active[tab.pane] === id) {
        const sib = next.find(t => t.pane === tab.pane);
        active[tab.pane] = sib ? sib.id : null;
      }
      return { ...s, wbTabs: next, wbActive: active };
    }),

    openFileInSheet: (path, ext, permanent = false) => setState(s => {
      ext = ext || (path.match(/\.([a-z0-9]+)$/i)?.[1] || 'txt').toLowerCase();
      const name = path.split('/').pop();
      // If a permanent tab with this name already exists, activate it.
      const existingPerm = s.wbTabs.find(t => t.kind === 'file' && t.name === name && !t.preview);
      if (existingPerm) {
        const viewState = s.viewState === 'main' ? 'both' : s.viewState;
        return { ...s, wbActive: { ...s.wbActive, [existingPerm.pane]: existingPerm.id }, viewState };
      }
      const existingPrev = s.wbTabs.find(t => t.kind === 'file' && t.preview);
      let lines;
      if (name === 'CLAUDE.md') lines = CLAUDE_MD.map((l, i) => [String(i + 1), l]);
      else if (name === 'oauth.ts' || name === 'oauth.spec.ts') lines = OAUTH_TS;
      else lines = [['1', '// ' + path, 'cm'], ['2', ''], ['3', 'export function hi() {', 'kw'], ['4', '  return 42;'], ['5', '}']];
      const icoKindMap = { md: 'md', ts: 'ts', tsx: 'tsx', json: 'json', css: 'css' };
      const icoTextMap = { md: 'M', ts: 'TS', tsx: 'TS', json: '{}', css: '#' };
      const tabContent = { name, kind: 'file', icoKind: icoKindMap[ext] || 'ts', ico: icoTextMap[ext] || 'F', lines, viewMode: 'source' };

      let tabs = [...s.wbTabs];
      let active = { ...s.wbActive };

      if (existingPrev) {
        // If we're opening permanent and it's the SAME file, just promote.
        if (permanent && existingPrev.name === name) {
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...t, preview: false } : t);
          active[existingPrev.pane] = existingPrev.id;
          const viewState = s.viewState === 'main' ? 'both' : s.viewState;
          return { ...s, wbTabs: tabs, wbActive: active, viewState };
        }
        // Single-click on a different file: replace the preview tab's content in place.
        if (!permanent) {
          tabs = tabs.map(t => t.id === existingPrev.id ? { ...t, ...tabContent, preview: true } : t);
          active[existingPrev.pane] = existingPrev.id;
          const viewState = s.viewState === 'main' ? 'both' : s.viewState;
          return { ...s, wbTabs: tabs, wbActive: active, viewState };
        }
        // Permanent open of a different file: drop the preview tab.
        tabs = tabs.filter(t => t.id !== existingPrev.id);
        Object.keys(active).forEach(k => { if (active[k] === existingPrev.id) active[k] = null; });
      }

      const hasTermInUpper = tabs.some(t => t.pane === 0 && t.kind === 'term');
      const hasFileAlready = tabs.some(t => t.kind === 'file');
      if (hasTermInUpper && !hasFileAlready) {
        const moved = tabs.filter(t => t.pane === 0 && t.kind === 'term').map(t => t.id);
        tabs = tabs.map(t => moved.includes(t.id) ? { ...t, pane: 1 } : t);
        active[1] = active[0]; active[0] = null;
      }
      const id = 'tab-' + Date.now();
      const tab = { id, pane: 0, ...tabContent, preview: !permanent };
      tabs.push(tab);
      active[0] = id;
      const viewState = s.viewState === 'main' ? 'both' : s.viewState;
      return { ...s, wbTabs: tabs, wbActive: active, viewState, tabAddOpenPane: null };
    }),

    pinSheetTab: (id) => setState(s => ({
      ...s, wbTabs: s.wbTabs.map(t => t.id === id ? { ...t, preview: false } : t),
    })),

    duplicateSheetTab: (id) => setState(s => {
      const src = s.wbTabs.find(t => t.id === id);
      if (!src) return s;
      const newId = 'tab-' + Date.now();
      const copy = { ...src, id: newId, preview: false };
      return {
        ...s,
        wbTabs: [...s.wbTabs, copy],
        wbActive: { ...s.wbActive, [src.pane]: newId },
      };
    }),

    setTabViewMode: (id, viewMode) => setState(s => ({
      ...s, wbTabs: s.wbTabs.map(t => t.id === id ? { ...t, viewMode } : t),
    })),

    addTerminalTab: () => setState(s => {
      const id = 'tab-' + Date.now();
      const hasFile = s.wbTabs.some(t => t.kind === 'file');
      const pane = hasFile ? 1 : 0;
      const tab = { id, pane, name: 'zsh · ~/gian', kind: 'term', icoKind: 'term', ico: '$' };
      const wbTabs = [...s.wbTabs, tab];
      const wbActive = { ...s.wbActive, [pane]: id };
      const viewState = s.viewState === 'main' ? 'both' : s.viewState;
      return { ...s, wbTabs, wbActive, viewState, tabAddOpenPane: null };
    }),

    clickPathSeg: (idx, seg) => setState(s => {
      if (seg.kind === 'session') {
        return { ...s, sessionMenuOpen: !s.sessionMenuOpen };
      } else {
        try { navigator.clipboard?.writeText(seg.label); } catch (_) {}
        setTimeout(() => setState(curr => curr.copiedSegIdx === idx ? { ...curr, copiedSegIdx: null } : curr), 1400);
        return { ...s, copiedSegIdx: idx };
      }
    }),

    startRename: (idx) => setState(s => ({ ...s, pathRenameIdx: idx, sessionMenuOpen: false })),
    finishRename: () => setState(s => ({ ...s, pathRenameIdx: null })),
    cancelRename: () => setState(s => ({ ...s, pathRenameIdx: null })),

    toggleBotEnabled: () => setState(s => s),

    selectTask: (taskId) => setState(s => ({
      ...s,
      selectedTaskId: taskId,
      selectedSubtaskId: null,
      expandedTaskIds: s.expandedTaskIds.includes(taskId) ? s.expandedTaskIds : [...s.expandedTaskIds, taskId],
      inspectorTab: null,
    })),

    selectSubtask: (taskId, subtaskId) => setState(s => ({
      ...s,
      selectedTaskId: taskId,
      selectedSubtaskId: subtaskId,
      expandedTaskIds: s.expandedTaskIds.includes(taskId) ? s.expandedTaskIds : [...s.expandedTaskIds, taskId],
    })),

    toggleTaskExpand: (taskId) => setState(s => ({
      ...s,
      expandedTaskIds: s.expandedTaskIds.includes(taskId)
        ? s.expandedTaskIds.filter(id => id !== taskId)
        : [...s.expandedTaskIds, taskId],
    })),

    // Effective status reads override if any, else falls back to seed data.
    effectiveTaskStatus: (task) => stateRef.current.taskStatusOverrides[task.id] || task.status,

    toggleTaskDone: (taskId) => setState(s => {
      const t = TASKS.find(x => x.id === taskId);
      if (!t) return s;
      const current = s.taskStatusOverrides[taskId] || t.status;
      const next = current === 'done' ? 'open' : 'done';
      return { ...s, taskStatusOverrides: { ...s.taskStatusOverrides, [taskId]: next } };
    }),

    effectiveSubtaskStatus: (subtask) =>
      stateRef.current.subtaskStatusOverrides[subtask.id] || subtask.status,

    toggleSubtaskDone: (subtaskId) => setState(s => {
      const st = SUBTASKS.find(x => x.id === subtaskId);
      if (!st) return s;
      const current = s.subtaskStatusOverrides[subtaskId] || st.status;
      const next = current === 'done' ? 'active' : 'done';
      return { ...s, subtaskStatusOverrides: { ...s.subtaskStatusOverrides, [subtaskId]: next } };
    }),

    approveProposal: (taskId) => setState(s => {
      const pp = s.pendingProposalByTask?.[taskId];
      if (!pp) return s;
      return { ...s, proposalStatusById: { ...s.proposalStatusById, [pp.id]: 'approved' } };
    }),

    rejectProposal: (taskId) => setState(s => {
      const pp = s.pendingProposalByTask?.[taskId];
      if (!pp) return s;
      return { ...s, proposalStatusById: { ...s.proposalStatusById, [pp.id]: 'rejected' } };
    }),

    editProposal: (taskId) => setState(s => {
      const pp = s.pendingProposalByTask?.[taskId];
      if (!pp) return s;
      return { ...s, proposalStatusById: { ...s.proposalStatusById, [pp.id]: 'editing' } };
    }),

  }), []);

  const path = React.useMemo(() => {
    if (state.mode === 'sessions') {
      if (state.sessionsView === 'new') {
        return [{ kind: 'session', label: 'New session' }];
      }
      const segs = SESSION_PATH_FOR_ID(state.selectedSessionId);
      if (state.pathRenameIdx !== null && segs[state.pathRenameIdx]) {
        segs[state.pathRenameIdx] = { ...segs[state.pathRenameIdx], editing: true };
      }
      return segs;
    } else if (state.mode === 'spaces') {
      const ws = WORKSPACES.find(w => w.id === state.selectedWsId);
      return ws ? [{ kind: 'workspace', label: ws.name, copyHint: `Copy "${ws.name}"` }] : [];
    } else if (state.mode === 'bots') {
      if (state.botsView === 'new') return [{ kind: 'session', label: 'New bot' }];
      const b = BOTS.find(x => x.id === state.selectedBotId);
      return b ? [{ kind: 'session', label: b.name, copyHint: `Copy "${b.name}"` }] : [];
    } else if (state.mode === 'tasks') {
      return TASK_PATH_FOR_ID(state.selectedTaskId, state.selectedSubtaskId);
    }
    return [];
  }, [state.mode, state.selectedSessionId, state.sessionsView, state.selectedWsId, state.selectedBotId, state.botsView, state.selectedTaskId, state.selectedSubtaskId, state.pathRenameIdx]);

  const inbox = 2;
  const topState = { ...state, path, inbox };

  const sessionsMode = state.mode === 'sessions';
  const tasksMode = state.mode === 'tasks';
  const wbHasTabs = state.wbTabs.length > 0;
  const showMain = state.viewState !== 'workbench';
  const showWb   = sessionsMode && wbHasTabs && state.viewState !== 'main';
  // Inspector: sessions mode (files/changes), or tasks mode with a subtask selected ("Manager" tab).
  const showInspector = (sessionsMode && state.inspectorTab)
                     || (tasksMode && state.selectedSubtaskId && state.inspectorTab);

  return (
    <div className="app">
      <Topbar state={topState} A={A} />
      <div className={`body ${state.railHidden ? 'rail-hidden' : ''} ${state.viewState === 'workbench' ? 'wb-only' : ''}`}>
        {!state.railHidden && (
          <>
            {state.mode === 'sessions' && <SidebarSessions state={state} A={A} />}
            {state.mode === 'spaces'   && <SidebarSpaces  state={state} A={A} />}
            {state.mode === 'bots'     && <SidebarBots    state={state} A={A} />}
            {state.mode === 'tasks'    && <SidebarTasks   state={state} A={A} />}
          </>
        )}

        {showMain && (
          <>
            {state.mode === 'sessions' && (state.chatMode === 'cli' ? <CliMain state={state} A={A} /> : <ChatMain state={state} A={A} />)}
            {state.mode === 'spaces'   && <SpacesMain state={state} A={A} />}
            {state.mode === 'bots'     && <BotsMain   state={state} A={A} />}
            {state.mode === 'tasks'    && (state.selectedSubtaskId
              ? (state.chatMode === 'cli' ? <CliMain state={state} A={A} /> : <ChatMain state={state} A={A} />)
              : <ManagerMain state={state} A={A} />)}
          </>
        )}

        {showWb && (
          <>
            {showMain && <Splitter side="right" varName="--sheet-w" base={600} min={420} max={1080} invert />}
            <Sheet state={state} A={A} />
          </>
        )}
        {showInspector && (
          <>
            {(showWb || showMain) && <Splitter side="right" varName="--inspector-w" base={280} min={220} max={500} invert />}
            <Inspector state={state} A={A} />
          </>
        )}

        {(sessionsMode || tasksMode) && <Dock state={state} A={A} />}
      </div>

      {state.paletteOpen && <CommandPalette state={state} A={A} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
