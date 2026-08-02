// ============================================================
// Other views — New, Chat, Files, Workspaces, Bots, Settings, popovers
// ============================================================

(function(){
  const D = window.GIAN_DATA;
  const { ICO, esc, pill, codeBlock, renderSessionRail, thinkingDot } = window.V;

  // ---------- NEW SESSION ----------
  function renderNew() {
    const rail = renderSessionRail(null);
    const main = `<div class="main">
      <div class="main-head">
        <div class="main-head-l"><span class="main-title">New session</span></div>
        <div class="main-head-r">
          <button class="btn ghost sm" onclick="App.switchView('coding')">Cancel</button>
        </div>
      </div>
      <div class="ns-wrap">
        <div class="ns-card">
          <div class="ns-head">
            <div class="ns-title">Start a new session</div>
            <div class="ns-sub">Pick an executor and workspace — Gian will spin up the agent on your runner.</div>
          </div>
          <div class="ns-body">
            <div class="field">
              <div class="field-lbl"><span>Workspace</span><span class="field-hint">where the agent runs</span></div>
              <select class="select">${D.workspaces.filter(w=>!w.hidden).map(w=>`<option>${w.name}</option>`).join('')}</select>
            </div>
            <div class="field">
              <div class="field-lbl"><span>Executor</span><span class="field-hint">agent</span></div>
              <div class="exec-picker">
                <div class="exec-card codex active" onclick="App.pickExec(this,'codex')">
                  <div class="exec-card-dot"></div>
                  <div class="exec-card-body">
                    <div class="exec-card-name">Codex</div>
                    <div class="exec-card-desc">OpenAI · gpt-5-codex</div>
                    <div class="exec-card-meta"><span>sandbox: ro</span><span>·</span><span>detailed</span></div>
                  </div>
                </div>
                <div class="exec-card claude" onclick="App.pickExec(this,'claude')">
                  <div class="exec-card-dot"></div>
                  <div class="exec-card-body">
                    <div class="exec-card-name">Claude Code</div>
                    <div class="exec-card-desc">Anthropic · sonnet-4.6</div>
                    <div class="exec-card-meta"><span>sandbox: rw</span><span>·</span><span>plan mode</span></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="field">
              <div class="field-lbl"><span>Approval mode</span><span class="field-hint">controls turn count + auto-approve</span></div>
              <div style="display:flex;align-items:center;gap:8px;">
                <div class="segm" style="width:fit-content;">
                  <button class="segm-item active">Default</button>
                  <button class="segm-item">Auto</button>
                </div>
                <div class="turns-stepper" style="display:none;" title="Job turn limit (>1 = Job mode)">
                  <span class="ts-lbl">turns</span>
                  <button class="ts-btn">−</button>
                  <span class="ts-val">1</span>
                  <button class="ts-btn">+</button>
                </div>
              </div>
              <div class="field-hint">Default: you confirm risky actions. Auto: all auto-approved; set turns &gt; 1 for Job Mode.</div>
            </div>
            <div class="field">
              <div class="field-lbl"><span>Name</span><span class="field-hint">optional</span></div>
              <input class="input" placeholder="auto-generated if blank"/>
            </div>
            <div class="field">
              <div class="field-lbl"><span>First message</span></div>
              <textarea class="input" rows="4" placeholder="Describe what you want the agent to do…"></textarea>
            </div>
          </div>
          <div class="ns-foot">
            <button class="btn ghost sm" onclick="App.switchView('coding')">Cancel</button>
            <button class="btn primary sm" onclick="App.switchView('coding');App.toast('Session created')">Create session</button>
          </div>
        </div>
      </div>
    </div>`;
    return `<div class="view">${rail}${main}</div>`;
  }

  // ---------- CHAT ----------
  function renderChat() {
    const rail = `<div class="rail">
      <div class="rail-head">
        <div class="rail-head-row">
          <span class="rail-title">Chats</span>
          <button class="btn primary sm">${ICO.plus}<span>New</span></button>
        </div>
      </div>
      <div class="rail-scroll">
        <div class="rail-group">Today</div>
        ${D.chats.filter(c=>c.group==='today').map((c,i)=>`<button class="rail-item ${i===0?'active':''}">
          <span class="ri-body"><span class="ri-row1"><span class="ri-title">${esc(c.title)}</span></span>
          <span class="ri-row2"><span>${esc(c.model)}</span><span class="ri-dot-sep">·</span><span>${c.age}</span></span></span>
        </button>`).join('')}
        <div class="rail-group">Yesterday</div>
        ${D.chats.filter(c=>c.group==='yesterday').map(c=>`<button class="rail-item">
          <span class="ri-body"><span class="ri-row1"><span class="ri-title">${esc(c.title)}</span></span>
          <span class="ri-row2"><span>${esc(c.model)}</span><span class="ri-dot-sep">·</span><span>${c.age}</span></span></span>
        </button>`).join('')}
      </div>
    </div>`;

    const main = `<div class="main">
      <div class="main-head">
        <div class="main-head-l">
          <span class="main-title">VMware port mirror</span>
          <button class="btn ghost sm icon">${ICO.edit}</button>
          <span class="chip">Sonnet 4.6</span>
        </div>
        <div class="main-head-r">
          <button class="btn ghost sm">Promote to coding</button>
        </div>
      </div>
      <div class="transcript-wrap">
        <div class="transcript">
          <div class="turn-mark"><span>10:15</span></div>
          <div class="msg user">
            <div class="msg-av user">R</div>
            <div class="msg-body">
              <div class="msg-meta"><span class="msg-author">You</span><span class="msg-time">10:15</span></div>
              <div class="msg-text"><p>VMware port mirror — how does it work?</p></div>
            </div>
          </div>
          <div class="msg">
            <div class="msg-av claude">a</div>
            <div class="msg-body">
              <div class="msg-meta"><span class="msg-author claude">Claude</span><span class="msg-time">10:15</span></div>
              <div class="msg-text">
                <p>VMware port mirroring (SPAN) on a vSphere Distributed Switch replicates traffic from one source port/VLAN to a destination for inspection. Three flavors:</p>
                <div class="src-list">
                  <div class="src-list-title">Types</div>
                  <div class="src-item"><span class="src-item-num">1</span><span class="src-item-t">Encapsulated Remote Mirror (ERSPAN)</span><span class="src-item-d">GRE to remote collector</span></div>
                  <div class="src-item"><span class="src-item-num">2</span><span class="src-item-t">Remote Mirror</span><span class="src-item-d">VLAN-based, cross-switch</span></div>
                  <div class="src-item"><span class="src-item-num">3</span><span class="src-item-t">Local Mirror</span><span class="src-item-d">source + dest on same host</span></div>
                </div>
                <p>Configuration lives under dvSwitch → <code>Port Mirroring</code>. Want me to sketch a diagram?</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="composer-wrap">
        <div class="composer">
          <textarea class="composer-ta" rows="1" placeholder="Ask anything — ⌘↵ to send"></textarea>
          <div class="composer-bar">
            <button class="composer-opt">Sonnet 4.6 ${ICO.caret}</button>
            <span class="spacer"></span>
            <button class="attach-chip">${ICO.attach}<span>Attach</span></button>
            <button class="voice-btn" title="Hold to record" onmousedown="App.voiceStart()" onmouseup="App.voiceEnd()">${ICO.mic}</button>
            <span class="composer-hint"><kbd class="kc">⌘↵</kbd> send</span>
            <button class="btn primary sm icon">${ICO.send}</button>
          </div>
        </div>
      </div>
    </div>`;

    return `<div class="view">${rail}${main}</div>`;
  }

  // ---------- FILES ----------
  function renderFiles() {
    function renderTree(nodes, depth=0) {
      return nodes.map(n => {
        if (n.type === 'folder') {
          return `<div class="tree-item folder ${n.open?'open':''}">
            <span class="tree-caret">${ICO.caret}</span>
            <span class="tree-ico">${ICO.folder}</span>
            <span class="tree-name">${esc(n.name)}</span>
            <span></span>
          </div>${n.open?`<div class="tree-children">${renderTree(n.children||[], depth+1)}</div>`:''}`;
        }
        return `<div class="tree-item ${n.active?'active':''}">
          <span></span>
          <span class="tree-ico">${ICO.file}</span>
          <span class="tree-name">${esc(n.name)}</span>
          ${n.flag?`<span class="tree-flag ${n.flag}"></span>`:'<span></span>'}
        </div>`;
      }).join('');
    }

    // Flatten tree to find changed files
    function flattenChanged(nodes, path='') {
      const out = [];
      for (const n of nodes) {
        const p = path ? `${path}/${n.name}` : n.name;
        if (n.type === 'folder') out.push(...flattenChanged(n.children||[], p));
        else if (n.flag) out.push({ name: n.name, path: p, flag: n.flag, active: n.active });
      }
      return out;
    }
    const changed = flattenChanged(D.fileTree);
    const flagLabel = { mod:'M', add:'A', del:'D' };

    // Default tab: Changed if there are changes, else Tree
    const filesTab = (App.state.filesTab) || (changed.length ? 'changed' : 'tree');

    const rail = `<div class="rail">
      <div class="rail-head">
        <div class="rail-head-row">
          <span class="rail-title">Files</span>
        </div>
        <select class="select">${D.workspaces.filter(w=>!w.hidden).map(w=>`<option>${w.name}</option>`).join('')}</select>
        <div class="rail-tabs" style="margin-top:8px;">
          <button class="rail-tab ${filesTab==='changed'?'active':''}" onclick="App.setFilesTab('changed')">
            Changed${changed.length?` <span class="rail-tab-count">${changed.length}</span>`:''}
          </button>
          <button class="rail-tab ${filesTab==='tree'?'active':''}" onclick="App.setFilesTab('tree')">
            Tree
          </button>
        </div>
      </div>
      <div class="rail-scroll">
        ${filesTab === 'changed' ? (
          changed.length ? `<div class="changed-list">
            ${changed.map(c => `
              <button class="changed-item ${c.active?'active':''}" title="${esc(c.path)}">
                <span class="changed-flag ${c.flag}">${flagLabel[c.flag]||'?'}</span>
                <span class="changed-name">${esc(c.name)}</span>
                <span class="changed-path">${esc(c.path.replace('/'+c.name,'')||'·')}</span>
              </button>`).join('')}
          </div>` : `<div class="rail-empty">
            <div class="rail-empty-ico">${ICO.file}</div>
            <div>Working tree clean</div>
          </div>`
        ) : `<div class="tree">${renderTree(D.fileTree)}</div>`}
      </div>
    </div>`;

    const main = `<div class="main">
      <div class="main-head">
        <div class="main-head-l">
          <span class="main-title" style="font-family:var(--font-mono);font-size:13px;">auth.ts</span>
          <span class="preview-path" style="font-family:var(--font-mono);"><span>src/routes/</span></span>
        </div>
        <div class="main-head-r">
          <button class="btn ghost sm">Open in new tab</button>
        </div>
      </div>
      <div class="file-meta">
        <span>TypeScript</span><span>·</span><span>86 lines</span><span>·</span><span>3 edits today</span><span>·</span><span style="color:var(--warn);">● uncommitted</span>
      </div>
      <div class="file-code">
        ${codeBlock(1, [
          ['import express from \'express\';', false],
          ['import { verifyToken } from \'../middleware/auth.js\';', false],
          ['import { OAuth2Client } from \'google-auth-library\';', true],
          ['', false],
          ['const oauth = new OAuth2Client(', false],
          ['  process.env.GOOGLE_CLIENT_ID,', false],
          ['  process.env.GOOGLE_REDIRECT_URI', false],
          [');', false],
          ['', false],
          ['export async function registerAuthRoutes(app) {', false],
          ['  app.post(\'/api/auth/login\', async (req, res) => {', false],
          ['    const { token } = req.body;', false],
          ['    const user = await verifyToken(token);', false],
          ['    if (!user) return res.status(401).end();', false],
          ['    res.json({ ok: true, user });', false],
          ['  });', false],
          ['', false],
          ['  app.get(\'/api/auth/google/callback\', async (req, res) => {', false],
          ['    const { code } = req.query;', false],
          ['    const { tokens } = await oauth.getToken(code);', false],
          ['    oauth.setCredentials(tokens);', false],
          ['    res.redirect(\'/\');', false],
          ['  });', false],
          ['}', false],
        ])}
      </div>
    </div>`;

    return `<div class="view">${rail}${main}</div>`;
  }

  // ---------- WORKSPACES ----------
  function renderWorkspaces() {
    const visible = D.workspaces.filter(w=>!w.hidden);
    const rail = `<div class="rail">
      <div class="rail-head">
        <div class="rail-head-row">
          <span class="rail-title">Spaces</span>
          <button class="btn primary sm" onclick="App.toast('New workspace flow')">${ICO.plus}<span>New</span></button>
        </div>
        <div class="field-hint" style="padding:0 2px;">root: <span style="color:var(--text-2);font-family:var(--font-mono);">${esc(D.runner.wsRoot)}</span></div>
      </div>
      <div class="rail-scroll" style="padding-top:4px;">
        ${visible.map((w,i)=>`<div class="ws-list-item ${i===0?'active':''}" role="button" tabindex="0">
          <div class="ws-list-body">
            <div class="ws-title">${esc(w.name)}</div>
            <div class="ws-path">${esc(w.path)}</div>
          </div>
          <span class="ws-meta">${w.sessions}</span>
          <div class="ws-list-actions">
            <button class="btn ghost icon xs" title="Move up" onclick="event.stopPropagation();App.toast('Moved up');">${ICO.up}</button>
            <button class="btn ghost icon xs" title="Move down" onclick="event.stopPropagation();App.toast('Moved down');">${ICO.down}</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;

    const ws = visible[0];
    const main = `<div class="main">
      <div class="main-head">
        <div class="main-head-l"><span class="main-title">${esc(ws.name)}</span></div>
        <div class="main-head-r">
          <button class="btn danger-ghost sm">Delete</button>
          <button class="btn primary sm">Save</button>
        </div>
      </div>
      <div class="admin-body">
        <div class="fcard">
          <div class="fcard-head">Workspace</div>
          <div class="fcard-body">
            <div class="kv-grid">
              <div class="field"><div class="field-lbl">Name</div><input class="input" value="${esc(ws.name)}"/></div>
              <div class="field"><div class="field-lbl">Default executor</div><select class="select"><option>Codex</option><option>Claude Code</option></select></div>
            </div>
            <div class="field"><div class="field-lbl">Local path</div><input class="input" value="${esc(ws.path)}"/></div>
            <div class="kv-grid">
              <div class="field"><div class="field-lbl">Git remote</div><input class="input" value="git@github.com:acme/remote-vibe-coding.git"/></div>
              <div class="field"><div class="field-lbl">Default branch</div><input class="input" value="main"/></div>
            </div>
          </div>
        </div>

        <div class="fcard">
          <div class="fcard-head">Approval categories · default risk</div>
          <div class="fcard-body">
            <div class="approval-cat-grid">
              <div class="approval-cat-row">
                <span class="approval-cat-name">command</span>
                <span class="field-hint">shell commands the executor wants to run</span>
                <div class="segm"><button class="segm-item">low</button><button class="segm-item active">medium</button><button class="segm-item">high</button></div>
              </div>
              <div class="approval-cat-row">
                <span class="approval-cat-name">network</span>
                <span class="field-hint">outbound HTTP/DNS the executor initiates</span>
                <div class="segm"><button class="segm-item">low</button><button class="segm-item active">medium</button><button class="segm-item">high</button></div>
              </div>
              <div class="approval-cat-row">
                <span class="approval-cat-name">file_write_outside_ws</span>
                <span class="field-hint">writes outside the active workspace</span>
                <div class="segm"><button class="segm-item">low</button><button class="segm-item">medium</button><button class="segm-item active">high</button></div>
              </div>
              <div class="approval-cat-row">
                <span class="approval-cat-name">other</span>
                <span class="field-hint">unclassified plugin / MCP tool requests</span>
                <div class="segm"><button class="segm-item">low</button><button class="segm-item active">medium</button><button class="segm-item">high</button></div>
              </div>
            </div>
            <div class="field-hint" style="margin-top:8px;">High-risk requests show a red banner and require an extra confirm tap. Overrides the global default for this workspace only.</div>
          </div>
        </div>

        <div class="fcard">
          <div class="fcard-head">Sessions · ${ws.sessions}</div>
          <div class="fcard-body" style="gap:2px;">
            ${D.sessions.filter(s=>s.ws===ws.id).map(s=>`<button class="rail-item" onclick="App.selectSession('${s.id}');App.switchView('coding')">
              <span class="ri-body">
                <span class="ri-row1"><span class="ri-title">${esc(s.title)}</span>${pill(s.status)}</span>
                <span class="ri-row2"><span class="ri-exec-name ${s.exec}">${s.exec}</span><span class="ri-dot-sep">·</span><span>${s.age}</span></span>
              </span>
            </button>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

    return `<div class="view">${rail}${main}</div>`;
  }

  // ---------- BOTS ----------
  function renderBots() {
    const rail = `<div class="rail">
      <div class="rail-head">
        <div class="rail-head-row"><span class="rail-title">Bots</span><button class="btn primary sm">${ICO.plus}<span>New</span></button></div>
      </div>
      <div class="rail-scroll" style="padding-top:4px;">
        ${D.bots.map((b,i)=>`<button class="bot-list-item ${i===0?'active':''}">
          <span class="bot-dot ${b.online?'on':'off'}"></span>
          <span class="bot-icon ${b.platform}">${b.platform[0].toUpperCase()}</span>
          <span>
            <div class="bot-name">${esc(b.label)}</div>
            <div class="bot-sub">${b.online?'connected':'offline'} · ${esc(b.lastMsg)}</div>
          </span>
          <span class="bot-meta">${esc(b.platform)}</span>
        </button>`).join('')}
      </div>
    </div>`;

    const b = D.bots[0];

    const main = `<div class="main">
      <div class="main-head">
        <div class="main-head-l">
          <span class="bot-icon discord">D</span>
          <span class="main-title">${esc(b.label)}</span>
          <div class="inline-tabs">
            <button class="inline-tab active">Config</button>
            <button class="inline-tab">Permissions</button>
            <button class="inline-tab">IM preview</button>
            <button class="inline-tab">Logs <span class="chip" style="padding:0 5px;font-size:9px;">3</span></button>
          </div>
        </div>
        <div class="main-head-r">
          <button class="btn danger-ghost sm">Delete</button>
          <button class="btn primary sm">Save</button>
        </div>
      </div>
      <div class="admin-body" style="max-width:760px;">

        <div class="fcard">
          <div class="fcard-head">Connection</div>
          <div class="fcard-body">
            <div class="kv-grid">
              <div class="field"><div class="field-lbl">Label</div><input class="input" value="${esc(b.label)}"/></div>
              <div class="field"><div class="field-lbl">Platform</div><select class="select"><option>Discord</option><option>Slack</option></select></div>
            </div>
            <div class="field"><div class="field-lbl"><span>Bot token</span><span class="field-hint">encrypted at rest</span></div><input class="input" type="password" placeholder="••••••••••••••••"/></div>
            <div class="field"><div class="field-lbl">Default workspace</div><select class="select">${D.workspaces.filter(w=>!w.hidden).map(w=>`<option>${w.name}</option>`).join('')}</select></div>
          </div>
        </div>

        <div class="fcard">
          <div class="fcard-head">Behavior · what IM users see</div>
          <div class="fcard-body">
            <div class="field">
              <div class="field-lbl">Mode</div>
              <div class="segm" style="width:fit-content;">
                <button class="segm-item">Read-only mirror</button>
                <button class="segm-item active">Queue approvals</button>
                <button class="segm-item">Full control (takeover)</button>
              </div>
              <div class="field-hint">Queue approvals — bot can forward requests; user still approves in Web. Take-over flips the active channel and Web becomes read-only until released.</div>
            </div>

            <div class="field">
              <div class="field-lbl"><span>Allowed user IDs</span><span class="field-hint">comma-separated</span></div>
              <input class="input" value="283749201, 394802111"/>
            </div>
            <div class="field">
              <div class="field-lbl"><span>Channels</span><span class="field-hint">leave blank for all</span></div>
              <input class="input" value="#dev, #agent"/>
            </div>
          </div>
        </div>

        <div class="fcard">
          <div class="fcard-head">IM message preview · what gets pushed</div>
          <div class="fcard-body">
            <div class="segm" style="width:fit-content;margin-bottom:6px;">
              <button class="segm-item active" onclick="document.querySelector('.im-preview').dataset.platform='discord'">Discord</button>
              <button class="segm-item" onclick="document.querySelector('.im-preview').dataset.platform='slack'">Slack</button>
            </div>
            <div class="im-preview" data-platform="discord">
              <div class="im-msg">
                <div class="im-msg-head"><span class="im-msg-name bot">rvc-discord</span><span>· just now</span></div>
                <div class="im-msg-body">⏵ <strong>Approval needed</strong> · session <em>Implement OAuth flow</em> wants to run:
                  <div class="im-msg-code">$ npm install google-auth-library</div>
                </div>
                <div class="im-btn-row">
                  <button class="im-btn primary">Allow once</button>
                  <button class="im-btn secondary">Allow session</button>
                  <button class="im-btn danger">Decline</button>
                </div>
              </div>
              <div class="im-msg">
                <div class="im-msg-head"><span class="im-msg-name bot">rvc-discord</span><span>· 2m ago</span></div>
                <div class="im-msg-body">✓ Codex finished editing <code>src/routes/auth.ts</code> (+6 −1) and <code>src/config/oauth.ts</code> (+14).</div>
              </div>
              <div class="im-msg">
                <div class="im-msg-head"><span class="im-msg-name user">rich</span><span>· 1m ago</span></div>
                <div class="im-msg-body"><code>/switch s2</code></div>
              </div>
              <div class="im-msg">
                <div class="im-msg-head"><span class="im-msg-name bot">rvc-discord</span><span>· just now</span></div>
                <div class="im-msg-body im-switch-summary">
                  <div class="im-switch-head">⇋ Switched to <strong>Fix Discord bot reconnect</strong> · Claude · Job Mode · turn 4/20</div>
                  <div class="im-switch-row"><span class="im-switch-key">last 3 events</span></div>
                  <ul class="im-switch-list">
                    <li>10:05 · edited <code>heartbeat.ts</code> (+8 −3) and 2 more files</li>
                    <li>10:06 · npm test — 6 passed in 8.2s</li>
                    <li>10:07 · committing <code>fix(discord): reset heartbeat after RESUMED</code>…</li>
                  </ul>
                  <div class="im-switch-row"><span class="im-switch-key">pending</span><span class="im-switch-val">none</span></div>
                </div>
              </div>
              <div class="im-reply-hint">Slash commands: <code>/new</code> · <code>/switch</code> · <code>/alter</code> · <code>/stop</code> · <code>/reset</code> · <code>/status</code></div>
            </div>
            <div class="field-hint" style="margin-top:6px;">
              In <b>read-only mirror</b>, only <code>assistant_text</code> and <code>session_error</code> are pushed. In <b>queue approvals</b>, also <code>approval_requested</code>. In <b>full control</b>, the full event stream is mirrored.
            </div>
          </div>
        </div>

      </div>
    </div>`;

    return `<div class="view">${rail}${main}</div>`;
  }

  // ---------- SETTINGS SHEET ----------
  function renderSettings() {
    return `<div class="sheet-head">
      <div class="sheet-title">Settings</div>
      <button class="btn ghost sm icon" onclick="App.closeSettings()">${ICO.close}</button>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Account</div>
      <div class="account-card">
        <div class="account-av">R</div>
        <div class="account-body">
          <div class="account-name">Acme</div>
          <div class="account-role">owner · single-user instance</div>
        </div>
        <button class="btn secondary sm">Sign out</button>
      </div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Theme</div>
      <div class="theme-picker">
        <button class="theme-chip" data-theme="light" onclick="App.setTheme('light')">
          <span class="theme-swatch"><i style="background:#f2f2f6;"></i><i style="background:#fff;"></i><i style="background:oklch(0.55 0.13 310);"></i></span>
          <span>Light</span>
        </button>
        <button class="theme-chip" data-theme="warm" onclick="App.setTheme('warm')">
          <span class="theme-swatch"><i style="background:oklch(0.955 0.020 80);"></i><i style="background:oklch(0.990 0.012 82);"></i><i style="background:oklch(0.52 0.13 310);"></i></span>
          <span>Warm</span>
        </button>
        <button class="theme-chip" data-theme="dark" onclick="App.setTheme('dark')">
          <span class="theme-swatch"><i style="background:oklch(0.165 0.012 250);"></i><i style="background:oklch(0.24 0.016 250);"></i><i style="background:oklch(0.72 0.13 310);"></i></span>
          <span>Dark</span>
        </button>
      </div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Accent</div>
      <div class="accent-picker">
        <button class="accent-swatch" style="background:oklch(0.55 0.13 310);" onclick="App.setAccent('plum')"></button>
        <button class="accent-swatch" style="background:oklch(0.58 0.10 150);" onclick="App.setAccent('moss')"></button>
        <button class="accent-swatch" style="background:oklch(0.55 0.11 255);" onclick="App.setAccent('ink')"></button>
        <button class="accent-swatch" style="background:oklch(0.62 0.13 30);" onclick="App.setAccent('ember')"></button>
      </div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">System · runner</div>
      <div class="kv-grid">
        <div class="field"><div class="field-lbl">Listen address</div><input class="input" value="127.0.0.1"/></div>
        <div class="field"><div class="field-lbl">Port</div><input class="input" value="8990"/></div>
      </div>
      <div class="field"><div class="field-lbl">Workspace root</div><input class="input" value="${esc(D.runner.wsRoot)}"/></div>
      <div class="field"><div class="field-lbl">Data dir</div><input class="input" value="~/.config/gian"/></div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Executors</div>
      <div class="kv-grid">
        <div class="field"><div class="field-lbl">Codex CLI path</div><input class="input" value="/usr/local/bin/codex"/></div>
        <div class="field"><div class="field-lbl">Codex version</div><input class="input" value="${esc(D.runner.codexVersion)}" disabled/></div>
        <div class="field"><div class="field-lbl">Claude Code path</div><input class="input" value="/usr/local/bin/claude"/></div>
        <div class="field"><div class="field-lbl">CC version</div><input class="input" value="${esc(D.runner.ccVersion)}" disabled/></div>
      </div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Voice (STT)</div>
      <div class="kv-grid">
        <div class="field"><div class="field-lbl">Engine</div><select class="select"><option>OpenAI Whisper API</option><option>whisper.cpp (local)</option><option>Deepgram</option></select></div>
        <div class="field"><div class="field-lbl">Language</div><select class="select"><option>auto</option><option>zh</option><option>en</option></select></div>
      </div>
      <div class="field"><div class="field-lbl"><span>API key</span><span class="field-hint">stored in keychain</span></div><input class="input" type="password" placeholder="sk-…"/></div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Auth</div>
      <div class="kv-grid">
        <div class="field"><div class="field-lbl">Username</div><input class="input" value="rich"/></div>
        <div class="field"><div class="field-lbl">Password</div><input class="input" type="password" value="••••••••"/></div>
      </div>
      <div class="field-hint">Single-user mode. Multi-user is on the roadmap.</div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Density</div>
      <div class="segm" style="width:fit-content;">
        <button class="segm-item" onclick="App.setDensity('compact')">Compact</button>
        <button class="segm-item active" onclick="App.setDensity('cozy')">Cozy</button>
        <button class="segm-item" onclick="App.setDensity('roomy')">Roomy</button>
      </div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Language</div>
      <div class="segm" style="width:fit-content;">
        <button class="segm-item ${D.i18n.current==='zh-CN'?'active':''}">中文 (zh-CN)</button>
        <button class="segm-item ${D.i18n.current==='en'?'active':''}">English</button>
      </div>
      <div class="field-hint">UI strings only — transcript content stays as-is.</div>
    </div>

    <div class="sheet-section">
      <div class="sheet-lbl">Public access · domain &amp; reverse proxy</div>
      <div class="field">
        <div class="field-lbl">Public URL</div>
        <input class="input" value="${esc(D.network.publicUrl)}"/>
        <div class="field-hint">Where you access Gian when you’re not on the runner. Leave blank to use ${D.runner.host}:8990.</div>
      </div>
      <div class="field">
        <div class="field-lbl">Tunnel mode</div>
        <div class="segm" style="width:fit-content;">
          <button class="segm-item">None (LAN only)</button>
          <button class="segm-item active">Cloudflare Tunnel</button>
          <button class="segm-item">Tailscale Funnel</button>
          <button class="segm-item">Reverse proxy</button>
        </div>
      </div>
      <div class="kv-grid">
        <div class="field"><div class="field-lbl">Tunnel ID</div><input class="input" value="${esc(D.network.cfTunnelId)}"/></div>
        <div class="field"><div class="field-lbl">Force HTTPS</div>
          <div class="segm" style="width:fit-content;"><button class="segm-item active">On</button><button class="segm-item">Off</button></div>
        </div>
      </div>
      <div class="field-hint">Auth still applies on top of the tunnel — requests without your session cookie are 401.</div>
    </div>`;
  }

  // ---------- INBOX POPOVER ----------
  function renderInbox() {
    return `<div style="padding:8px 4px 4px;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 8px 6px;">
        <span class="rail-title">Pending approvals</span>
        <span class="chip">${D.approvals.length}</span>
      </div>
      ${D.approvals.map(a=>{
        const s = D.sessions.find(x=>x.id===a.session);
        return `<button class="rail-item" onclick="App.selectSession('${s.id}');App.switchView('coding');App.closeInbox();">
          <span class="ri-body">
            <span class="ri-row1"><span class="ri-title">${esc(a.title)}</span><span class="approval-risk" style="font-size:9px;">${esc(a.category)}</span></span>
            <span class="ri-row2"><span class="ri-sub" style="font-family:var(--font-mono);">${esc(a.cmd)}</span></span>
            <span class="ri-row2"><span>in</span><span class="ri-exec-name ${s.exec}">${esc(s.title)}</span></span>
          </span>
        </button>`;
      }).join('')}
      <div class="hairline" style="margin:6px 8px;"></div>
      <div style="padding:4px 8px;font-size:10.5px;color:var(--text-3);font-family:var(--font-mono);">
        Tip: press <kbd class="kc">⌘⇧A</kbd> from anywhere to jump to next pending.
      </div>
    </div>`;
  }

  function renderRunner() {
    return `<div class="runner-pop">
      <div class="runner-pop-head">
        <span class="runner-dot"></span>
        <div class="runner-pop-host">
          <div class="runner-pop-name">${esc(D.runner.host)}</div>
          <div class="runner-pop-meta">connected · ${D.runner.latency}ms · started ${D.runner.startedAgo} ago</div>
        </div>
      </div>
      <div class="hairline" style="margin:6px 0;"></div>
      <dl class="runner-pop-list">
        <dt>Agents</dt><dd>${D.runner.agents} running</dd>
        <dt>Disk</dt><dd>${esc(D.runner.disk)}</dd>
        <dt>Codex CLI</dt><dd>${esc(D.runner.codexVersion)}</dd>
        <dt>Claude Code</dt><dd>${esc(D.runner.ccVersion)}</dd>
        <dt>Workspace root</dt><dd>${esc(D.runner.wsRoot)}</dd>
      </dl>
      <div class="hairline" style="margin:6px 0;"></div>
      <div class="runner-pop-actions">
        <button class="btn secondary sm" style="flex:1;">Open tunnel</button>
        <button class="btn ghost sm">Restart</button>
      </div>
    </div>`;
  }

  // ---------- SESSION GRANTS POPOVER (per-session allowed-once-permanent list) ----------
  function renderGrants() {
    const sid = (window.App && App.state && App.state.grantsSession) || 's1';
    const grants = D.sessionGrants.filter(g => g.session === sid);
    const s = D.sessions.find(x => x.id === sid);
    return `<div style="padding:8px 4px 4px;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0 8px 6px;">
        <div>
          <div class="rail-title">Session grants</div>
          <div class="field-hint" style="margin-top:2px;">${esc(s.title)} — auto-allowed for this session</div>
        </div>
        <span class="chip">${grants.length}</span>
      </div>
      <div class="grants-list">
        ${grants.map(g => `<div class="grant-row">
          <span class="grant-cat">${esc(g.category)}</span>
          <span class="grant-pat">${esc(g.pattern)}</span>
          <span class="grant-time">${esc(g.grantedAt)}</span>
          <button class="btn ghost icon xs" title="Revoke">${ICO.close}</button>
        </div>`).join('')}
        ${grants.length === 0 ? `<div class="field-hint" style="padding:10px;">No grants yet.</div>` : ''}
      </div>
      <div class="hairline" style="margin:6px 8px;"></div>
      <div style="padding:4px 8px;display:flex;gap:4px;">
        <button class="btn ghost sm" style="flex:1;">Revoke all</button>
      </div>
    </div>`;
  }

  // ---------- SLASH COMMAND PALETTE (Gian + executor-native) ----------
  function renderSlash(sid) {
    const s = D.sessions.find(x => x.id === sid) || D.sessions[0];
    const execKey = s.exec === 'claude' ? 'claude' : 'codex';
    const execLabel = execKey === 'claude' ? 'Claude' : 'Codex';
    const sc = D.slashCommands;
    const section = (label, items, tone) => `
      <div class="slash-sec-head"><span>${label}</span><span class="slash-sec-count">${items.length}</span></div>
      ${items.map(c => `<button class="slash-row tone-${tone}" onclick="App.pickSlash('${c.cmd}')">
        <span class="slash-row-cmd">${esc(c.cmd)}</span>
        <span class="slash-row-desc">${esc(c.desc)}</span>
      </button>`).join('')}`;
    return `<div class="slash-palette">
      <div class="slash-head">
        <span class="slash-head-glyph">/</span>
        <input class="slash-input" placeholder="Filter commands…" autofocus
          oninput="this.closest('.slash-palette').querySelectorAll('.slash-row').forEach(r => { r.style.display = r.textContent.toLowerCase().includes(this.value.toLowerCase()) ? '' : 'none'; });"/>
        <span class="slash-head-hint">↑↓ navigate · ↵ run</span>
      </div>
      <div class="slash-body">
        ${section(execLabel + ' · native', sc[execKey], execKey)}
      </div>
      <div class="slash-foot">Slash commands are passed through to the executor.</div>
    </div>`;
  }

  // ---------- MODEL & THINKING POPOVER ----------
  function renderModelPicker() {
    const sid = (window.App && App.state && App.state.modelSession) || 's1';
    const s = D.sessions.find(x => x.id === sid);
    const cur = s.model || 'gpt-5-codex';
    const curThink = s.thinking || 'medium';
    const isClaude = s.exec === 'claude';

    const claudeModels = [
      { id: 'sonnet-4.6',  label: 'Claude Sonnet 4.6', hint: 'balanced · default' },
      { id: 'opus-4.1',    label: 'Claude Opus 4.1',   hint: 'most capable · slow' },
      { id: 'haiku-4.5',   label: 'Claude Haiku 4.5',  hint: 'fastest · cheapest' },
    ];
    const codexModels = [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex',  hint: 'tuned for coding' },
      { id: 'gpt-5',       label: 'GPT-5',        hint: 'general · capable' },
      { id: 'gpt-5-mini',  label: 'GPT-5 mini',   hint: 'fast · cheap' },
    ];
    const list = isClaude ? claudeModels : codexModels;
    const thinkingLabel = isClaude ? 'Thinking' : 'Reasoning effort';
    const thinkLevels = [
      { id: 'off',    label: 'Off',    hint: isClaude ? 'no extended thinking' : 'minimal reasoning' },
      { id: 'low',    label: 'Low',    hint: 'short' },
      { id: 'medium', label: 'Medium', hint: 'default' },
      { id: 'high',   label: 'High',   hint: 'deep · slower' },
    ];

    return `<div class="model-pop">
      <div class="mp-section">
        <div class="mp-section-head">
          <span class="mp-section-title">Model</span>
          <span class="mp-section-hint">${esc(s.exec)}</span>
        </div>
        <div class="mp-list">
          ${list.map(m => `<button class="mp-row ${m.id===cur?'active':''}" onclick="App.setModel('${sid}','${m.id}')">
            <span class="mp-check">${m.id===cur ? '✓' : ''}</span>
            <span class="mp-row-body">
              <span class="mp-row-title">${esc(m.label)}</span>
              <span class="mp-row-hint">${esc(m.hint)}</span>
            </span>
          </button>`).join('')}
        </div>
      </div>
      <div class="hairline" style="margin:4px 6px;"></div>
      <div class="mp-section">
        <div class="mp-section-head">
          <span class="mp-section-title">${thinkingLabel}</span>
          <span class="mp-section-hint">how much the model deliberates before answering</span>
        </div>
        <div class="mp-think-grid">
          ${thinkLevels.map(t => `<button class="mp-think ${t.id===curThink?'active':''}" onclick="App.setThinking('${sid}','${t.id}')" title="${esc(t.hint)}">
            ${thinkingDot(t.id)}
            <span>${esc(t.label)}</span>
          </button>`).join('')}
        </div>
      </div>
    </div>`;
  }

  // ---------- SESSION MENU POPOVER (Reset / Archive) ----------
  function renderSessionMenu(sid) {
    return `<div class="sess-menu">
      <button class="sess-menu-item" onclick="App.resetSession('${sid}')">
        <span class="sess-menu-ico">${ICO.retry}</span>
        <span class="sess-menu-body">
          <span class="sess-menu-title">Reset context</span>
          <span class="sess-menu-desc">Clear context window · keep transcript</span>
        </span>
        <kbd class="kc">⇧⌘R</kbd>
      </button>
      <div class="hairline" style="margin:4px 6px;"></div>
      <button class="sess-menu-item danger" onclick="App.toast('Archived','session moved to Archived');App.closePopover();">
        <span class="sess-menu-ico">${ICO.close}</span>
        <span class="sess-menu-body">
          <span class="sess-menu-title">Archive session</span>
          <span class="sess-menu-desc">Hide from rail · transcript preserved</span>
        </span>
      </button>
    </div>`;
  }

  // ---------- Expose ----------
  Object.assign(window.Views, {
    new: renderNew,
    files: renderFiles,
    workspaces: renderWorkspaces,
    bots: renderBots,
    settings: renderSettings,
    inbox: renderInbox,
    runner: renderRunner,
    grants: renderGrants,
    slash: renderSlash,
    sessionMenu: renderSessionMenu,
    modelPicker: renderModelPicker,
  });
})();
