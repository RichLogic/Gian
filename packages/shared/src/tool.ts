import type {
  ApprovalCategory,
  ApprovalMode,
  ConfigOption,
  ConfigValue,
  Executor,
  NativeApprovalOption,
  Session,
  Task,
  Workspace,
} from './model.js';
import { isProxyPluginId } from './plugin-id.js';
import type { UserAgent } from './agents.js';
import type { ComposerDocument, MessageContextItem } from './context.js';
import type { InputItem } from './proxy.js';
import { isScheduleTrigger } from './schedule.js';
import type { GianBrowserTabSnapshot } from './browser.js';

export const GIAN_TOOL_METHODS = [
  'catalog.get_create_options',
  'task.list',
  'task.get',
  'task.create',
  'task.update',
  'session.list',
  'session.get',
  'session.read',
  'session.create',
  'session.update',
  'session.assign_task',
  'session.set_subtask_state',
  'session.archive',
  'session.send',
  'session.cancel_delivery',
  'session.wait',
  'session.stop',
  'queue.update',
  'queue.remove',
  'queue.clear',
  'queue.send_now',
  'worktree.create_and_bind',
  'browser.tabs',
  'browser.open',
  'browser.snapshot',
  'browser.click',
  'browser.fill',
  'browser.press',
  'browser.wait',
  'browser.evaluate',
  'browser.screenshot',
  'browser.go_back',
  'browser.reload',
  'browser.close',
  'interaction.list',
  'interaction.respond',
  'schedule.preview',
  'schedule.create',
  'schedule.list',
  'schedule.get',
  'schedule.update',
  'schedule.pause',
  'schedule.resume',
  'schedule.run_now',
  'schedule.archive',
] as const;

export type GianToolMethod = (typeof GIAN_TOOL_METHODS)[number];

export const GIAN_TOOL_MUTATION_METHODS = [
  'task.create',
  'task.update',
  'session.create',
  'session.update',
  'session.assign_task',
  'session.set_subtask_state',
  'session.archive',
  'session.send',
  'session.cancel_delivery',
  'session.stop',
  'queue.update',
  'queue.remove',
  'queue.clear',
  'queue.send_now',
  'worktree.create_and_bind',
  'browser.open',
  'browser.click',
  'browser.fill',
  'browser.press',
  'browser.go_back',
  'browser.reload',
  'browser.close',
  'interaction.respond',
  'schedule.create',
  'schedule.update',
  'schedule.pause',
  'schedule.resume',
  'schedule.run_now',
  'schedule.archive',
] as const satisfies readonly GianToolMethod[];

export type GianToolMutationMethod = (typeof GIAN_TOOL_MUTATION_METHODS)[number];

export const GIAN_TOOL_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'SESSION_BUSY',
  'SESSION_CLOSED',
  'TASK_NOT_OPEN',
  'TASK_HAS_ACTIVE_SUBTASKS',
  'EXECUTOR_NOT_READY',
  'AGENT_NOT_READY',
  'AGENT_DELETED',
  'CAPABILITY_NOT_SUPPORTED',
  'INTERACTION_ALREADY_RESOLVED',
  'INVALID_INTERACTION_RESPONSE',
  'DELIVERY_NOT_CANCELABLE',
  'IDEMPOTENCY_CONFLICT',
  'PRECONDITION_FAILED',
  'UNKNOWN_OUTCOME',
  'COMMAND_EXPIRED',
  'SCHEDULE_CREATE_REJECTED',
  'TIMEOUT',
  'INTERNAL_ERROR',
] as const;

export type GianToolErrorCode = (typeof GIAN_TOOL_ERROR_CODES)[number];

export interface GianToolCall<P = Record<string, unknown>> {
  request_id: string;
  caller_id: string;
  method: GianToolMethod;
  params: P;
  idempotency_key?: string;
}

