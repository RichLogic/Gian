export type Executor = 'codex' | 'claude' | 'kimi' | 'grok';

/** Kimi and Grok expose opaque ACP config options instead of Gian ApprovalMode. */
export function usesNativeExecutorConfig(executor: Executor): executor is 'kimi' | 'grok' {
  return executor === 'kimi' || executor === 'grok';
}

export type SessionType = 'coding' | 'subtask' | 'manager';

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
 * - `custom` — codex only. Restores the effective permissions loaded from
 *             config.toml when the native thread was attached.
 *
 * - `full-access` — codex only, persistent. (sandbox=danger-full-access,
 *             approval=never): unrestricted file + network, no approval cards.
 *             The codex composer surfaces this as "Full access"; it replaces the
 *             old per-turn one-shot bypass. Claude has no persistent equivalent
 *             (it keeps the plan/ask/auto segmented control + per-turn bypass),
 *             so a claude session never carries this value.
 *
 * IM channels only support `auto` (no UI for approvals — see im/router.ts).
 */
export type ApprovalMode = 'plan' | 'ask' | 'auto' | 'custom' | 'full-access';

export type NativeConfigValue = string | boolean | number | null;

export interface NativeConfigChoice {
  value: NativeConfigValue;
  label: string;
  description?: string;
  /** Optional ACP group label. Opaque to the host. */
  group?: string;
}

/**
 * Executor-owned session configuration. IDs and values are deliberately
 * opaque for persistence and round-trip. A product control may classify an
 * advertised option by category/id, but must always send the option's actual
 * id back to that executor.
 */
export interface NativeConfigOption {
  id: string;
  name: string;
  category?: string;
  description?: string;
  type: 'select' | 'boolean' | 'number' | 'text';
  currentValue: NativeConfigValue;
  choices?: NativeConfigChoice[];
  scope: 'session' | 'turn';
}

export interface ExecutorConfigState {
  schemaVersion: 1;
  values: Record<string, NativeConfigValue>;
}

export interface NativeApprovalOption {
  optionId: string;
  label: string;
  kind:
    | 'allow_once'
    | 'allow_always'
    | 'reject_once'
    | 'reject_always'
    | string;
}

export type ActiveChannel = 'web' | 'im';

export type SessionStatus = 'new' | 'running' | 'pending' | 'error' | 'done';

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

