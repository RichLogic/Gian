import type {
  Approval,
  ExternalEditor,
  NativeApprovalOption,
  NativeConfigChoice,
  NativeConfigOption,
  NativeConfigValue,
  Session,
  SideChatInfo,
  SystemConfig,
  Task,
  Workspace,
} from './model.js';
import { EXECUTOR_IDS, PRODUCT_EXECUTOR_IDS } from './executors.js';
import { normalizeBrowserElementCapture } from './browser-context.js';
import { normalizeComposerDocument } from './context.js';
import type { ListNativeSessionsResponse, NativeSession } from './native.js';
import type { RunnerInfo, StateSyncMessage } from './web.js';

type UnknownRecord = Record<string, unknown>;
type Predicate = (value: unknown) => boolean;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isZeroOrOne(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function isOneOf(value: unknown, choices: readonly unknown[]): boolean {
  return choices.includes(value);
}

function isArrayOf(value: unknown, predicate: Predicate): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isOptional(record: UnknownRecord, key: string, predicate: Predicate): boolean {
  return !(key in record) || predicate(record[key]);
}

function isNativeConfigValue(value: unknown): value is NativeConfigValue {
  return value === null || isString(value) || typeof value === 'boolean' || isFiniteNumber(value);
}

function isNativeConfigChoice(value: unknown): value is NativeConfigChoice {
  if (!isRecord(value)) return false;
  return isNativeConfigValue(value.value)
    && isString(value.label)
    && isOptional(value, 'description', isString)
    && isOptional(value, 'group', isString);
}

function isNativeConfigOption(value: unknown): value is NativeConfigOption {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.name)
    && isOptional(value, 'category', isString)
    && isOptional(value, 'description', isString)
    && isOneOf(value.type, ['select', 'boolean', 'number', 'text'])
    && isNativeConfigValue(value.currentValue)
    && isOptional(value, 'choices', candidate => isArrayOf(candidate, isNativeConfigChoice))
    && isOneOf(value.scope, ['session', 'turn']);
}

function isNativeApprovalOption(value: unknown): value is NativeApprovalOption {
  if (!isRecord(value)) return false;
  return isString(value.optionId)
    && isString(value.label)
    && isString(value.kind);
}

function isExecutorConfigState(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.values)) return false;
  return Object.values(value.values).every(isNativeConfigValue);
}

function isAgentRuntimeProfile(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.skill)) return false;
  return isString(value.id)
    && isString(value.agentId)
    && isOneOf(value.proxy, PRODUCT_EXECUTOR_IDS as readonly string[])
    && isString(value.cliPath)
    && isString(value.cliVersion)
    && isNullableString(value.configHome)
    && isNullableString(value.cliFingerprint)
    && isString(value.proxyVersion)
    && isArrayOf(value.verifiedCliVersions, isString)
    && isOneOf(value.verification, ['verified', 'unverified', 'incompatible'])
    && value.skill.name === 'gian-session'
    && isString(value.skill.version)
    && isOneOf(value.skill.state, ['ready', 'missing', 'conflict', 'invalid']);
}