export interface GianToolError {
  code: GianToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface GianToolResult<T = unknown> {
  ok: boolean;
  request_id: string;
  data?: T;
  error?: GianToolError;
}

export interface GianToolSessionConfigInput {
  model?: string | null;
  thinking_effort?: string | null;
  approval_mode?: ApprovalMode | null;
  service_tier?: 'fast' | null;
  session?: Record<string, ConfigValue>;
  turn?: Record<string, ConfigValue>;
}

export interface GianToolResolvedSessionConfig {
  agent_id: string | null;
  agent_name: string | null;
  proxy: Executor;
  model: string | null;
  thinking_effort: string | null;
  approval_mode: ApprovalMode | null;
  service_tier: 'fast' | 'flex' | null;
  session: Record<string, ConfigValue>;
  turn: Record<string, ConfigValue>;
}

export interface GianToolCatalogAgent {
  id: string;
  name: string;
  proxy: UserAgent['proxy'];
  ready: boolean;
  defaults: {
    model: string | null;
    thinking: string | null;
    mode: string | null;
    /** Agent defaults for role-less catalog options; `null` deletes a key
     *  when echoed back in a defaults patch. */
    option_defaults: Record<string, ConfigValue | null>;
  };
  models: Array<{
    id: string;
    label: string;
    is_default: boolean;
    supported_thinking: string[];
  }>;
  modes: Array<{ id: string; label: string; is_default: boolean }>;
  config_kind: 'gian' | 'executor-native';
  session_config: ConfigOption[];
  turn_config: ConfigOption[];
}

export type GianToolAgentSnapshot = Pick<UserAgent, 'id' | 'name' | 'proxy' | 'defaults'>;

export interface GianToolCreateOptions {
  workspaces: Array<Pick<Workspace, 'id' | 'name' | 'path'>>;
  agents: GianToolCatalogAgent[];
}

export interface GianToolMessage {
  role: 'user' | 'assistant';
  text: string;
  created_at?: string;
}

export interface GianToolTurn {
  id: string;
  turn_number: number;
  status: 'running' | 'completed' | 'error' | 'stopped';
  created_at: string;
  completed_at: string | null;
  config_snapshot?: GianToolResolvedSessionConfig;
  messages?: GianToolMessage[];
  interactions?: GianToolTurnInteraction[];
}

export interface GianToolTurnInteraction {
  id: string;
  kind: 'approval' | 'question' | 'exit_plan_mode' | 'native_choice';
  description: string;
  status: 'pending' | 'resolved';
  decision?: string;
}

export interface GianToolInteractionQuestion {
  id: string;
  prompt: string;
  multiple: boolean;
  input_type?: 'text' | 'multiline_text' | 'single_select' | 'multi_select' | 'boolean';
  options: Array<{ value: string; label: string; description?: string }>;
}

export interface GianToolInteraction {
  id: string;
  session_id: string;
  turn_id: string;
  kind: 'approval' | 'question' | 'exit_plan_mode' | 'native_choice';
  category: ApprovalCategory;
  risk: 'low' | 'medium' | 'high';
  description: string;
  subject?: string;
  questions?: GianToolInteractionQuestion[];
  native_options?: NativeApprovalOption[];
  /** Standard decisions only. Empty for native_choice; use native_options instead. */
  allowed_decisions: string[];
  created_at: string;
}

export interface GianToolDelivery {
  delivery_id: string;
  state: 'started' | 'queued' | 'steered' | 'completed' | 'error' | 'stopped' | 'cancelled' | 'unknown';
  session_id: string;
  turn_id?: string;
  turn_number?: number;
  queue_id?: string;
  config_snapshot?: GianToolResolvedSessionConfig;
}

export interface GianToolQueueEntry {
  id: string;
  session_id: string;
  text: string;
  items?: InputItem[];
  context_items?: MessageContextItem[];
  composer_document?: ComposerDocument;
  created_at: string;
  delivery_id?: string;
}

export interface GianToolQueueReplacement {
  queue: GianToolQueueEntry[];
  queue_revision: string;
}

export interface GianToolSendQueuedNowReceipt extends GianToolQueueReplacement {
  mode: 'noop' | 'started' | 'steered';
  affected: Array<{
    queue_id: string;
    delivery_id?: string;
    state: 'started' | 'steered';
    turn_id: string;
    turn_number: number;
  }>;
}

export interface GianToolMethodParams {
  'catalog.get_create_options': { refresh?: boolean };
  'task.list': { statuses?: Array<'open' | 'done' | 'archived'>; include_sessions?: boolean };
  'task.get': { task_id: string };
  'task.create': { name: string; description?: string | null };
  'task.update': {
    task_id: string;
    name?: string;
    description?: string | null;
    status?: 'open' | 'done' | 'archived';
    pinned?: boolean;
  };
  'session.list': {
    task_id?: string | null;
    workspace_id?: string | null;
    agent_id?: string | null;
    proxy?: Executor;
    status?: Array<'new' | 'running' | 'pending' | 'error' | 'done'>;
    archived?: 'active' | 'archived' | 'all';
    limit?: number;
  };
  'session.get': { session_id: string };
  'session.read': {
    session_id: string;
    before_turn?: number | null;
    turns?: number;
    view?: 'messages' | 'events';
  };
  'session.create': {
    workspace_id: string;
    task_id?: string;
    agent_id: string;
    name?: string;
    config?: GianToolSessionConfigInput;
  };
  'session.update': {
    session_id: string;
    name?: string;
    config?: GianToolSessionConfigInput;
    expected_session_revision?: string;
  };
  'session.assign_task': { session_id: string; task_id: string };
  'session.set_subtask_state': { session_id: string; state: 'completed' | 'open' };
  'session.archive': { session_id: string; archived: boolean };
  'session.send': {
    session_id: string;
    text: string;
    busy?: 'queue' | 'fail' | 'steer';
    items?: InputItem[];
    context_items?: MessageContextItem[];
    composer_document?: ComposerDocument;
  };
  'session.cancel_delivery': { delivery_id: string };
  'session.wait': {
    session_id: string;
    delivery_id?: string;
    until?: Array<'interaction' | 'turn_terminal'>;
    timeout_ms?: number;
  };
  'session.stop': { session_id: string; expected_session_revision?: string };
  'queue.update': {
    session_id: string;
    queue_id: string;
    text: string;
    expected_queue_revision?: string;
  };
  'queue.remove': { session_id: string; queue_id: string; expected_queue_revision?: string };
  'queue.clear': { session_id: string; expected_queue_revision?: string };
  'queue.send_now': { session_id: string; expected_queue_revision?: string };
  'worktree.create_and_bind': { branch: string; base_ref?: string };
  'browser.tabs': Record<string, never>;
  'browser.open': { url: string; tab_id?: string; activate?: boolean };
  'browser.snapshot': { tab_id: string; max_nodes?: number };
  'browser.click': { tab_id: string; snapshot_id: string; ref: string };
  'browser.fill': { tab_id: string; snapshot_id: string; ref: string; text: string };
  'browser.press': { tab_id: string; key: string; snapshot_id?: string; ref?: string };
  'browser.wait': {
    tab_id: string;
    condition?: 'load' | 'text';
    text?: string;
    timeout_ms?: number;
  };
  'browser.evaluate': { tab_id: string; expression: string };
  'browser.screenshot': { tab_id: string; max_width?: number };
  'browser.go_back': { tab_id: string };
  'browser.reload': { tab_id: string; ignore_cache?: boolean };
  'browser.close': { tab_id: string };
  'interaction.list': { session_id?: string };
  'interaction.respond': {
    session_id: string;
    interaction_id: string;
    expected_interaction_revision?: string;
    decision?:
      | 'allow_once'
      | 'allow_session'
      | 'decline'
      | 'accept_with_auto'
      | 'accept_with_ask'
      | 'keep_planning';
    answers?: Record<string, string | boolean | string[]>;
    native_option_id?: string;
  };
  'schedule.preview': {
    trigger: import('./schedule.js').ScheduleTrigger;
    timezone: string;
    after?: string;
    limit?: number;
  };
  'schedule.create': {
    name: string;
    prompt: string;
    trigger: import('./schedule.js').ScheduleTrigger;
    timezone: string;
    misfire_policy?: 'skip' | 'run_once';
    /** How long the Tool call waits for the user's decision (5 min default). */
    confirmation_timeout_ms?: number;
  };
  'schedule.list': {
    status?: Array<'active' | 'paused' | 'completed' | 'archived'>;
    limit?: number;
    cursor?: string;
    /** Host-internal: the access controller forces this onto the caller's
     *  own Session. Explicit values from actors are denied before here. */
    control_session_id?: string;
  };
  'schedule.get': { schedule_id: string; include_runs?: boolean };
  'schedule.update': {
    schedule_id: string;
    expected_revision: number;
    name?: string;
    prompt?: string;
    trigger?: import('./schedule.js').ScheduleTrigger;
    timezone?: string;
    misfire_policy?: 'skip' | 'run_once';
  };
  'schedule.pause': { schedule_id: string; expected_revision?: number };
  'schedule.resume': { schedule_id: string; expected_revision?: number };
  'schedule.run_now': { schedule_id: string };
  'schedule.archive': { schedule_id: string; expected_revision?: number };
}

export interface GianToolMethodData {
  'catalog.get_create_options': GianToolCreateOptions;
  'task.list': { tasks: Array<Task & { sessions?: Session[] }> };
  'task.get': { task: Task; sessions: Session[] };
  'task.create': { task: Task };
  'task.update': { task: Task; sessions: Session[] };
  'session.list': { sessions: Session[] };
  'session.get': Record<string, unknown>;
  'session.read': Record<string, unknown>;
  'session.create': {
    session: Session;
    agent: GianToolAgentSnapshot;
    resolved_config: GianToolResolvedSessionConfig;
  };
  'session.update': Record<string, unknown>;
  'session.assign_task': { session: Session };
  'session.set_subtask_state': { session: Session };
  'session.archive': { session: Session };
  'session.send': GianToolDelivery;
  'session.cancel_delivery': GianToolDelivery;
  'session.wait': Record<string, unknown>;
  'session.stop': { already_idle: boolean };
  'queue.update': { entry: GianToolQueueEntry } & GianToolQueueReplacement;
  'queue.remove': { removed: GianToolQueueEntry } & GianToolQueueReplacement;
  'queue.clear': { removed: GianToolQueueEntry[] } & GianToolQueueReplacement;
  'queue.send_now': GianToolSendQueuedNowReceipt;
  'worktree.create_and_bind': {
    session_id: string;
    workspace_id: string;
    working_tree_id: string;
    path: string;
    branch: string;
    base_ref: string;
    created: boolean;
  };
  'browser.tabs': { revision: number; tabs: GianBrowserTabSnapshot[] };
  'browser.open': { tab: GianBrowserTabSnapshot };
  'browser.snapshot': {
    tab_id: string;
    page_generation: number;
    snapshot_id: string;
    url: string;
    title: string;
    tree: string;
    truncated: boolean;
  };
  'browser.click': { tab_id: string; clicked: true };
  'browser.fill': { tab_id: string; filled: true };
  'browser.press': { tab_id: string; pressed: string };
  'browser.wait': { tab_id: string; condition: 'load' | 'text'; satisfied: true };
  'browser.evaluate': { tab_id: string; value: unknown };
  'browser.screenshot': {
    tab_id: string;
    mime_type: 'image/png';
    base64: string;
    width: number;
    height: number;
  };
  'browser.go_back': { tab: GianBrowserTabSnapshot };
  'browser.reload': { tab: GianBrowserTabSnapshot };
  'browser.close': { tab_id: string; closed: true };
  'interaction.list': { interactions: GianToolInteraction[] };
  'interaction.respond': { interaction_id: string; resolved: true };
  'schedule.preview': import('./schedule.js').SchedulePreviewResponse;
  'schedule.create': {
    schedule: import('./schedule.js').Schedule;
    confirmation_id: string;
  };
  'schedule.list': import('./schedule.js').ScheduleListResponse;
  'schedule.get': {
    schedule: import('./schedule.js').Schedule;
    runs?: import('./schedule.js').ScheduleRun[];
  };
  'schedule.update': { schedule: import('./schedule.js').Schedule };
  'schedule.pause': { schedule: import('./schedule.js').Schedule };
  'schedule.resume': { schedule: import('./schedule.js').Schedule };
  'schedule.run_now': { run: import('./schedule.js').ScheduleRun };
  'schedule.archive': { schedule: import('./schedule.js').Schedule };
}

const METHODS = new Set<string>(GIAN_TOOL_METHODS);
const MUTATIONS = new Set<string>(GIAN_TOOL_MUTATION_METHODS);
const ERROR_CODES = new Set<string>(GIAN_TOOL_ERROR_CODES);
const TASK_STATUSES = new Set(['open', 'done', 'archived']);
const SESSION_STATUSES = new Set(['new', 'running', 'pending', 'error', 'done']);
const APPROVAL_MODES = new Set(['plan', 'ask', 'auto', 'custom', 'full-access']);
const DECISIONS = new Set([
  'allow_once',
  'allow_session',
  'decline',
  'accept_with_auto',
  'accept_with_ask',
  'keep_planning',
]);

function invalid(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unknown.length > 0) invalid(`${label} has unknown field: ${unknown[0]}`);
}

