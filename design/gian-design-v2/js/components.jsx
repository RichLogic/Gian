// ============================================================
// View components — Topbar, Sidebar variants, Main panes (chat/cli),
// Sheet, Inspector, Dock, Spaces detail, Bots detail, Overlays.
// ============================================================

// Drag-to-resize handle. Sets a CSS custom property on body for live update.
// axis='x' = vertical bar that resizes width (default); axis='y' = horizontal bar that resizes height.
// RunStatusIcon — sidebar status indicator shared by SubtaskRow (and could be used
// by SessionRow). Maps a session-like status to one of: running spinner, green ✓,
// red !, or a neutral hollow circle. Pure visual — not a button.
function RunStatusIcon({ status, size = 13, title }) {
  // Normalize subtask vs session status names down to the 4 visual cases.
  const norm = (status === 'active' || status === 'run') ? 'run'
             : (status === 'error'  || status === 'err') ? 'err'
             : (status === 'idle'   || status === 'done') ? 'done'
             : status; // wait | draft | abandoned
  if (norm === 'run') {
    return (
      <span className="run-status run-status-run" title={title || 'running'}>
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeDasharray="22 38" />
        </svg>
      </span>
    );
  }
  if (norm === 'done') {
    return (
      <span className="run-status run-status-done" title={title || 'done'}>
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.8 8.2l2 2 4.4-4.4" stroke="white" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </span>
    );
  }
  if (norm === 'err') {
    return (
      <span className="run-status run-status-err" title={title || 'errored'}>
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M8 4v5 M8 11.5v.01" stroke="white" strokeWidth="2"
                strokeLinecap="round" fill="none" />
        </svg>
      </span>
    );
  }
  if (norm === 'wait') {
    return (
      <span className="run-status run-status-wait" title={title || 'waiting'}>
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M6.2 5.5v5 M9.8 5.5v5" stroke="white" strokeWidth="1.8"
                strokeLinecap="round" fill="none" />
        </svg>
      </span>
    );
  }
  // draft / abandoned / fallback — outlined gray
  return (
    <span className={`run-status run-status-${norm || 'draft'}`} title={title || norm || ''}>
      <svg viewBox="0 0 16 16" width={size} height={size} fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"
                strokeDasharray={norm === 'draft' ? '2 2' : 'none'} />
        {norm === 'abandoned' && (
          <path d="M4.5 8h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

function Splitter({ axis = 'x', side = 'left', varName, base, min = 160, max = 800, invert = false }) {
  const isY = axis === 'y';
  const ref = React.useRef(null);
  const onMouseDown = (e) => {
    e.preventDefault();
    const node = ref.current;
    node && node.classList.add('dragging');
    const start = isY ? e.clientY : e.clientX;
    const cur = parseInt(getComputedStyle(document.body).getPropertyValue(varName)) || base;
    const onMove = (ev) => {
      const pos = isY ? ev.clientY : ev.clientX;
      const d = (pos - start) * (invert ? -1 : 1);
      const w = Math.max(min, Math.min(max, cur + d));
      document.body.style.setProperty(varName, w + 'px');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      node && node.classList.remove('dragging');
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = isY ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  };
  return <div ref={ref} className={`splitter ${isY ? 'h' : side}`} onMouseDown={onMouseDown} />;
}

function Topbar({ state, A }) {
  const { mode, modeDropdownOpen, path, railHidden, viewState, wbTabs } = state;
  const wbHasTabs = wbTabs && wbTabs.length > 0;
  const sessionsMode = mode === 'sessions';
  return (
    <header className="topbar">
      <button className="brand" title="Toggle session list" onClick={() => A.set('railHidden', !railHidden)}>
        <GianMark size={18} />
        <span className="brand-word">Gian</span>
      </button>

      <span className="mode-anchor">
        <button className="mode-btn" onClick={() => A.set('modeDropdownOpen', !modeDropdownOpen)}>
          {mode === 'sessions' ? 'Sessions' : mode === 'spaces' ? 'Workspaces' : mode === 'bots' ? 'Bots' : 'Tasks'}
          <span className="caret">▾</span>
        </button>
        {modeDropdownOpen && (
          <div className="mode-pop">
            {[
              ['sessions', 'Sessions'],
              ['tasks',    'Tasks'],
            ].map(([key, label]) => (
              <button key={key}
                      className={`mode-pop-item ${mode === key ? 'active' : ''}`}
                      onClick={() => { A.setMode(key); A.set('modeDropdownOpen', false); }}>
                <span className="check">{mode === key ? '✓' : ''}</span>
                {label}
              </button>
            ))}
          </div>
        )}
      </span>

      <PathBreadcrumb path={path} state={state} A={A} />

      {sessionsMode && wbHasTabs && (
        <div className="view-seg" title="View — chat / split / workbench">
          <button className={`view-seg-item ${viewState === 'main' ? 'active' : ''}`}
                  onClick={() => A.setViewState('main')}
                  title="Chat only">
            <ViewIcon variant="main" />
          </button>
          <button className={`view-seg-item ${viewState === 'both' ? 'active' : ''}`}
                  onClick={() => A.setViewState('both')}
                  title="Chat + workbench (split)">
            <ViewIcon variant="both" />
          </button>
          <button className={`view-seg-item ${viewState === 'workbench' ? 'active' : ''}`}
                  onClick={() => A.setViewState('workbench')}
                  title="Workbench only">
            <ViewIcon variant="wb" />
          </button>
        </div>
      )}
    </header>
  );
}

// ─── Mode Rail removed (reverted) ──────────────────────────────────────────

function ViewIcon({ variant }) {
  // Clearer 3-state view icons.
  // Each tile = one pane; the active pane is filled, the inactive pane is just an outline.
  const stroke = 'currentColor';
  if (variant === 'main') {
    // Chat only: single filled rect (no workbench).
    return (
      <svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round">
        <rect x="2.2" y="2" width="15.6" height="10" rx="1.6" fill="currentColor" fillOpacity="0.25" />
      </svg>
    );
  }
  if (variant === 'both') {
    // Both: left filled (chat) + right filled (workbench), separated.
    return (
      <svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round">
        <rect x="2.2" y="2"  width="9"   height="10" rx="1.6" fill="currentColor" fillOpacity="0.25" />
        <rect x="12.6" y="2" width="5.2" height="10" rx="1.6" fill="currentColor" fillOpacity="0.55" />
      </svg>
    );
  }
  // wb only — workbench fills the canvas; left panel collapsed to a hint stripe.
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round">
      <rect x="2.2"  y="2" width="2.4"  height="10" rx="1.2" fill="currentColor" fillOpacity="0.18" strokeOpacity="0.6" />
      <rect x="6.2"  y="2" width="11.6" height="10" rx="1.6" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

function PathBreadcrumb({ path, state, A }) {
  if (!path || !path.length) return <span style={{ flex: 1 }} />;
  return (
    <div className="path">
      {path.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="path-sep">›</span>}
          {seg.editing
            ? <input className="path-rename-input" autoFocus defaultValue={seg.label}
                     onBlur={(e) => A.finishRename(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') A.cancelRename(); }} />
            : <span className="path-seg-anchor" style={{ position: 'relative' }}>
                <button className={`path-seg ${seg.kind || ''} ${state.copiedSegIdx === i ? 'copied' : ''}`}
                        title={seg.copyHint}
                        onClick={(e) => { e.stopPropagation(); A.clickPathSeg(i, seg); }}>
                  {seg.kind === 'branch' && <BranchIcon />}
                  <span className="path-seg-label">{seg.label}</span>
                  {seg.kind === 'session' && (
                    <span className="path-seg-affordance caret" aria-hidden="true">
                      <Icon d={I.caretDown} size={11} stroke={2} />
                    </span>
                  )}
                </button>
                {state.copiedSegIdx === i && (
                  <span className="path-copied" role="status">
                    <Icon d={I.check} size={10} stroke={2.4} />
                    Copied
                  </span>
                )}
                {seg.kind === 'session' && state.sessionMenuOpen && (
                  <div className="session-menu" onClick={(e) => e.stopPropagation()}>
                    <button className="item" onClick={() => A.startRename(i)}>
                      <Icon d={I.edit || I.copy} size={13} />Rename
                      <span className="sub">F2</span>
                    </button>
                    <button className="item" onClick={() => { try { navigator.clipboard?.writeText(seg.label); } catch (_) {} A.set('sessionMenuOpen', false); }}>
                      <Icon d={I.copy} size={13} />Copy name
                    </button>
                    <button className="item" onClick={() => A.set('sessionMenuOpen', false)}>
                      <Icon d={I.refresh} size={13} />Force recover
                    </button>
                    <div className="rule" />
                    <button className="item" onClick={() => A.set('sessionMenuOpen', false)}>
                      <Icon d={I.folder} size={13} />Archive
                    </button>
                    <button className="item danger" onClick={() => A.set('sessionMenuOpen', false)}>
                      <Icon d={I.trash} size={13} />Delete session…
                    </button>
                  </div>
                )}
              </span>}
        </React.Fragment>
      ))}
      <span style={{ flex: 1 }} />
    </div>
  );
}

// ─── Sidebar (Sessions) ────────────────────────────────────────────────────
function SidebarSessions({ state, A }) {
  const { search, filter, filterOpen, groupOpen, groupBy, selectedSessionId } = state;
  const list = SESSIONS.filter(s => {
    if (filter.ws && s.ws !== filter.ws) return false;
    if (filter.exec && s.exec !== filter.exec) return false;
    if (search) {
      const q = search.toLowerCase();
      return s.title.toLowerCase().includes(q) || s.branch.toLowerCase().includes(q) || s.ws.toLowerCase().includes(q);
    }
    return true;
  });
  const groups = groupSessions(list, groupBy);
  const hasFilter = Boolean(filter.ws || filter.exec);

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="sb-search-row">
          <div className="sb-search">
            <Icon d={I.search} />
            <input placeholder="Search" value={search} onChange={(e) => A.set('search', e.target.value)} />
          </div>
          <button className="sb-iconbtn" title={`Group by · ${groupBy}`}
                  onClick={() => A.set('groupOpen', !groupOpen)}>
            <Icon d={I.group} />
          </button>
          <button className={`sb-iconbtn ${hasFilter ? 'has-active' : ''}`} title="Filter"
                  onClick={() => A.set('filterOpen', !filterOpen)}>
            <Icon d={I.filter} />
          </button>
          <span className="sb-sep" />
          <button className="sb-iconbtn" title="New session" onClick={() => A.set('sessionsView', 'new')}>
            <Icon d={I.plus} />
          </button>

          {groupOpen && (
            <div className="group-pop">
              <div className="head">Group by</div>
              {['time', 'status', 'workspace'].map(g => (
                <button key={g} className={`item ${groupBy === g ? 'active' : ''}`}
                        onClick={() => { A.set('groupBy', g); A.set('groupOpen', false); }}>
                  <span className="check">{groupBy === g ? '✓' : ''}</span>
                  {g === 'time' ? 'Time' : g === 'status' ? 'Status' : 'Workspace'}
                </button>
              ))}
            </div>
          )}
          {filterOpen && (
            <div className="filter-pop">
              <div>
                <div className="lbl">Workspace</div>
                <select className="select" style={{ width: '100%' }}
                        value={filter.ws || ''}
                        onChange={(e) => A.set('filter', { ...filter, ws: e.target.value || null })}>
                  <option value="">All workspaces</option>
                  {WORKSPACES.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>
              <div>
                <div className="lbl">Executor</div>
                <div className="segm" style={{ width: '100%' }}>
                  {[['', 'All'], ['claude', 'Claude'], ['codex', 'Codex']].map(([v, lbl]) => (
                    <button key={v || 'all'}
                            className={`segm-item ${(filter.exec || '') === v ? 'active' : ''}`}
                            style={{ flex: 1 }}
                            onClick={() => A.set('filter', { ...filter, exec: v || null })}>
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }}
                      onClick={() => A.set('filter', { ws: null, exec: null })}>
                Reset
              </button>
            </div>
          )}
        </div>

        {hasFilter && (
          <div className="sb-chips">
            {filter.ws && (
              <span className="sb-chip">
                <span className="dot" />{WORKSPACES.find(w => w.id === filter.ws)?.name}
                <button className="x" onClick={() => A.set('filter', { ...filter, ws: null })}><Icon d={I.x} size={9} stroke={2.4} /></button>
              </span>
            )}
            {filter.exec && (
              <span className={`sb-chip ${filter.exec}`}>
                <span className="dot" />{filter.exec === 'claude' ? 'Claude' : 'Codex'}
                <button className="x" onClick={() => A.set('filter', { ...filter, exec: null })}><Icon d={I.x} size={9} stroke={2.4} /></button>
              </span>
            )}
            <button className="sb-chip clear" onClick={() => A.set('filter', { ws: null, exec: null })}>clear</button>
          </div>
        )}
      </div>

      <div className="sb-scroll">
        {groups.map((g, i) => (
          <React.Fragment key={i}>
            <div className={`sb-group ${g.needs ? 'needs-you' : ''}`}>
              {g.needs && <span className="dot" />}
              <span>{g.label}</span>
              {g.needs && <span className="count">{g.items.length}</span>}
            </div>
            {g.items.map(s => <SessionRow key={s.id} s={s} active={s.id === selectedSessionId} A={A} />)}
          </React.Fragment>
        ))}
        <button className="sb-archived" onClick={() => A.set('archivedOpen', !state.archivedOpen)}>
          <span className="caret">{state.archivedOpen ? '▾' : '▸'}</span> Archived
          <span className="count">14</span>
        </button>
      </div>
    </aside>
  );
}

function SessionRow({ s, active, A }) {
  return (
    <div className={`rail-item ${active ? 'active' : ''}`} onClick={() => A.selectSession(s.id)}>
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{s.title}</span>
          {s.status === 'run'  && <span className="pill run">running</span>}
          {s.status === 'wait' && <span className="pill wait">waiting</span>}
          {s.status === 'err'  && <span className="pill err">error</span>}
        </div>
        <div className="ri-row2">
          <span className={`ri-exec ${s.exec}`}>{s.exec === 'claude' ? 'Claude' : 'Codex'}</span>
          <span className="ri-dot-sep">·</span>
          <span className="ri-sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <BranchIcon size={9} />{s.branch}
          </span>
        </div>
      </div>
      <span className="ri-age" title="Last activity">{s.age}</span>
    </div>
  );
}

// ─── Sidebar (Spaces / Bots) ───────────────────────────────────────────────
function SidebarSpaces({ state, A }) {
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="sb-search-row">
          <span className="sb-meta">{WORKSPACES.length} workspaces</span>
          <button className="sb-iconbtn" title="New workspace"><Icon d={I.plus} /></button>
        </div>
      </div>
      <div className="sb-scroll">
        {WORKSPACES.map(w => (
          <div key={w.id} className={`rail-item ${w.id === state.selectedWsId ? 'active' : ''}`}
               onClick={() => A.set('selectedWsId', w.id)}>
            <div className="ri-body">
              <div className="ri-row1"><span className="ri-title">{w.name}</span></div>
              <div className="ri-row2">
                <span className="ri-sub" style={{ fontFamily: 'var(--font-mono)' }}>{w.path}</span>
              </div>
            </div>
            <span className="ri-age">{w.sessions} sess</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function SidebarBots({ state, A }) {
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="sb-search-row">
          <span className="sb-meta">{BOTS.length} bots</span>
          <button className="sb-iconbtn" title="New bot" onClick={() => { A.set('botsView', 'new'); A.set('selectedBotId', null); }}>
            <Icon d={I.plus} />
          </button>
        </div>
      </div>
      <div className="sb-scroll">
        {BOTS.map(b => (
          <button key={b.id} className={`bots-row ${b.id === state.selectedBotId ? 'active' : ''} ${b.connected ? 'connected' : ''}`}
                  onClick={() => { A.set('selectedBotId', b.id); A.set('botsView', 'detail'); }}>
            <span className={`pmark ${b.platform}`}>{b.platform[0].toUpperCase()}</span>
            <div className="info">
              <div className="name">{b.name}</div>
              <div className="sub">{b.platform} · {b.workspace || 'unbound'}</div>
            </div>
            <span className="status-dot" />
          </button>
        ))}
      </div>
    </aside>
  );
}

// ─── Sidebar (Tasks) ───────────────────────────────────────────────────────
function SidebarTasks({ state, A }) {
  const { selectedTaskId, selectedSubtaskId, expandedTaskIds, taskSearch } = state;
  const q = (taskSearch || '').toLowerCase();
  const filtered = TASKS.filter(t => {
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q);
  });
  const effStatus = (t) => A.effectiveTaskStatus ? A.effectiveTaskStatus(t) : t.status;
  const open = filtered.filter(t => effStatus(t) !== 'archived');
  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="sb-search-row">
          <div className="sb-search">
            <Icon d={I.search} />
            <input placeholder="Search tasks" value={taskSearch || ''} onChange={(e) => A.set('taskSearch', e.target.value)} />
          </div>
          <span className="sb-sep" />
          <button className="sb-iconbtn" title="New task" onClick={() => { /* stub */ }}>
            <Icon d={I.plus} />
          </button>
        </div>
      </div>

      <div className="sb-scroll">
        <div className="sb-group"><span>Open</span><span className="count">{open.filter(t => effStatus(t) === 'open').length}</span></div>
        {open.filter(t => effStatus(t) === 'open').map(t => {
          const expanded = t.id === selectedTaskId;
          const childSubs = SUBTASKS.filter(st => st.taskId === t.id);
          return (
            <React.Fragment key={t.id}>
              <TaskRow task={t} active={t.id === selectedTaskId && !selectedSubtaskId} subCount={childSubs.length} A={A} />
              {expanded && childSubs.map(st => (
                <SubtaskRow key={st.id} subtask={st}
                            active={t.id === selectedTaskId && st.id === selectedSubtaskId}
                            A={A} />
              ))}
            </React.Fragment>
          );
        })}

        <div className="sb-group" style={{ marginTop: 14 }}><span>Done</span><span className="count">{open.filter(t => effStatus(t) === 'done').length}</span></div>
        {open.filter(t => effStatus(t) === 'done').map(t => {
          const expanded = t.id === selectedTaskId;
          const childSubs = SUBTASKS.filter(st => st.taskId === t.id);
          return (
            <React.Fragment key={t.id}>
              <TaskRow task={t} active={t.id === selectedTaskId && !selectedSubtaskId} subCount={childSubs.length} A={A} />
              {expanded && childSubs.map(st => (
                <SubtaskRow key={st.id} subtask={st}
                            active={t.id === selectedTaskId && st.id === selectedSubtaskId}
                            A={A} />
              ))}
            </React.Fragment>
          );
        })}
      </div>
    </aside>
  );
}

function TaskRow({ task, active, subCount, A }) {
  const effectiveStatus = A.effectiveTaskStatus ? A.effectiveTaskStatus(task) : task.status;
  return (
    <div className={`rail-item task-row status-${effectiveStatus} ${active ? 'active' : ''}`} onClick={() => A.selectTask(task.id)}>
      {effectiveStatus !== 'archived' && (
        <button className={`done-toggle ${effectiveStatus === 'done' ? 'done' : ''}`}
                title={effectiveStatus === 'done' ? 'Reopen task' : 'Mark task done'}
                onClick={(e) => { e.stopPropagation(); A.toggleTaskDone(task.id); }}>
          <Icon d={I.check} size={12} stroke={2.4} />
        </button>
      )}
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{task.name}</span>
        </div>
        <div className="ri-row2">
          <span className="ri-sub" style={{ flex: 1 }}>{subCount} subtask{subCount === 1 ? '' : 's'}</span>
        </div>
      </div>
      <span className="ri-age" title="Last activity">{task.updatedAt}</span>
    </div>
  );
}

function SubtaskRow({ subtask, active, A }) {
  const effectiveStatus = A.effectiveSubtaskStatus ? A.effectiveSubtaskStatus(subtask) : subtask.status;
  return (
    <div className={`rail-item subtask-row status-${effectiveStatus} ${active ? 'active' : ''}`}
         onClick={() => A.selectSubtask(subtask.taskId, subtask.id)}>
      {effectiveStatus !== 'abandoned' && (
        <button className={`done-toggle ${effectiveStatus === 'done' ? 'done' : ''}`}
                title={effectiveStatus === 'done' ? 'Reopen subtask' : 'Mark subtask done'}
                onClick={(e) => { e.stopPropagation(); A.toggleSubtaskDone(subtask.id); }}>
          <Icon d={I.check} size={12} stroke={2.4} />
        </button>
      )}
      <div className="ri-body">
        <div className="ri-row1">
          <span className="ri-title">{subtask.name}</span>
          <RunStatusIcon status={effectiveStatus} />
        </div>
        <div className="ri-row2">
          <span className={`ri-exec ${subtask.executor}`}>{subtask.executor === 'claude' ? 'Claude' : 'Codex'}</span>
          <span className="ri-dot-sep">·</span>
          <span className="ri-sub">{subtask.runtimeMode}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Dock ──────────────────────────────────────────────────────────────────
function Dock({ state, A }) {
  const Btn = ({ id, label, icon, onClick, active, badge, group }) => (
    <button className={`dock-btn ${group || ''} ${active ? 'active' : ''}`}
            data-dock-group={group} onClick={onClick} title={label}>
      <Icon d={I[icon]} size={17} />
      {badge != null && <span className="dock-badge">{badge > 9 ? '9+' : badge}</span>}
      <span className="lbl">{label}</span>
    </button>
  );
  const inbox = state.inbox || 0;
  const hasTerminal = state.wbTabs.some(t => t.kind === 'term');
  const hasSettings = state.wbTabs.some(t => t.kind === 'settings');
  const isTasksSubtask = state.mode === 'tasks' && state.selectedSubtaskId;
  const isTasksManager = state.mode === 'tasks' && !state.selectedSubtaskId;
  return (
    <aside className="dock">
      {/* Group 1 — open side panel (Inspector). Hidden when no workspace context (Tasks manager view). */}
      {!isTasksManager && (
        <>
          <div className="dock-group" data-dock-group-label="Panel">
            {isTasksSubtask && (
              <Btn id="manager" label="Manager" icon="chat" group="panel"
                   active={state.inspectorTab === 'manager'} onClick={() => A.toggleInspector('manager')} />
            )}
            <Btn id="workspaces" label="Workspaces" icon="grid" group="panel"
                 active={state.inspectorTab === 'workspaces'} onClick={() => A.toggleInspector('workspaces')} />
            <Btn id="files"    label="Files"    icon="folder"   group="panel"
                 active={state.inspectorTab === 'files'}    onClick={() => A.toggleInspector('files')} />
            <Btn id="changes"  label="Changes"  icon="diff"     group="panel"
                 active={state.inspectorTab === 'changes'}  onClick={() => A.toggleInspector('changes')} />
          </div>
          <div className="dock-divider" aria-hidden="true" />
        </>
      )}

      {/* Group 2 — open a tab in the Workbench */}
      <div className="dock-group" data-dock-group-label="Workbench">
        <Btn id="terminal" label="Terminal" icon="terminal" group="wb"
             active={hasTerminal}                       onClick={() => A.toggleWbTabKind('term')} />
        <Btn id="settings" label="Settings" icon="gear" group="wb"
             active={hasSettings}                       onClick={() => A.toggleWbTabKind('settings')} />
      </div>

      <span className="dock-spacer" />
      <div className="dock-divider" aria-hidden="true" />

      {/* Group 3 — overlays */}
      <div className="dock-group" data-dock-group-label="Popout">
        <Btn id="search"   label="Search"   icon="search" group="popout"
             onClick={() => A.set('paletteOpen', true)} />
        <span className="inbox-anchor" style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}>
          <Btn id="inbox" label="Inbox" icon="inbox" group="popout" badge={inbox > 0 ? inbox : null}
               active={state.inboxOpen}
               onClick={() => A.set('inboxOpen', !state.inboxOpen)} />
          {state.inboxOpen && (
            <div className="inbox-pop dock-side">
              <div className="head">
                <span>Approvals waiting</span>
                <button className="clear-all" onClick={() => A.set('inboxOpen', false)}>Clear all</button>
              </div>
              <button className="row">
                <span className="cat high">cmd</span>
                <span className="desc">Allow <code style={{ fontFamily: 'var(--font-mono)' }}>pnpm test packages/host/src/auth</code> in worktree feat/auth-flow?</span>
                <span className="at">2m</span>
              </button>
              <button className="row">
                <span className="cat">net</span>
                <span className="desc">Permit fetch to <code style={{ fontFamily: 'var(--font-mono)' }}>github.com/api/v3</code> for fetch-pr step</span>
                <span className="at">15m</span>
              </button>
            </div>
          )}
        </span>
      </div>
    </aside>
  );
}

Object.assign(window, {
  Topbar, PathBreadcrumb, Splitter,
  SidebarSessions, SessionRow, SidebarSpaces, SidebarBots,
  SidebarTasks, TaskRow, SubtaskRow,
  Dock, RunStatusIcon,
});
