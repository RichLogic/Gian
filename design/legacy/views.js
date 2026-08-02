// ============================================================
// Views — shared helpers, icons, rail, CODING view
// ============================================================

(function(){
  const D = window.GIAN_DATA;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ---------- Icons ----------
  const ICO = {
    caret:     '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close:     '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    plus:      '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    edit:      '<svg viewBox="0 0 16 16"><path d="M3 13l3-1 7-7-2-2-7 7-1 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    up:        '<svg viewBox="0 0 16 16"><path d="M8 12V4M4 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down:      '<svg viewBox="0 0 16 16"><path d="M8 4v8M4 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    send:      '<svg viewBox="0 0 16 16"><path d="M14 2L2 7l5 2 2 5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    stop:      '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
    attach:    '<svg viewBox="0 0 16 16"><path d="M13 7l-5 5a3 3 0 01-4-4l6-6a2 2 0 013 3l-6 6a1 1 0 01-1.5-1.5l5-5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    mic:       '<svg viewBox="0 0 16 16"><rect x="6" y="2" width="4" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 8a4 4 0 008 0M8 12v2M6 14h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    file:      '<svg viewBox="0 0 16 16"><path d="M3 2h6l3 3v9H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 2v3h3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    folder:    '<svg viewBox="0 0 16 16"><path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    alert:     '<svg viewBox="0 0 16 16"><path d="M8 2L1.5 13h13zM8 7v3M8 12v.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    split:     '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 3v10" stroke="currentColor" stroke-width="1.4"/></svg>',
    read:      '<svg viewBox="0 0 16 16"><path d="M3 3h7l3 3v7H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5 8h6M5 11h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    terminal:  '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 7l2 1-2 1M8 10h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search:    '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    globe:     '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    agent:     '<svg viewBox="0 0 16 16"><path d="M4 3v7l4 3 4-3V3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="6.5" r="1.4" fill="currentColor"/></svg>',
    brain:     '<svg viewBox="0 0 16 16"><path d="M6 3a2 2 0 00-2 2v1a2 2 0 00-1 2 2 2 0 001 2v1a2 2 0 002 2M10 3a2 2 0 012 2v1a2 2 0 011 2 2 2 0 01-1 2v1a2 2 0 01-2 2M6 3a2 2 0 014 0M6 13a2 2 0 004 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    check:     '<svg viewBox="0 0 16 16"><path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x:         '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    info:      '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7v4M8 5.2v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    im:        '<svg viewBox="0 0 16 16"><path d="M2 4h12v7H6l-3 2 .5-2H2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    retry:     '<svg viewBox="0 0 16 16"><path d="M13 4V1M13 4l-2.5-.3M13 4a5 5 0 10-.5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    web:       '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.4"/></svg>',
  };

  const pill = (status) => {
    const map = {
      'running':        ['run',  'Running'],
      'job-running':    ['run',  'Running'],
      'needs-approval': ['wait', 'Pending'],
      'pending':        ['wait', 'Pending'],
      'new':            null,           // no chip for New
      'idle':           null,           // legacy → New
      'archived':       ['idle', 'Archived'],
      'err':            ['err',  'Error'],
      'error':          ['err',  'Error'],
      'done':           ['done', 'Done'],
    };
    const m = map[status];
    if (!m) return '';
    const [cls, label] = m;
    return `<span class="pill ${cls}">${label}</span>`;
  };

  const execDot = (exec) => `<span class="ri-avatar ${exec}"></span>`;

  // 4 levels of thinking effort, rendered as a stacked-bars glyph
  const thinkingDot = (level) => {
    const map = { off: 0, low: 1, medium: 2, high: 3 };
    const n = map[level] ?? 2;
    return `<span class="think-bars" data-level="${level}">
      <i class="${n>=1?'on':''}"></i><i class="${n>=2?'on':''}"></i><i class="${n>=3?'on':''}"></i>
    </span>`;
  };

  // ============================================================
  //  Rail — session list
  // ============================================================
  function renderSessionRail(activeId) {
    const groups = { today:'Today', yesterday:'Yesterday', earlier:'Earlier' };
    const needsYou = [];
    const byGroup = {};
    for (const s of D.sessions) {
      if (s.status === 'pending' || s.status === 'needs-approval' || s.status === 'error') {
        needsYou.push(s);
      } else {
        (byGroup[s.group]||(byGroup[s.group]=[])).push(s);
      }
    }

    const renderItem = (s) => {
      const ws = D.workspaces.find(w => w.id === s.ws);
      const channel = s.active_channel === 'im'
        ? `<span class="ri-ch im" title="IM is in control">IM</span>`
        : '';
      const isActive = s.id === activeId;
      const turnBadge = (isActive && s.job)
        ? `<span class="ri-turn">T${s.job.turn}/${s.job.limit}</span>`
        : (s.job
          ? `<span class="ri-turn">T${s.job.turn}/${s.job.limit}</span>`
          : '');

      return `<button class="rail-item ${isActive?'active':''}" onclick="App.selectSession('${s.id}')">
        <span class="ri-body">
          <span class="ri-row1">
            <span class="ri-title">${esc(s.title)}</span>
            ${channel}
            ${pill(s.status)}
          </span>
          <span class="ri-row2">
            ${turnBadge}
            <span class="ri-exec-name ${s.exec}">${s.exec}</span>
            <span class="ri-dot-sep">·</span>
            <span class="ri-sub">${esc(ws.name)}</span>
          </span>
          <span class="ri-age">${s.age}</span>
        </span>
      </button>`;
    };

    let out = `<div class="rail">
      <div class="rail-head">
        <div class="rail-head-row">
          <span class="rail-title">Sessions</span>
          <button class="btn primary sm" onclick="App.switchView('new')">${ICO.plus}<span>New</span></button>
        </div>
        <div class="rail-filterbar">
          <button class="rail-fchip" title="Filter sessions by workspace">
            <span class="rfc-lbl">Workspace</span>
            <span class="rfc-val">All</span>
            <span class="rfc-car">${ICO.caret}</span>
          </button>
          <button class="rail-fchip" title="Filter sessions by activity">
            <span class="rfc-lbl">Activity</span>
            <span class="rfc-val">All</span>
            <span class="rfc-car">${ICO.caret}</span>
          </button>
          <button class="rail-fchip" title="Change how sessions are grouped">
            <span class="rfc-lbl">Group</span>
            <span class="rfc-val">Time</span>
            <span class="rfc-car">${ICO.caret}</span>
          </button>
        </div>
      </div>
      <div class="rail-scroll">`;

    if (needsYou.length) {
      out += `<div class="rail-group needs-you-group">
        <span class="rng-dot"></span>
        <span>NEEDS YOU</span>
        <span class="rng-count">${needsYou.length}</span>
      </div>`;
      for (const s of needsYou) out += renderItem(s);
    }

    for (const g of Object.keys(groups)) {
      const items = byGroup[g] || [];
      if (!items.length) continue;
      out += `<div class="rail-group">${groups[g]}</div>`;
      for (const s of items) out += renderItem(s);
    }
    out += `</div></div>`;
    return out;
  }

  // ============================================================
  //  Transcript event renderers  (12 PRD event types)
  // ============================================================

  function renderTurnStart(e) {
    return `<div class="turn-mark"><span>${esc(e.time)} · ${esc(e.label || 'Turn ' + e.turn)}</span></div>`;
  }

  function renderTurnComplete(e) {
    return `<div class="turn-sep"><span class="tsep-turn">Turn ${e.turn} · complete</span></div>`;
  }

  function renderUserMessage(e) {
    return `<div class="msg user">
      <div class="msg-av user">R</div>
      <div class="msg-body">
        <div class="msg-meta"><span class="msg-time">${esc(e.time)}</span></div>
        <div class="msg-text"><p>${esc(e.text)}</p></div>
      </div>
    </div>`;
  }

  function renderAssistantText(e) {
    const name = e.exec === 'codex' ? 'Codex' : 'Claude';
    const av = e.exec === 'codex' ? 'c' : 'a';
    return `<div class="msg">
      <div class="msg-av ${e.exec}">${av}</div>
      <div class="msg-body">
        <div class="msg-meta"><span class="msg-author ${e.exec}">${name}</span><span class="msg-time">${esc(e.time)}</span></div>
        <div class="msg-text"><p>${esc(e.text)}</p></div>
      </div>
    </div>`;
  }

  function renderThinking(e) {
    return `<div class="evt thinking" onclick="this.classList.toggle('open')">
      <div class="evt-head">
        <span class="evt-caret">${ICO.caret}</span>
        <span class="evt-ico">${ICO.brain}</span>
        <span class="evt-verb">Thinking</span>
        <span class="evt-subject">${esc(e.summary)}</span>
        <span class="evt-meta"><span>${esc(e.time)}</span></span>
      </div>
      <div class="evt-body">
        <div class="thinking-head">Claude Code · internal reasoning</div>
        <p>${esc(e.text)}</p>
      </div>
    </div>`;
  }

  function renderFileRead(e) {
    // Compact single-line card — no body
    const status = e.status === 'running'
      ? `<span class="evt-status running">Reading</span>`
      : `<span class="evt-status success">${e.lines} lines</span>`;
    return `<div class="evt inline" onclick="App.openInspector('${esc(e.path)}')">
      <div class="evt-head">
        <span class="evt-ico">${ICO.read}</span>
        <span class="evt-verb">Read</span>
        <span class="evt-subject path">${esc(e.path)}</span>
        <span class="evt-meta">
          ${e.range ? `<span>L${esc(e.range)}</span>` : ''}
          ${status}
        </span>
      </div>
    </div>`;
  }

  function renderFileSearch(e) {
    const verb = e.tool || 'Grep';
    const status = e.status === 'running'
      ? `<span class="evt-status running">Searching</span>`
      : (e.matches === 0
          ? `<span class="evt-status success">no matches</span>`
          : `<span class="evt-status success">${e.matches} match${e.matches>1?'es':''}</span>`);
    return `<div class="evt search open" onclick="if(event.target.closest('.evt-head'))this.classList.toggle('open')">
      <div class="evt-head">
        <span class="evt-caret">${ICO.caret}</span>
        <span class="evt-ico">${ICO.search}</span>
        <span class="evt-verb">${esc(verb)}</span>
        <span class="evt-subject"><span class="search-pattern">${esc(e.pattern)}</span></span>
        <span class="evt-meta">${status}</span>
      </div>
      <div class="evt-body">
        <div class="search-results">
          ${(e.results||[]).map(r => `<div class="search-result" onclick="App.openInspector('${esc(r.path)}', ${r.line})">
            <span class="sr-loc">${esc(r.path)}<span class="sr-line">:${r.line}</span></span>
            <span class="sr-snippet">${esc(r.snippet)}</span>
          </div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  function renderWebSearch(e) {
    return `<div class="evt web">
      <div class="evt-head">
        <span class="evt-ico">${ICO.globe}</span>
        <span class="evt-verb">Web</span>
        <span class="evt-subject">${esc(e.query)}</span>
        <span class="evt-meta"><span class="evt-status success">done</span></span>
      </div>
    </div>`;
  }

  function renderAgentSpawn(e) {
    const status = e.status === 'running'
      ? `<span class="evt-status running">Running</span>`
      : `<span class="evt-status success">Done</span>`;
    return `<div class="evt agent open">
      <div class="evt-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="evt-caret">${ICO.caret}</span>
        <span class="evt-ico">${ICO.agent}</span>
        <span class="evt-verb">Subagent</span>
        <span class="evt-subject">${esc(e.task)}</span>
        <span class="evt-meta">${status}</span>
      </div>
      <div class="evt-body">${esc(e.summary)}</div>
    </div>`;
  }

  function renderCommandExec(e) {
    const status = e.status === 'running'
      ? `<span class="evt-status running">Running</span>`
      : (e.status === 'error'
          ? `<span class="evt-status error">exit ${e.exit}</span>`
          : `<span class="evt-status success">${e.duration || 'ok'}</span>`);
    return `<div class="evt command open">
      <div class="evt-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="evt-caret">${ICO.caret}</span>
        <span class="evt-ico">${ICO.terminal}</span>
        <span class="evt-verb">Bash</span>
        <span class="evt-subject cmd">${esc(e.cmd)}</span>
        <span class="evt-meta">${status}</span>
      </div>
      <div class="evt-body">${esc(e.output || '')}${e.status === 'running' ? '<span class="cmd-cursor"></span>' : ''}</div>
    </div>`;
  }

  function renderFileChange(e) {
    const fileCount = e.files.length;
    const totalAdd = e.files.reduce((s,f)=>s+(f.add||0),0);
    const totalDel = e.files.reduce((s,f)=>s+(f.del||0),0);
    return `<div class="evt fc">
      <div class="evt-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="evt-caret">${ICO.caret}</span>
        <span class="evt-ico">${ICO.edit}</span>
        <span class="evt-verb">Edit</span>
        <span class="evt-subject">Changed ${fileCount} file${fileCount>1?'s':''}</span>
        <span class="evt-meta">
          <span class="add">+${totalAdd}</span>
          <span class="del">−${totalDel}</span>
          <span class="evt-status success">ok</span>
        </span>
      </div>
      <div class="evt-body" style="background:transparent;max-height:none;">
        <div class="fc-files">
          ${e.files.map(f => `<div class="fc-file" onclick="App.openInspector('${esc(f.path)}')">
            <span class="fc-op ${f.op}"></span>
            <span class="fc-path">${esc(f.path)}</span>
            <span class="fc-stat"><span class="add">+${f.add||0}</span> <span class="del">−${f.del||0}</span></span>
            <span class="fc-open">open →</span>
          </div>`).join('')}
        </div>
        ${e.files.filter(f => f.diff).map(f => `<div class="evt-diff">
          <div class="evt-diff-head">
            <span>${esc(f.path)}</span>
            <span style="color:var(--text-3);">diff</span>
          </div>
          ${diff(f.diff)}
        </div>`).join('')}
      </div>
    </div>`;
  }

  function renderApprovalRequested(e) {
    const risk = e.risk || 'medium';
    const high = risk === 'high';
    return `<div class="approval ${high?'high':''}" data-approval="${e.id}">
      <div class="approval-top">
        <div class="approval-ico">${ICO.alert}</div>
        <div style="flex:1;min-width:0;">
          <div class="approval-title">
            <span>${esc(e.title)}</span>
            <span class="approval-risk">${esc(risk)} risk</span>
          </div>
          <div class="approval-sub">${esc(e.reason)}</div>
        </div>
        <span class="evt-meta" style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-3);">${esc(e.time||'')}</span>
      </div>
      <div class="approval-cmd"><span class="prompt">$ </span>${esc(e.cmd)}</div>
      <div class="approval-actions">
        <button class="btn primary sm" onclick="App.approve('${e.id}','once')">Allow once</button>
        <button class="btn secondary sm" onclick="App.approve('${e.id}','session')">Allow session</button>
        <button class="btn danger-ghost sm" onclick="App.approve('${e.id}','deny')">Decline</button>
        <span class="spacer"></span>
        <span class="approval-tip"><kbd class="kc">A</kbd> once · <kbd class="kc">⇧A</kbd> session · <kbd class="kc">D</kbd> decline</span>
      </div>
    </div>`;
  }

  function renderApprovalResolved(e) {
    const ok = e.decision !== 'declined';
    const label = ({
      'approved-once':    'Allowed once',
      'approved-session': 'Allowed for session',
      'declined':         'Declined',
    })[e.decision] || e.decision;
    return `<div class="approval ${ok?'resolved':'declined'}" data-approval="${e.id||''}">
      <div class="approval-top">
        <div class="approval-ico">${ok ? ICO.check : ICO.x}</div>
        <div style="flex:1;min-width:0;">
          <div class="approval-title">
            <span>${esc(e.title)}</span>
            <span class="approval-risk">${ok ? 'approved' : 'declined'}</span>
          </div>
          <div class="approval-sub">${esc(e.category||'command')}</div>
        </div>
        <span class="evt-meta" style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-3);">${esc(e.time||'')}</span>
      </div>
      <div class="approval-cmd"><span class="prompt">$ </span>${esc(e.cmd)}</div>
      <div class="approval-resolved-note">
        <span class="dot"></span>
        <span>${esc(label)} · by <strong>${esc(e.resolved_by||'web')}</strong></span>
      </div>
    </div>`;
  }

  function renderSessionError(e) {
    return `<div class="err-banner">
      <span class="err-banner-ico">${ICO.alert}</span>
      <div class="err-banner-body">
        <div class="err-banner-title">${esc(e.title || 'Session error')}</div>
        <div class="err-banner-desc">${esc(e.desc || '')}</div>
        <div class="err-banner-actions">
          <button class="btn danger sm">${ICO.retry}<span>Retry</span></button>
          <button class="btn ghost sm">Copy log</button>
        </div>
      </div>
    </div>`;
  }

  // Executor-native slash command (Codex /compact, Claude /clear, etc.)
  function renderSlashCommand(e) {
    const exec = e.source === 'claude' ? 'Claude' : 'Codex';
    return `<div class="evt slash open">
      <div class="evt-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="evt-caret">${ICO.caret}</span>
        <span class="evt-ico slash-ico">/</span>
        <span class="evt-verb">${exec} ran</span>
        <span class="evt-subject"><code class="slash-cmd">${esc(e.cmd)}</code></span>
        <span class="evt-meta"><span class="evt-status success">done</span><span>${esc(e.time||'')}</span></span>
      </div>
      <div class="evt-body slash-body">${esc(e.result||'')}</div>
    </div>`;
  }

  // Executor-native system notice (CLAUDE.md edits, model switch, mid-session memory writes…)
  function renderSystemNotice(e) {
    const exec = e.source === 'claude' ? 'Claude' : 'Codex';
    const kindLabel = ({
      'context-edit': 'Context edited',
      'model-switch': 'Model switched',
      'memory-write': 'Memory updated',
      'init':         'Initialised',
    })[e.kind] || e.kind;
    return `<div class="sys-notice">
      <span class="sys-notice-rail"></span>
      <span class="sys-notice-tag">${exec} · ${esc(kindLabel)}</span>
      <span class="sys-notice-text">${esc(e.text)}</span>
      <span class="sys-notice-time">${esc(e.time||'')}</span>
    </div>`;
  }

  // User-uploaded attachments — chip strip
  function renderAttachment(e) {
    const ICONS = {
      image:  '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="7" r="1.2" fill="currentColor"/><path d="M2 11l3-3 3 3 2-2 4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
      json:   '<svg viewBox="0 0 16 16"><path d="M5 3a2 2 0 00-2 2v2a2 2 0 01-2 2 2 2 0 012 2v2a2 2 0 002 2M11 3a2 2 0 012 2v2a2 2 0 002 2 2 2 0 00-2 2v2a2 2 0 01-2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
      file:   ICO.file,
      pdf:    '<svg viewBox="0 0 16 16"><path d="M3 2h6l3 3v9H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><text x="8" y="12" text-anchor="middle" font-size="4.6" font-family="sans-serif" font-weight="700" fill="currentColor">PDF</text></svg>',
    };
    return `<div class="attach-row">
      <span class="attach-row-lbl">You attached</span>
      ${e.items.map(a => `<span class="attach-chip kind-${esc(a.kind)}">
        <span class="attach-chip-ico">${ICONS[a.kind]||ICONS.file}</span>
        <span class="attach-chip-name">${esc(a.name)}</span>
        <span class="attach-chip-size">${esc(a.size)}</span>
      </span>`).join('')}
      <span class="attach-row-time">${esc(e.time||'')}</span>
    </div>`;
  }

  // Job Mode terminal card — success / failure / stopped
  function renderJobCompletion(e) {
    const tone = e.outcome === 'success' ? 'ok' : (e.outcome === 'stopped' ? 'warn' : 'err');
    const ico = e.outcome === 'success' ? ICO.check : (e.outcome === 'stopped' ? ICO.stop : ICO.alert);
    const label = ({success:'Job complete', stopped:'Job stopped', failure:'Job failed'})[e.outcome] || e.outcome;
    const st = e.stats || {};
    return `<div class="job-card ${tone}">
      <div class="job-card-head">
        <span class="job-card-ico">${ico}</span>
        <span class="job-card-label">${label}</span>
        <span class="job-card-turns">· ${esc(e.turns||0)} turns</span>
        <span class="spacer"></span>
        <span class="job-card-time">${esc(e.time||'')}</span>
      </div>
      <div class="job-card-title">${esc(e.title||'')}</div>
      <div class="job-card-summary">${esc(e.summary||'')}</div>
      <div class="job-card-stats">
        ${st.files!=null  ? `<span><b>${st.files}</b> files</span>` : ''}
        ${st.add!=null    ? `<span class="add">+${st.add}</span>` : ''}
        ${st.del!=null    ? `<span class="del">−${st.del}</span>` : ''}
        ${st.ops!=null    ? `<span><b>${st.ops}</b> ops</span>` : ''}
        ${st.tokens!=null ? `<span><b>${(st.tokens/1000).toFixed(1)}k</b> tok</span>` : ''}
        ${st.duration    ? `<span><b>${esc(st.duration)}</b></span>` : ''}
      </div>
      <div class="job-card-actions">
        <button class="btn primary sm">Push branch</button>
        <button class="btn secondary sm">Open diff</button>
        <button class="btn ghost sm">Continue session</button>
      </div>
    </div>`;
  }

  function renderEvent(e) {
    switch (e.type) {
      case 'turn_start':         return renderTurnStart(e);
      case 'turn_complete':      return renderTurnComplete(e);
      case 'user_message':       return renderUserMessage(e);
      case 'assistant_text':     return renderAssistantText(e);
      case 'thinking':           return renderThinking(e);
      case 'file_read':          return renderFileRead(e);
      case 'file_search':        return renderFileSearch(e);
      case 'web_search':         return renderWebSearch(e);
      case 'agent_spawn':        return renderAgentSpawn(e);
      case 'command_execution':  return renderCommandExec(e);
      case 'file_change':        return renderFileChange(e);
      case 'approval_requested': return renderApprovalRequested(e);
      case 'approval_resolved':  return renderApprovalResolved(e);
      case 'session_error':      return renderSessionError(e);
      case 'slash_command':      return renderSlashCommand(e);
      case 'system_notice':      return renderSystemNotice(e);
      case 'attachment':         return renderAttachment(e);
      case 'job_completion':     return renderJobCompletion(e);
      default: return '';
    }
  }

  function diff(lines) {
    return lines.map(([n, c, t]) =>
      `<div class="diff-ln ${t||''}"><span class="diff-num">${t==='add'?'+':(t==='del'?'-':'')}${esc(n)}</span><span class="diff-txt">${c}</span></div>`
    ).join('');
  }

  // ============================================================
  //  Job Mode progress bar + takeover banner
  // ============================================================
  function renderJobBar(s) {
    const j = s.job;
    if (!j) return '';
    const pct = Math.min(100, (j.turn / j.limit) * 100);
    return `<div class="job-bar">
      <span class="job-bar-label">Job Mode</span>
      <span class="job-bar-turn">Turn ${j.turn}<span> / ${j.limit}</span></span>
      <div class="job-bar-prog"><div class="job-bar-prog-fill" style="width:${pct}%;"></div></div>
      <span class="job-bar-stat" title="${j.ops} tool calls so far"><b>${j.ops}</b> ops</span>
      <span class="job-bar-stat" title="tokens consumed"><b>${(j.tokens/1000).toFixed(1)}k</b> tok</span>
      <button class="btn danger sm job-bar-stop" onclick="App.stopJob('${s.id}')">${ICO.stop}<span>Stop</span></button>
    </div>`;
  }

  function renderTakeoverBanner(s) {
    if (s.active_channel !== 'im') return '';
    return `<div class="takeover-banner">
      <span class="takeover-ico">${ICO.im}</span>
      <span class="takeover-label"><strong>IM</strong> is currently controlling this session. Transcript is read-only on Web.</span>
      <span class="spacer"></span>
      <button class="btn secondary sm" onclick="App.takeoverWeb('${s.id}')">Take over</button>
    </div>`;
  }

  // ============================================================
  //  Composer
  // ============================================================
  function renderComposer(s) {
    const isJob = !!(s.job);
    const isLocked = s.active_channel === 'im';
    const mode = s.approval_mode || 'default';
    const turns = s.approval_turns || (mode === 'auto' ? 5 : 1);
    const queue = D.queue;

    if (isLocked) {
      return `<div class="composer-wrap">
        <div class="composer is-locked">
          <textarea class="composer-ta" placeholder="IM has control — take over above to send from Web." disabled></textarea>
        </div>
      </div>`;
    }

    // Single send/stop slot — same position, swaps role
    const sendOrStop = isJob
      ? `<button class="composer-act primary danger" title="Stop job" onclick="App.stopJob('${s.id}')">${ICO.stop}</button>`
      : `<button class="composer-act primary" title="Send (↵)">${ICO.send}</button>`;

    const tokPct = s.job ? Math.min(100, (s.job.tokens / 200000) * 100) : 14;
    const tokLabel = s.job ? `${(s.job.tokens/1000).toFixed(1)}k` : '28.4k';

    return `<div class="composer-wrap">
      ${renderQueue(queue)}
      <div class="composer">
        <textarea class="composer-ta" rows="1" placeholder="${isJob ? 'Send to job…' : 'Message…'}" oninput="App.composerInput(event)"></textarea>
        <div class="composer-bar">
          <button class="composer-opt" title="Model & thinking" onclick="App.openModelPicker(event,'${s.id}')">
            <span class="cmp-model">${esc(s.model||'gpt-5-codex')}</span>
            <span class="cmp-think" title="Thinking effort: ${esc(s.thinking||'medium')}">${thinkingDot(s.thinking||'medium')}</span>
            ${ICO.caret}
          </button>
          <div class="composer-mode" title="Approval mode">
            <button class="cmode-item ${mode==='default'?'active':''}" data-mode="default" onclick="App.setMode('${s.id}','default')">Default</button>
            <button class="cmode-item ${mode==='auto'?'active':''}"    data-mode="auto"    onclick="App.setMode('${s.id}','auto')">Auto</button>
          </div>
          ${mode==='auto' ? `<div class="turns-stepper" title="Job turn limit (>1 = Job mode)">
            <span class="ts-lbl">turns</span>
            <button class="ts-btn" onclick="App.adjTurns('${s.id}',-1)" title="Decrease">−</button>
            <span class="ts-val">${turns}</span>
            <button class="ts-btn" onclick="App.adjTurns('${s.id}',+1)" title="Increase">+</button>
          </div>` : ''}
          <span class="spacer"></span>
          <button class="composer-act" title="Slash commands ( / )" onclick="App.openSlash(event,'${s.id}')"><span class="composer-act-glyph">/</span></button>
          <button class="composer-act" title="Attach file">${ICO.attach}</button>
          <button class="composer-act" id="voice-btn" title="Hold to record" onmousedown="App.voiceStart()" onmouseup="App.voiceEnd()" onmouseleave="App.voiceEnd()">${ICO.mic}</button>
          ${sendOrStop}
        </div>
      </div>
      <div class="tok-strip">
        <span class="tok-strip-lbl">Context</span>
        <span class="tok-strip-val"><b>${tokLabel}</b> / 200k</span>
        <div class="tok-bar" title="Compact at 90% · ${(200 - (s.job?s.job.tokens/1000:28.4)).toFixed(1)}k until auto-compact">
          <div class="tok-bar-fill ${tokPct>=85?'warn':''} ${tokPct>=95?'danger':''}" style="width:${tokPct}%;"></div>
          <div class="tok-bar-mark" style="left:90%;" title="auto-compact threshold"></div>
        </div>
        <span class="tok-compact-hint">${tokPct>=85?'compact soon':'compact 90%'}</span>
        <span class="spacer"></span>
        <button class="btn ghost xs" onclick="App.openSessionMenu(event,'${s.id}')" title="Session menu">⋯</button>
      </div>
    </div>`;
  }

  function renderQueue(q) {
    if (!q.length) return '';
    return `<div class="queue-drawer">
      <div class="qd-head">
        <span class="qd-title">queued <span class="qd-count">${q.length}</span></span>
        <span class="qd-sub">sent serially after current turn</span>
        <div class="qd-actions">
          <button class="btn ghost xs" onclick="App.toast('Sending queue now')">Send now</button>
          <button class="btn ghost xs" onclick="App.toast('Queue cleared')">Clear</button>
        </div>
      </div>
      <div class="qd-body">
        ${q.map((m,i)=>`<div class="qd-item">
          <span class="qd-idx">${i+1}</span>
          <span class="qd-text">${esc(m.text)}</span>
          <span class="qd-item-act">
            <button class="btn ghost" title="Move up">${ICO.up}</button>
            <button class="btn ghost" title="Move down">${ICO.down}</button>
            <button class="btn ghost" title="Edit">${ICO.edit}</button>
            <button class="btn ghost" title="Remove">${ICO.close}</button>
          </span>
        </div>`).join('')}
      </div>
    </div>`;
  }

  // ============================================================
  //  CODING view
  // ============================================================
  function renderCoding(sessionId = 's1') {
    const s = D.sessions.find(x => x.id === sessionId) || D.sessions[0];
    const ws = D.workspaces.find(w => w.id === s.ws);
    const events = D.transcript[s.id] || [];

    const rail = renderSessionRail(s.id);

    // Transcript body
    let transcriptBody = events.map(renderEvent).join('');

    // If session needs approval, append ticker
    if (s.status === 'pending') {
      transcriptBody += `<div class="msg">
        <div class="msg-av ${s.exec}">${s.exec==='codex'?'c':'a'}</div>
        <div class="msg-body">
          <div class="msg-meta"><span class="msg-author ${s.exec}">${s.exec==='codex'?'Codex':'Claude'}</span></div>
          <div class="msg-text">
            <span class="ticker"><span class="dots"><span></span><span></span><span></span></span>Waiting on your approval above…</span>
          </div>
        </div>
      </div>`;
    }
    // If running a job with a trailing command still running, add a running ticker too
    if (s.job && s.status === 'running') {
      transcriptBody += `<div class="msg">
        <div class="msg-av ${s.exec}">${s.exec==='codex'?'c':'a'}</div>
        <div class="msg-body">
          <div class="msg-meta"><span class="msg-author ${s.exec}">${s.exec==='codex'?'Codex':'Claude'}</span></div>
          <div class="msg-text">
            <span class="ticker"><span class="dots"><span></span><span></span><span></span></span>Committing changes…</span>
          </div>
        </div>
      </div>`;
    }

    const main = `<div class="main">
      <div class="main-head">
        <div class="main-head-l">
          <span class="main-title">${esc(s.title)}</span>
          <button class="btn ghost sm icon" title="Rename">${ICO.edit}</button>
          ${pill(s.status)}
        </div>
        <div class="main-head-r">
          <button class="btn ghost sm icon" title="Toggle inspector" onclick="App.togglePreview()">${ICO.split}</button>
        </div>
      </div>

      ${renderJobBar(s)}
      ${renderTakeoverBanner(s)}

      <div class="transcript-wrap">
        <div class="transcript">
          ${transcriptBody}
        </div>
      </div>

      ${renderComposer(s)}
    </div>`;

    const preview = renderInspector(s);

    return `<div class="view">${rail}${main}${preview}</div>`;
  }

  // ============================================================
  //  Inspector (preview pane) — single file at a time, or empty
  // ============================================================
  function renderInspector(s) {
    const hasFile = App && App.state && App.state.inspectorFile;
    const isOpen = !!(App && App.state && App.state.previewOpen);
    const cls = `preview ${isOpen ? 'open' : ''}`;
    if (!hasFile) {
      return `<div class="${cls}" id="preview">
        <div class="preview-head">
          <div><div class="preview-path">Inspector</div></div>
          <div style="display:flex;gap:4px;">
            <button class="btn ghost sm icon" onclick="App.togglePreview()">${ICO.close}</button>
          </div>
        </div>
        <div class="inspector-empty">
          <div class="empty-ico">${ICO.read}</div>
          <div>Click a file path in the transcript to open it here.</div>
          <div class="empty-kbd">or press <kbd class="kc">⌘P</kbd> to browse</div>
        </div>
      </div>`;
    }

    // Show auth.ts as the example (mirrors previous preview)
    return `<div class="${cls}" id="preview">
      <div class="preview-head">
        <div>
          <div class="preview-path"><span>src/routes/</span><span class="hi">auth.ts</span></div>
          <div class="preview-hunks">2 hunks · <span style="color:var(--ok);">+6</span> <span style="color:var(--danger);">−1</span></div>
        </div>
        <div style="display:flex;gap:4px;">
          <button class="btn ghost sm icon" onclick="App.togglePreview()">${ICO.close}</button>
        </div>
      </div>
      <div class="preview-body">
        <div class="hunk-bar">
          <span class="hunk-range">@@ lines 22–30</span>
        </div>
        ${codeBlock(22, [
          ['import { verifyToken } from \'../middleware/auth.js\';', false],
          ['', false],
          ['import { OAuth2Client } from \'google-auth-library\';', true],
          ['', true],
          ['const oauth = new OAuth2Client(', true],
          ['  process.env.GOOGLE_CLIENT_ID,', true],
          ['  process.env.GOOGLE_REDIRECT_URI', true],
          [');', true],
          ['', false],
          ['export async function registerAuthRoutes(app) {', false],
          ['  app.post(\'/api/auth/login\', async (req, res) => {', false],
          ['    const { token } = req.body;', false],
        ])}
      </div>
    </div>`;
  }

  function codeBlock(startLine, rows) {
    return rows.map((r,i)=>{
      const [text, isAdd] = r;
      const n = startLine + i;
      return `<div class="code-ln ${isAdd?'add':''}"><span class="code-num">${n}</span><span class="code-txt">${esc(text)}</span></div>`;
    }).join('');
  }

  // Expose shared helpers for other-views.js
  window.V = { ICO, esc, pill, codeBlock, diff, renderSessionRail, thinkingDot };

  window.Views = window.Views || {};
  window.Views.coding = renderCoding;
})();