/** Runtime contract for the canonical shared model crossing REST/WS boundaries. */
export function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isNullableString(value.name)
    && isOneOf(value.type, ['coding', 'subtask', 'manager'])
    && isNullableString(value.task_id)
    && isNullableString(value.workspace_id)
    && isOptional(value, 'created_by_actor_kind', entry => (
      entry === null || isOneOf(entry, ['internal_session', 'external_controller'])
    ))
    && isOptional(value, 'created_by_actor_id', isNullableString)
    && isOptional(value, 'created_by_session_id', isNullableString)
    && isOneOf(value.executor, EXECUTOR_IDS as readonly string[])
    && isOptional(value, 'runtime_profile', entry => entry === null || isAgentRuntimeProfile(entry))
    && isNullableString(value.model)
    && (value.approval_mode === null
      || isOneOf(value.approval_mode, ['plan', 'ask', 'auto', 'custom', 'full-access']))
    && isExecutorConfigState(value.executor_config)
    && isArrayOf(value.native_config_options, isNativeConfigOption)
    && isNullableString(value.thinking_effort)
    && (value.service_tier === null || isOneOf(value.service_tier, ['fast', 'flex']))
    && (value.active_channel === null || isOneOf(value.active_channel, ['web', 'im']))
    && isOneOf(value.status, ['new', 'running', 'pending', 'error', 'done'])
    && isZeroOrOne(value.archived)
    && isNullableString(value.pinned_at)
    && isOptional(value, 'workspace_order', isNullableNumber)
    && isOptional(value, 'task_order', isNullableNumber)
    && isZeroOrOne(value.unread)
    && isNullableString(value.worktree_path)
    && isOptional(value, 'detected_worktree_path', isNullableString)
    && isOptional(value, 'detected_worktree_source', item => (
      item === null || item === 'agent' || item === 'gian_tool'
    ))
    && isOptional(value, 'detected_worktree_revision', item => (
      typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
    ))
    && isNullableString(value.branch)
    && isNullableString(value.base_branch)
    && (value.worktree_outcome === null || isOneOf(value.worktree_outcome, ['merged', 'discarded']))
    && isNullableString(value.native_session_id)
    && isOptional(value, 'context_tokens_used', isNullableNumber)
    && isOptional(value, 'context_window_tokens', isNullableNumber)
    && isOptional(value, 'context_usage_updated_at', isNullableString)
    && isOptional(value, 'conversation_input_tokens', isNullableNumber)
    && isOptional(value, 'conversation_output_tokens', isNullableNumber)
    && isOptional(value, 'conversation_cached_input_tokens', isNullableNumber)
    && isOptional(value, 'conversation_total_tokens', isNullableNumber)
    && isOptional(value, 'conversation_usage_complete', isZeroOrOne)
    && isNullableString(value.summary)
    && isNullableString(value.completed_at)
    && isOptional(value, 'turn_config', (entry) => (
      isRecord(entry) && Object.values(entry).every(isNativeConfigValue)
    ))
    && isOptional(value, 'turn_config_options', (entry) => isArrayOf(entry, isRecord))
    && isOptional(value, 'turn_config_revision', isNullableString)
    && isOptional(value, 'available_actions', isAvailableActions)
    && isOptional(value, 'origin', isSessionOrigin)
    && isString(value.created_at)
    && isString(value.updated_at);
}

function isAvailableActions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => (
    isRecord(entry)
    && typeof entry.enabled === 'boolean'
    && isOptional(entry, 'reason', isString)
  ));
}

function isSessionOrigin(value: unknown): boolean {
  return isRecord(value)
    && value.kind === 'fork'
    && isString(value.session_id)
    && isString(value.turn_id)
    && isString(value.source_turn_id);
}

function isSideChatAnchor(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.type)) return false;
  if (value.type === 'empty') return true;
  return (value.type === 'turn' || value.type === 'activeInput')
    && isString(value.turn_id)
    && isString(value.source_turn_id);
}

function isMessageContextItem(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.id) || !isString(value.type)) return false;
  if (value.type === 'folder') {
    return isString(value.path) && isString(value.name);
  }
  if (value.type === 'browserElement') {
    const normalized = normalizeBrowserElementCapture(value);
    return normalized !== null
      && isString(value.pageUrl)
      && isString(value.pageTitle)
      && isString(value.tagName)
      && isString(value.selector)
      && isRecord(value.attributes)
      && typeof value.contentOmitted === 'boolean'
      && isString(value.snippet);
  }
  return value.type === 'pastedText'
    && isString(value.text)
    && isFiniteNumber(value.lineCount)
    && isFiniteNumber(value.byteSize);
}

function isSideChatUserInput(value: unknown): boolean {
  return isRecord(value)
    && isString(value.turn_id)
    && 'input' in value
    && isString(value.created_at)
    && (!('context_items' in value) || isArrayOf(value.context_items, isMessageContextItem))
    && (!('composer_document' in value) || normalizeComposerDocument(value.composer_document) !== null);
}

