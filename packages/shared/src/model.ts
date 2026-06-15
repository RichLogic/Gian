export type Executor = 'codex' | 'claude';

export type SessionType = 'coding';

/**
 * Mode that decides who (and how) approves agent actions.
 *
 * - `plan`  — read-only exploration; agent may inspect but not edit/execute.
 *             cc maps to `--permission-mode plan` (with native ExitPlanMode
 *             ceremony); codex maps to (sandbox=read-only, mode=plan,
 *             approval=on-request).
 * - `ask`   — every risky action is relayed to the user for approval. cc maps
 *             to `--permission-mode default`; codex maps to (sandbox=workspace-write,
 *             approval=on-request, reviewer=user).
 * - `auto`  — agent runs without interrupting the user. cc maps to
 *             `--permission-mode auto` (Anthropic classifier filters); codex
 *             maps to (sandbox=workspace-write, approval=on-request,
 *             reviewer=auto_review).
 *
 * IM channels only support `auto` (no UI for approvals — see im/router.ts).
 */
export type ApprovalMode = 'plan' | 'ask' | 'auto';

export type ActiveChannel = 'web' | 'im';

/**
 * Which CLI runtime drives a session right now.
 *
 * - `structured` — `claude -p --output-format stream-json` (cc) or `codex
 *                  proto` (codex). Today's default — emits structured events
 *                  the host renders as transcript cards. Counts against the
 *                  Agent SDK monthly credit on/after 2026-06-15.
 * - `tty`        — interactive CLI inside a PTY, surfaced to the user as
 *                  xterm.js. Continues to count against the Claude/Codex
 *                  subscription quota. Lifecycle events arrive via HTTP
 *                  hooks (cc) or session JSONL tail + fs.watch (codex);
 *                  cards are not rendered.
 *
 * Mode is session-scoped and mutable — the user toggles in the header
 * (precondition: session idle). New sessions default to `structured`.
 */
export type RuntimeMode = 'structured' | 'tty';

export type SessionStatus = 'new' | 'running' | 'pending' | 'error' | 'done';

export type TurnStatus = 'running' | 'completed' | 'error' | 'stopped';

export type RiskLevel = 'low' | 'medium' | 'high';

export type ApprovalCategory =
  | 'command'
  | 'network'
  | 'file_write_outside_ws'
  | 'exit_plan_mode'
  | 'question'
  | 'other';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'approved-session'
  | 'auto-approved'
  | 'declined';

export type ApprovalResolvedBy = 'web' | 'im' | 'auto';

export type IMPlatform = 'discord' | 'slack';

export type BotMode = 'read-only' | 'full-control';

export type BotStatus = 'disabled' | 'connecting' | 'connected' | 'error';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  sort_order: number;
  hidden: 0 | 1;
  created_at: string;
  updated_at: string;
}

export type WorktreeOutcome = 'merged' | 'discarded';

/** Effort/thinking level selected by the user. Kept open-ended because
 *  Claude Code reports its supported `--effort` values at runtime. */
export type ThinkingEffort = string;

export interface Session {
  id: string;
  name: string | null;
  type: SessionType;
  workspace_id: string;
  executor: Executor;
  model: string | null;
  approval_mode: ApprovalMode;
  /** Reasoning effort. Null = omit the executor-specific effort flag and let
   *  the underlying CLI use its own default. */
  thinking_effort: ThinkingEffort | null;
  turns: number;
  active_channel: ActiveChannel | null;
  status: SessionStatus;
  archived: 0 | 1;
  /** Unread marker. Set to 1 when a background turn finishes (done/error) and
   *  cleared to 0 when the user opens/views the session. Also togglable by hand
   *  via the session menu ("Mark as unread"). Drives the sidebar unread dot.
   *  Read/unread changes do NOT bump `updated_at` — they must not reorder the
   *  list. */
  unread: 0 | 1;
  /** Absolute path to the live worktree dir. Null when not in worktree mode
   *  OR when the worktree was removed (merged/discarded). */
  worktree_path: string | null;
  /** Branch name, e.g. 'worktree/abc123' (or legacy 'gian/abc123' from
   *  earlier versions). Set on worktree creation; survives merge/discard
   *  for history. Null for regular sessions. */
  branch: string | null;
  /** Branch the worktree was forked from (e.g. 'main'). Null for regular. */
  base_branch: string | null;
  /** Terminal state of a worktree session. Null while active. */
  worktree_outcome: WorktreeOutcome | null;
  /** When this Gian session was created by adopting an existing native
   *  cc / codex session, the native session UUID. The proxy then uses it
   *  as the resume id so the on-disk JSONL stays the source of truth. */
  native_session_id: string | null;
  /** Active CLI runtime — `structured` (today's `claude -p` / `codex proto`
   *  path) or `tty` (interactive CLI in a PTY). Mutable at runtime via the
   *  session header toggle. */
  runtime_mode: RuntimeMode;
  created_at: string;
  updated_at: string;
}

