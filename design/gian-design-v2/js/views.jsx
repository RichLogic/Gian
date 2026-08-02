// ============================================================
// Main views — Chat, CLI, Sheet, Inspector, Spaces detail, Bots detail,
// and the Settings / Command palette overlays.
// ============================================================

// ─── Chat main pane ────────────────────────────────────────────────────────
function ChatMain({ state, A }) {
  if (state.sessionsView === 'new') return <SessionNew state={state} A={A} />;
  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          <div className="chat-toggle">
            <button className={state.chatMode === 'chat' ? 'active' : ''} onClick={() => A.set('chatMode', 'chat')}>Chat</button>
            <button className={state.chatMode === 'cli'  ? 'active' : ''} onClick={() => A.set('chatMode', 'cli')}>CLI</button>
          </div>
        </div>
        <div className="main-head-r">
          <span className="session-status">
            <span className="status-dot run" />
            <span className="status-label">running</span>
          </span>
        </div>
      </div>
      <div className="main-scroll">
        <Transcript A={A} />
      </div>
      <Composer state={state} A={A} />
    </main>
  );
}

function SessionNew({ state, A }) {
  const [exec, setExec] = React.useState('claude');
  const [mode, setMode] = React.useState('auto');
  const [wtMode, setWtMode] = React.useState('worktree');
  return (
    <main className="main">
      <div className="main-scroll">
        <div className="detail" style={{ maxWidth: 620 }}>
          <h1>New session</h1>
          <div className="detail-sub">Wire an agent to a workspace and kick off the first turn.</div>

          <div className="card">
            <div className="card-head"><h3>Workspace</h3></div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Workspace</dt>
                <dd>
                  <select className="select" defaultValue="gian">
                    {WORKSPACES.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </dd>
                <dt>Worktree</dt>
                <dd>
                  <div className="segm">
                    <button className={`segm-item ${wtMode === 'regular' ? 'active' : ''}`} onClick={() => setWtMode('regular')}>Use main</button>
                    <button className={`segm-item ${wtMode === 'worktree' ? 'active' : ''}`} onClick={() => setWtMode('worktree')}>New worktree</button>
                  </div>
                </dd>
                {wtMode === 'worktree' && (
                  <>
                    <dt>Branch name</dt>
                    <dd><input className="input" style={{ width: '70%' }} defaultValue="feat/new-feature" /></dd>
                    <dt>Base branch</dt>
                    <dd>
                      <select className="select" defaultValue="main">
                        <option>main</option>
                        <option>develop</option>
                      </select>
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Executor</h3></div>
            <div className="card-body">
              <div className="segm" style={{ marginBottom: 10 }}>
                <button className={`segm-item ${exec === 'claude' ? 'active' : ''}`} onClick={() => setExec('claude')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--claude)' }} />Claude Code
                </button>
                <button className={`segm-item ${exec === 'codex' ? 'active' : ''}`} onClick={() => setExec('codex')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--codex)' }} />Codex
                </button>
              </div>
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Approval mode</dt>
                <dd>
                  <div className="segm">
                    <button className={`segm-item ${mode === 'plan' ? 'active' : ''}`} onClick={() => setMode('plan')}>Plan</button>
                    <button className={`segm-item ${mode === 'ask' ? 'active' : ''}`} onClick={() => setMode('ask')}>Ask</button>
                    <button className={`segm-item ${mode === 'auto' ? 'active' : ''}`} onClick={() => setMode('auto')}>Auto</button>
                  </div>
                </dd>
                <dt>Model</dt>
                <dd className="mono" style={{ color: 'var(--text-3)' }}>
                  {exec === 'claude' ? 'sonnet-4.5 · medium effort' : 'gpt-5.1-codex · medium thinking'}
                </dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Session</h3></div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Name</dt>
                <dd><input className="input" style={{ width: '80%' }} placeholder="auto · derive from first message" /></dd>
                <dt>First message</dt>
                <dd>
                  <textarea className="input" rows={4} style={{ width: '100%', resize: 'vertical' }}
                            placeholder="Describe what you want the agent to do…" />
                </dd>
              </dl>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => A.set('sessionsView', 'detail')}>Cancel</button>
            <button className="btn primary" onClick={() => A.set('sessionsView', 'detail')}>Create session</button>
          </div>
        </div>
      </div>
    </main>
  );
}

function Transcript({ A }) {
  return (
    <div className="transcript">
      <Msg who="You" kind="user">
        The OAuth callback is dropping the <code>state</code> param when we redirect through the worktree subdomain. Logs show the cookie is set on <code>.gian.local</code> but the callback handler reads it from the root. Can you find where the read happens and fix it?
      </Msg>

      <Msg who="Claude · sonnet-4.5" kind="claude" time="2:14 PM">
        <p>Tracing the callback handler. The state cookie is being read in <code>packages/host/src/auth/oauth.ts</code> via <code>cookies.get(STATE_COOKIE)</code> — that uses the request's own host as the domain. Let me look at how it's written.</p>
      </Msg>

      <Evt open
           verb="Read"
           subject="packages/host/src/auth/oauth.ts"
           meta="80 lines"
           A={A}
           body={
             <div className="evt-args">
               <dt>path</dt><dd>packages/host/src/auth/oauth.ts</dd>
               <dt>lines</dt><dd>1–80</dd>
             </div>
           } />
      <Evt verb="Grep" subject="STATE_COOKIE" meta="4 matches" A={A} body={<div className="evt-args"><dt>pattern</dt><dd>STATE_COOKIE</dd><dt>scope</dt><dd>packages/**</dd></div>} />
      <Evt verb="Edit" subject="packages/host/src/auth/oauth.ts" meta={<><span className="add">+8</span> <span className="del">−3</span></>} A={A} />

      <Msg who="Claude · sonnet-4.5" kind="claude" time="2:15 PM">
        <p>Found it. The cookie is written with <code>domain: '.gian.local'</code> from the worktree subdomain, but the callback handler reads via <code>request.cookies</code> which is scoped to whichever Host header arrived — when the IdP redirects back to the root, the parent domain's cookie isn't in scope.</p>
        <p>Patched the read side to walk up cookie domains the same way browsers do (try exact, then parent). Verifies against both subdomain and root callbacks.</p>
      </Msg>

      <div className="approval">
        <div className="approval-top">
          <div className="approval-ico">
            <Icon d={I.shield} size={14} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="approval-title-row">
              <span className="approval-title">Run command</span>
              <span className="approval-risk">medium</span>
            </div>
            <div className="approval-sub">Claude wants to run a shell command in this worktree · also in <a className="approval-inbox-link" href="#" onClick={(e) => { e.preventDefault(); A.set('inboxOpen', true); }}>Inbox</a></div>
          </div>
        </div>
        <div className="approval-cmd"><span className="prompt">$ </span>pnpm test packages/host/src/auth/oauth.spec.ts --run</div>
        <div className="approval-actions">
          <button className="btn primary">Allow once</button>
          <button className="btn secondary">Allow session</button>
          <button className="btn ghost">Decline</button>
          <span className="approval-tip">⏎ Allow · ⌫ Decline</span>
        </div>
      </div>

      <Msg who="You" kind="user">
        Add a regression test that reproduces the cross-subdomain case before merging.
      </Msg>

      <Msg who="Claude · sonnet-4.5" kind="claude" time="2:16 PM · running">
        <p>Writing a fixture in <code>e2e/auth/oauth.spec.ts</code> that mounts both <code>app.gian.local</code> and <code>auth.gian.local</code>, sets the state cookie from the subdomain, then drives the callback from the root. It should fail on main and pass on this branch.</p>
      </Msg>
    </div>
  );
}

function Msg({ who, kind, time, children }) {
  const isUser = kind === 'user';
  return (
    <div className={`msg ${isUser ? 'user' : ''}`}>
      <div className="msg-body">
        <div className="msg-text">{children}</div>
        {time && <div className={`msg-time ${isUser ? 'user' : ''}`}>{time}</div>}
      </div>
    </div>
  );
}

function Evt({ open, verb, subject, meta, status, body, A }) {
  const [isOpen, setOpen] = React.useState(!!open);
  return (
    <div className={`evt ${isOpen ? 'open' : ''}`}>
      <div className="evt-head" onClick={() => setOpen(o => !o)}>
        <svg className="evt-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
        <span className="evt-verb">{verb}</span>
        <span className={`evt-subject ${verb === 'Read' || verb === 'Edit' ? 'path' : ''}`}
              onClick={(e) => { e.stopPropagation(); if (A && (verb === 'Read' || verb === 'Edit')) A.openFileInSheet(subject); }}>
          {subject}
        </span>
        <span className="evt-meta">
          {meta && <span>{meta}</span>}
          {status === 'success' && <span className="evt-status success">done</span>}
          {status === 'error' && <span className="evt-status error">error</span>}
          {status === 'running' && <span className="evt-status running">running</span>}
        </span>
      </div>
      {body && <div className="evt-body">{body}</div>}
    </div>
  );
}

function Composer({ state, A }) {
  const m = state.composerMode;
  const isBypass = m === 'bypass';
  const modeHints = {
    plan:   'Plan — agent only proposes; nothing runs without your OK.',
    ask:    'Ask — agent runs reads, but asks before edits or shell commands.',
    auto:   'Auto — agent runs reads + edits; asks for shell + network.',
    bypass: 'Bypass — agent runs everything with no prompts. Use with care.',
  };
  return (
    <div className={`composer-wrap ${isBypass ? 'is-bypass' : ''}`}>
      <div className="composer">
        {isBypass && (
          <div className="composer-bypass-banner">
            <Icon d={I.warning} size={12} stroke={2} />
            <span>Bypass mode — all actions auto-approved</span>
          </div>
        )}
        <textarea className="composer-ta" placeholder="Message…" defaultValue="" />
        <div className="composer-bar">
          <button className="composer-model" title="Click to switch model / thinking effort">
            <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--claude)', display: 'inline-block' }} />
            <span className="name">sonnet-4.5</span>
            <span className="caret">▾</span>
            <span className="think" title="Thinking effort — medium">
              <i /><i className="on" /><i />
            </span>
          </button>
          <div className="composer-mode" role="tablist" aria-label="Approval mode">
            {['plan', 'ask', 'auto', 'bypass'].map(k => (
              <button key={k} data-mode={k}
                      className={`cmode-item ${m === k ? 'active' : ''}`}
                      title={modeHints[k]}
                      onClick={() => A.set('composerMode', k)}>
                {k === 'bypass' && <span className="cmode-warn" aria-hidden="true">⚠</span>}
                {k}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="composer-act slash-box" title="Slash command"><span className="glyph">/</span></button>
          <button className="composer-act" title="Attach"><Icon d={I.attach} /></button>
          <button className="composer-act primary" title="Send"><Icon d={I.send} stroke={2} /></button>
        </div>
      </div>
    </div>
  );
}

// ─── Tasks mode — ManagerMain / SubtaskMain / ApprovalCard ─────────────────
function ManagerMain({ state, A, compact = false }) {
  const task = TASKS.find(t => t.id === state.selectedTaskId) || TASKS[0];
  if (!task) return <main className="main"><div className="main-scroll" /></main>;
  const stream = MANAGER_MESSAGES[task.id] || [];
  const proposal = state.pendingProposalByTask?.[task.id] || null;

  return (
    <main className={`main ${compact ? 'compact' : ''}`}>
      {!compact && (
        <div className="main-head">
          <div className="main-head-l">
            <span className="manager-eyebrow">Manager</span>
            <span className="manager-task-name">{task.name}</span>
          </div>
          <div className="main-head-r">
            <span className="session-status">
              <span className={`status-dot ${task.status === 'open' ? 'run' : ''}`} />
              <span className="status-label">{task.status === 'open' ? 'open' : task.status}</span>
            </span>
          </div>
        </div>
      )}
      <div className="main-scroll">
        <ManagerTranscript stream={stream} proposal={proposal} state={state} A={A} />
      </div>
      <Composer state={state} A={A} />
    </main>
  );
}

function ManagerTranscript({ stream, proposal, state, A }) {
  return (
    <div className="transcript">
      {stream.map((m, i) => {
        if (m.kind === 'user') return <Msg key={i} who="You" kind="user">{m.text}</Msg>;
        if (m.kind === 'manager') return (
          <Msg key={i} who="Manager · Codex · gpt-5.5 · xhigh" kind="manager" time={m.time}>
            <p>{m.text}</p>
          </Msg>
        );
        if (m.kind === 'tool_call') return (
          <div key={i} className="tool-call-card">
            <span className="tool-call-tag">manager tool</span>
            <span className="tool-call-verb">{m.verb}</span>
            <span className="tool-call-subject mono">{m.subject}</span>
            {m.meta && <span className="tool-call-meta">{m.meta}</span>}
          </div>
        );
        if (m.kind === 'tool_result') return (
          <div key={i} className="tool-result-card">
            <span className="tool-result-tag">result</span>
            <span className="tool-result-body">{m.text}</span>
          </div>
        );
        if (m.kind === 'proposal_anchor') {
          if (!proposal || proposal.id !== m.proposalId) return null;
          return <ApprovalCard key={i} proposal={proposal} state={state} A={A} />;
        }
        return null;
      })}
    </div>
  );
}

function ApprovalCard({ proposal, state, A }) {
  // Visible state: 'pending' | 'editing' | 'approved' | 'rejected' | 'timeout'
  const initialStatus = state.proposalStatusById?.[proposal.id] || 'pending';
  const [status, setStatus] = React.useState(initialStatus);
  const [secs, setSecs] = React.useState(proposal.timeoutSec || 60);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    workspaceId: proposal.workspaceId,
    executor: proposal.executor,
    runtimeMode: proposal.runtimeMode,
    approvalMode: proposal.approvalMode,
    initialPrompt: proposal.initialPrompt,
  });

  React.useEffect(() => {
    if (status !== 'pending' && status !== 'editing') return;
    if (secs <= 0) { setStatus('timeout'); return; }
    const t = setInterval(() => setSecs(s => s - 1), 1000);
    return () => clearInterval(t);
  }, [status, secs]);

  if (status === 'approved') {
    return (
      <div className="approval-card approved">
        <span className="approval-card-icon"><Icon d={I.check} size={12} stroke={2.4} /></span>
        <span className="approval-card-label">Subtask created</span>
        <span className="approval-card-subtask mono">→ {proposal.proposedSubtaskName}</span>
      </div>
    );
  }
  if (status === 'rejected') {
    return (
      <div className="approval-card rejected">
        <span className="approval-card-icon"><Icon d={I.x} size={12} stroke={2.4} /></span>
        <span className="approval-card-label">Proposal rejected</span>
      </div>
    );
  }
  if (status === 'timeout') {
    return (
      <div className="approval-card timeout">
        <span className="approval-card-icon">⏱</span>
        <span className="approval-card-label">Approval timeout · auto-discarded</span>
      </div>
    );
  }

  // pending / editing — full card
  const total = proposal.timeoutSec || 60;
  const frac = Math.max(0, secs / total);
  const r = 9;
  const c = 2 * Math.PI * r;

  return (
    <div className={`approval-card pending ${editing ? 'editing' : ''}`}>
      <div className="approval-card-head">
        <span className="approval-card-eyebrow">Manager proposal · create_subtask</span>
        <span className="approval-card-timer" title={`Auto-discard in ${secs}s`}>
          <svg viewBox="0 0 24 24" width="22" height="22" className="ring-svg">
            <circle cx="12" cy="12" r={r} stroke="var(--hairline)" strokeWidth="2" fill="none" />
            <circle cx="12" cy="12" r={r} stroke="var(--accent)" strokeWidth="2" fill="none"
                    strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
                    strokeLinecap="round"
                    style={{ transform: 'rotate(-90deg)', transformOrigin: '12px 12px', transition: 'stroke-dashoffset 0.9s linear' }} />
          </svg>
          <span className="approval-card-secs mono">{secs}s</span>
        </span>
      </div>

      <div className="approval-card-grid">
        <label className="approval-field">
          <span className="lbl">Workspace</span>
          <select className="select" disabled={!editing} value={draft.workspaceId}
                  onChange={(e) => setDraft(d => ({ ...d, workspaceId: e.target.value }))}>
            {WORKSPACES.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <label className="approval-field">
          <span className="lbl">Executor</span>
          <select className="select" disabled={!editing} value={draft.executor}
                  onChange={(e) => setDraft(d => ({ ...d, executor: e.target.value }))}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="approval-field">
          <span className="lbl">Runtime mode</span>
          <select className="select" disabled={!editing} value={draft.runtimeMode}
                  onChange={(e) => setDraft(d => ({ ...d, runtimeMode: e.target.value }))}>
            <option value="structured">structured</option>
            <option value="tty">tty</option>
          </select>
        </label>
        <label className="approval-field">
          <span className="lbl">Approval mode</span>
          <select className="select" disabled={!editing} value={draft.approvalMode}
                  onChange={(e) => setDraft(d => ({ ...d, approvalMode: e.target.value }))}>
            <option value="plan">plan</option>
            <option value="ask">ask</option>
            <option value="auto">auto</option>
            <option value="bypass">bypass</option>
          </select>
        </label>
        <label className="approval-field full">
          <span className="lbl">Initial prompt</span>
          <textarea className="input" rows={5}
                    disabled={!editing}
                    value={draft.initialPrompt}
                    onChange={(e) => setDraft(d => ({ ...d, initialPrompt: e.target.value }))} />
        </label>
      </div>

      <div className="approval-card-actions">
        {!editing ? (
          <>
            <button className="btn primary" onClick={() => setStatus('approved')}>Approve & create</button>
            <button className="btn secondary" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn ghost" onClick={() => setStatus('rejected')}>Reject</button>
          </>
        ) : (
          <>
            <button className="btn primary" onClick={() => { setEditing(false); setStatus('approved'); }}>Approve & create</button>
            <button className="btn ghost" onClick={() => { setEditing(false); setDraft({
              workspaceId: proposal.workspaceId, executor: proposal.executor,
              runtimeMode: proposal.runtimeMode, approvalMode: proposal.approvalMode,
              initialPrompt: proposal.initialPrompt,
            }); }}>Cancel edit</button>
          </>
        )}
        <span className="approval-card-tip">⏎ Approve · ⌫ Reject</span>
      </div>
    </div>
  );
}

// ─── CLI main pane ─────────────────────────────────────────────────────────
function CliMain({ state, A }) {
  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l">
          <div className="chat-toggle">
            <button className={state.chatMode === 'chat' ? 'active' : ''} onClick={() => A.set('chatMode', 'chat')}>Chat</button>
            <button className={state.chatMode === 'cli'  ? 'active' : ''} onClick={() => A.set('chatMode', 'cli')}>CLI</button>
          </div>
        </div>
        <div className="main-head-r">
          <span className="session-status">
            <span className="status-dot run" />
            <span className="status-label">running</span>
          </span>
        </div>
      </div>
      <div className="tty-bar">
        <span><span className="k">branch</span>feat/auth-flow</span>
        <span><span className="k">model</span>sonnet-4.5</span>
        <span><span className="k">approval</span>auto</span>
        <span><span className="k">cwd</span>~/Coding/gian.gian-session-9f3</span>
      </div>
      <div className="tty">
        <div><span className="dim">$</span> <span className="prompt">claude</span> code "fix the oauth callback redirect"</div>
        <div className="dim">Claude Code · 1.4.2 · sonnet-4.5 · auto-approve</div>
        <div />
        <div>● Reading <span className="file">packages/host/src/auth/oauth.ts</span></div>
        <div className="dim">  └ 80 lines · 2.1 KB</div>
        <div>● Searching for <span className="file">STATE_COOKIE</span></div>
        <div className="dim">  └ 4 matches across 3 files</div>
        <div>● Reading <span className="file">packages/shared/src/cookies.ts</span></div>
        <div className="dim">  └ 124 lines · 3.4 KB</div>
        <div />
        <div><span className="ok">✓</span> Found it. The cookie is written from the worktree subdomain</div>
        <div>  with <span className="dim">domain: '.gian.local'</span> but the callback reads via</div>
        <div>  <span className="dim">request.cookies</span> which is scoped to whichever Host header arrived.</div>
        <div>  Patching the read side to walk up cookie domains.</div>
        <div />
        <div>● Editing <span className="file">packages/host/src/auth/oauth.ts</span></div>
        <div className="dim">  <span className="add">+8</span> <span className="del">−3</span></div>
        <div />
        <div><span className="warn">⚠</span> Writing regression test in <span className="file">e2e/auth/oauth.spec.ts</span></div>
        <div>  Mounting <span className="file">app.gian.local</span> and <span className="file">auth.gian.local</span></div>
        <div>  to reproduce the cross-subdomain case.</div>
        <div />
        <div><span className="dim">›</span> <span className="cursor" /></div>
      </div>
    </main>
  );
}

// ─── Sheet ─────────────────────────────────────────────────────────────────
function Sheet({ state, A }) {
  const byPane = { 0: [], 1: [] };
  state.wbTabs.forEach(t => byPane[t.pane || 0].push(t));
  const panes = [];
  if (byPane[0].length) panes.push({ idx: 0, tabs: byPane[0] });
  if (byPane[1].length) panes.push({ idx: 1, tabs: byPane[1] });

  if (panes.length === 0) return null;

  return (
    <section className="sheet">
      {panes.map((p, i) => {
        const activeId = state.wbActive[p.idx] || p.tabs[0]?.id;
        const tab = p.tabs.find(t => t.id === activeId) || p.tabs[0];
        const isFile = tab.kind === 'file';
        return (
          <React.Fragment key={p.idx}>
            {i > 0 && <Splitter axis="y" varName="--sheet-top-h" base={320} min={120} max={700} />}
            <div className="sheet-pane" style={i === 0 && panes.length === 2 ? { flex: 'none', height: 'var(--sheet-top-h, 320px)' } : undefined}>
              <div className="sheet-tabs">
                {p.tabs.map(t => (
                  <button key={t.id}
                          className={`sheet-tab ${t.id === activeId ? 'active' : ''} ${t.preview ? 'preview' : ''}`}
                          title={t.preview ? `${t.name} · single-click preview — double-click or pin to keep` : t.name}
                          onClick={() => A.activateSheetTab(p.idx, t.id)}
                          onDoubleClick={() => A.pinSheetTab(t.id)}>
                    <span className={`ext-ico ${t.icoKind}`}>
                      {t.icoKind === 'gear'
                        ? <Icon d={I.gear} size={9} stroke={2} />
                        : (t.ico || t.icoKind[0].toUpperCase())}
                    </span>
                    <span className="name">{t.name}</span>
                    {t.preview && (
                      <span className="tab-pin-inline" title="Keep this tab open" onClick={(e) => { e.stopPropagation(); A.pinSheetTab(t.id); }}>
                        <Icon d={I.pin} size={10} stroke={1.8} />
                      </span>
                    )}
                    <span className="tab-x" onClick={(e) => { e.stopPropagation(); A.closeSheetTab(t.id); }}>
                      <Icon d={I.x} size={10} stroke={2.2} />
                    </span>
                  </button>
                ))}
                <span className="sheet-tabs-spacer" />
                {isFile && (
                  <span className="sheet-tabs-actions">
                    {tab.icoKind === 'md' && (
                      <div className="sheet-mode-toggle" role="tablist">
                        <button className={tab.viewMode === 'preview' ? 'active' : ''}
                                title="Rendered preview"
                                onClick={() => A.setTabViewMode(tab.id, 'preview')}>
                          <Icon d={I.eye} size={11} stroke={1.8} />
                        </button>
                        <button className={(tab.viewMode || 'source') === 'source' ? 'active' : ''}
                                title="Source"
                                onClick={() => A.setTabViewMode(tab.id, 'source')}>
                          <Icon d={I.code} size={11} stroke={1.8} />
                        </button>
                      </div>
                    )}
                    <button className="sheet-tabs-act" title="Open in new tab"
                            onClick={() => A.duplicateSheetTab(tab.id)}>
                      <Icon d={I.openNew} size={12} stroke={1.8} />
                    </button>
                  </span>
                )}
              </div>
              <div className="sheet-content">
                {tab.kind === 'file' && tab.icoKind === 'md' && tab.viewMode === 'preview'
                  ? <MarkdownPreview lines={tab.lines} />
                  : tab.kind === 'file' ? <FileBody lines={tab.lines} /> : null}
                {tab.kind === 'term' && <TermBody />}
                {tab.kind === 'settings' && <SettingsBody state={state} A={A} />}
                {tab.kind === 'workspace' && <WorkspaceDetailBody wsId={tab.wsId} state={state} A={A} />}
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </section>
  );
}

function FileBody({ lines }) {
  return (
    <div className="sheet-file">
      {lines.map((row, i) => {
        const [n, t, cls, diff] = row.length ? row : ['', '', '', ''];
        return (
          <div className={`ln ${diff || ''}`} key={i}>
            <span className="num">{n}</span>
            <span className={`txt ${cls || ''}`}>{t}</span>
          </div>
        );
      })}
    </div>
  );
}

// Lightweight markdown preview — enough for CLAUDE.md style content.
function MarkdownPreview({ lines }) {
  const src = lines.map(row => row[1] !== undefined ? row[1] : '').join('\n');
  const blocks = [];
  const rows = src.split('\n');
  let i = 0;
  while (i < rows.length) {
    const ln = rows[i];
    if (/^```/.test(ln)) {
      const lang = ln.slice(3).trim();
      const code = [];
      i++;
      while (i < rows.length && !/^```/.test(rows[i])) { code.push(rows[i]); i++; }
      i++; // closing fence
      blocks.push({ type: 'code', lang, code: code.join('\n') });
      continue;
    }
    const h = ln.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push({ type: 'h', lvl: h[1].length, text: h[2] }); i++; continue; }
    if (/^[-*]\s+/.test(ln)) {
      const items = [];
      while (i < rows.length && /^[-*]\s+/.test(rows[i])) { items.push(rows[i].replace(/^[-*]\s+/, '')); i++; }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (ln.trim() === '') { i++; continue; }
    const paras = [ln];
    i++;
    while (i < rows.length && rows[i].trim() !== '' && !/^(#{1,4}\s|[-*]\s|```)/.test(rows[i])) {
      paras.push(rows[i]); i++;
    }
    blocks.push({ type: 'p', text: paras.join(' ') });
  }
  const renderInline = (t) => {
    const parts = [];
    let rest = t;
    let key = 0;
    while (rest.length) {
      const m = rest.match(/`([^`]+)`|\*\*([^*]+)\*\*/);
      if (!m) { parts.push(rest); break; }
      if (m.index > 0) parts.push(rest.slice(0, m.index));
      if (m[1] !== undefined) parts.push(<code key={key++}>{m[1]}</code>);
      else parts.push(<strong key={key++}>{m[2]}</strong>);
      rest = rest.slice(m.index + m[0].length);
    }
    return parts;
  };
  return (
    <div className="md-preview">
      {blocks.map((b, k) => {
        if (b.type === 'h') {
          const H = `h${Math.min(b.lvl, 4)}`;
          return React.createElement(H, { key: k }, renderInline(b.text));
        }
        if (b.type === 'p') return <p key={k}>{renderInline(b.text)}</p>;
        if (b.type === 'ul') return (
          <ul key={k}>
            {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
          </ul>
        );
        if (b.type === 'code') return (
          <pre key={k} className="md-code"><code>{b.code}</code></pre>
        );
        return null;
      })}
    </div>
  );
}

function TermBody() {
  return (
    <div className="sheet-term">
      <div><span className="prompt">~/Coding/gian</span> <span className="dim">git:(feat/auth-flow)</span> <span className="ok">✓</span></div>
      <div><span className="dim">$</span> pnpm test packages/host/src/auth</div>
      <div className="dim" />
      <div className="dim">  PASS  packages/host/src/auth/oauth.spec.ts</div>
      <div className="dim">    OAuth callback</div>
      <div>      <span className="ok">✓</span> reads state cookie from worktree subdomain (12ms)</div>
      <div>      <span className="ok">✓</span> falls back to parent domain (8ms)</div>
      <div>      <span className="ok">✓</span> rejects if state mismatch (4ms)</div>
      <div className="dim" />
      <div className="dim">Tests:       3 passed, 3 total</div>
      <div className="dim">Time:        0.81s</div>
      <div className="dim" />
      <div><span className="prompt">~/Coding/gian</span> <span className="dim">git:(feat/auth-flow)</span> <span className="ok">✓</span></div>
      <div><span className="dim">$</span> <span className="cursor" /></div>
    </div>
  );
}

// ─── Inspector ─────────────────────────────────────────────────────────────
function SettingsBody({ state, A }) {
  const [active, setActive] = React.useState('appearance');
  const rootRef = React.useRef(null);
  const [claudeModel, setClaudeModel] = React.useState('sonnet-4.5');
  const [claudeEffort, setClaudeEffort] = React.useState('medium');
  const [codexModel, setCodexModel] = React.useState('gpt-5.1-codex');
  const [codexThinking, setCodexThinking] = React.useState('medium');
  const [claudeSurface, setClaudeSurface] = React.useState('tty');
  const [claudeCli, setClaudeCli] = React.useState(true);
  const [codexCli, setCodexCli] = React.useState(false);
  const [lang, setLang] = React.useState('en');
  const [fontChrome, setFontChrome] = React.useState('md');
  const [fontChat, setFontChat] = React.useState('md');
  const [fontCode, setFontCode] = React.useState('md');
  const [minimap, setMinimap] = React.useState(true);
  const [editors, setEditors] = React.useState(['Visual Studio Code', 'Cursor']);
  const [openApps, setOpenApps] = React.useState({ code: 'Visual Studio Code', web: '@newtab', images: 'Preview', pdf: 'Preview', other: '@finder' });

  const Seg = ({ value, options, onChange }) => (
    <div className="segm">
      {options.map(([v, l]) => (
        <button key={v} className={`segm-item ${value === v ? 'active' : ''}`} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
  const Toggle = ({ checked, onChange, children }) => (
    <label className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{children}</span></label>
  );

  const SIZE = [['sm', 'SM'], ['md', 'MD'], ['lg', 'LG'], ['xl', 'XL']];
  const THEMES = [
    ['light', 'Light', ['oklch(0.955 0.004 280)', 'oklch(0.935 0.005 280)', 'oklch(0.22 0.02 280)']],
    ['warm',  'Warm',  ['oklch(0.955 0.020 80)',   'oklch(0.925 0.022 78)',  'oklch(0.30 0.04 55)']],
    ['dark',  'Dark',  ['oklch(0.165 0.012 250)',  'oklch(0.240 0.016 250)', 'oklch(0.93 0.01 250)']],
  ];
  const ACCENTS = [
    ['rose', 'Rose', 'oklch(0.55 0.15 5)'], ['ember', 'Ember', 'oklch(0.55 0.14 35)'],
    ['citron', 'Citron', 'oklch(0.55 0.13 95)'], ['moss', 'Moss', 'oklch(0.55 0.11 150)'],
    ['teal', 'Teal', 'oklch(0.55 0.11 195)'], ['azure', 'Azure', 'oklch(0.55 0.13 230)'],
    ['ink', 'Ink', 'oklch(0.55 0.13 270)'], ['plum', 'Plum', 'oklch(0.55 0.14 320)'],
  ];
  const OPEN_CATS = [['code', 'Code & text'], ['web', 'Web pages'], ['images', 'Images'], ['pdf', 'PDF'], ['other', 'Other files']];

  const NAV = [
    ['Preferences', [['appearance', 'Appearance'], ['notifications', 'Notifications'], ['shortcuts', 'Shortcuts']]],
    ['Runtime', [['executors', 'Executors'], ['chatview', 'Chat view'], ['openwith', 'Open with']]],
  ];
  const TITLES = {
    appearance: 'Appearance', notifications: 'Notifications', shortcuts: 'Shortcuts',
    executors: 'Executors', chatview: 'Chat view', openwith: 'Open with',
  };

  // Nav is a locator, not a switcher: clicking scrolls to the section; the
  // active highlight follows the scroll position (scrollspy).
  const goTo = (key) => {
    setActive(key);
    const el = document.getElementById('sec-' + key);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  React.useEffect(() => {
    const root = rootRef.current;
    const scroller = root && root.closest('.sheet-content');
    if (!scroller) return;
    const keys = NAV.flatMap(([, items]) => items.map(([k]) => k));
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top;
      let cur = keys[0];
      for (const k of keys) {
        const el = document.getElementById('sec-' + k);
        if (el && el.getBoundingClientRect().top - top <= 56) cur = k;
      }
      setActive(cur);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="settings2" data-testid="settings-body" ref={rootRef}>
      <nav className="settings2-nav">
        <div className="settings2-title">Settings</div>
        {NAV.map(([group, items]) => (
          <div className="s2-group" key={group}>
            <div className="s2-grouplabel">{group}</div>
            {items.map(([key, label]) => (
              <button key={key} className={`s2-navitem ${active === key ? 'active' : ''}`} onClick={() => goTo(key)}>{label}</button>
            ))}
          </div>
        ))}
        <div className="s2-foot mono">Gian (dev) · local</div>
      </nav>

      <div className="settings2-main">
        <section id="sec-appearance" className="s2-section">
          <h3 className="s2-sectiontitle">Appearance</h3>
          <div className="s2-card">
            <dl className="kv-grid">
              <dt>Theme</dt>
              <dd><div className="theme-row">{THEMES.map(([key, name, sw]) => (
                <button key={key} className={`theme-chip ${state.theme === key ? 'active' : ''}`} onClick={() => A.setTheme(key)}>
                  <div className="swatches">{sw.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
                  <div className="name">{name}</div>
                </button>
              ))}</div></dd>
              <dt>Accent</dt>
              <dd><div className="accent-row">{ACCENTS.map(([k, name, c]) => (
                <button key={k} className={`accent-swatch ${state.accent === k ? 'active' : ''}`} style={{ background: c }} title={name} onClick={() => A.setAccent(k)} />
              ))}</div></dd>
              <dt>Density</dt>
              <dd><Seg value={state.density} options={[['compact', 'Compact'], ['cozy', 'Cozy'], ['roomy', 'Roomy']]} onChange={A.setDensity} /></dd>
              <dt>Language</dt>
              <dd><Seg value={lang} options={[['zh-CN', '中文'], ['en', 'English']]} onChange={setLang} /></dd>
              <dt>Interface font</dt>
              <dd><Seg value={fontChrome} options={SIZE} onChange={setFontChrome} /></dd>
              <dt>Transcript font</dt>
              <dd><Seg value={fontChat} options={SIZE} onChange={setFontChat} /></dd>
              <dt>Code font</dt>
              <dd><Seg value={fontCode} options={SIZE} onChange={setFontCode} /></dd>
              <dt>Font family</dt>
              <dd className="mono" style={{ color: 'var(--text-3)' }}>Instrument Sans · JetBrains Mono</dd>
              <dt>Minimap</dt>
              <dd><Toggle checked={minimap} onChange={setMinimap}>Show transcript minimap</Toggle></dd>
            </dl>
          </div>
        </section>

        <section id="sec-notifications" className="s2-section">
          <h3 className="s2-sectiontitle">Notifications</h3>
          <div className="s2-card">
            <dl className="kv-grid">
              <dt>Desktop</dt>
              <dd><Toggle checked={true} onChange={() => {}}>Approval needed · session done · error</Toggle></dd>
              <dt>Sound</dt>
              <dd><Toggle checked={false} onChange={() => {}}>Soft chime on approval</Toggle></dd>
              <dt>Dock badge</dt>
              <dd><Toggle checked={true} onChange={() => {}}>Show pending approval count</Toggle></dd>
            </dl>
          </div>
        </section>

        <section id="sec-shortcuts" className="s2-section">
          <h3 className="s2-sectiontitle">Shortcuts</h3>
          <div className="s2-card">
            <dl className="kv-grid shortcuts">
              <dt>Command palette</dt><dd><kbd>⌘</kbd><kbd>K</kbd></dd>
              <dt>New session</dt><dd><kbd>⌘</kbd><kbd>N</kbd></dd>
              <dt>Toggle workbench</dt><dd><kbd>⌘</kbd><kbd>\</kbd></dd>
              <dt>Rename session</dt><dd><kbd>F2</kbd></dd>
              <dt>Approve / decline</dt><dd><kbd>⏎</kbd> &nbsp; <kbd>⌫</kbd></dd>
              <dt>Show chat</dt><dd><kbd>⌃/⌘</kbd><kbd>1</kbd></dd>
              <dt>Show CLI</dt><dd><kbd>⌃/⌘</kbd><kbd>2</kbd></dd>
            </dl>
          </div>
        </section>

        <section id="sec-executors" className="s2-section">
          <h3 className="s2-sectiontitle">Executors</h3>
          <div className="s2-card">
            <div className="exec-row">
              <div className="exec-head">
                <span className="exec-dot claude" />
                <span className="exec-name">Claude Code</span>
                <span className="exec-ver mono">1.4.2</span>
                <span className="exec-status ok">ready</span>
              </div>
              <dl className="kv-grid">
                <dt>Binary</dt><dd className="mono">/usr/local/bin/claude</dd>
                <dt>Default model</dt>
                <dd><select className="select" value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)}>
                  <option value="sonnet-4.5">claude-sonnet-4.5</option>
                  <option value="opus-4">claude-opus-4</option>
                  <option value="haiku-4.5">claude-haiku-4.5</option>
                </select></dd>
                <dt>Effort</dt>
                <dd><select className="select" value={claudeEffort} onChange={(e) => setClaudeEffort(e.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select></dd>
              </dl>
              <p className="exec-note">Default model &amp; effort apply to the <span className="mono">claude -p</span> surface only — ignored in TTY mode.</p>
            </div>
            <div className="exec-row">
              <div className="exec-head">
                <span className="exec-dot codex" />
                <span className="exec-name">Codex</span>
                <span className="exec-ver mono">0.18.0</span>
                <span className="exec-status ok">ready</span>
              </div>
              <dl className="kv-grid">
                <dt>Binary</dt><dd className="mono">~/.local/bin/codex</dd>
                <dt>Default model</dt>
                <dd><select className="select" value={codexModel} onChange={(e) => setCodexModel(e.target.value)}>
                  <option value="gpt-5.1-codex">gpt-5.1-codex</option>
                  <option value="gpt-5-codex">gpt-5-codex</option>
                  <option value="o4-mini">o4-mini</option>
                </select></dd>
                <dt>Thinking</dt>
                <dd><select className="select" value={codexThinking} onChange={(e) => setCodexThinking(e.target.value)}>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select></dd>
              </dl>
            </div>
          </div>
        </section>

        <section id="sec-chatview" className="s2-section">
          <h3 className="s2-sectiontitle">Chat view</h3>
          <div className="s2-card">
            <p className="s2-help">How each executor's conversation is rendered. Changing this restructures the session tablist.</p>
            <dl className="kv-grid">
              <dt>Claude surface</dt>
              <dd><Seg value={claudeSurface} options={[['structured', 'claude -p'], ['tty', 'TTY']]} onChange={setClaudeSurface} /></dd>
              <dt>Claude CLI tab</dt>
              <dd><Toggle checked={claudeCli} onChange={setClaudeCli}>Show a raw CLI tab for Claude sessions</Toggle></dd>
              <dt>Codex CLI tab</dt>
              <dd><Toggle checked={codexCli} onChange={setCodexCli}>Show a raw CLI tab for Codex sessions</Toggle></dd>
            </dl>
          </div>
        </section>

        <section id="sec-openwith" className="s2-section">
          <h3 className="s2-sectiontitle">Open with</h3>
          <div className="s2-card">
            <p className="s2-help">Apps Gian can hand a file to, and the default opener for each file kind.</p>
            <div className="s2-subhead">Applications</div>
            <div className="ee-list">
              {editors.map(name => (
                <div key={name} className="ee-app-row">
                  <span className="ee-app-name">{name}</span>
                  <button className="ee-remove" title="Remove" onClick={() => setEditors(editors.filter(x => x !== name))}>✕</button>
                </div>
              ))}
              <label className="ee-add-app">
                <span className="rfc-lbl">Add application</span>
                <select value="" onChange={(e) => { if (e.target.value) setEditors([...editors, e.target.value]); }}>
                  <option value="">Choose an app…</option>
                  {['Xcode', 'Sublime Text', 'Zed', 'WebStorm'].filter(a => !editors.includes(a)).map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            </div>
            <div className="s2-subhead">Default app by file type</div>
            <div className="openapps">
              {OPEN_CATS.map(([key, label]) => (
                <div key={key} className="open-cat-row">
                  <span className="open-cat-label">{label}</span>
                  <select value={openApps[key]} onChange={(e) => setOpenApps({ ...openApps, [key]: e.target.value })}>
                    <option value="@newtab">New browser tab</option>
                    <option value="@finder">Reveal in Finder</option>
                    {[...new Set([...editors, 'Preview'])].map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Inspector({ state, A }) {
  if (state.inspectorTab === 'manager') return <ManagerInspector state={state} A={A} />;
  if (state.inspectorTab === 'files')   return <FilesInspector state={state} A={A} />;
  if (state.inspectorTab === 'changes') return <ChangesInspector state={state} A={A} />;
  if (state.inspectorTab === 'workspaces') return <WorkspacesInspector state={state} A={A} />;
  return null;
}

// Workspaces navigator — lives in the right Inspector rail (zone 4) alongside
// Files / Changes. The list is just a picker; clicking a row opens that
// workspace's detail as a Workbench tab (zone 3) via openWorkspaceInSheet.
function WorkspacesInspector({ state, A }) {
  // Order + hidden are local to the prototype (reset on reload). Reorder via the
  // up/down buttons; the eye toggles hidden. No drag, no session-count noise.
  const [order, setOrder] = React.useState(WORKSPACES.map(w => w.id));
  const [hidden, setHidden] = React.useState({});
  const list = order.map(id => WORKSPACES.find(w => w.id === id)).filter(Boolean);

  const move = (id, dir) => setOrder(prev => {
    const i = prev.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const toggleHidden = (id) => setHidden(prev => ({ ...prev, [id]: !prev[id] }));

  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="label">Workspaces</span>
        <button className="iconbtn" title="New workspace"><Icon d={I.plus} /></button>
      </div>
      <div className="insp-scroll">
        <div className="ws-list">
          {list.map((w, idx) => {
            const open = state.wbTabs.some(t => t.kind === 'workspace' && t.wsId === w.id);
            const isHidden = !!hidden[w.id];
            return (
              <div key={w.id} className={`ws-item ${w.id === state.selectedWsId && open ? 'active' : ''} ${isHidden ? 'hidden' : ''}`}>
                <button className="ws-item-main" onClick={() => A.openWorkspaceInSheet(w.id)}>
                  <span className="ws-item-body">
                    <span className="ws-item-name">{w.name}</span>
                    <span className="ws-item-path mono">{w.path}</span>
                  </span>
                </button>
                <span className="ws-item-actions">
                  <button className="ws-act" title={isHidden ? 'Show workspace' : 'Hide workspace'}
                          onClick={() => toggleHidden(w.id)}>
                    <Icon d={isHidden ? I.eyeOff : I.eye} size={14} />
                  </button>
                  <button className="ws-act" title="Move up" disabled={idx === 0}
                          onClick={() => move(w.id, -1)}>
                    <Icon d={I.arrowUp} size={14} />
                  </button>
                  <button className="ws-act" title="Move down" disabled={idx === list.length - 1}
                          onClick={() => move(w.id, 1)}>
                    <Icon d={I.arrowDown} size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// Workspace detail rendered inside a Workbench tab (zone 3). Reuses the
// existing SpacesConfig / SpacesNative bodies under a compact tab header.
function WorkspaceDetailBody({ wsId, state, A }) {
  const ws = WORKSPACES.find(w => w.id === wsId) || WORKSPACES[0];
  const tab = state.spacesTab || 'config';
  const rootRef = React.useRef(null);
  // The Workbench scroll container is shared across tabs, so its scrollTop
  // carries over when this tab activates — reset to top so the header/stat
  // cards aren't scrolled out of view on open.
  React.useEffect(() => {
    const sc = rootRef.current && rootRef.current.closest('.sheet-content');
    if (sc) sc.scrollTop = 0;
  }, [wsId]);
  return (
    <div className="ws-detail" ref={rootRef}>
      <div className="ws-detail-head">
        <div className="ws-detail-title">
          <h1>{ws.name}</h1>
          <span className="ws-detail-path mono">{ws.path}</span>
        </div>
        <div className="detail-tabs">
          <button className={`detail-tab ${tab === 'config' ? 'active' : ''}`}
                  onClick={() => A.set('spacesTab', 'config')}>Config</button>
          <button className={`detail-tab ${tab === 'native' ? 'active' : ''}`}
                  onClick={() => A.set('spacesTab', 'native')}>Native sessions <span className="count">2</span></button>
        </div>
      </div>
      <div className="ws-detail-scroll detail">
        {tab === 'config' ? <SpacesConfig ws={ws} /> : <SpacesNative />}
      </div>
    </div>
  );
}

function ManagerInspector({ state, A }) {
  // Compact ManagerMain rendering inside the inspector slot — no header.
  return (
    <aside className="inspector manager-inspector">
      <div className="insp-head">
        <span className="label">Manager</span>
        <button className="iconbtn" title="Refresh"><Icon d={I.refresh} /></button>
      </div>
      <div className="manager-inspector-body">
        <ManagerMain state={state} A={A} compact={true} />
      </div>
    </aside>
  );
}

function FilesInspector({ A }) {
  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="label">Files</span>
        <button className="iconbtn" title="Refresh"><Icon d={I.refresh} /></button>
        <button className="iconbtn" title="Search"><Icon d={I.search} /></button>
      </div>
      <div className="insp-scroll">
        <div className="tree">
          <TreeNode node={FILE_TREE} depth={0} A={A} />
        </div>
      </div>
    </aside>
  );
}

function TreeNode({ node, depth, A }) {
  const [isOpen, setOpen] = React.useState(!!node.open);
  if (node.leaf) {
    return (
      <div className={`tree-item ${node.active ? 'active' : ''}`}
           style={{ paddingLeft: 6 + depth * 12 }}
           onClick={() => A.openFileInSheet(node.n, node.leaf, false)}
           onDoubleClick={() => A.openFileInSheet(node.n, node.leaf, true)}>
        <span className="tree-caret" />
        <FileIco kind={node.leaf} />
        <span className="tree-name">{node.n}</span>
      </div>
    );
  }
  return (
    <>
      <div className={`tree-item folder ${isOpen ? 'open' : ''} ${node.dim ? 'dim' : ''}`}
           style={{ paddingLeft: 6 + depth * 12 }}
           onClick={() => setOpen(o => !o)}>
        <span className="tree-caret">▶</span>
        <Icon d={I.folder} size={13} className="tree-ico" />
        <span className="tree-name">{node.n}</span>
      </div>
      {isOpen && node.children && (
        <div className="tree-children">
          {node.children.map((c, i) => <TreeNode key={i} node={c} depth={depth + 1} A={A} />)}
        </div>
      )}
    </>
  );
}

function FileIco({ kind }) {
  const colors = {
    md:   'oklch(0.55 0.04 250)',
    ts:   'oklch(0.55 0.13 260)',
    tsx:  'oklch(0.55 0.13 260)',
    json: 'oklch(0.55 0.11 80)',
    css:  'oklch(0.55 0.13 320)',
  };
  return (
    <span className="tree-ico" style={{
      width: 14, height: 14, borderRadius: 2,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: colors[kind] || 'oklch(0.55 0.01 280)',
      color: 'white', font: '700 7.5px/1 var(--font-mono)',
    }}>{(kind || '').toUpperCase().slice(0, 2)}</span>
  );
}

function ChangesInspector({ A }) {
  const total = CHANGES.reduce((acc, c) => ({ add: acc.add + c.add, del: acc.del + c.del }), { add: 0, del: 0 });
  return (
    <aside className="inspector">
      <div className="insp-head">
        <span className="label">Changes</span>
        <button className="iconbtn" title="Refresh"><Icon d={I.refresh} /></button>
      </div>
      <div className="insp-scroll">
        <div className="changes-summary">
          <span className="count">{CHANGES.length} files</span>
          <span className="add">+{total.add}</span>
          <span className="del">−{total.del}</span>
        </div>
        {CHANGES.map((c, i) => (
          <button key={i} className={`changes-row ${c.active ? 'active' : ''}`}
                  onClick={() => A.openFileInSheet(c.dir + c.name, fileExt(c.name), false)}
                  onDoubleClick={() => A.openFileInSheet(c.dir + c.name, fileExt(c.name), true)}>
            <span className={`files-badge ${c.sig}`}>{c.sig === 'mod' ? 'M' : c.sig === 'add' ? 'A' : 'D'}</span>
            <span className="path"><span className="dir">{c.dir}</span>{c.name}</span>
            <span className="stat">
              {c.add > 0 && <span className="add">+{c.add}</span>}
              {c.del > 0 && <span className="del">−{c.del}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="changes-foot">
        <div className="row"><span className="lbl">Branch</span><span className="val">feat/auth-flow</span></div>
        <div className="row"><span className="lbl">Base</span><span className="val">main · 3 ahead</span></div>
        <div className="actions">
          <button className="btn primary sm"><Icon d={I.check} size={11} stroke={2.4} />Commit (AI draft)</button>
          <button className="btn secondary sm">Push</button>
          <button className="btn ghost sm">Merge</button>
        </div>
      </div>
    </aside>
  );
}

function fileExt(name) {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : 'txt';
}

// ─── Spaces detail ─────────────────────────────────────────────────────────
function SpacesMain({ state, A }) {
  const ws = WORKSPACES.find(w => w.id === state.selectedWsId) || WORKSPACES[0];
  return (
    <main className="main">
      <div className="main-scroll">
        <div className="detail">
          <h1>{ws.name}</h1>
          <div className="detail-sub">{ws.path}</div>
          <div className="detail-tabs">
            <button className={`detail-tab ${state.spacesTab === 'config' ? 'active' : ''}`}
                    onClick={() => A.set('spacesTab', 'config')}>Config</button>
            <button className={`detail-tab ${state.spacesTab === 'native' ? 'active' : ''}`}
                    onClick={() => A.set('spacesTab', 'native')}>Native sessions <span className="count">2</span></button>
          </div>
          {state.spacesTab === 'config' ? <SpacesConfig ws={ws} /> : <SpacesNative />}
        </div>
      </div>
    </main>
  );
}

function SpacesConfig({ ws }) {
  const wts = ws.id === 'gian' ? WORKTREES_GIAN : [
    { branch: 'main', isMain: true, claudeLines: null, state: 'clean', session: null },
  ];
  // Branches: every worktree's branch + a few "tracked-but-no-worktree" ones.
  const wtBranchNames = new Set(wts.map(w => w.branch));
  const looseBranches = ws.id === 'gian' ? [
    { name: 'fix/ws-backoff', upstream: 'origin/fix/ws-backoff', behind: 0, ahead: 2, lastCommit: 'reconnect with jittered backoff', age: '4h ago' },
    { name: 'db/migrations',  upstream: 'origin/db/migrations',  behind: 1, ahead: 0, lastCommit: 'add SQLite migrations runner',     age: '6h ago' },
    { name: 'ui/spaces',      upstream: null,                    behind: 0, ahead: 5, lastCommit: 'spaces config inspector tweaks',    age: 'Mon' },
    { name: 'i18n/zh',        upstream: 'origin/i18n/zh',        behind: 0, ahead: 0, lastCommit: 'zh-CN strings pass',                age: 'May 8' },
  ].filter(b => !wtBranchNames.has(b.name)) : [];

  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="k">Native sessions</div><div className="v">2</div></div>
        <div className="stat-card"><div className="k">Adopted</div><div className="v">12<span className="sub">/ 14</span></div></div>
        <div className="stat-card"><div className="k">Last activity</div><div className="v">2m<span className="sub">ago</span></div></div>
        <div className="stat-card"><div className="k">Created</div><div className="v">Apr 03</div></div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Repository</h3>
          <span className="aside">git remote · default branch · last commit</span>
          <div className="right"><button className="btn ghost sm"><Icon d={I.github} size={13} />View on GitHub</button></div>
        </div>
        <div className="card-body">
          <dl className="kv-grid">
            <dt>Local path</dt><dd>{ws.path}</dd>
            <dt>Remote</dt><dd>{ws.repoRemote || '—'}</dd>
            <dt>Default branch</dt><dd>{ws.defaultBranch || 'main'}</dd>
            {ws.lastCommit && (
              <>
                <dt>Last commit</dt>
                <dd style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span>{ws.lastCommit.sha}</span>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>
                    {ws.lastCommit.msg} · {ws.lastCommit.age} · {ws.lastCommit.author}
                  </span>
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            Worktrees
            <HelpHint>
              A <b>worktree</b> is a separate checkout of the repo on disk —
              each sits in its own folder with one branch checked out. Gian
              spins up one worktree per session so agents can work on
              different branches without colliding.
            </HelpHint>
          </h3>
          <span className="aside">{wts.length} on disk · {wts.filter(w => w.state === 'dirty').length} dirty</span>
          <div className="right"><button className="btn primary sm"><Icon d={I.plus} size={11} stroke={2.4} />New worktree</button></div>
        </div>
        <div className="card-body compact">
          {wts.map((w, i) => (
            <div className="wt-row" key={i}>
              <span className="wt-ico">{w.isMain ? <Icon d={I.folder} size={15} /> : <BranchIcon size={14} />}</span>
              <div className="wt-branch">
                {w.branch}{w.isMain && <span className="main-tag">main tree</span>}
              </div>
              <div className={`wt-claude ${w.claudeLines ? '' : 'empty'}`}>
                {w.claudeLines ? `CLAUDE.md · ${w.claudeLines} lines` : '+ CLAUDE.md'}
              </div>
              <div className={`wt-state ${w.state}`}>
                <span className="dot" />{w.state === 'clean' ? 'clean' : `${w.count} changed`}
              </div>
              {w.session
                ? <a className="wt-session" href="#">{w.session}</a>
                : <span className="wt-session none">—</span>}
              <button className="wt-kebab"><Icon d={I.kebabV} size={14} /></button>
            </div>
          ))}
        </div>
      </div>

      {looseBranches.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>
              Other local branches
              <HelpHint>
                Branches that exist locally but aren't checked out in any
                worktree. Spin one up to start a session on it.
              </HelpHint>
            </h3>
            <span className="aside">{looseBranches.length} branches · not in any worktree</span>
          </div>
          <div className="card-body compact">
            {looseBranches.map((b, i) => (
              <div className="branch-row" key={i}>
                <span className="wt-ico"><BranchIcon size={13} /></span>
                <div className="branch-name">{b.name}</div>
                <div className="branch-track mono">
                  {b.upstream
                    ? <>
                        <span className="upstream">{b.upstream}</span>
                        {(b.ahead > 0 || b.behind > 0) && (
                          <span className="ab">
                            {b.ahead > 0 && <span className="ah">↑{b.ahead}</span>}
                            {b.behind > 0 && <span className="be">↓{b.behind}</span>}
                          </span>
                        )}
                        {b.ahead === 0 && b.behind === 0 && <span className="ab synced">in sync</span>}
                      </>
                    : <span className="no-upstream">no upstream</span>}
                </div>
                <div className="branch-last">
                  <span className="msg">{b.lastCommit}</span>
                  <span className="age">{b.age}</span>
                </div>
                <button className="btn ghost xs" title="Check out in a new worktree">
                  <Icon d={I.plus} size={11} stroke={2.4} />Worktree
                </button>
                <button className="wt-kebab"><Icon d={I.kebabV} size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// Small "?" pop-out — a hover-anchored hint used to inline-explain jargon.
function HelpHint({ children }) {
  return (
    <span className="help-hint" tabIndex={0}>
      <span className="help-hint-trigger" aria-label="More info"><Icon d={I.info} size={12} stroke={1.8} /></span>
      <span className="help-hint-pop" role="tooltip">{children}</span>
    </span>
  );
}

function SpacesNative() {
  const rows = [
    { exec: 'claude', adopted: true,  name: 'Fix OAuth callback redirect',     branch: 'feat/auth-flow', age: '2m ago', turns: 14, size: '128 KB', preview: 'The OAuth callback is dropping the state param when we redirect…' },
    { exec: 'claude', adopted: true,  name: 'Refactor settings panel',         branch: 'ui/settings',    age: '2h ago', turns: 8,  size: '64 KB',  preview: 'Settings sheet should slide in from the right, not cover the topbar.' },
    { exec: 'codex',  adopted: false, name: null,                              branch: null,             age: '4h ago', turns: 3,  size: '21 KB',  preview: 'Need to investigate why pnpm dev fails on the rvc workspace lately.' },
    { exec: 'claude', adopted: true,  name: 'Discord bot wiring',              branch: 'bots/discord',   age: 'Mon',    turns: 22, size: '512 KB', preview: 'Wire bot token + application id into the discord platform package.' },
    { exec: 'codex',  adopted: false, name: null,                              branch: null,             age: 'Sun',    turns: 6,  size: '47 KB',  preview: 'Quick experiment with the migrations DSL — does this look ergonomic?' },
  ];
  return (
    <>
      <div style={{ font: 'var(--fz-12)/1.5 var(--font-sans)', color: 'var(--text-2)', marginTop: -4, marginBottom: 14, display: 'inline-flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }}>
        <span>Sessions discovered on disk under <span className="mono">~/.claude</span> / <span className="mono">~/.codex</span>. <b>Adopt</b> a session to manage it from Gian.</span>
        <HelpHint>
          The Claude / Codex CLIs each keep their own session history. Gian
          can <b>adopt</b> them — import the transcript and start tracking
          new turns — without changing where the CLI writes them.
        </HelpHint>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div className="segm"><button className="segm-item active">All</button><button className="segm-item">Claude</button><button className="segm-item">Codex</button></div>
        <div className="segm"><button className="segm-item active">All</button><button className="segm-item">Adopted</button><button className="segm-item">Available</button></div>
        <span style={{ marginLeft: 'auto', font: '500 10.5px/1 var(--font-mono)', textTransform: 'none', letterSpacing: '0.06em', color: 'var(--text-3)' }}>
          {rows.length} sessions
        </span>
      </div>
      <div className="card">
        <div className="card-body compact">
          {rows.map((r, i) => (
            <div className="wt-row" key={i} style={{ gridTemplateColumns: '18px 1fr auto 110px 22px', alignItems: 'start' }}>
              <span className="wt-ico" style={{ paddingTop: 2 }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: r.exec === 'claude' ? 'var(--claude)' : 'var(--codex)' }} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ font: 'var(--fz-13)/1.3 var(--font-sans)', fontWeight: 500, color: 'var(--text)' }}>
                    {r.adopted ? r.name : <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>unadopted session</span>}
                  </span>
                  {r.branch && <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>{r.branch}</span>}
                  <span className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>· {r.age} · {r.turns} turns · {r.size}</span>
                </div>
                <div style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.preview}
                </div>
              </div>
              <span />
              {r.adopted
                ? <span style={{ font: '500 12px/1.4 var(--font-sans)', color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Icon d={I.check} size={12} stroke={2.4} /> Adopted
                  </span>
                : <button className="btn primary sm">Adopt</button>}
              <button className="wt-kebab"><Icon d={I.kebabV} size={14} /></button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Bots detail ───────────────────────────────────────────────────────────
function BotsMain({ state, A }) {
  if (state.botsView === 'new') return <BotsNew state={state} A={A} />;
  const bot = BOTS.find(b => b.id === state.selectedBotId) || BOTS[0];
  if (!bot) return null;
  return (
    <main className="main">
      <div className="main-scroll">
        <div className="detail">
          <div className="bot-detail-head">
            <span className={`pmark ${bot.platform}`}>{bot.platform[0].toUpperCase()}</span>
            <div className="info">
              <div className="name">{bot.name}</div>
              <div className="sub">
                <span className={`pchip ${bot.platform}`}>{bot.platform}</span>
                <span>workspace · {bot.workspace || 'unbound'}</span>
                <span>created {bot.createdAt}</span>
              </div>
            </div>
            <div className="actions">
              <button className={`toggle ${bot.connected ? 'on' : ''}`} onClick={() => A.toggleBotEnabled(bot.id)}>
                {bot.connected ? 'Enabled' : 'Disabled'}
                <span className="track"><span className="knob" /></span>
              </button>
              <button className="btn primary">Save</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="card">
              <div className="card-head"><h3>Connection</h3><span className="aside">credentials from {bot.platform[0].toUpperCase() + bot.platform.slice(1)} Developer Portal</span></div>
              <div className="card-body">
                <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                  <dt>Label</dt>
                  <dd style={{ fontFamily: 'var(--font-sans)' }}>{bot.name}</dd>

                  <dt>Bot token</dt>
                  <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ color: 'var(--text-3)' }}>•••••••••••••••••••• {bot.tokenTail || 'XYZ'}</span>
                    <span className="pill done" style={{ fontSize: 9.5 }}>saved</span>
                    <button className="btn ghost xs">Show</button>
                  </dd>

                  <dt>Application ID</dt>
                  <dd style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>{bot.appId || '—'}</span>
                    {bot.appId && <button className="btn ghost xs"><Icon d={I.copy} size={11} />Copy</button>}
                  </dd>
                </dl>
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Routing</h3><span className="aside">where new sessions land · who can talk</span></div>
              <div className="card-body">
                <dl className="kv-grid" style={{ gridTemplateColumns: '140px 1fr' }}>
                  <dt>Workspace</dt>
                  <dd>
                    <select className="select" defaultValue={bot.workspace || ''}>
                      <option value="">— unbound —</option>
                      {WORKSPACES.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </dd>
                  <dt>Allowed user IDs</dt>
                  <dd>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {['ruoyu#0001', '210458271…482', '298017249…120'].map(u => (
                        <span key={u} className="chip" style={{ fontSize: 11 }}>
                          {u}<button style={{ background: 'transparent', border: 0, color: 'var(--text-3)', cursor: 'pointer', padding: 0, marginLeft: 2 }}>×</button>
                        </span>
                      ))}
                    </div>
                    <div style={{ marginTop: 6, color: 'var(--text-3)', fontSize: 11, fontFamily: 'var(--font-sans)' }}>
                      Leave empty to allow all users.
                    </div>
                  </dd>
                </dl>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ font: '600 10.5px/1 var(--font-mono)', textTransform: 'none', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: 8 }}>Mode behavior</div>
            <div className="mode-cards">
              <button className="mode-card active">
                <div className="head">
                  <Icon d={I.eye} size={15} />
                  <span className="title">Read-only</span>
                  <span className="pill-active">Active</span>
                </div>
                <div className="desc">Bot mirrors assistant responses only. No prompts can originate from chat — useful for support / observability.</div>
              </button>
              <button className="mode-card">
                <div className="head">
                  <Icon d={I.check} size={15} />
                  <span className="title">Full control</span>
                </div>
                <div className="desc">Bot can send prompts and receive full event stream. Anyone on the allowlist can drive sessions from {bot.platform}.</div>
              </button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-head"><h3>Activity</h3><span className="aside">connection state · last events</span></div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '160px 1fr' }}>
                <dt>Status</dt>
                <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className={`pill ${bot.connected ? 'run' : 'idle'}`}>{bot.connected ? 'connected' : 'offline'}</span>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>2 channels live · 14h since reconnect</span>
                </dd>
                <dt>Last message</dt>
                <dd>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>4m ago in #ask-claude — </span>
                  <span style={{ fontFamily: 'var(--font-sans)' }}>"fix the oauth callback redirect"</span>
                </dd>
                <dt>Approvals routed</dt>
                <dd style={{ fontFamily: 'var(--font-sans)' }}>23 today · 0 declined</dd>
              </dl>
            </div>
          </div>

          <div className="danger-zone">
            <div style={{ flex: 1 }}>
              <h4>Danger zone</h4>
              <p>Delete this bot. The {bot.platform} application registration is not affected; only Gian's link is removed.</p>
            </div>
            <div className="right"><button className="btn danger-ghost sm"><Icon d={I.trash} size={12} />Delete bot</button></div>
          </div>
        </div>
      </div>
    </main>
  );
}

function BotsNew({ state, A }) {
  const [platform, setPlatform] = React.useState('discord');
  return (
    <main className="main">
      <div className="main-scroll">
        <div className="detail">
          <div className="bot-detail-head">
            <span className="pmark" style={{ background: 'var(--surface-3)', color: 'var(--text-3)' }}>+</span>
            <div className="info">
              <div className="name">New bot</div>
              <div className="sub" style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>Wire an IM channel into a Gian workspace</div>
            </div>
            <div className="actions">
              <button className="btn ghost" onClick={() => A.set('botsView', 'detail')}>Cancel</button>
              <button className="btn primary">Create</button>
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ font: '600 10.5px/1 var(--font-mono)', textTransform: 'none', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: 8 }}>Platform</div>
            <div className="segm">
              <button className={`segm-item ${platform === 'discord' ? 'active' : ''}`} onClick={() => setPlatform('discord')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--discord)' }} />Discord
              </button>
              <button className={`segm-item ${platform === 'slack' ? 'active' : ''}`} onClick={() => setPlatform('slack')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--slack)' }} />Slack
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>01 · Identity</h3></div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Label</dt><dd><input className="input" style={{ width: '60%' }} placeholder={`my-${platform}-bot`} /></dd>
                <dt>Workspace</dt><dd>
                  <select className="select" style={{ width: '60%' }} defaultValue="gian">
                    <option value="">— select workspace —</option>
                    {WORKSPACES.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>02 · Connection</h3><span className="aside">credentials from {platform === 'discord' ? 'Discord Developer Portal' : 'Slack App Manifest'}</span></div>
            <div className="card-body">
              <dl className="kv-grid" style={{ gridTemplateColumns: '120px 1fr' }}>
                <dt>Bot token</dt><dd><input className="input" type="password" style={{ width: '80%' }} placeholder="MTE0ODky…" /></dd>
                {platform === 'discord' && <><dt>Application ID</dt><dd><input className="input" style={{ width: '60%' }} placeholder="1148927316082212864" /></dd></>}
                {platform === 'slack' && <><dt>App-level token</dt><dd><input className="input" type="password" style={{ width: '80%' }} placeholder="xapp-1-…" /></dd></>}
              </dl>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>03 · Permissions</h3></div>
            <div className="card-body">
              <div className="mode-cards">
                <button className="mode-card active"><div className="head"><Icon d={I.eye} size={15} /><span className="title">Read-only</span></div><div className="desc">Mirror responses only. Recommended for first-time setup.</div></button>
                <button className="mode-card"><div className="head"><Icon d={I.check} size={15} /><span className="title">Full control</span></div><div className="desc">Allow prompts to originate from {platform} chat.</div></button>
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={{ font: '600 10.5px/1 var(--font-mono)', textTransform: 'none', letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 6 }}>Allowed user IDs</div>
                <input className="input" style={{ width: '100%' }} placeholder={`comma-separated ${platform} user IDs (leave empty to allow all)`} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── Settings + Command palette overlays ───────────────────────────────────
function SettingsOverlay({ state, A }) {
  return (
    <div className="overlay right" onClick={(e) => { if (e.target === e.currentTarget) A.set('settingsOpen', false); }}>
      <div className="settings-sheet">
        <div className="settings-head">
          <h2>Settings</h2>
          <div className="right">
            <span className="settings-saved">saved</span>
            <button className="sb-iconbtn" onClick={() => A.set('settingsOpen', false)}><Icon d={I.x} size={14} stroke={2.2} /></button>
          </div>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <h3>Account</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <span style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', font: '700 14px/1 var(--font-sans)' }}>R</span>
              <div style={{ flex: 1 }}>
                <div style={{ font: '500 13px/1.3 var(--font-sans)' }}>ruoyu</div>
                <div style={{ font: '11px/1.3 var(--font-mono)', color: 'var(--text-3)' }}>owner · single-user instance</div>
              </div>
              <button className="btn ghost sm">Sign out</button>
            </div>
          </div>

          <div className="settings-section">
            <h3>Theme</h3>
            <div className="theme-row">
              {[
                ['light', 'Light', ['oklch(0.955 0.004 280)', 'oklch(0.935 0.005 280)', 'oklch(0.22 0.02 280)']],
                ['warm',  'Warm',  ['oklch(0.955 0.020 80)',   'oklch(0.925 0.022 78)',  'oklch(0.30 0.04 55)']],
                ['dark',  'Dark',  ['oklch(0.165 0.012 250)',  'oklch(0.240 0.016 250)', 'oklch(0.93 0.01 250)']],
              ].map(([key, name, swatches]) => (
                <button key={key} className={`theme-chip ${state.theme === key ? 'active' : ''}`}
                        onClick={() => A.setTheme(key)}>
                  <div className="swatches">{swatches.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
                  <div className="name">{name}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <h3>Accent</h3>
            <div className="accent-row">
              {[
                ['plum',  'oklch(0.55 0.13 310)'],
                ['moss',  'oklch(0.55 0.10 150)'],
                ['ink',   'oklch(0.55 0.11 255)'],
                ['ember', 'oklch(0.55 0.13 30)'],
              ].map(([key, color]) => (
                <button key={key} className={`accent-swatch ${state.accent === key ? 'active' : ''}`}
                        style={{ background: color }} onClick={() => A.setAccent(key)} />
              ))}
            </div>
          </div>

          <div className="settings-section">
            <h3>Density</h3>
            <div className="segm">
              {['compact', 'cozy', 'roomy'].map(d => (
                <button key={d} className={`segm-item ${state.density === d ? 'active' : ''}`} onClick={() => A.setDensity(d)}>
                  {d[0].toUpperCase() + d.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <h3>System · runner</h3>
            <dl className="kv-grid" style={{ gridTemplateColumns: '140px 1fr' }}>
              <dt>Listen address</dt><dd className="mono" style={{ color: 'var(--text-3)' }}>127.0.0.1</dd>
              <dt>Port</dt><dd className="mono" style={{ color: 'var(--text-3)' }}>8990</dd>
              <dt>Workspace root</dt><dd className="mono">~/Coding</dd>
              <dt>Data dir</dt><dd className="mono" style={{ color: 'var(--text-3)' }}>~/Library/Application Support/gian</dd>
            </dl>
          </div>

          <div className="settings-section">
            <h3>Default model</h3>
            <dl className="kv-grid" style={{ gridTemplateColumns: '140px 1fr' }}>
              <dt>Claude</dt><dd>sonnet-4.5 · medium effort</dd>
              <dt>Codex</dt><dd>gpt-5.1-codex · medium thinking</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommandPalette({ A }) {
  const [q, setQ] = React.useState('oauth');
  return (
    <div className="overlay center" onClick={(e) => { if (e.target === e.currentTarget) A.set('paletteOpen', false); }}>
      <div className="cmdk">
        <div className="cmdk-search">
          <Icon d={I.search} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sessions, files, commands…" />
          <kbd style={{ font: '10px/1 var(--font-mono)', color: 'var(--text-3)', background: 'var(--surface-2)', borderRadius: 3, padding: '2px 5px' }}>Esc</kbd>
        </div>
        <div className="cmdk-list">
          <div className="cmdk-head">Sessions</div>
          <button className="cmdk-row active"><span className="lbl">Fix OAuth callback redirect</span><span className="sub">feat/auth-flow · 2m</span><span className="tag session">session</span></button>
          <button className="cmdk-row"><span className="lbl">OAuth refresh-token rotation</span><span className="sub">feat/auth-flow · 3d · archived</span><span className="tag session">session</span></button>
          <div className="cmdk-head">Files</div>
          <button className="cmdk-row"><span className="lbl">packages/host/src/auth/oauth.ts</span><span className="sub">changed</span><span className="tag file">file</span></button>
          <button className="cmdk-row"><span className="lbl">e2e/auth/oauth.spec.ts</span><span className="sub">new file</span><span className="tag file">file</span></button>
          <div className="cmdk-head">Commands</div>
          <button className="cmdk-row"><span className="lbl">/oauth</span><span className="sub">Compose OAuth-related prompt template</span><span className="tag">cmd</span></button>
          <button className="cmdk-row"><span className="lbl">Open terminal in worktree</span><span className="sub">zsh · feat/auth-flow</span><span className="tag">cmd</span></button>
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  ChatMain, CliMain, Transcript, Msg, Evt, Composer,
  Sheet, FileBody, TermBody, SettingsBody, MarkdownPreview,
  Inspector, FilesInspector, TreeNode, FileIco, ChangesInspector,
  WorkspacesInspector, WorkspaceDetailBody,
  SpacesMain, SpacesConfig, SpacesNative,
  BotsMain, BotsNew,
  SettingsOverlay, CommandPalette,
  SessionNew,
  ManagerMain, ManagerTranscript, ApprovalCard, ManagerInspector,
});
