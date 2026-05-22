import type { Executor } from './model.js';

export type ProxySessionStatus =
  | 'idle'
  | 'running'
  | 'needs-approval'
  | 'stale'
  | 'closed'
  | 'error';

export type CcEffortLevel = 'low' | 'medium' | 'high' | 'max';

export type CodexThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CcModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultEffort: CcEffortLevel;
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
  /** Built-in CLI commands + user-level custom commands from
   *  ~/.claude/commands/. Project-level commands are fetched per-session
   *  via slash.list with cwd. */
  slashCommands: SlashCommand[];
}

export interface CodexCapabilities {
  protocolVersion: string;
  models: CodexModelCapabilities[];
  /** Built-in CLI commands + user-level custom commands from
   *  ~/.codex/prompts/. */
  slashCommands: SlashCommand[];
}

export interface SlashListResult {
  /** Built-in + user-level + project-level (when cwd was given). */
  commands: SlashCommand[];
}

export type ProxyCapabilities = CcCapabilities | CodexCapabilities;

export interface InitializeResult {
  mode: 'spawn';
  protocolVersion: string;
  methods: string[];
}

export type InputItem = TextInputItem | LocalImageInputItem | SkillInputItem;

export interface TextInputItem {
  type: 'text';
  text: string;
}

export interface LocalImageInputItem {
  type: 'localImage';
  path: string;
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
  model: string | null;
  status: ProxySessionStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface ProxyTurn {
  id: string;
  status: ProxySessionStatus | 'completed' | 'failed';
}

export interface JsonRpcRequest<P = unknown> {
  id: number | string;
  method: string;
  params?: P;
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

export type ProxyErrorCode =
  | 'INVALID_REQUEST'
  | 'SESSION_NOT_FOUND'
  | 'APPROVAL_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'SESSION_BUSY'
  | 'SESSION_CLOSED'
  | 'SESSION_STALE'
  | 'SESSION_ERROR'
  | 'PROCESS_SPAWN_FAILED'
  | 'INTERNAL_ERROR';

export const PROXY_METHODS = [
  'initialize',
  'capabilities.list',
  'slash.list',
  'session.create',
  'session.get',
  'turn.start',
  'turn.interrupt',
  'approval.respond',
  'session.snapshot',
  'session.close',
  'shutdown',
] as const;

export type ProxyMethod = (typeof PROXY_METHODS)[number];

export const PROXY_NOTIFICATION_METHODS = [
  // Turn lifecycle (both proxies)
  'turn.started',
  'turn.completed',
  'turn.failed',
  // Approval routing (both proxies)
  'approval.requested',
  'approval.resolved',
  // Diagnostic stream (both proxies, dropped at host edge)
  'debug',
  // cc-proxy event stream
  'output.text',
  'tool.use',
  'auto.classifier_denied',
  'auto.circuit_breaker',
  'session.rotated',
  // codex-proxy event stream
  'output.text.delta',
  'output.command.delta',
  'output.reasoning.delta',
  'output.plan.delta',
  'output.plan.final',
  'diff.updated',
  // Stats and runtime (both proxies)
  'token_usage.updated',
  'runtime.error',
] as const;

export type ProxyNotificationMethod = (typeof PROXY_NOTIFICATION_METHODS)[number];

export interface ProxyExecutorBinding {
  executor: Executor;
  binPath: string;
  dataDir: string;
}