function string(value: unknown, label: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.trim().length === 0)) {
    invalid(`${label} must be ${nonEmpty ? 'a non-empty ' : ''}string`);
  }
  return value as string;
}

function optionalString(value: unknown, label: string, nullable = false): void {
  if (value === undefined || (nullable && value === null)) return;
  string(value, label, false);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') invalid(`${label} must be a boolean`);
}

function finiteInteger(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(`${label} must be an integer from ${min} to ${max}`);
  }
}

function enumValue(value: unknown, values: Set<string>, label: string): void {
  if (typeof value !== 'string' || !values.has(value)) invalid(`${label} is invalid`);
}

function enumArray(value: unknown, values: Set<string>, label: string): void {
  if (!Array.isArray(value) || value.length === 0) invalid(`${label} must be a non-empty array`);
  for (const item of value) enumValue(item, values, `${label} item`);
}

function configValues(value: unknown, label: string): void {
  if (value === undefined) return;
  const input = record(value, label);
  for (const [key, item] of Object.entries(input)) {
    string(key, `${label} key`);
    if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && typeof item !== 'number') {
      invalid(`${label}.${key} has an unsupported value`);
    }
    if (typeof item === 'number' && !Number.isFinite(item)) invalid(`${label}.${key} must be finite`);
  }
}