export function isSideChatPublicSnapshot(value: unknown): value is SideChatInfo {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.parent_session_id)
    && isFiniteNumber(value.ordinal)
    && Number.isSafeInteger(value.ordinal)
    && value.ordinal > 0
    && isNullableString(value.name)
    && isNullableString(value.stream_id)
    && isOneOf(value.state, ['idle', 'running', 'waiting_interaction', 'stale', 'closed', 'error'])
    && isOneOf(value.status, ['open', 'closing', 'unavailable'])
    && isSideChatAnchor(value.anchor)
    && isRecord(value.session_config)
    && isOptional(value, 'turn_config', (entry) => (
      isRecord(entry) && Object.values(entry).every(isNativeConfigValue)
    ))
    && isOptional(value, 'turn_config_options', (entry) => isArrayOf(entry, isRecord))
    && isOptional(value, 'turn_config_revision', isNullableString)
    && isNullableString(value.last_error)
    && isNullableString(value.uncertain_turn_id)
    && Array.isArray(value.events)
    && isArrayOf(value.user_inputs, isSideChatUserInput)
    && isString(value.created_at)
    && isString(value.updated_at);
}

export function isSideChatInfo(value: unknown): value is SideChatInfo {
  return isSideChatPublicSnapshot(value);
}

function isWorkspace(value: unknown): value is Workspace {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.name)
    && isString(value.path)
    && isFiniteNumber(value.sort_order)
    && isZeroOrOne(value.hidden)
    && isZeroOrOne(value.pinned)
    && isString(value.created_at)
    && isString(value.updated_at);
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.name)
    && isNullableString(value.description)
    && isOneOf(value.status, ['open', 'done', 'archived'])
    && isString(value.created_at)
    && isString(value.updated_at)
    && isNullableString(value.pinned_at)
    && isOptional(value, 'sort_order', isNullableNumber);
}

function isApproval(value: unknown): value is Approval {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.session_id)
    && isString(value.turn_id)
    && isOneOf(value.category, [
      'command', 'network', 'file_write_outside_ws', 'exit_plan_mode', 'question', 'other',
    ])
    && isString(value.title)
    && isString(value.command)
    && isNullableString(value.reason)
    && isOneOf(value.status, [
      'pending', 'approved', 'approved-session', 'auto-approved', 'declined',
    ])
    && (value.resolved_by === null || isOneOf(value.resolved_by, ['web', 'im', 'auto', 'tool']))
    && isNullableString(value.resolved_at)
    && isString(value.created_at)
    && isOptional(value, 'native_options', candidate => isArrayOf(candidate, isNativeApprovalOption));
}

function isExternalEditor(value: unknown): value is ExternalEditor {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.name)
    && isString(value.command)
    && isArrayOf(value.args, isString);
}

function isTerminalPreferences(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isOneOf(value.font_family, ['jetbrains-mono', 'system-mono', 'sf-mono', 'menlo'])
    && isFiniteNumber(value.font_size)
    && Number.isInteger(value.font_size)
    && value.font_size >= 10
    && value.font_size <= 22
    && isFiniteNumber(value.line_height)
    && value.line_height >= 1
    && value.line_height <= 1.6
    && isOneOf(value.cursor_style, ['block', 'bar', 'underline'])
    && typeof value.cursor_blink === 'boolean'
    && isOneOf(value.scrollback_lines, [1_000, 5_000, 10_000, 50_000])
    && isString(value.shell)
    && value.shell.length <= 4_096
    && isOneOf(value.start_directory, ['context', 'home']);
}

