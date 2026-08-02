// ============================================================
// Icons + fixture data for the Gian redesign prototype.
// ============================================================

const Icon = ({ d, size = 16, stroke = 1.6, className = '' }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
       strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className}>
    {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
  </svg>
);

const I = {
  paneLeft:   "M3 5h18v14H3z M9 5v14",
  paneRight:  "M3 5h18v14H3z M15 5v14",
  paneCenter: "M3 5h18v14H3z M9 5v14 M15 5v14",
  chevR:      "M9 18l6-6-6-6",
  caretDown:  "M6 9l6 6 6-6",
  search:     "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3",
  group:      "M3 7h18 M6 12h12 M9 17h6",
  filter:     "M4 5h16l-6 8v6l-4-2v-4z",
  plus:       "M12 5v14 M5 12h14",
  inbox:      "M3 13l3-8h12l3 8 M3 13v6h18v-6 M3 13h5l1 3h6l1-3h5",
  folder:     "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  diff:       "M9 4v12 M9 4l-3 3 M9 4l3 3 M15 20V8 M15 20l3-3 M15 20l-3-3",
  gear:       "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19 12a7 7 0 0 0-.2-1.6l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2.8-1.6L13.2 2H10.8l-.4 2.7a7 7 0 0 0-2.8 1.6L5.2 5.4l-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .6.1 1.1.2 1.6l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2.8 1.6l.4 2.7h2.4l.4-2.7a7 7 0 0 0 2.8-1.6l2.4.9 2-3.4-2-1.6c.1-.5.2-1 .2-1.6z",
  send:       "M5 12l14-7-5 17-3-7z",
  attach:     "M21 11l-9 9a5 5 0 0 1-7-7l9-9a3 3 0 0 1 4 4l-9 9a1 1 0 0 1-1-1l8-8",
  x:          "M5 5l14 14 M5 19L19 5",
  kebabV:     "M12 5.01v-.02 M12 12.01v-.02 M12 19.01v-.02",
  copy:       "M9 9h10v10H9z M5 15V5h10",
  file:       "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5",
  terminal:   "M5 7l5 5-5 5 M12 19h8",
  refresh:    "M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5",
  github:     "M9 19c-4.5 1.5-4.5-2.5-6-3 m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6 0C6.7 2.8 5.6 3.1 5.6 3.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
  check:      "M5 12l5 5L20 7",
  eye:        "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  trash:      "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  warning:    "M12 2L1 22h22z M12 9v6 M12 18v.01",
  shield:     "M12 2l9 4v6c0 5-3.5 9-9 10-5.5-1-9-5-9-10V6z",
  ext:        "M14 4h6v6 M20 4l-9 9 M20 14v6H4V4h6",
  pin:        "M12 3l5 5-2 2-3 6-3-3-5 5 5-5-3-3 6-3 2-2z",
  openNew:    "M14 4h6v6 M20 4l-9 9 M19 13v7H4V5h7",
  code:       "M8 17l-5-5 5-5 M16 7l5 5-5 5 M14 4l-4 16",
  edit:       "M4 20h4l10-10-4-4L4 16z M14 6l4 4",
  chat:       "M21 12c0 4.4-4 8-9 8-1.2 0-2.3-.2-3.4-.6L3 21l1.5-4.4A7.8 7.8 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z",
  bot:        "M9 12h.01 M15 12h.01 M8 7h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z M12 4v3 M5 12h1 M18 12h1 M9 16h6",
  branchPlus: "M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M6 7v10 M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 8c0 4-6 3-6 8 M15 14h6 M18 11v6",
  info:       "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8v.01 M11 12h1v5h1",
  grid:       "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  eyeOff:     "M17.94 17.94A10 10 0 0 1 12 20c-6 0-10-8-10-8a18 18 0 0 1 5-5.94 M9.9 4.24A9 9 0 0 1 12 4c6 0 10 8 10 8a18 18 0 0 1-2.16 3.19 M1 1l22 22 M9.88 9.88a3 3 0 1 0 4.24 4.24",
  arrowUp:    "M12 19V5 M6 11l6-6 6 6",
  arrowDown:  "M12 5v14 M6 13l6 6 6-6",
};