function sessionConfig(value: unknown, label: string): void {
  if (value === undefined) return;
  const input = record(value, label);
  exact(input, ['model', 'thinking_effort', 'approval_mode', 'service_tier', 'session', 'turn'], label);
  optionalString(input['model'], `${label}.model`, true);
  optionalString(input['thinking_effort'], `${label}.thinking_effort`, true);
  if (input['approval_mode'] !== undefined && input['approval_mode'] !== null) {
    enumValue(input['approval_mode'], APPROVAL_MODES, `${label}.approval_mode`);
  }
  if (input['service_tier'] !== undefined && input['service_tier'] !== null && input['service_tier'] !== 'fast') {
    invalid(`${label}.service_tier is invalid`);
  }
  configValues(input['session'], `${label}.session`);
  configValues(input['turn'], `${label}.turn`);
}

function requireId(input: Record<string, unknown>, key: string, label = 'params'): void {
  string(input[key], `${label}.${key}`);
}

function inputItems(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 32) invalid(`${label} must be an array of at most 32 items`);
  for (const [index, item] of value.entries()) {
    const entry = record(item, `${label}[${index}]`);
    const type = entry['type'];
    if (type === 'text') {
      exact(entry, ['type', 'text'], `${label}[${index}]`);
      string(entry['text'], `${label}[${index}].text`, false);
    } else if (type === 'localImage' || type === 'localFile') {
      exact(entry, ['type', 'path', 'name', 'mime', 'size'], `${label}[${index}]`);
      string(entry['path'], `${label}[${index}].path`);
      optionalString(entry['name'], `${label}[${index}].name`);
      optionalString(entry['mime'], `${label}[${index}].mime`);
      if (entry['size'] !== undefined && (!Number.isInteger(entry['size']) || (entry['size'] as number) < 0)) {
        invalid(`${label}[${index}].size must be a non-negative integer`);
      }
    } else if (type === 'skill') {
      exact(entry, ['type', 'name', 'path'], `${label}[${index}]`);
      string(entry['name'], `${label}[${index}].name`);
      string(entry['path'], `${label}[${index}].path`);
    } else {
      invalid(`${label}[${index}].type is invalid`);
    }
  }
}