export interface Workspace {
  id: string;
  name: string;
  path: string;
  sort_order: number;
  hidden: 0 | 1;
  /** Pinned workspaces sort above the rest in the sidebar; `sort_order`
   *  still applies within each pinned/unpinned group. */
  pinned: 0 | 1;
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
  /** The Task this session belongs to (PRD-v3). A non-null task_id with
   *  type='subtask' is a Subtask; type='manager' is the Task's executor-backed
   *  manager. Null = a standalone ("scattered") session. */
  task_id: string | null;
  /** Owning workspace. NULL after the workspace was deleted (migration 045:
   *  ON DELETE SET NULL) — such sessions surface in the Sessions rail's
   *  无归属 (Unfiled) group and can no longer run turns. */
  workspace_id: string | null;
  executor: Executor;
  model: string | null;
  /** Legacy Claude/Codex policy. Kimi stores its exact ACP mode in
   *  `executor_config` and therefore keeps this NULL. */
  approval_mode: ApprovalMode | null;
  /** Exact executor-native values, persisted as JSON by the host. */
  executor_config: ExecutorConfigState;
  /** Dynamic choices reported by the live executor. Empty until attached. */
  native_config_options: NativeConfigOption[];
  /** Reasoning effort. Null = omit the executor-specific effort flag and let
   *  the underlying CLI use its own default. */
  thinking_effort: ThinkingEffort | null;
  /** Codex service tier — 'fast' when the composer's Fast toggle is on, else
   *  null. Rides every Codex turn (applies next turn); null for other
   *  executors. */
  service_tier: 'fast' | 'flex' | null;
  active_channel: ActiveChannel | null;
  status: SessionStatus;
  archived: 0 | 1;
  /** When the session was pinned (ISO-8601), or null when not pinned. Pinned
   *  sessions sort above the rest within their workspace group,
   *  most-recently-pinned first (pinned_at DESC). */
  pinned_at: string | null;
  /** Unread marker. Set to 1 when a background turn finishes (done/error) and
   *  cleared to 0 when the user opens/views the session. Also togglable by hand
   *  via the session menu ("Mark as unread"). Drives the sidebar unread dot.
   *  Read/unread changes do NOT bump `updated_at` — they must not reorder the
   *  list. */
  unread: 0 | 1;
  /** Absolute path to the live worktree dir. Null when not in worktree mode
   *  OR when the worktree was removed (merged/discarded). */
  worktree_path: string | null;
  /** Absolute path of a worktree the AGENT created itself mid-session via
   *  `git worktree add` (detected from command_execution events). Null until
   *  detected; never set on Gian-owned worktree sessions. View-only: the web
   *  auto-switches the diff/files view to it; execution stays put.
   *  Optional for compatibility with hosts predating migration 040. */
  detected_worktree_path?: string | null;
  /** Branch name, e.g. 'worktree/abc123' (or legacy 'gian/abc123' from
   *  earlier versions). Set on worktree creation; survives merge/discard
   *  for history. Null for regular sessions. */
  branch: string | null;
  /** Branch the worktree was forked from (e.g. 'main'). Null for regular. */
  base_branch: string | null;
  /** Terminal state of a worktree session. Null while active. */
  worktree_outcome: WorktreeOutcome | null;
  /** Native executor session id. Claude/Codex resume their on-disk history;
   *  Kimi loads or resumes the corresponding ACP session. */
  native_session_id: string | null;
  /** Tokens occupying the executor's current context window. Null after an
   *  invalidation (for example `/compact`) until the executor reports again.
   *  Optional for compatibility with hosts predating migration 034. */
  context_tokens_used?: number | null;
  /** Executor-reported context-window capacity, when available. */
  context_window_tokens?: number | null;
  /** Last context sample or invalidation time. Does not reorder the session. */
  context_usage_updated_at?: string | null;
  /** Cumulative conversation usage. Only display when
   *  `conversation_usage_complete` is 1. */
  conversation_input_tokens?: number | null;
  conversation_output_tokens?: number | null;
  conversation_cached_input_tokens?: number | null;
  conversation_total_tokens?: number | null;
  /** Whether cumulative fields cover the native conversation from its start. */
  conversation_usage_complete?: 0 | 1;
  /** Subtask-level summary (PRD-v3 P4). Written by the summarizer when a
   *  `type='subtask'` session completes, and user-editable thereafter. The
   *  per-Task Manager inlines it into its system prompt. Null until the
   *  summarizer runs (and for non-subtask sessions). */
  summary: string | null;
  /** User-set completion flag for a `type='subtask'` session, kept SEPARATE
   *  from `status` (the turn lifecycle). Null = not completed; an ISO string =
   *  the moment the user marked it complete. Set via `complete`, cleared via
   *  `reopen`. Finishing a turn never touches this (migration 027). */
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'open' | 'done' | 'archived';

/**
 * Lightweight container for "one thing the user is doing" (PRD-v3). A Task
 * groups multiple Subtasks (sessions) — possibly spread across workspaces.
 * It does NOT bind a workspace; workspace membership is decided by its Subtasks.
 */
export interface Task {
  id: string;
  name: string;
  description: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  /** When the task was pinned (ISO-8601), or null when not pinned. Pinned tasks
   *  sort above the rest, most-recently-pinned first (pinned_at DESC). */
  pinned_at: string | null;
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
  /** Executor-owned choices, used by Kimi ACP permission requests. */
  native_options?: NativeApprovalOption[];
}

export interface QueueEntry {
  id: string;
  session_id: string;
  text: string;
  sort_order: number;
  created_at: string;
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

/** Chat (transcript/composer) font family. 'system' is the built-in sans
 *  stack; the other ids map to the bundled Google fonts. */
export type ChatFontFamily = 'system' | 'manrope' | 'serif' | 'mono';

export const DEFAULT_CHAT_FONT_SIZE = 14;
export const MIN_CHAT_FONT_SIZE = 12;
export const MAX_CHAT_FONT_SIZE = 20;

/** CSS stacks behind each chat font choice. Mirrors the tokens.css font
 *  variables; 'system' is the default sans stack. */
export const CHAT_FONT_FAMILY_STACKS: Readonly<Record<ChatFontFamily, string>> = {
  system: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
  manrope: '"Manrope", ui-sans-serif, system-ui, sans-serif',
  serif: '"Instrument Serif", ui-serif, Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
};

/** App-level keyboard shortcuts the user can remap in Settings. Values are
 *  canonical combo strings: modifiers (`mod` = Cmd-or-Ctrl, `shift`, `alt`)
 *  joined with `+` before the key, e.g. "mod+shift+k", "mod+enter", "a". */
export type ShortcutAction =
  | 'commandPalette'
  | 'steerOrSendNow'
  | 'createClaudeChild'
  | 'createCodexChild'
  | 'markUnread'
  | 'approveOnce'
  | 'approveSession'
  | 'decline';

export type ShortcutMap = Partial<Record<ShortcutAction, string>>;

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'commandPalette',
  'steerOrSendNow',
  'createClaudeChild',
  'createCodexChild',
  'markUnread',
  'approveOnce',
  'approveSession',
  'decline',
];

export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutAction, string>> = {
  commandPalette: 'mod+shift+k',
  steerOrSendNow: 'mod+enter',
  createClaudeChild: 'mod+j',
  createCodexChild: 'mod+k',
  markUnread: 'mod+u',
  approveOnce: 'a',
  approveSession: 'shift+a',
  decline: 'd',
};

/** Canonical combo shape: 0-3 distinct modifiers then a single key. The key
 *  itself must not be a modifier name ("mod+shift" is not a combo). */
const SHORTCUT_COMBO_RE = /^(?:(mod|shift|alt)\+){0,3}(?!(?:mod|shift|alt)$)[a-z0-9]{1,16}$/;

export function isValidShortcutCombo(value: unknown): value is string {
  if (typeof value !== 'string' || !SHORTCUT_COMBO_RE.test(value)) return false;
  const parts = value.split('+');
  const modifiers = parts.slice(0, -1);
  return new Set(modifiers).size === modifiers.length;
}

/** Effective shortcut for an action: the user's override when valid, else
 *  the built-in default. */
export function resolveShortcuts(
  overrides: ShortcutMap | undefined,
): Record<ShortcutAction, string> {
  const resolved = { ...DEFAULT_SHORTCUTS } as Record<ShortcutAction, string>;
  if (!overrides) return resolved;
  for (const action of SHORTCUT_ACTIONS) {
    const combo = overrides[action];
    if (isValidShortcutCombo(combo)) resolved[action] = combo;
  }
  return resolved;
}

export type TerminalFontFamily =
  | 'jetbrains-mono'
  | 'system-mono'
  | 'sf-mono'
  | 'menlo';

export type TerminalCursorStyle = 'block' | 'bar' | 'underline';
export type TerminalStartDirectory = 'context' | 'home';
export type TerminalScrollbackLines = 1_000 | 5_000 | 10_000 | 50_000;

export interface TerminalPreferences {
  font_family: TerminalFontFamily;
  font_size: number;
  line_height: number;
  cursor_style: TerminalCursorStyle;
  cursor_blink: boolean;
  scrollback_lines: TerminalScrollbackLines;
  /** Empty means the Host's effective $SHELL. */
  shell: string;
  start_directory: TerminalStartDirectory;
}

export const DEFAULT_TERMINAL_PREFERENCES: Readonly<TerminalPreferences> = {
  font_family: 'jetbrains-mono',
  font_size: 13,
  line_height: 1.2,
  cursor_style: 'block',
  cursor_blink: true,
  scrollback_lines: 5_000,
  shell: '',
  start_directory: 'context',
};

export interface TerminalShellOption {
  path: string;
  label: string;
}

export interface TerminalOptions {
  system_shell: string;
  shells: TerminalShellOption[];
}

export const THEME_DEFAULT_ACCENT: Record<'light' | 'warm' | 'dark', Accent> = {
  light: 'azure',
  warm: 'ember',
  dark: 'plum',
};

export interface SystemConfig {
  host: string;
  port: number;
  workspace_root: string;
  theme: 'light' | 'warm' | 'dark';
  accent: Accent;
  /** @deprecated Fixed to `cozy`; retained for older API clients. */
  density: 'compact' | 'cozy' | 'roomy';
  /** @deprecated Fixed to `md`; retained for older API clients. */
  font_scale_chrome: FontScale;
  /** @deprecated Superseded by `chat_font_size`; retained for older API clients. */
  font_scale_chat: FontScale;
  /** @deprecated Fixed to `md`; retained for older API clients. */
  font_scale_code: FontScale;
  /** Chat font size in px (transcript + composer). */
  chat_font_size: number;
  chat_font_family: ChatFontFamily;
  /** User keyboard-shortcut overrides; absent actions use DEFAULT_SHORTCUTS. */
  shortcuts?: ShortcutMap;
  terminal: TerminalPreferences;
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
}
