// ============================================================
// Mock data for Gian prototype — aligned with PRD v0.3
// ============================================================

window.GIAN_DATA = {
  // ---------- Runner (the local machine) ----------
  runner: {
    host: 'mbp-16.local',
    latency: 12,
    startedAgo: '4h',
    agents: 2,
    disk: '134 GB free',
    codexVersion: 'v1.0.4',
    ccVersion: 'v0.8.2',
    wsRoot: '~/Coding',
  },

  // ---------- Workspaces ----------
  workspaces: [
    { id: 'rvc', name: 'remote-vibe-coding', path: '~/Coding/remote-vibe-coding', sessions: 3, order: 0 },
    { id: 'cxp', name: 'codex-proxy',         path: '~/Coding/codex-proxy',         sessions: 2, order: 1 },
    { id: 'cc',  name: 'claude-code',         path: '~/Coding/claude-code',         sessions: 1, order: 2 },
    { id: 'chat', name: '__chat__',           path: '~/.config/gian/chat',          sessions: 2, order: 99, hidden: true },
  ],

  // ---------- Sessions ----------
  // status: new | running | pending | error | done   (archived is a boolean flag, not a status)
  // approval_mode: default | auto
  // active_channel: web | im
  sessions: [
    {
      id:'s1', title:'Implement OAuth flow', type:'coding',
      exec:'codex',  ws:'rvc',
      status:'pending', approval_mode:'default', active_channel:'web',
      files:3, age:'3m', group:'today',
      model:'gpt-5-codex', thinking:'medium',
    },
    {
      id:'s2', title:'Fix Discord bot reconnect', type:'coding',
      exec:'claude', ws:'rvc',
      status:'running', approval_mode:'auto', active_channel:'web',
      job:{ turn:4, limit:20, ops:47, tokens:128500 },
      files:7, age:'12m', group:'today',
      model:'sonnet-4.6', thinking:'high',
    },
    {
      id:'s3', title:'Proxy auth refactor', type:'coding',
      exec:'codex',  ws:'cxp',
      status:'new', approval_mode:'auto', active_channel:'im',
      age:'2h', group:'today',
      model:'gpt-5-codex',
    },
    {
      id:'s4', title:'Add Slack integration', type:'coding',
      exec:'claude', ws:'rvc',
      status:'done', approval_mode:'auto', active_channel:'web',
      age:'1d', group:'yesterday', files:3,
      model:'sonnet-4.6',
    },
    {
      id:'s5', title:'Session streaming fix', type:'coding',
      exec:'codex',  ws:'cxp',
      status:'error', approval_mode:'default', active_channel:'web',
      lastError:'executor crashed · exit 139',
      age:'1d', group:'yesterday',
      model:'gpt-5-codex',
    },
    {
      id:'s6', title:'Add rate limiting', type:'coding',
      exec:'claude', ws:'cc',
      status:'done', approval_mode:'default', active_channel:'web',
      age:'3d', group:'earlier',
      model:'sonnet-4.6',
    },
  ],

  chats: [
    { id:'c1', title:'VMware port mirror',  age:'10m', group:'today',     model:'sonnet-4.6' },
    { id:'c2', title:'Shanghai weather',    age:'1h',  group:'today',     model:'gpt-5' },
    { id:'c3', title:'SSH tunnel recipes',  age:'1d',  group:'yesterday', model:'sonnet-4.6' },
  ],

  bots: [
    { id:'b1', label:'rvc-discord', platform:'discord', ws:'rvc', online:true,  lastMsg:'1m ago', behavior:'queue-approvals' },
    { id:'b2', label:'rvc-slack',   platform:'slack',   ws:'rvc', online:false, lastMsg:'3h ago', behavior:'read-only' },
  ],

  // Domain / reverse-proxy config (for Settings)
  network: {
    publicUrl: 'https://gian.example.com',
    proxyMode: 'cloudflare-tunnel',  // none | cloudflare-tunnel | tailscale-funnel | reverse-proxy
    cfTunnelId: 'a1b2c3d4-…-7e8f9',
    forceHttps: true,
  },

  i18n: { current: 'zh-CN', available: ['zh-CN','en'] },

  queue: [
    { id:'q1', text:'Also add session token refresh logic — auto-renew 5 min before expiry.' },
    { id:'q2', text:'Write unit tests for the callback endpoint.' },
  ],

  // ---------- File tree ----------
  fileTree: [
    { type:'folder', name:'src', open:true, children:[
      { type:'folder', name:'routes', open:true, children:[
        { type:'file', name:'auth.ts', active:true, flag:'mod' },
        { type:'file', name:'api.ts' },
      ]},
      { type:'folder', name:'middleware', children:[] },
      { type:'folder', name:'config', children:[
        { type:'file', name:'oauth.ts', flag:'add' },
      ]},
      { type:'file', name:'server.ts' },
    ]},
    { type:'file', name:'package.json', flag:'mod' },
    { type:'file', name:'tsconfig.json' },
    { type:'file', name:'README.md' },
  ],

  // ---------- Open approvals (Inbox) ----------
  // category: command | network | file_write_outside_ws | other
  approvals: [
    { id:'a1', session:'s1', category:'command',    title:'Run npm install',
      cmd:'npm install google-auth-library',
      reason:'Needed to import OAuth2Client in auth.ts' },
    { id:'a2', session:'s3', category:'file_write_outside_ws', title:'Write outside workspace',
      cmd:'~/.config/gian/runtime/cache.json',
      reason:'Cache file lives outside the project root; Codex needs to persist it.' },
    { id:'a3', session:'s2', category:'other', title:'Custom MCP tool',
      cmd:'mcp::shell.spawn(detached=true, env={…})',
      reason:'Requested by tool plugin `mcp-shell-plus` — not auto-classifiable.' },
  ],

  // ---------- Session permissions (Allow Session) ----------
  sessionGrants: [
    { session:'s1', category:'command', pattern:'git status', grantedAt:'14:21' },
    { session:'s1', category:'command', pattern:'npm test',    grantedAt:'14:28' },
  ],

  // ---------- Slash command palette (Gian + executor-native) ----------
  slashCommands: {
    gian: [
      { cmd:'/queue',       desc:'Push next message into the queue instead of sending now' },
      { cmd:'/job',         desc:'Switch this turn into Job Mode (multi-turn auto-continue)' },
      { cmd:'/stop',        desc:'Stop the current turn or job' },
      { cmd:'/reset',       desc:'Reset session — clear context window' },
      { cmd:'/grants',      desc:'Show / revoke session grants' },
      { cmd:'/switch',      desc:'Take over this session from IM' },
    ],
    codex: [
      { cmd:'/init',        desc:'Codex · seed AGENTS.md from current repo' },
      { cmd:'/compact',     desc:'Codex · compact transcript to free context' },
      { cmd:'/review',      desc:'Codex · review uncommitted diff' },
      { cmd:'/approvals',   desc:'Codex · list current per-session approvals' },
    ],
    claude: [
      { cmd:'/clear',       desc:'Claude · clear context window' },
      { cmd:'/compact',     desc:'Claude · summarize and compact context' },
      { cmd:'/cost',        desc:'Claude · show token + $ cost so far' },
      { cmd:'/model',       desc:'Claude · switch model mid-session' },
      { cmd:'/memory',      desc:'Claude · view / edit CLAUDE.md' },
    ],
  },

  // ============================================================
  // TRANSCRIPT for s1 — exercises all 12 event types from PRD §一
  // ============================================================
  transcript: {
    s1: [
      // Turn 1 header
      { type:'turn_start', turn:1, time:'14:32', label:'Opened with Codex' },

      { type:'user_message', time:'14:32', text:
        'Help me implement OAuth 2.0 login flow with Google provider. Use the existing auth middleware and add a callback endpoint.' },

      { type:'assistant_text', time:'14:32', exec:'codex',
        text:"I'll implement the OAuth 2.0 flow. Checking existing auth middleware first." },

      { type:'file_read', time:'14:32', path:'src/middleware/auth.ts', range:'1–68', lines:68, status:'success' },

      { type:'file_search', time:'14:32', tool:'Grep', pattern:'registerAuthRoutes', matches:3, status:'success',
        results:[
          { path:'src/routes/auth.ts', line:12, snippet:'export async function registerAuthRoutes(app) {' },
          { path:'src/server.ts',      line:24, snippet:'registerAuthRoutes(app);' },
          { path:'tests/auth.test.ts', line: 8, snippet:'await registerAuthRoutes(app);' },
        ] },

      { type:'assistant_text', time:'14:33', exec:'codex',
        text:'Adding Google OAuth config and a callback handler — one new file, two edits.' },

      { type:'file_change', time:'14:33', status:'success',
        files:[
          { op:'add', path:'src/config/oauth.ts', add:14, del:0 },
          { op:'mod', path:'src/routes/auth.ts',  add:6,  del:1,
            diff:[
              ['22', 'import { verifyToken } from \'../middleware/auth.js\';', null],
              ['23', '', null],
              ['24', 'import { OAuth2Client } from \'google-auth-library\';', 'add'],
              ['25', '', 'add'],
              ['26', 'const oauth = new OAuth2Client(', 'add'],
              ['27', '  process.env.GOOGLE_CLIENT_ID,', 'add'],
              ['28', '  process.env.GOOGLE_REDIRECT_URI', 'add'],
              [']);', ');', 'add'],
            ]},
          { op:'mod', path:'package.json',        add:1,  del:0 },
        ]},

      // Web search (separate event)
      { type:'web_search', time:'14:33', query:'google-auth-library v10 breaking changes', status:'success' },

      // Resolved approval — inline card, green "Approved"
      { type:'approval_resolved', time:'14:33', category:'command',
        title:'Run shell command', cmd:'git status',
        decision:'approved-session', resolved_by:'web' },

      // Pending approval — the big blocker
      { type:'approval_requested', time:'14:34', id:'a1', category:'command',
        title:'Run shell command',
        cmd:'npm install google-auth-library',
        reason:'Needed to import OAuth2Client in auth.ts.' },

      // Activity ticker is rendered based on session.status=pending
    ],

    // s4 — finished Job, shows job_completion terminal card + slash + system_notice
    s4: [
      { type:'turn_start', turn:1, time:'09:14', label:'Started Job · Slack integration' },
      { type:'user_message', time:'09:14', text:'Add Slack integration alongside Discord. Mirror the same behavior.' },
      { type:'slash_command', time:'09:14', source:'claude', cmd:'/compact',
        result:'Compacted 47 messages → summary; 18.2k tokens reclaimed.' },
      { type:'system_notice', time:'09:15', source:'claude', kind:'context-edit',
        text:'CLAUDE.md updated — added "Always run `npm run lint` before committing".' },
      { type:'assistant_text', time:'09:15', exec:'claude',
        text:'Mirroring the Discord bot scaffold. Will reuse the bot-token field and add a Slack-only event handler.' },
      { type:'attachment', time:'09:15', source:'user', items:[
        { name:'slack-event-payload.json', kind:'json', size:'4.1 KB' },
        { name:'screenshot-channel-perm.png', kind:'image', size:'182 KB' },
      ]},
      { type:'file_change', time:'09:18', status:'success',
        files:[
          { op:'add', path:'src/bots/slack/client.ts',     add:96, del:0 },
          { op:'add', path:'src/bots/slack/handlers.ts',   add:54, del:0 },
          { op:'mod', path:'src/server.ts',                add:6,  del:0 },
        ]},
      { type:'command_execution', time:'09:19', cmd:'npm run lint', status:'success', exit:0, duration:'2.4s', output:'✓ no warnings' },
      { type:'turn_complete', turn:1, time:'09:19' },
      { type:'job_completion', time:'09:19', outcome:'success', turns:6,
        title:'Slack integration shipped',
        summary:'Added Slack client + handlers, wired into server.ts, all tests + lint pass. Branch `feat/slack-integration` ready to push.',
        stats:{ files:3, add:156, del:0, ops:24, tokens:42100, duration:'5m 12s' },
      },
    ],

    // ============================================================
    // Transcript for s2 — Job Mode, Claude Code, thinking + agent_spawn
    // ============================================================
    s2: [
      { type:'turn_start', turn:1, time:'10:02', label:'Started Job' },

      { type:'user_message', time:'10:02', text:
        'The Discord bot keeps dropping every few hours. Investigate, fix, and ship a PR.' },

      { type:'thinking', time:'10:02', summary:'Planning investigation approach',
        text:'The user wants me to investigate a reconnection issue. I should start by reading the bot initialization code and looking for heartbeat or reconnection logic. Then I can check logs if available.' },

      { type:'assistant_text', time:'10:02', exec:'claude',
        text:"I'll start by mapping the bot lifecycle. Spawning a subagent to audit logs in parallel." },

      { type:'agent_spawn', time:'10:02', task:'Audit last 7 days of Discord bot logs, extract disconnect patterns', status:'done',
        summary:'Found 14 disconnects; 11 match pattern "websocket 4009 session timeout" in the last week.' },

      { type:'file_read', time:'10:03', path:'src/bots/discord/client.ts', range:'1–156', lines:156, status:'success' },
      { type:'file_read', time:'10:03', path:'src/bots/discord/heartbeat.ts', range:'1–48', lines:48, status:'success' },

      { type:'turn_complete', turn:1, time:'10:04' },

      { type:'turn_start', turn:2, time:'10:04', label:'Auto-continued (Job Mode)' },

      { type:'assistant_text', time:'10:04', exec:'claude',
        text:"Identified the issue: heartbeat timer doesn't reset after a resume. Writing the fix now." },

      { type:'file_change', time:'10:05', status:'success',
        files:[
          { op:'mod', path:'src/bots/discord/heartbeat.ts', add:8, del:3 },
          { op:'mod', path:'src/bots/discord/client.ts',    add:4, del:2 },
          { op:'add', path:'tests/bots/discord/heartbeat.test.ts', add:34, del:0 },
        ]},

      { type:'command_execution', time:'10:06', cmd:'npm test -- tests/bots/discord', status:'success',
        exit:0, duration:'8.2s',
        output:
`> gian@0.3.0 test
> vitest run tests/bots/discord

 ✓ tests/bots/discord/heartbeat.test.ts (6)
   ✓ resets timer on RESUMED
   ✓ reconnects after 4009 close code
   ✓ throttles reconnect attempts
   ✓ fires onReady after resume
   ✓ cleans up on close
   ✓ logs session_id on resume

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  8.21s` },

      { type:'turn_complete', turn:2, time:'10:06' },

      { type:'turn_start', turn:3, time:'10:06', label:'Auto-continued' },

      { type:'command_execution', time:'10:07', cmd:'git checkout -b fix/discord-reconnect', status:'success', exit:0, output:'Switched to a new branch \'fix/discord-reconnect\'' },
      { type:'command_execution', time:'10:07', cmd:'git commit -am "fix(discord): reset heartbeat after RESUMED"', status:'running', exit:null,
        output:'[fix/discord-reconnect a8c4f2] fix(discord): reset heartbeat after RESUMED\n 3 files changed, 46 insertions(+), 5 deletions(-)' },
    ],

    // s5 — error state, shows session_error event
    s5: [
      { type:'turn_start', turn:1, time:'11:40', label:'Opened with Codex' },
      { type:'user_message', time:'11:40', text:'Fix the streaming endpoint — it drops connections after 30 seconds of inactivity.' },
      { type:'assistant_text', time:'11:40', exec:'codex',
        text:'Looking at the streaming handler to find the timeout logic.' },
      { type:'file_read', time:'11:40', path:'src/stream/handler.ts', range:'1–92', lines:92, status:'success' },
      { type:'session_error', time:'11:41', title:'Executor crashed', desc:'codex exited with code 139 (SIGSEGV). This usually indicates a memory issue. Check executor logs for details.' },
    ],
  },
};