function contextItems(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 16) invalid(`${label} must be an array of at most 16 items`);
  for (const [index, item] of value.entries()) {
    const entry = record(item, `${label}[${index}]`);
    const type = entry['type'];
    if (type === 'pastedText') {
      exact(entry, ['type', 'id', 'text', 'lineCount', 'byteSize', 'origin'], `${label}[${index}]`);
      string(entry['id'], `${label}[${index}].id`);
      string(entry['text'], `${label}[${index}].text`, false);
      finiteInteger(entry['lineCount'], `${label}[${index}].lineCount`, 0, Number.MAX_SAFE_INTEGER);
      finiteInteger(entry['byteSize'], `${label}[${index}].byteSize`, 0, Number.MAX_SAFE_INTEGER);
      if (entry['origin'] !== undefined && entry['origin'] !== 'selection') {
        invalid(`${label}[${index}].origin is invalid`);
      }
    } else if (type === 'folder' || type === 'file') {
      exact(entry, ['type', 'id', 'path', 'name'], `${label}[${index}]`);
      string(entry['id'], `${label}[${index}].id`);
      string(entry['path'], `${label}[${index}].path`);
      string(entry['name'], `${label}[${index}].name`);
    } else if (type === 'session') {
      exact(entry, ['type', 'id', 'sessionId', 'title', 'workspaceName'], `${label}[${index}]`);
      string(entry['id'], `${label}[${index}].id`);
      string(entry['sessionId'], `${label}[${index}].sessionId`);
      string(entry['title'], `${label}[${index}].title`);
      if (entry['workspaceName'] !== undefined) {
        string(entry['workspaceName'], `${label}[${index}].workspaceName`);
      }
    } else if (type === 'browserElement') {
      if (typeof entry['id'] !== 'string') invalid(`${label}[${index}].id must be a string`);
    } else {
      invalid(`${label}[${index}].type is invalid`);
    }
  }
}

function composerDocument(value: unknown, label: string): void {
  if (value === undefined) return;
  const entry = record(value, label);
  exact(entry, ['version', 'segments'], label);
  if (entry['version'] !== 1) invalid(`${label}.version is invalid`);
  if (!Array.isArray(entry['segments'])) invalid(`${label}.segments must be an array`);
}

export function isGianToolMutation(method: GianToolMethod): method is GianToolMutationMethod {
  return MUTATIONS.has(method);
}

