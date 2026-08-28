export type ProxySessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_interaction'
  | 'stale'
  | 'closed'
  | 'error';

export type CcEffortLevel = string;

/** Codex owns this vocabulary and may add levels without a Gian release. */
export type CodexThinkingLevel = string;

export interface ProxyModeCapabilities {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface CcModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultEffort: CcEffortLevel | null;
  supportedEfforts: CcEffortLevel[];
}

export interface CodexModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultThinking: CodexThinkingLevel | null;
  supportedThinking: CodexThinkingLevel[];
}

export type SlashCommandSource = 'builtin' | 'project' | 'user';

export interface SlashCommandArgHint {
  /** What kind of argument the user should provide. UI can use this to
   *  drive autocomplete (e.g. 'model' → suggest from models list). */
  kind: 'free' | 'model' | 'path' | 'agent' | 'enum';
  /** For 'enum' kind, the allowed values. */
  values?: string[];
  /** Human-friendly placeholder for the input ("model name", "path", etc.) */
  placeholder?: string;
}

export interface SlashCommand {
  /** Command name including the leading '/'. e.g. '/clear', '/code-review' */
  name: string;
  /** One-line description shown in the popover. */
  description: string;
  /** Where this command came from. */
  source: SlashCommandSource;
  /** Absolute path of the source file for custom commands. UI uses this
   *  for the "from .claude/commands/foo.md" hover hint. */
  filePath?: string;
  /** Hints for arg autocomplete. Empty array = command takes no args. */
  argHints?: SlashCommandArgHint[];
}

export interface CcCapabilities {
  protocolVersion: string;
  models: CcModelCapabilities[];
  /** Session-mode vocabulary advertised by cc-proxy. */
  modes?: ProxyModeCapabilities[];
  /** Built-in CLI commands + user-level custom commands from
   *  ~/.claude/commands/. Project-level commands are fetched per-session
   *  via slash.list with cwd. */
  slashCommands: SlashCommand[];
}

export interface CodexCapabilities {
  protocolVersion: string;
  models: CodexModelCapabilities[];
  /** Session-mode vocabulary advertised by codex-proxy. */
  modes?: ProxyModeCapabilities[];
  /** Built-in CLI commands + user-level custom commands from
   *  ~/.codex/prompts/. */
  slashCommands: SlashCommand[];
}

export interface KimiCapabilities {
  protocolVersion: string;
  /** Probed from ACP session configOptions. Thinking levels are per-model
   *  (`session/set_config_option` on `model` rewrites the thought-level
   *  select), so each model carries its own supportedThinking list. Empty
   *  when the agent advertises no model option, the probe failed (e.g. not
   *  logged in), or that model could not be resolved. */
  models: CodexModelCapabilities[];
  modes?: ProxyModeCapabilities[];
  slashCommands: [];
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  sessionCapabilities: {
    load: boolean;
    list: boolean;
    resume: boolean;
    close: boolean;
  };
}

export interface SlashListResult {
  /** Built-in + user-level + project-level (when cwd was given). */
  commands: SlashCommand[];
}

export type GrokCapabilities = KimiCapabilities;

export type ProxyCapabilities = CcCapabilities | CodexCapabilities | KimiCapabilities | GrokCapabilities;

export interface ProxyCatalog {
  catalogRevision: string;
  input: Array<{
    type: 'text' | 'localFile' | 'localImage' | 'skill';
    enabledWhen?: import('./model.js').ConfigCondition[];
  }>;
  configOptions: import('./model.js').ConfigOption[];
  specialCatalogs?: {
    model?: string;
    thinking?: string;
    fast?: string;
    approvalMode?: string;
  };
  actions?: import('./sidechat.js').CatalogActionDescriptor[];
  slashCommands: SlashCommand[];
}

export interface ResolvedProxyCatalog extends ProxyCatalog {
  resolvedDefaults: {
    sessionConfig: Record<string, import('./model.js').ConfigValue>;
    turnConfig: Record<string, import('./model.js').ConfigValue>;
  };
}