function isSystemConfig(value: unknown): value is SystemConfig {
  if (!isRecord(value)) return false;
  return isString(value.host)
    && isFiniteNumber(value.port)
    && isString(value.workspace_root)
    && isOneOf(value.theme, ['light', 'warm', 'dark'])
    && isOneOf(value.accent, ['rose', 'ember', 'citron', 'moss', 'teal', 'azure', 'ink', 'plum'])
    && isOneOf(value.density, ['compact', 'cozy', 'roomy'])
    && isOneOf(value.font_scale_chrome, ['sm', 'md', 'lg', 'xl'])
    && isOneOf(value.font_scale_chat, ['sm', 'md', 'lg', 'xl'])
    && isOneOf(value.font_scale_code, ['sm', 'md', 'lg', 'xl'])
    && isTerminalPreferences(value.terminal)
    && isOneOf(value.locale, ['zh-CN', 'en'])
    && isString(value.default_claude_model)
    && isString(value.default_claude_effort)
    && isString(value.default_codex_model)
    && isString(value.default_codex_effort)
    && isString(value.auth_username)
    && isArrayOf(value.external_editors, isExternalEditor)
    && isOptional(value, 'open_apps', candidate => {
      if (!isRecord(candidate)) return false;
      const keys = ['code', 'web', 'images', 'pdf', 'other'];
      return Object.entries(candidate).every(([key, entry]) => keys.includes(key) && isString(entry));
    });
}

function isRunnerInfo(value: unknown): value is RunnerInfo {
  if (!isRecord(value)) return false;
  return isString(value.host)
    && isFiniteNumber(value.latency)
    && isString(value.started_ago)
    && isFiniteNumber(value.agents)
    && isString(value.disk)
    && isString(value.codex_version)
    && isString(value.cc_version)
    && isString(value.ws_root);
}

/** Deep runtime schema for the authoritative WebSocket snapshot. */
export function isStateSyncMessage(value: unknown): value is StateSyncMessage {
  if (!isRecord(value)) return false;
  return value.type === 'state_sync'
    && isRunnerInfo(value.runner)
    && isArrayOf(value.sessions, isSession)
    && isOptional(value, 'sidechats', (entry) => isArrayOf(entry, isSideChatPublicSnapshot))
    && isArrayOf(value.workspaces, isWorkspace)
    && isArrayOf(value.tasks, isTask)
    && isArrayOf(value.approvals, isApproval)
    && isSystemConfig(value.config);
}

/** Runtime contract for a native CLI session returned by the Host REST API. */
export function isNativeSession(value: unknown): value is NativeSession {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isOneOf(value.executor, EXECUTOR_IDS as readonly string[])
    && isString(value.filePath)
    && isString(value.cwd)
    && isString(value.updatedAt)
    && isFiniteNumber(value.fileSize)
    && isFiniteNumber(value.turnCount)
    && isString(value.firstUserMessage)
    && isOptional(value, 'gitBranch', isString)
    && isOptional(value, 'adoptedBy', candidate => isRecord(candidate)
      && isString(candidate.gianSessionId)
      && isNullableString(candidate.gianSessionName));
}

export function isListNativeSessionsResponse(value: unknown): value is ListNativeSessionsResponse {
  return isRecord(value) && isArrayOf(value.sessions, isNativeSession);
}

export class RuntimeContractError extends TypeError {
  readonly contract: string;

  constructor(contract: string) {
    super(`Invalid runtime payload for ${contract}`);
    this.name = 'RuntimeContractError';
    this.contract = contract;
  }
}

function parseContract<T>(value: unknown, contract: string, predicate: (candidate: unknown) => candidate is T): T {
  if (!predicate(value)) throw new RuntimeContractError(contract);
  return value;
}

export function parseSession(value: unknown): Session {
  return parseContract(value, 'Session', isSession);
}

export function parseSessionList(value: unknown): Session[] {
  return parseContract(
    value,
    'Session[]',
    (candidate): candidate is Session[] => isArrayOf(candidate, isSession),
  );
}

export function parseStateSyncMessage(value: unknown): StateSyncMessage {
  return parseContract(value, 'StateSyncMessage', isStateSyncMessage);
}

export function parseSideChatInfo(value: unknown): SideChatInfo {
  return parseContract(value, 'SideChatInfo', isSideChatPublicSnapshot);
}

export function parseListNativeSessionsResponse(value: unknown): ListNativeSessionsResponse {
  return parseContract(value, 'ListNativeSessionsResponse', isListNativeSessionsResponse);
}