export interface Turn {
  id: string;
  session_id: string;
  turn_number: number;
  status: TurnStatus;
  summary: string | null;
  ops: number;
  tokens: number;
  duration_ms: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface EventRecord {
  id: string;
  session_id: string;
  turn_id: string;
  call_id: string;
  type: string;
  data: string;
  created_at: string;
}

export interface Approval {
  id: string;
  session_id: string;
  turn_id: string;
  category: ApprovalCategory;
  title: string;
  command: string;
  reason: string | null;
  status: ApprovalStatus;
  resolved_by: ApprovalResolvedBy | null;
  resolved_at: string | null;
  created_at: string;
}

export interface QueueEntry {
  id: string;
  session_id: string;
  text: string;
  sort_order: number;
  created_at: string;
}

export interface DiscordBotExtra {
  token: string;
  application_id: string;
  bot_user_id?: string;
  direct_channel_id?: string;
}

export interface SlackBotExtra {
  bot_token: string;
  app_token: string;
  config_token: string;
  team_id: string;
  bot_user_id?: string;
  direct_channel_id?: string;
  command_prefix: string;
}

export type BotExtra = DiscordBotExtra | SlackBotExtra;

export interface Bot {
  id: string;
  label: string;
  platform: IMPlatform;
  workspace_id: string | null;
  mode: BotMode;
  allowed_user_id: string | null;
  enabled: 0 | 1;
  status: BotStatus;
  last_error: string | null;
  last_connected_at: string | null;
  extra: BotExtra;
  created_at: string;
  updated_at: string;
}

export interface ExternalEditor {
  /** Stable handle (uuid) used by the open API. */
  id: string;
  /** Display label, e.g. "VS Code". */
  name: string;
  /** Executable name (PATH-resolved) or absolute path. */
  command: string;
  /** argv template. Tokens equal to "{path}" are replaced with the absolute
   *  file path; if no token matches, the path is appended at the end. */
  args: string[];
}

/** Broad file categories the "Open" action routes by. Each maps to a target
 *  the user can pick in Settings (an installed app, a new browser tab, or
 *  reveal in Finder). */
export type OpenFileCategory = 'code' | 'web' | 'images' | 'pdf' | 'other';

/** Per-category Open target. Value is an app name (e.g. "Visual Studio Code"),
 *  the sentinel `@newtab` (open in a browser tab via /raw), `@finder` (reveal),
 *  or '' / absent to use the built-in default for that category. */
export type OpenAppPrefs = Partial<Record<OpenFileCategory, string>>;

export type Accent =
  | 'rose' | 'ember' | 'citron' | 'moss'
  | 'teal' | 'azure' | 'ink' | 'plum';

export type FontScale = 'sm' | 'md' | 'lg' | 'xl';

export const THEME_DEFAULT_ACCENT: Record<'light' | 'warm' | 'dark', Accent> = {
  light: 'azure',
  warm: 'ember',
  dark: 'plum',
};

export interface SystemConfig {
  host: string;
  port: number;
  workspace_root: string;
  public_url: string;
  tunnel_mode: 'none' | 'cloudflare-tunnel' | 'tailscale-funnel' | 'reverse-proxy';
  tunnel_id: string;
  force_https: boolean;
  theme: 'light' | 'warm' | 'dark';
  accent: Accent;
  density: 'compact' | 'cozy' | 'roomy';
  font_scale_chrome: FontScale;
  font_scale_chat: FontScale;
  font_scale_code: FontScale;
  locale: 'zh-CN' | 'en';
  /** Default model for new claude (cc) sessions. Empty = use proxy default. */
  default_claude_model: string;
  /** Default reasoning effort for new claude sessions. Empty = use model default. */
  default_claude_effort: string;
  /** Default model for new codex sessions. Empty = use proxy default. */
  default_codex_model: string;
  /** Default reasoning effort for new codex sessions. Empty = use model default. */
  default_codex_effort: string;
  auth_username: string;
  /** Programs surfaced in the Files view's "Open with…" menu. */
  external_editors: ExternalEditor[];
  /** Per-category default app for the "Open" button (see OpenAppPrefs).
   *  Optional so older configs / test fixtures stay valid; loadConfig always
   *  returns at least `{}`. */
  open_apps?: OpenAppPrefs;
  /** Claude chat main-area surface: 'structured' (`claude -p` / Agent SDK) or
   *  'tty' (interactive Claude). The non-selected surface is not shown as a
   *  tab. Optional so older configs / fixtures stay valid; loadConfig defaults
   *  to 'tty'. */
  claude_chat_surface?: 'structured' | 'tty';
  /** Whether Claude sessions show a CLI tab alongside the chat surface.
   *  loadConfig defaults to true (matches the 'tty' surface default). */
  claude_chat_cli?: boolean;
  /** Whether Codex sessions show a CLI tab alongside the chat surface.
   *  loadConfig defaults to false. */
  codex_chat_cli?: boolean;
}