export interface InitializeResult {
  protocol: {
    name: 'gian.proxy';
    version: '2.0' | '2.1';
  };
  plugin: {
    id: string;
    name: string;
    version: string;
  };
  process: {
    scope: 'shared' | 'session';
  };
  capabilities: Record<string, unknown>;
}

export type InputItem = TextInputItem | LocalImageInputItem | LocalFileInputItem | SkillInputItem;

export interface TextInputItem {
  type: 'text';
  text: string;
}

export interface LocalImageInputItem {
  type: 'localImage';
  path: string;
  /** User-facing filename (e.g. `paste-1700000000000.png`). Optional —
   *  proxies treat this opaquely; host echoes it back in user_message
   *  events so the web can label the attachment chip. */
  name?: string;
  /** MIME type (e.g. `image/png`). Same rationale as `name`. */
  mime?: string;
  /** Original byte size, used only for transcript metadata. */
  size?: number;
}

/** A non-image file that the host has snapshotted into the session attachment
 *  store. Proxies translate this provider-neutral item into the executor's
 *  native file-reference shape. */
export interface LocalFileInputItem {
  type: 'localFile';
  path: string;
  name?: string;
  mime?: string;
  size?: number;
}

/** Per-attachment metadata echoed back in `user_message` event payloads.
 *  `url` is a GET-able path on the host (`/api/sessions/:id/attachments/:filename`)
 *  the web can drop straight into an `<img src>`. */
export interface MessageAttachment {
  name: string;
  mime: string;
  url: string;
  size?: number;
}

/**
 * Skill / slash invocation. Codex's app-server has first-class support
 * (`{type:'skill', name, path}` on `turn/start`); cc-proxy doesn't have a
 * native skill concept — when a skill is selected for cc, host translates it
 * to a text input (`/<name>`) before dispatch.
 */
export interface SkillInputItem {
  type: 'skill';
  name: string;
  path: string;
}

export interface ProxySession {
  id: string;
  cwd: string;
  state: ProxySessionStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  nativeSessionId?: string;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  id: number | string;
  result: R;
}

export interface JsonRpcErrorResponse {
  id: number | string;
  error: {
    code: string;
    message: string;
  };
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse;

export interface ProxyNotification<T = unknown> {
  method: string;
  params: {
    requestId?: number | string;
    sessionId: string;
    turnId?: string;
    data: T;
    rawRuntimeEvent?: {
      method: string;
      params?: unknown;
    };
  };
}

/** Canonical session-scoped usage payload emitted by executor proxies.
 * Current context is replaceable state; conversation usage is either an
 * executor-authoritative absolute value or one per-turn delta. */
export interface TokenUsageUpdate {
  context?: {
    used: number;
    window?: number;
  } | null;
  conversation?: {
    mode: 'absolute' | 'delta' | 'reset';
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
  reason?: 'compact_started' | 'session_reset';
}

export const PROXY_METHODS = [
  'initialize',
  'catalog.list',
  'catalog.resolve',
  'session.create',
  'session.get',
  'session.rename',
  'session.native.list',
  'session.native.delete',
  'session.replay',
  'sidechat.create',
  'sidechat.resume',
  'sidechat.close',
  'session.fork',
  'turn.start',
  'turn.interrupt',
  'turn.steer',
  'interaction.respond',
  'session.close',
  'shutdown',
] as const;

export const PROXY_NOTIFICATION_METHODS = [
  'turn.started',
  'input.recorded',
  'content.delta',
  'content.completed',
  'session.updated',
  'turn.completed',
  'turn.failed',
  'runtime.error',
  'activity.updated',
  'step.updated',
  'request.updated',
  'interaction.requested',
  'interaction.resolved',
  'plan.updated',
  'diff.updated',
  'usage.updated',
  'catalog.changed',
  'history.changed',
] as const;