const GianMark = ({ size = 18 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
    <path d="M3 6h18 M3 12h18 M3 18h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="20" cy="18" r="1.6" fill="currentColor" />
  </svg>
);

const BranchIcon = ({ size = 11 }) => (
  <svg className="branch-ico" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
       strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="4" cy="3.5" r="1.6" />
    <circle cx="4" cy="12.5" r="1.6" />
    <circle cx="12" cy="6" r="1.6" />
    <path d="M4 5v6 M4 11c0-3 8-2 8-4.5" />
  </svg>
);

// ============================================================
// Fixture data
// ============================================================

const SESSIONS = [
  // needs you
  { id: 's-proxy',  title: 'Wire reverse proxy', branch: 'feat/proxy', exec: 'claude', status: 'wait', age: '3m',  ws: 'gian', flag: 'reply' },
  { id: 's-ci',     title: 'Pin pnpm version in CI', branch: 'ci/lockstep', exec: 'codex',  status: 'err',  age: '1h',  ws: 'gian' },
  // today
  { id: 's-auth',   title: 'Fix OAuth callback redirect', branch: 'feat/auth-flow', exec: 'claude', status: 'run',  age: 'now', ws: 'gian' },
  { id: 's-settings', title: 'Refactor settings panel', branch: 'ui/settings',   exec: 'claude', status: 'done', age: '2h',  ws: 'gian' },
  { id: 's-ws',     title: 'WebSocket reconnect backoff', branch: 'fix/ws-backoff', exec: 'codex',  status: 'done', age: '4h',  ws: 'gian' },
  { id: 's-migr',   title: 'Add SQLite migrations runner', branch: 'db/migrations', exec: 'claude', status: 'done', age: '6h',  ws: 'gian' },
  // week
  { id: 's-spaces', title: 'Spaces config inspector tweaks', branch: 'ui/spaces',  exec: 'claude', status: 'done', age: 'Mon', ws: 'gian' },
  { id: 's-disc',   title: 'Discord bot wiring',  branch: 'bots/discord', exec: 'codex',  status: 'done', age: 'Mon', ws: 'gian' },
  { id: 's-runner', title: 'Move host runner to systemd', branch: 'ops/runner', exec: 'claude', status: 'done', age: 'Sun', ws: 'gian' },
  // earlier
  { id: 's-i18n',   title: 'i18n zh-CN strings pass',     branch: 'i18n/zh',     exec: 'claude', status: 'done', age: 'May 8', ws: 'gian' },
  { id: 's-md',     title: 'Wire CLAUDE.md inspector',    branch: 'ui/claudemd', exec: 'codex',  status: 'done', age: 'May 6', ws: 'gian' },
  { id: 's-rvc1',   title: 'Investigate rvc dev script', branch: 'main',        exec: 'codex',  status: 'done', age: 'May 4', ws: 'rvc' },
  { id: 's-rvc2',   title: 'Port API client to fetch',   branch: 'refactor/api', exec: 'claude',status: 'done', age: 'May 3', ws: 'rvc' },
];

function groupSessions(items, by) {
  const buckets = [];
  const push = (label, arr, extra = {}) => arr.length && buckets.push({ label, items: arr, ...extra });
  if (by === 'time') {
    const needs = items.filter(s => s.flag || s.status === 'err' || s.status === 'wait');
    const today  = items.filter(s => !needs.includes(s) && ['now', '2h', '4h', '6h', '3m', '1h'].includes(s.age));
    const week   = items.filter(s => !needs.includes(s) && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(s.age));
    const earlier = items.filter(s => !needs.includes(s) && !today.includes(s) && !week.includes(s));
    push('Needs you', needs, { needs: true });
    push('Today', today);
    push('This week', week);
    push('Earlier', earlier);
  } else if (by === 'status') {
    push('Running',  items.filter(s => s.status === 'run'));
    push('Waiting',  items.filter(s => s.status === 'wait'));
    push('Errored',  items.filter(s => s.status === 'err'));
    push('Done',     items.filter(s => s.status === 'done'));
  } else if (by === 'workspace') {
    const by = {};
    items.forEach(s => { (by[s.ws] = by[s.ws] || []).push(s); });
    Object.keys(by).forEach(ws => push(ws, by[ws]));
  }
  return buckets;
}

const WORKSPACES = [
  { id: 'gian', name: 'gian', path: '~/Coding/gian', sessions: 12, repoRemote: 'git@github.com:gian-dev/gian.git', defaultBranch: 'main', lastCommit: { sha: 'e2a4f19', msg: 'feat(spaces): inspect CLAUDE.md inline', age: '4h ago', author: 'ruoyu' } },
  { id: 'rvc',  name: 'remote-vibe-coding', path: '~/Coding/rvc', sessions: 5 },
  { id: 'notion', name: 'notion-clone-demo', path: '~/Coding/notion-clone', sessions: 0 },
];

const WORKTREES_GIAN = [
  { branch: 'main', isMain: true, claudeLines: null, state: 'clean', session: null },
  { branch: 'feat/auth-flow', claudeLines: 47, state: 'dirty', count: 8, session: 'Fix OAuth callback redirect' },
  { branch: 'feat/proxy', claudeLines: 47, state: 'dirty', count: 2, session: 'Wire reverse proxy' },
  { branch: 'ui/settings', claudeLines: 47, state: 'clean', session: 'Refactor settings panel' },
  { branch: 'ci/lockstep', claudeLines: null, state: 'dirty', count: 3, session: 'Pin pnpm version in CI' },
];

const BOTS = [
  { id: 'gian-dev',   name: 'gian-dev',   platform: 'discord', workspace: 'gian',  connected: true,  appId: '1148927316082212864', tokenTail: 'OQ8', createdAt: 'Apr 22' },
  { id: 'gian-slack', name: 'gian-slack', platform: 'slack',   workspace: 'gian',  connected: true,  createdAt: 'Apr 25' },
  { id: 'rvc-dev',    name: 'rvc-dev-bot', platform: 'discord', workspace: 'rvc',   connected: false, createdAt: 'May 1' },
  { id: 'nc',         name: 'notion-clone', platform: 'slack',  workspace: null,    connected: false, createdAt: 'May 6' },
];

const FILE_TREE = {
  n: 'gian', kind: 'folder', open: true, children: [
    { n: '.claude', kind: 'folder' },
    { n: '.pnpm-store', kind: 'folder', dim: true },
    { n: 'design', kind: 'folder' },
    { n: 'doc', kind: 'folder', open: true, children: [
      { n: 'PRD-v2.md', leaf: 'md' },
      { n: 'architecture.md', leaf: 'md' },
      { n: 'data-model.md', leaf: 'md' },
      { n: 'runtime-modes', kind: 'folder' },
    ] },
    { n: 'e2e', kind: 'folder', open: true, children: [
      { n: 'auth', kind: 'folder', open: true, children: [
        { n: 'oauth.spec.ts', leaf: 'ts', active: true },
      ] },
    ] },
    { n: 'packages', kind: 'folder', open: true, children: [
      { n: 'host', kind: 'folder' },
      { n: 'proxies', kind: 'folder' },
      { n: 'shared', kind: 'folder' },
      { n: 'web', kind: 'folder' },
    ] },
    { n: 'scripts', kind: 'folder' },
    { n: 'AGENTS.md', leaf: 'md' },
    { n: 'CLAUDE.md', leaf: 'md', active: true },
    { n: 'package.json', leaf: 'json' },
    { n: 'tsconfig.json', leaf: 'json' },
  ],
};

const CHANGES = [
  { sig: 'mod', dir: 'packages/host/src/auth/',  name: 'oauth.ts',         add: 8,  del: 3, active: true },
  { sig: 'mod', dir: 'packages/shared/src/',     name: 'cookies.ts',       add: 2,  del: 1 },
  { sig: 'add', dir: 'e2e/auth/',                name: 'oauth.spec.ts',    add: 64, del: 0 },
  { sig: 'mod', dir: 'packages/web/src/views/',  name: 'CodingView.tsx',   add: 4,  del: 2 },
  { sig: 'del', dir: 'packages/host/legacy/',    name: 'auth-shim.ts',     add: 0,  del: 41 },
];

const CLAUDE_MD = [
  '# Gian — CLAUDE notes',
  '',
  '## Dev server ports',
  '',
  '- Host (Hono API + WebSocket): **8990**',
  '- Web (Vite dev server): **5190**',
  '',
  '**Do NOT use the `remote-vibe-coding` (rvc) host or web dev ports.**',
  'Gian must stay off them so both projects can run side-by-side.',
  '',
  '## Proxy packages (vendored in-tree)',
  '',
  'The two upstream proxies are vendored under `packages/proxies/`:',
  '',
  '- **`packages/proxies/cc-proxy`** (Claude Code): one process per session',
  '- **`packages/proxies/codex-proxy`** (Codex CLI): same shape',
  '',
  '## Tests',
  '',
  '- `pnpm test` runs Vitest across all packages',
  '- `pnpm test:e2e` runs Playwright suites under `e2e/`',
  '',
  '## House style',
  '',
  '- All colors via `oklch()` tokens — no hex except in fixtures',
  '- Minimum 24px text in slide decks, 12pt in print',
  '- Mobile hit targets ≥ 44px',
];

// ============================================================
// Tasks mode fixture data (added 2026-05-26)
// ============================================================

const TASKS = [
  {
    id: 't-auth',
    name: 'End-to-end login & session resume',
    description: 'Wire up OAuth + worktree subdomains + session persistence so users can restart and jump back to where they were.',
    status: 'open',
    createdAt: 'May 20',
    updatedAt: '2 min ago',
  },
  {
    id: 't-bots',
    name: 'Connect Discord / Slack bots to sessions',
    description: 'IM platforms enter the site → route to the right workspace sessions; read-only first.',
    status: 'open',
    createdAt: 'May 22',
    updatedAt: 'Today 11:04',
  },
  {
    id: 't-migr',
    name: 'SQLite migration system landed',
    description: 'Merged; kept around for revisiting trade-offs and outputs.',
    status: 'done',
    createdAt: 'May 10',
    updatedAt: 'May 18',
  },
];

const SUBTASKS = [
  // t-auth — 4 subtasks (mix of states)
  { id: 'st-auth-1', taskId: 't-auth', name: 'Fix OAuth callback cross-subdomain cookie', workspaceId: 'gian',
    executor: 'claude', runtimeMode: 'structured', status: 'active',
    summary: 'state cookie is written on .gian.local subdomain; root callback cannot read it — make the reader walk up cookie domains per browser rules.',
    createdAt: 'Yesterday 14:12' },
  { id: 'st-auth-2', taskId: 't-auth', name: 'WebSocket reconnect backoff strategy', workspaceId: 'gian',
    executor: 'codex', runtimeMode: 'structured', status: 'done',
    summary: 'Switched to jittered exponential backoff, max 30s. Merged to main.',
    outcome: '+62 / −18, 3 tests pass; fix/ws-backoff merged.',
    createdAt: 'May 22' },
  { id: 'st-auth-3', taskId: 't-auth', name: 'Persist session state to SQLite', workspaceId: 'gian',
    executor: 'claude', runtimeMode: 'structured', status: 'draft',
    summary: 'Draft; waiting on the OAuth fix to merge before kicking off.',
    createdAt: 'Today 10:30' },
  { id: 'st-auth-4', taskId: 't-auth', name: 'Explore: localStorage fallback approach', workspaceId: 'gian',
    executor: 'codex', runtimeMode: 'tty', status: 'abandoned',
    summary: 'Tried a browser-side fallback; concluded it is not needed — server-side cookie covers it.',
    outcome: 'Abandoned. Rationale captured in manager/notes.md.',
    createdAt: 'May 23' },
  { id: 'st-auth-5', taskId: 't-auth', name: 'Verify with e2e regression suite', workspaceId: 'gian',
    executor: 'codex', runtimeMode: 'structured', status: 'error',
    summary: 'CI run failed during e2e/auth/oauth.spec.ts — 2 of 7 cases timed out.',
    createdAt: 'Today 12:30' },

  // t-bots — 2 subtasks
  { id: 'st-bots-1', taskId: 't-bots', name: 'Discord bot connection + command routing', workspaceId: 'gian',
    executor: 'claude', runtimeMode: 'structured', status: 'active',
    summary: 'Wire bot token / app id into the platform package, route /ask to the matching workspace.',
    createdAt: 'Today 09:45' },

  // t-migr — 1 done subtask
  { id: 'st-migr-1', taskId: 't-migr', name: 'Add SQLite migrations runner', workspaceId: 'gian',
    executor: 'claude', runtimeMode: 'structured', status: 'done',
    summary: 'Built on better-sqlite3 + a small custom runner; migrations sorted by filename timestamp.',
    outcome: 'Merged to main; 12 new migration files added.',
    createdAt: 'May 12' },
];

// Manager chat transcripts keyed by taskId.
// Each entry is one of:
//   { kind: 'user', text }                        — user message
//   { kind: 'manager', text, time }              — manager prose
//   { kind: 'tool_call', verb, subject, meta, args? }  — manager tool call
//   { kind: 'tool_result', for, text }            — tool result echoed back
//   { kind: 'proposal_anchor', proposalId }       — placeholder; ApprovalCard renders here
const MANAGER_MESSAGES = {
  't-auth': [
    { kind: 'user', text: 'Did that OAuth subtask we worked on last time finish? What was the outcome?' },
    { kind: 'manager', time: '14:32',
      text: 'Let me check the final result of "Fix OAuth callback cross-subdomain cookie".' },
    { kind: 'tool_call', verb: 'read_subtask_outcome', subject: 'st-auth-1',
      meta: 'manager tool', args: { subtask_id: 'st-auth-1' } },
    { kind: 'tool_result', for: 'st-auth-1',
      text: 'status: active · latest commit: change readState() to walk up cookie domains. Still waiting on the e2e regression run.' },
    { kind: 'manager', time: '14:32',
      text: "That subtask **isn't wrapped up yet**: the change landed on feat/auth-flow, but the regression suite is still running. Want to wait for the result before deciding the next step?" },
    { kind: 'user', text: "Don't wait. Next I want to land session-state persistence — please draft a new subtask." },
    { kind: 'manager', time: '14:34',
      text: 'Sounds good. I recommend reusing the existing gian workspace + Claude (sonnet-4.5) in structured mode, since this touches the existing persistence modules under packages/host. Here are the parameters I propose — I will only create it after you confirm:' },
    { kind: 'proposal_anchor', proposalId: 'pp-auth-3' },
  ],
  't-bots': [
    { kind: 'user', text: 'How is the Discord bot piece going?' },
    { kind: 'manager', time: '11:02',
      text: 'Subtask "Discord bot connection + command routing" is currently active; last activity was 30 minutes ago. Want me to open its details?' },
  ],
  't-migr': [
    { kind: 'user', text: 'Do I still need to look at this Task?' },
    { kind: 'manager', time: 'May 18',
      text: "Everything has been merged. I'm only keeping it around in case you want to revisit the migrations runner trade-offs. Say the word and I'll archive it." },
  ],
};

// Pending create_subtask proposals — keyed by taskId. Pre-seeded for the demo.
const MANAGER_PROPOSALS = {
  't-auth': {
    id: 'pp-auth-3',
    taskId: 't-auth',
    workspaceId: 'gian',
    executor: 'claude',
    runtimeMode: 'structured',
    approvalMode: 'auto',
    initialPrompt: "Persist the current session's chat / event history to SQLite.\n\nFollow the pattern in packages/host/src/auth/oauth.ts for writing the state cookie — reuse the same migration infrastructure. Expected output: 1) new table + migration; 2) a host-side hook that flushes at turn end; 3) the web reads back the last N entries on cold start.\n\nDo a read-only pass over the existing structure first, then start editing.",
    proposedSubtaskName: 'Persist session state to SQLite',
    timeoutSec: 60,
  },
};

const OAUTH_TS = [
  ['1', "import { createCookie } from 'hono/cookie';", 'kw'],
  ['2', "import type { Context } from 'hono';", 'kw'],
  ['3', ''],
  ['4', "// State cookie — written by /authorize, read by /callback.", 'cm'],
  ['5', "export const STATE_COOKIE = 'gian.oauth.state';", ''],
  ['6', ''],
  ['7', "export function setState(c: Context, state: string) {", ''],
  ['8', "  c.header('Set-Cookie',", ''],
  ['9', "    `${STATE_COOKIE}=${state}; Path=/; Domain=.gian.local; HttpOnly`);", 'str'],
  ['10', '}'],
  ['11', ''],
  ['12', "export function readState(c: Context): string | null {", '', 'add'],
  ['13', "  // Walk up cookie domains so a state set on .gian.local from", 'cm', 'add'],
  ['14', "  // a subdomain is also visible at the apex callback.", 'cm', 'add'],
  ['15', "  const direct = c.req.cookie(STATE_COOKIE);", '', 'add'],
  ['16', "  if (direct) return direct;", '', 'add'],
  ['17', "  return c.req.header('Cookie')", '', 'add'],
  ['18', "    ?.split(';').map(s => s.trim())", '', 'add'],
  ['19', "    .find(s => s.startsWith(`${STATE_COOKIE}=`))", '', 'add'],
  ['20', "    ?.split('=')[1] ?? null;", '', 'add'],
  ['21', '}'],
];

Object.assign(window, {
  Icon, I, GianMark, BranchIcon,
  SESSIONS, groupSessions,
  WORKSPACES, WORKTREES_GIAN,
  BOTS, FILE_TREE, CHANGES,
  CLAUDE_MD, OAUTH_TS,
  TASKS, SUBTASKS, MANAGER_MESSAGES, MANAGER_PROPOSALS,
});