export function validateGianToolParams<M extends GianToolMethod>(
  method: M,
  value: unknown,
): GianToolMethodParams[M] {
  const input = record(value, 'params');
  switch (method) {
    case 'catalog.get_create_options':
      exact(input, ['refresh'], 'params');
      optionalBoolean(input['refresh'], 'params.refresh');
      break;
    case 'task.list':
      exact(input, ['statuses', 'include_sessions'], 'params');
      if (input['statuses'] !== undefined) enumArray(input['statuses'], TASK_STATUSES, 'params.statuses');
      optionalBoolean(input['include_sessions'], 'params.include_sessions');
      break;
    case 'task.get':
      exact(input, ['task_id'], 'params'); requireId(input, 'task_id');
      break;
    case 'task.create':
      exact(input, ['name', 'description'], 'params'); requireId(input, 'name');
      optionalString(input['description'], 'params.description', true);
      break;
    case 'task.update':
      exact(input, ['task_id', 'name', 'description', 'status', 'pinned'], 'params');
      requireId(input, 'task_id');
      if (input['name'] !== undefined) string(input['name'], 'params.name');
      optionalString(input['description'], 'params.description', true);
      if (input['status'] !== undefined) enumValue(input['status'], TASK_STATUSES, 'params.status');
      optionalBoolean(input['pinned'], 'params.pinned');
      if (Object.keys(input).length === 1) invalid('task.update requires a field to update');
      break;
    case 'session.list':
      exact(input, ['task_id', 'workspace_id', 'agent_id', 'proxy', 'status', 'archived', 'limit'], 'params');
      optionalString(input['task_id'], 'params.task_id', true);
      optionalString(input['workspace_id'], 'params.workspace_id', true);
      optionalString(input['agent_id'], 'params.agent_id', true);
      if (input['proxy'] !== undefined && !isProxyPluginId(input['proxy'])) {
        invalid('params.proxy must be a valid pluginId');
      }
      if (input['status'] !== undefined) enumArray(input['status'], SESSION_STATUSES, 'params.status');
      if (input['archived'] !== undefined) enumValue(input['archived'], new Set(['active', 'archived', 'all']), 'params.archived');
      if (input['limit'] !== undefined) finiteInteger(input['limit'], 'params.limit', 1, 200);
      break;
    case 'session.get':
      exact(input, ['session_id'], 'params'); requireId(input, 'session_id');
      break;
    case 'session.read':
      exact(input, ['session_id', 'before_turn', 'turns', 'view'], 'params'); requireId(input, 'session_id');
      if (input['before_turn'] !== undefined && input['before_turn'] !== null) finiteInteger(input['before_turn'], 'params.before_turn', 1, Number.MAX_SAFE_INTEGER);
      if (input['turns'] !== undefined) finiteInteger(input['turns'], 'params.turns', 1, 10);
      if (input['view'] !== undefined) enumValue(input['view'], new Set(['messages', 'events']), 'params.view');
      break;
    case 'session.create':
      exact(input, ['workspace_id', 'task_id', 'agent_id', 'name', 'config'], 'params');
      requireId(input, 'workspace_id'); requireId(input, 'agent_id');
      optionalString(input['task_id'], 'params.task_id');
      optionalString(input['name'], 'params.name');
      sessionConfig(input['config'], 'params.config');
      break;
    case 'session.update':
      exact(input, ['session_id', 'name', 'config', 'expected_session_revision'], 'params'); requireId(input, 'session_id');
      optionalString(input['name'], 'params.name');
      sessionConfig(input['config'], 'params.config');
      optionalString(input['expected_session_revision'], 'params.expected_session_revision');
      if (Object.keys(input).filter(key => key !== 'expected_session_revision').length === 1) {
        invalid('session.update requires a field to update');
      }
      break;
    case 'session.assign_task':
      exact(input, ['session_id', 'task_id'], 'params'); requireId(input, 'session_id'); requireId(input, 'task_id');
      break;
    case 'session.set_subtask_state':
      exact(input, ['session_id', 'state'], 'params'); requireId(input, 'session_id');
      enumValue(input['state'], new Set(['completed', 'open']), 'params.state');
      break;
    case 'session.archive':
      exact(input, ['session_id', 'archived'], 'params'); requireId(input, 'session_id');
      if (typeof input['archived'] !== 'boolean') invalid('params.archived must be a boolean');
      break;
    case 'session.send':
      exact(input, ['session_id', 'text', 'busy', 'items', 'context_items', 'composer_document'], 'params');
      requireId(input, 'session_id'); requireId(input, 'text');
      if (input['busy'] !== undefined) enumValue(input['busy'], new Set(['queue', 'fail', 'steer']), 'params.busy');
      inputItems(input['items'], 'params.items');
      contextItems(input['context_items'], 'params.context_items');
      composerDocument(input['composer_document'], 'params.composer_document');
      break;
    case 'session.cancel_delivery':
      exact(input, ['delivery_id'], 'params'); requireId(input, 'delivery_id');
      break;
    case 'session.wait':
      exact(input, ['session_id', 'delivery_id', 'until', 'timeout_ms'], 'params'); requireId(input, 'session_id');
      optionalString(input['delivery_id'], 'params.delivery_id');
      if (input['until'] !== undefined) enumArray(input['until'], new Set(['interaction', 'turn_terminal']), 'params.until');
      if (input['timeout_ms'] !== undefined) finiteInteger(input['timeout_ms'], 'params.timeout_ms', 0, 45_000);
      break;
    case 'session.stop':
      exact(input, ['session_id', 'expected_session_revision'], 'params'); requireId(input, 'session_id');
      optionalString(input['expected_session_revision'], 'params.expected_session_revision');
      break;
    case 'queue.update':
      exact(input, ['session_id', 'queue_id', 'text', 'expected_queue_revision'], 'params');
      requireId(input, 'session_id'); requireId(input, 'queue_id'); requireId(input, 'text');
      optionalString(input['expected_queue_revision'], 'params.expected_queue_revision');
      break;
    case 'queue.remove':
      exact(input, ['session_id', 'queue_id', 'expected_queue_revision'], 'params');
      requireId(input, 'session_id'); requireId(input, 'queue_id');
      optionalString(input['expected_queue_revision'], 'params.expected_queue_revision');
      break;
    case 'queue.clear':
      exact(input, ['session_id', 'expected_queue_revision'], 'params'); requireId(input, 'session_id');
      optionalString(input['expected_queue_revision'], 'params.expected_queue_revision');
      break;
    case 'queue.send_now':
      exact(input, ['session_id', 'expected_queue_revision'], 'params'); requireId(input, 'session_id');
      optionalString(input['expected_queue_revision'], 'params.expected_queue_revision');
      break;
    case 'worktree.create_and_bind': {
      exact(input, ['branch', 'base_ref'], 'params');
      const branch = string(input['branch'], 'params.branch');
      if (branch.length > 200) invalid('params.branch must be at most 200 characters');
      optionalString(input['base_ref'], 'params.base_ref');
      if (typeof input['base_ref'] === 'string' && input['base_ref'].length > 200) {
        invalid('params.base_ref must be at most 200 characters');
      }
      break;
    }
    case 'browser.tabs':
      exact(input, [], 'params');
      break;
    case 'browser.open':
      exact(input, ['url', 'tab_id', 'activate'], 'params');
      string(input['url'], 'params.url');
      optionalString(input['tab_id'], 'params.tab_id');
      optionalBoolean(input['activate'], 'params.activate');
      if ((input['url'] as string).length > 8_192) invalid('params.url must be at most 8192 characters');
      break;
    case 'browser.snapshot':
      exact(input, ['tab_id', 'max_nodes'], 'params');
      requireId(input, 'tab_id');
      if (input['max_nodes'] !== undefined) finiteInteger(input['max_nodes'], 'params.max_nodes', 20, 1_000);
      break;
    case 'browser.click':
      exact(input, ['tab_id', 'snapshot_id', 'ref'], 'params');
      requireId(input, 'tab_id'); requireId(input, 'snapshot_id'); requireId(input, 'ref');
      break;
    case 'browser.fill':
      exact(input, ['tab_id', 'snapshot_id', 'ref', 'text'], 'params');
      requireId(input, 'tab_id'); requireId(input, 'snapshot_id'); requireId(input, 'ref');
      string(input['text'], 'params.text', false);
      if ((input['text'] as string).length > 100_000) invalid('params.text must be at most 100000 characters');
      break;
    case 'browser.press': {
      exact(input, ['tab_id', 'key', 'snapshot_id', 'ref'], 'params');
      requireId(input, 'tab_id'); requireId(input, 'key');
      optionalString(input['snapshot_id'], 'params.snapshot_id');
      optionalString(input['ref'], 'params.ref');
      if ((input['snapshot_id'] === undefined) !== (input['ref'] === undefined)) {
        invalid('browser.press requires snapshot_id and ref together');
      }
      if ((input['key'] as string).length > 100) invalid('params.key must be at most 100 characters');
      break;
    }
    case 'browser.wait':
      exact(input, ['tab_id', 'condition', 'text', 'timeout_ms'], 'params');
      requireId(input, 'tab_id');
      if (input['condition'] !== undefined) enumValue(input['condition'], new Set(['load', 'text']), 'params.condition');
      optionalString(input['text'], 'params.text');
      if ((input['condition'] ?? 'load') === 'text' && input['text'] === undefined) {
        invalid('browser.wait with condition=text requires text');
      }
      if (input['timeout_ms'] !== undefined) finiteInteger(input['timeout_ms'], 'params.timeout_ms', 100, 30_000);
      break;
    case 'browser.evaluate':
      exact(input, ['tab_id', 'expression'], 'params');
      requireId(input, 'tab_id');
      string(input['expression'], 'params.expression');
      if ((input['expression'] as string).length > 100_000) invalid('params.expression must be at most 100000 characters');
      break;
    case 'browser.screenshot':
      exact(input, ['tab_id', 'max_width'], 'params');
      requireId(input, 'tab_id');
      if (input['max_width'] !== undefined) finiteInteger(input['max_width'], 'params.max_width', 320, 2_000);
      break;
    case 'browser.go_back':
    case 'browser.close':
      exact(input, ['tab_id'], 'params');
      requireId(input, 'tab_id');
      break;
    case 'browser.reload':
      exact(input, ['tab_id', 'ignore_cache'], 'params');
      requireId(input, 'tab_id');
      optionalBoolean(input['ignore_cache'], 'params.ignore_cache');
      break;
    case 'interaction.list':
      exact(input, ['session_id'], 'params'); optionalString(input['session_id'], 'params.session_id');
      break;
    case 'interaction.respond': {
      exact(input, ['session_id', 'interaction_id', 'decision', 'answers', 'native_option_id', 'expected_interaction_revision'], 'params');
      requireId(input, 'session_id'); requireId(input, 'interaction_id');
      optionalString(input['expected_interaction_revision'], 'params.expected_interaction_revision');
      if (input['decision'] !== undefined) enumValue(input['decision'], DECISIONS, 'params.decision');
      optionalString(input['native_option_id'], 'params.native_option_id');
      if (input['answers'] !== undefined) {
        const answers = record(input['answers'], 'params.answers');
        for (const [key, answer] of Object.entries(answers)) {
          string(key, 'params.answers key');
          if (typeof answer !== 'string' && typeof answer !== 'boolean'
            && (!Array.isArray(answer) || answer.some(item => typeof item !== 'string'))) {
            invalid(`params.answers.${key} must be a string, boolean, or string array`);
          }
        }
      }
      if (input['decision'] === undefined && input['answers'] === undefined && input['native_option_id'] === undefined) {
        invalid('interaction.respond requires a decision, answers, or native_option_id');
      }
      break;
    }
    case 'schedule.preview': {
      exact(input, ['trigger', 'timezone', 'after', 'limit'], 'params');
      isScheduleTrigger(input['trigger']) || invalid('params.trigger is invalid');
      string(input['timezone'], 'params.timezone');
      optionalString(input['after'], 'params.after');
      if (input['limit'] !== undefined) finiteInteger(input['limit'], 'params.limit', 3, 10);
      break;
    }
    case 'schedule.create': {
      exact(input, ['name', 'prompt', 'trigger', 'timezone', 'misfire_policy', 'confirmation_timeout_ms'], 'params');
      string(input['name'], 'params.name');
      string(input['prompt'], 'params.prompt');
      isScheduleTrigger(input['trigger']) || invalid('params.trigger is invalid');
      string(input['timezone'], 'params.timezone');
      if (input['misfire_policy'] !== undefined) {
        enumValue(input['misfire_policy'], new Set(['skip', 'run_once']), 'params.misfire_policy');
      }
      if (input['confirmation_timeout_ms'] !== undefined) {
        finiteInteger(input['confirmation_timeout_ms'], 'params.confirmation_timeout_ms', 5_000, 1_800_000);
      }
      break;
    }
    case 'schedule.list':
      exact(input, ['status', 'limit', 'cursor', 'control_session_id'], 'params');
      if (input['status'] !== undefined) {
        enumArray(input['status'], new Set(['active', 'paused', 'completed', 'archived']), 'params.status');
      }
      if (input['limit'] !== undefined) finiteInteger(input['limit'], 'params.limit', 1, 200);
      optionalString(input['cursor'], 'params.cursor');
      optionalString(input['control_session_id'], 'params.control_session_id');
      break;
    case 'schedule.get':
      exact(input, ['schedule_id', 'include_runs'], 'params');
      requireId(input, 'schedule_id');
      optionalBoolean(input['include_runs'], 'params.include_runs');
      break;
    case 'schedule.update': {
      exact(input, ['schedule_id', 'expected_revision', 'name', 'prompt', 'trigger', 'timezone', 'misfire_policy'], 'params');
      requireId(input, 'schedule_id');
      finiteInteger(input['expected_revision'], 'params.expected_revision', 1, Number.MAX_SAFE_INTEGER);
      if (input['name'] !== undefined) string(input['name'], 'params.name');
      if (input['prompt'] !== undefined) string(input['prompt'], 'params.prompt');
      if (input['trigger'] !== undefined) isScheduleTrigger(input['trigger']) || invalid('params.trigger is invalid');
      optionalString(input['timezone'], 'params.timezone');
      if (input['misfire_policy'] !== undefined) {
        enumValue(input['misfire_policy'], new Set(['skip', 'run_once']), 'params.misfire_policy');
      }
      if (Object.keys(input).length === 2) invalid('schedule.update requires a field to update');
      break;
    }
    case 'schedule.pause':
    case 'schedule.resume':
    case 'schedule.run_now':
    case 'schedule.archive': {
      exact(input, ['schedule_id', 'expected_revision'], 'params');
      requireId(input, 'schedule_id');
      if (input['expected_revision'] !== undefined) {
        finiteInteger(input['expected_revision'], 'params.expected_revision', 1, Number.MAX_SAFE_INTEGER);
      }
      break;
    }
  }
  return input as GianToolMethodParams[M];
}

export function validateGianToolCall(value: unknown): GianToolCall {
  const input = record(value, 'call');
  exact(input, ['request_id', 'caller_id', 'method', 'params', 'idempotency_key'], 'call');
  string(input['request_id'], 'call.request_id');
  string(input['caller_id'], 'call.caller_id');
  if (typeof input['method'] !== 'string' || !METHODS.has(input['method'])) invalid('call.method is invalid');
  const method = input['method'] as GianToolMethod;
  validateGianToolParams(method, input['params']);
  optionalString(input['idempotency_key'], 'call.idempotency_key');
  if (isGianToolMutation(method) && typeof input['idempotency_key'] !== 'string') {
    invalid(`call.idempotency_key is required for ${method}`);
  }
  return input as unknown as GianToolCall;
}

export function validateGianToolResult(value: unknown): GianToolResult {
  const input = record(value, 'result');
  exact(input, ['ok', 'request_id', 'data', 'error'], 'result');
  if (typeof input['ok'] !== 'boolean') invalid('result.ok must be a boolean');
  string(input['request_id'], 'result.request_id', false);
  if (input['ok']) {
    if (!Object.hasOwn(input, 'data')) invalid('successful result requires data');
    if (input['error'] !== undefined) invalid('successful result must not contain error');
  } else {
    if (input['data'] !== undefined) invalid('failed result must not contain data');
    const error = record(input['error'], 'result.error');
    exact(error, ['code', 'message', 'retryable', 'details'], 'result.error');
    enumValue(error['code'], ERROR_CODES, 'result.error.code');
    string(error['message'], 'result.error.message');
    if (typeof error['retryable'] !== 'boolean') invalid('result.error.retryable must be a boolean');
    if (error['details'] !== undefined) record(error['details'], 'result.error.details');
  }
  return input as unknown as GianToolResult;
}
