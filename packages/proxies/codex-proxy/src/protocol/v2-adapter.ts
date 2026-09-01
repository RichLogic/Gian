import { createHash, randomUUID } from 'node:crypto';

import { OpaqueSidechatResumeStore } from '@gian/proxy-protocol';

import { AppError } from '../core/errors.js';
import { CodexProxyService } from '../core/service.js';
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  CapabilitiesPayload,
  InputItem,
  ModelCapabilities,
  SandboxMode,
} from '../core/types.js';
import {
  CodexJsonRpcError,
  CodexProtocolError,
  type DomainCode,
} from '../transport/protocol.js';
import {
  CodexNativeHistoryWatcher,
  IncrementalReplayTracker,
  listCodexNativeSessions,
  NativeTurnIdentityStore,
  replayCodexNativeSession,
  type NativeReplay,
} from './native-history.js';

export type ConfigValue = string | boolean | number | null;

export type WireRequest = {
  id: string;
  method: string;
  params: Record<string, unknown>;
};

type V2EventSink = (method: string, params: Record<string, unknown>) => void;

class TurnLedger {
  private readonly streams = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();

  attach(sessionId: string, streamId: string): void {
    this.streams.set(sessionId, streamId);
    for (const key of [...this.fingerprints.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.fingerprints.delete(key);
    }
  }

  close(sessionId: string): void {
    this.streams.delete(sessionId);
    for (const key of [...this.fingerprints.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.fingerprints.delete(key);
    }
  }

  accept(params: {
    sessionId: string;
    streamId: string;
    turnId: string;
    input: unknown;
    config: unknown;
  }): 'new' | 'duplicate' {
    const active = this.streams.get(params.sessionId);
    if (active === undefined) {
      throw new CodexProtocolError('SESSION_NOT_FOUND', `Session ${params.sessionId} is not attached.`);
    }
    if (active !== params.streamId) {
      throw new CodexProtocolError('SESSION_STALE', `Stream ${params.streamId} is no longer active.`);
    }
    const key = `${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`;
    const fingerprint = JSON.stringify({ input: params.input, config: params.config });
    const existing = this.fingerprints.get(key);
    if (existing === undefined) {
      this.fingerprints.set(key, fingerprint);
      return 'new';
    }
    if (existing !== fingerprint) {
      throw new CodexProtocolError('CONFLICT', `Turn ${params.turnId} was reused with different input.`);
    }
    return 'duplicate';
  }

  forget(params: { sessionId: string; streamId: string; turnId: string }): void {
    this.fingerprints.delete(`${params.sessionId}\u0000${params.streamId}\u0000${params.turnId}`);
  }
}

class ReplayPager {
  private readonly active = new Map<string, { streamId: string; events: readonly unknown[] }>();

  page(
    sessionId: string,
    latest: { streamId: string; events: readonly unknown[] },
    cursor: string | null,
    limit: number,
  ) {
    const snapshot = cursor === null ? latest : this.active.get(sessionId);
    if (snapshot === undefined) {
      throw new CodexJsonRpcError(-32602, 'Replay cursor has no active snapshot.');
    }
    if (cursor === null) this.active.set(sessionId, snapshot);
    const offset = cursor === null || /^(0|[1-9]\d*)$/.test(cursor) ? Number(cursor ?? 0) : Number.NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.events.length) {
      throw new CodexJsonRpcError(-32602, 'Invalid replay cursor.');
    }
    const end = Math.min(offset + limit, snapshot.events.length);
    const nextCursor = end < snapshot.events.length ? String(end) : null;
    if (nextCursor === null) this.active.delete(sessionId);
    return {
      replayStreamId: snapshot.streamId,
      events: snapshot.events.slice(offset, end),
      nextCursor,
    };
  }

  close(sessionId: string): void {
    this.active.delete(sessionId);
  }
}

interface AttachedSession {
  id: string;
  serviceSessionId: string;
  nativeSessionId: string;
  streamId: string;
  cwd: string;
  roots: string[];
  state: 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sessionConfig: Record<string, ConfigValue>;
  sequence: number;
}

interface ServiceSessionShape {
  id: string;
  threadId: string;
  status: 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

type SidechatAnchor =
  | { type: 'empty' }
  | { type: 'turn'; turnId: string; sourceTurnId: string }
  | { type: 'activeInput'; turnId: string; sourceTurnId: string };

interface SidechatRecord {
  parentSessionId: string;
  resumeRefId: string;
  anchor: SidechatAnchor;
  createFingerprint?: string;
  resumeFingerprint?: string;
}

interface HostTurnRef {
  sessionId: string;
  turnId: string;
}

interface InteractionRef extends HostTurnRef {
  serviceApprovalId: string;
  serviceMethod: string;
  actionIds: string[];
  inputs: InteractionInput[];
  responses: Map<string, { actionId: string; values: Record<string, unknown> }>;
}

interface OpenContent {
  contentId: string;
  kind: 'text' | 'reasoning' | 'status';
  content: string;
  deltaCount: number;
}

interface ActivityDescriptor {
  kind: string;
  title: string;
  presentation: Record<string, unknown>;
  summary?: string;
  details?: unknown;
}

interface InteractionInput {
  id: string;
  type: 'single_select' | 'text';
  label: string;
  required: boolean;
  description?: string;
  choices?: Array<{ value: string; displayName: string }>;
}

interface CatalogCondition {
  optionId: string;
  oneOf: ConfigValue[];
}

export interface CatalogOption {
  id: string;
  displayName: string;
  description?: string;
  binding: 'session' | 'turn';
  role?: string;
  control: 'select' | 'boolean' | 'number' | 'text';
  required: boolean;
  defaultValue: ConfigValue;
  choices?: Array<{ value: ConfigValue; displayName: string; description?: string }>;
  constraints?: {
    minimum?: number;
    maximum?: number;
    step?: number;
    minimumLength?: number;
    maximumLength?: number;
    multiline?: boolean;
  };
  visibleWhen?: CatalogCondition[];
  enabledWhen?: CatalogCondition[];
}

const PROTOCOL_NAME = 'gian.proxy';
const PROTOCOL_V2 = '2.1';
const REQUEST_USER_INPUT_METHOD = 'item/tool/requestUserInput';

const CAPABILITIES = {
  'input.localImage': 1,
  'input.skill': 1,
  'session.rename': 1,
  'session.native.list': 1,
  'session.replay': 1,
  'session.create.forkBoundaries': 1,
  sidechat: 1,
  'session.fork': 1,
  'session.fork.atTurn': 1,
  'integration.mcp.streamableHttp': 1,
  'turn.steer': 1,
  interaction: 1,
  'event.reasoning': 1,
  'event.plan': 1,
  'event.diff': 1,
  'event.usage': 1,
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function codexHostServiceConfig(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const servers: Record<string, unknown> = {};
  for (const raw of value) {
    const service = record(raw);
    const id = nonEmptyString(service.id);
    const transport = record(service.transport);
    const url = nonEmptyString(transport.url);
    if (!id || service.protocol !== 'mcp' || transport.type !== 'streamable-http' || !url) {
      throw new CodexJsonRpcError(
        -32602,
        'hostServices contains an invalid Streamable HTTP MCP descriptor.',
      );
    }
    const rawHeaders = record(transport.headers);
    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(rawHeaders)) {
      if (typeof headerValue !== 'string') {
        throw new CodexJsonRpcError(-32602, 'hostServices transport headers must be strings.');
      }
      headers[key] = headerValue;
    }
    servers[id] = {
      url,
      ...(Object.keys(headers).length > 0 ? { http_headers: headers } : {}),
    };
  }
  return { mcp_servers: servers };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function boundedJsonValue(value: unknown, maxBytes = 32_768): unknown {
  const normalized = jsonValue(value);
  const serialized = JSON.stringify(normalized);
  return Buffer.byteLength(serialized, 'utf8') <= maxBytes
    ? normalized
    : {
      truncated: true,
      preview: Buffer.from(serialized, 'utf8')
        .subarray(0, Math.max(0, maxBytes - 64))
        .toString('utf8'),
    };
}

function boundedText(value: unknown, maxLength = 32_768): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}

function codexActivityStatus(
  phase: unknown,
  nativeStatus: unknown,
): 'running' | 'succeeded' | 'failed' | 'cancelled' {
  if (phase === 'started') return 'running';
  if (nativeStatus === 'failed' || nativeStatus === 'errored') return 'failed';
  if (
    nativeStatus === 'declined'
    || nativeStatus === 'interrupted'
    || nativeStatus === 'cancelled'
    || nativeStatus === 'canceled'
  ) return 'cancelled';
  return 'succeeded';
}

function codexItemActivity(data: Record<string, unknown>): {
  activityId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  descriptor: ActivityDescriptor;
} | null {
  const item = record(data.item);
  const activityId = nonEmptyString(item.id);
  const nativeType = nonEmptyString(item.type);
  if (!activityId || !nativeType) return null;
  const status = codexActivityStatus(data.phase, item.status);
  const timing = typeof data.nativeTimestampMs === 'number'
    ? { phase: data.phase, timestampMs: data.nativeTimestampMs }
    : undefined;
  const details = boundedJsonValue({
    nativeType,
    ...(timing ? { timing } : {}),
    item,
  });

  if (nativeType === 'commandExecution') {
    const command = nonEmptyString(item.command) ?? 'command';
    const cwd = nonEmptyString(item.cwd);
    const output = boundedText(item.aggregatedOutput);
    return {
      activityId,
      status,
      descriptor: {
        kind: 'command',
        title: 'Command',
        presentation: {
          type: 'command',
          data: {
            command,
            ...(cwd ? { cwd } : {}),
            ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
          },
        },
        ...(output ? { summary: output } : {}),
        details,
      },
    };
  }

  if (nativeType === 'mcpToolCall' || nativeType === 'dynamicToolCall') {
    const server = nativeType === 'mcpToolCall' ? nonEmptyString(item.server) : nonEmptyString(item.namespace);
    const tool = nonEmptyString(item.tool) ?? 'tool';
    const name = server ? `${server}.${tool}` : tool;
    const result = item.error ?? item.result ?? item.contentItems;
    return {
      activityId,
      status,
      descriptor: {
        kind: nativeType === 'mcpToolCall' ? 'mcp' : 'tool',
        title: name,
        presentation: {
          type: 'tool',
          data: {
            name,
            ...(item.arguments !== undefined ? { input: boundedJsonValue(item.arguments) } : {}),
            ...(result !== undefined && result !== null ? { output: boundedJsonValue(result) } : {}),
          },
        },
        details,
      },
    };
  }

  if (nativeType === 'webSearch') {
    const query = nonEmptyString(item.query) ?? 'Web search';
    return {
      activityId,
      status,
      descriptor: {
        kind: 'web-search',
        title: 'Web search',
        presentation: { type: 'search', data: { query } },
        details,
      },
    };
  }

  if (nativeType === 'imageView') {
    const path = nonEmptyString(item.path) ?? 'image';
    return {
      activityId,
      status,
      descriptor: {
        kind: 'file-read',
        title: 'View image',
        presentation: { type: 'file', data: { path, operation: 'read' } },
        details,
      },
    };
  }

  const title = nativeType === 'fileChange'
    ? 'File change'
    : nativeType === 'imageGeneration'
      ? 'Image generation'
      : nativeType === 'sleep'
        ? 'Sleep'
        : nativeType;
  const input = nativeType === 'fileChange'
    ? { files: Array.isArray(item.changes) ? item.changes.map(change => record(change).path) : [] }
    : item;
  return {
    activityId,
    status,
    descriptor: {
      kind: nativeType,
      title,
      presentation: {
        type: 'tool',
        data: {
          name: title,
          input: boundedJsonValue(input),
        },
      },
      details,
    },
  };
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}

function isConfigValue(value: unknown): value is ConfigValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function standardError(error: unknown): CodexProtocolError | CodexJsonRpcError {
  if (error instanceof CodexProtocolError || error instanceof CodexJsonRpcError) return error;
  if (error instanceof AppError) {
    const code: DomainCode = (() => {
      switch (error.code) {
        case 'SESSION_NOT_FOUND': return 'SESSION_NOT_FOUND';
        case 'SESSION_CLOSED': return 'SESSION_CLOSED';
        case 'SESSION_STALE': return 'SESSION_STALE';
        case 'SESSION_ERROR': return 'SESSION_ERROR';
        case 'SESSION_BUSY': return 'SESSION_BUSY';
        case 'NO_ACTIVE_TURN': return 'TURN_NOT_FOUND';
        case 'APPROVAL_NOT_FOUND': return 'INTERACTION_NOT_FOUND';
        case 'THREAD_NOT_FOUND': return 'NATIVE_SESSION_NOT_FOUND';
        case 'NOT_SUPPORTED':
        case 'UNSUPPORTED': return 'CAPABILITY_NOT_SUPPORTED';
        case 'PROCESS_SPAWN_FAILED':
        case 'RUNTIME_STOPPED': return 'RUNTIME_UNAVAILABLE';
        default: return 'RUNTIME_ERROR';
      }
    })();
    if (error.code === 'INVALID_REQUEST') {
      return new CodexJsonRpcError(-32602, error.message);
    }
    return new CodexProtocolError(code, error.message, false);
  }
  return new CodexProtocolError(
    'INTERNAL',
    error instanceof Error ? error.message : String(error),
  );
}

function sessionUpdatedData(data: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (data.nativeSession !== undefined) next.nativeSession = data.nativeSession;
  if (data.state !== undefined) next.state = data.state;
  if (data.lastError !== undefined) next.lastError = data.lastError;
  if (data.turnConfigOptions !== undefined) next.turnConfigOptions = data.turnConfigOptions;
  if (data.turnConfigRevision !== undefined) next.turnConfigRevision = data.turnConfigRevision;
  if (data.availableActions !== undefined) next.availableActions = data.availableActions;
  if (data.updatedAt !== undefined) next.updatedAt = data.updatedAt;
  if (Object.keys(next).length === 0) next.updatedAt = new Date().toISOString();
  return next;
}

function catalogConfigOptions(capabilities: CapabilitiesPayload): CatalogOption[] {
  const models = capabilities.models.filter((model) => !model.hidden);
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const efforts = uniqueEfforts(models);
  const options: CatalogOption[] = [];
  if (models.length > 0) {
    options.push({
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: false,
      defaultValue: defaultModel?.id ?? null,
      choices: models.map((model) => ({
        value: model.id,
        displayName: model.displayName || model.id,
        ...(model.description ? { description: model.description } : {}),
      })),
    });
  }
  if (efforts.length > 0) {
    const defaultEffort = defaultModel?.defaultThinking
      ?? efforts.find((effort) => effort.isDefault)?.id
      ?? efforts[0]?.id
      ?? null;
    options.push({
      id: 'effort',
      displayName: 'Effort',
      binding: 'turn',
      role: 'effort',
      control: 'select',
      required: false,
      defaultValue: defaultEffort,
      choices: efforts.map((effort) => ({
        value: effort.id,
        displayName: effort.displayName,
      })),
    });
  }
  options.push({
    id: 'approval_mode',
    displayName: 'Approval',
    description: 'Choose how Codex actions are approved for this turn.',
    binding: 'turn',
    role: 'approval_mode',
    control: 'select',
    required: false,
    defaultValue: 'ask',
    choices: [
      {
        value: 'ask',
        displayName: 'Ask for approval',
        description: 'Always ask to edit external files and use the internet.',
      },
      {
        value: 'auto',
        displayName: 'Approve for me',
        description: 'Let Codex review approval requests automatically.',
      },
      {
        value: 'full-access',
        displayName: 'Full access',
        description: 'Run without sandbox restrictions or approval prompts.',
      },
      {
        value: 'custom',
        displayName: 'Custom (config.toml)',
        description: 'Use the permission configuration loaded from config.toml.',
      },
    ],
  });
  const fastModels = models.filter((model) => (
    model.serviceTiers.some((tier) => tier.id === 'fast')
  ));
  if (fastModels.length > 0) {
    const fastTier = fastModels
      .flatMap((model) => model.serviceTiers)
      .find((tier) => tier.id === 'fast');
    options.push({
      id: 'service_tier',
      displayName: fastTier?.displayName || 'Fast',
      description: fastTier?.description || 'Use the Codex Fast service tier for this turn.',
      binding: 'turn',
      role: 'fast',
      control: 'boolean',
      required: false,
      defaultValue: false,
      ...(fastModels.length < models.length
        ? {
            enabledWhen: [{
              optionId: 'model',
              oneOf: fastModels.map((model) => model.id),
            }],
          }
        : {}),
    });
  }
  return options;
}

function uniqueEfforts(models: ModelCapabilities[]) {
  const seen = new Map<string, { id: string; displayName: string; isDefault: boolean }>();
  for (const model of models) {
    for (const effort of model.supportedThinking) {
      if (!seen.has(effort)) {
        seen.set(effort, {
          id: effort,
          displayName: effort,
          isDefault: effort === model.defaultThinking && model.isDefault,
        });
      }
    }
  }
  return [...seen.values()];
}

function serializeOption(option: CatalogOption) {
  return {
    id: option.id,
    displayName: option.displayName,
    ...(option.description ? { description: option.description } : {}),
    binding: option.binding,
    control: option.control,
    required: option.required,
    defaultValue: option.defaultValue,
    ...(option.choices ? { choices: option.choices } : {}),
    ...(option.constraints ? { constraints: option.constraints } : {}),
    ...(option.visibleWhen ? { visibleWhen: option.visibleWhen } : {}),
    ...(option.enabledWhen ? { enabledWhen: option.enabledWhen } : {}),
  };
}

function specialCatalogs(options: CatalogOption[]) {
  const id = (role: CatalogOption['role']) => options.find((option) => option.role === role)?.id;
  return {
    ...(id('model') ? { model: id('model') } : {}),
    ...(id('effort') ? { thinking: id('effort') } : {}),
    ...(id('fast') ? { fast: id('fast') } : {}),
    ...(id('approval_mode') ? { approvalMode: id('approval_mode') } : {}),
  };
}

function sessionConfigFromRequested(
  options: CatalogOption[],
  requested: Record<string, unknown>,
): Record<string, ConfigValue> {
  const next: Record<string, ConfigValue> = {};
  for (const option of options) {
    const value = requested[option.id] !== undefined
      ? requested[option.id]
      : option.defaultValue;
    if (isConfigValue(value)) next[option.id] = value;
  }
  return next;
}

export function validateCatalogConfig(
  options: readonly CatalogOption[],
  config: Record<string, unknown>,
  binding: 'session' | 'turn',
): Record<string, ConfigValue> {
  const advertised = new Map(options.map((option) => [option.id, option]));
  const next: Record<string, ConfigValue> = {};
  for (const [configId, value] of Object.entries(config)) {
    const option = advertised.get(configId);
    if (!option) {
      throw new CodexProtocolError('CONFIG_VALUE_INVALID', `Unknown config option ${configId}.`);
    }
    if (option.binding !== binding) {
      throw new CodexProtocolError(
        'CONFIG_BINDING_INVALID',
        `Codex config ${configId} is ${option.binding}-bound, not ${binding}-bound.`,
      );
    }
    if (!isConfigValue(value)) {
      throw new CodexProtocolError('CONFIG_VALUE_INVALID', `Codex config ${configId} must be a config value.`);
    }
    if (
      option.control === 'select'
      && value !== null
      && !option.choices?.some((choice) => Object.is(choice.value, value))
    ) {
      throw new CodexProtocolError('CONFIG_VALUE_INVALID', `Unknown choice for ${configId}.`);
    }
    if (option.control === 'boolean' && value !== null && typeof value !== 'boolean') {
      throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} must be a boolean.`);
    }
    if (option.control === 'number' && value !== null) {
      if (typeof value !== 'number') {
        throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} must be a number.`);
      }
      const { minimum, maximum, step } = option.constraints ?? {};
      if (minimum !== undefined && value < minimum) {
        throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} is below its minimum.`);
      }
      if (maximum !== undefined && value > maximum) {
        throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} exceeds its maximum.`);
      }
      if (step !== undefined) {
        const origin = minimum ?? 0;
        const units = (value - origin) / step;
        if (Math.abs(units - Math.round(units)) > Number.EPSILON * 10) {
          throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} does not match its step.`);
        }
      }
    }
    if (option.control === 'text' && value !== null) {
      if (typeof value !== 'string') {
        throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} must be text.`);
      }
      const length = [...value].length;
      const { minimumLength, maximumLength } = option.constraints ?? {};
      if (minimumLength !== undefined && length < minimumLength) {
        throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} is shorter than its minimum length.`);
      }
      if (maximumLength !== undefined && length > maximumLength) {
        throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${configId} exceeds its maximum length.`);
      }
    }
    next[configId] = value;
  }
  const resolved = sessionConfigFromRequested(
    [...advertised.values()].filter((option) => option.binding === binding),
    next,
  );
  for (const option of advertised.values()) {
    if (option.binding !== binding) continue;
    const visible = conditionsMatch(option.visibleWhen, resolved);
    const enabled = conditionsMatch(option.enabledWhen, resolved);
    if (Object.prototype.hasOwnProperty.call(next, option.id) && (!visible || !enabled)) {
      throw new CodexProtocolError('CONFIG_VALUE_INVALID', `${option.id} is not currently enabled.`);
    }
    if (option.required && visible && enabled && (resolved[option.id] === null || resolved[option.id] === undefined)) {
      throw new CodexProtocolError('CONFIG_REQUIRED', `${option.id} is required.`);
    }
  }
  return next;
}

function configString(config: Record<string, ConfigValue>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function configChoice<T extends string>(
  config: Record<string, ConfigValue>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = config[key];
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
}

type CodexApprovalMode = 'ask' | 'auto' | 'full-access' | 'custom';

function approvalModeParams(mode: CodexApprovalMode): {
  sandbox?: SandboxMode;
  useConfiguredPermissions?: boolean;
  approvalPolicy?: Extract<ApprovalPolicy, string>;
  approvalsReviewer?: ApprovalsReviewer;
} {
  switch (mode) {
    case 'ask':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      };
    case 'auto':
      return {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    case 'full-access':
      return {
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        approvalsReviewer: 'auto_review',
      };
    case 'custom':
      return { useConfiguredPermissions: true };
  }
}

function conditionsMatch(
  conditions: CatalogCondition[] | undefined,
  config: Record<string, ConfigValue>,
): boolean {
  return (conditions ?? []).every((condition) => (
    Object.prototype.hasOwnProperty.call(config, condition.optionId)
    && condition.oneOf.some((candidate) => Object.is(candidate, config[condition.optionId]))
  ));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function questionInputs(payload: unknown): InteractionInput[] {
  const source = record(payload);
  const questions = Array.isArray(source.questions) ? source.questions : [];
  const inputs: Array<{
    id: string;
    type: 'single_select' | 'text';
    label: string;
    required: boolean;
    description?: string;
    choices?: Array<{ value: string; displayName: string }>;
  }> = [];
  for (const raw of questions) {
    const question = record(raw);
    const id = nonEmptyString(question.id);
    const label = typeof question.question === 'string' ? question.question : '';
    if (!id || !label) continue;
    const options = Array.isArray(question.options) ? question.options : [];
    const choices = options.flatMap((rawOption) => {
      const option = record(rawOption);
      if (typeof option.label !== 'string' || !option.label) return [];
      return [{ value: option.label, displayName: option.label }];
    });
    const description = typeof question.header === 'string' && question.header
      ? question.header
      : undefined;
    inputs.push(choices.length > 0
      ? {
        id,
        type: 'single_select',
        label,
        required: false,
        ...(description ? { description } : {}),
        choices,
      }
      : {
        id,
        type: 'text',
        label,
        required: false,
        ...(description ? { description } : {}),
      });
  }
  return inputs;
}

function answersFromValues(values: Record<string, unknown>): Record<string, string | string[]> | undefined {
  const answers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') answers[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      answers[key] = value;
    }
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function validateInteractionValues(
  inputs: InteractionInput[],
  values: Record<string, unknown>,
): void {
  const byId = new Map(inputs.map((input) => [input.id, input]));
  for (const key of Object.keys(values)) {
    if (!byId.has(key)) {
      throw new CodexJsonRpcError(-32602, `Unknown interaction input ${key}.`);
    }
  }
  for (const input of inputs) {
    const value = values[input.id];
    if (value === undefined) {
      if (input.required) throw new CodexJsonRpcError(-32602, `Interaction input ${input.id} is required.`);
      continue;
    }
    if (typeof value !== 'string') {
      throw new CodexJsonRpcError(-32602, `Interaction input ${input.id} must be a string.`);
    }
    if (
      input.type === 'single_select'
      && !input.choices?.some((choice) => choice.value === value)
    ) {
      throw new CodexJsonRpcError(-32602, `Interaction input ${input.id} has an invalid choice.`);
    }
  }
}

function interactionActions(method: string, scopeOptions: unknown) {
  if (method === REQUEST_USER_INPUT_METHOD) {
    return [
      { id: 'submit', label: 'Submit', style: 'primary' as const },
      { id: 'cancel', label: 'Cancel', style: 'danger' as const },
    ];
  }
  if (method === 'item/permissions/requestApproval') {
    return [
      { id: 'grantForTurn', label: 'Grant for turn', style: 'primary' as const },
      { id: 'grantForSession', label: 'Grant for session', style: 'secondary' as const },
      { id: 'deny', label: 'Deny', style: 'danger' as const },
    ];
  }
  const allowSession = Array.isArray(scopeOptions) && scopeOptions.includes('session');
  return [
    { id: 'accept', label: 'Accept', style: 'primary' as const },
    ...(allowSession
      ? [{ id: 'acceptForSession', label: 'Accept for session', style: 'secondary' as const }]
      : []),
    { id: 'decline', label: 'Decline', style: 'danger' as const },
  ];
}

function approvalResponse(
  method: string,
  actionId: string,
): { decision: 'accept' | 'decline'; scope: 'once' | 'session' } | null {
  if (method === REQUEST_USER_INPUT_METHOD) {
    if (actionId === 'submit') return { decision: 'accept', scope: 'once' };
    if (actionId === 'cancel') return { decision: 'decline', scope: 'once' };
    return null;
  }
  if (method === 'item/permissions/requestApproval') {
    if (actionId === 'grantForTurn') return { decision: 'accept', scope: 'once' };
    if (actionId === 'grantForSession') return { decision: 'accept', scope: 'session' };
    if (actionId === 'deny') return { decision: 'decline', scope: 'once' };
    return null;
  }
  if (actionId === 'accept') return { decision: 'accept', scope: 'once' };
  if (actionId === 'acceptForSession') return { decision: 'accept', scope: 'session' };
  if (actionId === 'decline') return { decision: 'decline', scope: 'once' };
  return null;
}

function agentState(status: unknown): 'running' | 'completed' | 'failed' | 'interrupted' {
  if (status === 'done' || status === 'completed') return 'completed';
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  return 'running';
}

function agentActivityStatus(state: 'running' | 'completed' | 'failed' | 'interrupted') {
  if (state === 'completed') return 'succeeded' as const;
  if (state === 'failed') return 'failed' as const;
  if (state === 'interrupted') return 'cancelled' as const;
  return 'running' as const;
}

function sanitizeUsage(data: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(data, 'context')) {
    const context = data.context;
    if (context === null) {
      const next: Record<string, unknown> = { context: null };
      const conversation = record(data.conversation);
      if (conversation.mode === 'reset') next.conversation = { mode: 'reset' };
      return next;
    }
    const canonical = record(context);
    const used = nonNegativeInteger(canonical.used);
    const window = nonNegativeInteger(canonical.window);
    if (used !== undefined) {
      return { context: { used, ...(window && window > 0 ? { window } : {}) } };
    }
  }

  const tokenUsage = record(record(data.params).tokenUsage);
  const total = record(tokenUsage.total);
  const last = record(tokenUsage.last);
  const inputTokens = nonNegativeInteger(total.inputTokens);
  const outputTokens = nonNegativeInteger(total.outputTokens);
  const cachedInputTokens = nonNegativeInteger(total.cachedInputTokens);
  const totalTokens = nonNegativeInteger(total.totalTokens);
  const used = nonNegativeInteger(last.totalTokens);
  const window = nonNegativeInteger(tokenUsage.modelContextWindow);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cachedInputTokens === undefined
    || totalTokens === undefined
    || used === undefined
  ) return null;
  return {
    context: { used, ...(window && window > 0 ? { window } : {}) },
    conversation: {
      mode: 'absolute',
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
    },
  };
}

export class CodexProtocolV2Adapter {
  private readonly sessions = new Map<string, AttachedSession>();
  private readonly sessionCreateFingerprints = new Map<string, string>();
  private readonly sessionByServiceId = new Map<string, AttachedSession>();
  private readonly turnsByRequest = new Map<string, HostTurnRef>();
  private readonly requestByTurn = new Map<string, string>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly sourceTurnByHostTurn = new Map<string, string>();
  private readonly hostTurnBySourceTurn = new Map<string, string>();
  private readonly pendingInputByTurn = new Map<string, unknown[]>();
  private readonly acceptedInputBatchesByTurn = new Map<string, unknown[][]>();
  private readonly eventOccurrences = new Map<string, number>();
  private readonly emittedFactsByTurn = new Map<string, Map<string, string>>();
  private readonly startedTurns = new Set<string>();
  private readonly pendingUsageByTurn = new Map<string, Record<string, unknown>>();
  private readonly terminalTurns = new Set<string>();
  private readonly interruptedTurns = new Set<string>();
  private readonly interactions = new Map<string, InteractionRef>();
  private readonly interactionResponses = new Map<string, {
    sessionId: string;
    fingerprint: string;
    result: { accepted: true; interactionId: string; responseId: string };
  }>();
  private readonly openActivitiesByTurn = new Map<string, Map<string, ActivityDescriptor>>();
  private readonly activityOutputByTurn = new Map<string, Map<string, string>>();
  private readonly openContentByTurn = new Map<string, Map<string, OpenContent>>();
  private readonly replayBySession = new Map<string, NativeReplay>();
  private readonly replayTrackers = new Map<string, IncrementalReplayTracker>();
  private readonly replayPager = new ReplayPager();
  private readonly historyWatchers = new Map<string, CodexNativeHistoryWatcher>();
  private readonly ledger = new TurnLedger();
  private readonly advertisedOptions = new Map<string, CatalogOption>();
  private readonly identityStore = new NativeTurnIdentityStore();
  private readonly resumeStore = new OpaqueSidechatResumeStore();
  private readonly sidechats = new Map<string, SidechatRecord>();
  private readonly terminalOrderBySession = new Map<string, string[]>();
  private readonly forkResults = new Map<string, { fingerprint: string; result: unknown }>();
  private initialized = false;
  private catalogRevision = 'codex-empty';

  constructor(
    private readonly service: CodexProxyService,
    private readonly pluginVersion: string,
    private readonly emitEvent: V2EventSink,
  ) {
    service.setEventSink((method, params) => this.translateEvent(method, params));
  }

  async handle(request: WireRequest): Promise<unknown> {
    if (!this.initialized && request.method !== 'initialize' && request.method !== 'shutdown') {
      throw new CodexProtocolError('NOT_INITIALIZED', 'initialize must be the first request.');
    }
    switch (request.method) {
      case 'initialize': return this.initialize(request.params);
      case 'catalog.list': return this.catalog();
      case 'session.create': return this.createSession(request.params);
      case 'session.get': return { session: this.serialize(this.requireOrdinarySession(String(request.params.sessionId ?? ''))) };
      case 'sidechat.create': return this.createSidechat(request.params);
      case 'sidechat.resume': return this.resumeSidechat(request.params);
      case 'sidechat.close': return this.closeSidechat(request.params);
      case 'session.fork': return this.forkSession(request.params);
      case 'turn.start': return this.startTurn(request.params, request.id);
      case 'turn.interrupt': return this.interruptTurn(request.params);
      case 'turn.steer': return this.steer(request.params);
      case 'interaction.respond': return this.respondInteraction(request.params);
      case 'session.close': return this.closeSession(request.params);
      case 'session.rename': return this.renameSession(request.params);
      case 'session.native.list': return this.listNative(request.params);
      case 'session.replay': return this.replay(request.params);
      case 'session.native.delete':
      case 'catalog.resolve':
        throw new CodexProtocolError(
          'CAPABILITY_NOT_SUPPORTED',
          `${request.method} is not advertised by Codex Proxy.`,
        );
      case 'shutdown': return { ok: true };
      default:
        throw new CodexJsonRpcError(-32601, `Unknown method "${request.method}".`);
    }
  }

  private initialize(params: Record<string, unknown>) {
    if (this.initialized) {
      throw new CodexProtocolError('ALREADY_INITIALIZED', 'initialize can only be called once.');
    }
    const protocol = record(params.protocol);
    const versions = Array.isArray(protocol.versions) ? protocol.versions.map(String) : [];
    if (protocol.name !== PROTOCOL_NAME || !versions.includes(PROTOCOL_V2)) {
      throw new CodexProtocolError('INCOMPATIBLE_PROTOCOL', 'gian.proxy/2.1 is required.');
    }
    this.initialized = true;
    return {
      protocol: { name: PROTOCOL_NAME, version: PROTOCOL_V2 },
      plugin: { id: 'codex', name: 'Codex', version: this.pluginVersion },
      process: { scope: 'shared' as const },
      capabilities: CAPABILITIES,
    };
  }

  private async catalog() {
    const capabilities = await this.service.listCapabilities();
    const advertised = catalogConfigOptions(capabilities);
    const configOptions = advertised.map(serializeOption);
    this.advertisedOptions.clear();
    for (const option of catalogConfigOptions(capabilities)) {
      this.advertisedOptions.set(option.id, option);
    }
    const slashCommands = [] as Array<{
      name: string;
      description: string;
      source: 'builtin' | 'user' | 'project';
      argHints: Array<{ kind: 'free' | 'model' | 'path' | 'agent' | 'enum'; placeholder?: string }>;
    }>;
    const attached = this.sessions.values().next().value as AttachedSession | undefined;
    try {
      const listed = await this.service.listSlashCommands(attached?.cwd);
      for (const command of listed.commands) {
        slashCommands.push({
          name: command.name.startsWith('/') ? command.name : `/${command.name}`,
          description: command.description ?? '',
          source: command.source,
          argHints: (command.argHints ?? []).map((hint) => ({
            kind: hint.kind,
            ...(hint.placeholder ? { placeholder: hint.placeholder } : {}),
          })),
        });
      }
    } catch {
      /* catalog remains valid without session commands */
    }
    const payload = {
      catalogRevision: '',
      input: [
        { type: 'text' as const },
        { type: 'localImage' as const },
        { type: 'skill' as const },
      ],
      configOptions,
      specialCatalogs: specialCatalogs(advertised),
      actions: [
        { id: 'sidechat.create', supported: true },
        { id: 'session.fork', supported: true },
        { id: 'session.fork.atTurn', supported: true },
      ],
      slashCommands,
    };
    payload.catalogRevision = stableId('catalog', {
      input: payload.input,
      configOptions,
      specialCatalogs: payload.specialCatalogs,
      actions: payload.actions,
    });
    this.catalogRevision = payload.catalogRevision;
    return payload;
  }

  private advertised(): CatalogOption[] {
    if (this.advertisedOptions.size > 0) return [...this.advertisedOptions.values()];
    return catalogConfigOptions({
      protocolVersion: '0.1.0',
      models: [],
      modes: [],
      slashCommands: [],
    });
  }

  private validateConfig(
    config: Record<string, unknown>,
    binding: 'session' | 'turn',
  ): Record<string, ConfigValue> {
    return validateCatalogConfig(this.advertised(), config, binding);
  }

  private async createSession(params: Record<string, unknown>) {
    const sessionId = nonEmptyString(params.sessionId);
    if (!sessionId) throw new CodexJsonRpcError(-32602, 'sessionId is required.');
    const workspace = record(params.workspace);
    const cwd = nonEmptyString(workspace.cwd);
    if (!cwd) throw new CodexJsonRpcError(-32602, 'workspace.cwd is required.');
    const roots = Array.isArray(workspace.roots)
      ? workspace.roots.filter((item): item is string => typeof item === 'string')
      : [];
    if (roots.length === 0) {
      throw new CodexJsonRpcError(-32602, 'workspace.roots must contain at least one path.');
    }
    const fingerprint = stableStringify({
      workspace: { cwd, roots },
      nativeSession: params.nativeSession,
      forkBoundaries: params.forkBoundaries,
      config: params.config,
      hostServices: params.hostServices,
    });
    const previousFingerprint = this.sessionCreateFingerprints.get(sessionId);
    if (previousFingerprint !== undefined) {
      if (previousFingerprint !== fingerprint) {
        throw new CodexProtocolError(
          'CONFLICT',
          `Session ${sessionId} was reused with different creation parameters.`,
        );
      }
      const existing = this.sessions.get(sessionId);
      if (!existing) {
        throw new CodexProtocolError('SESSION_CLOSED', `Session ${sessionId} is closed.`);
      }
      return { session: this.serialize(existing) };
    }
    if (this.sidechats.has(sessionId)) {
      throw new CodexProtocolError('CONFLICT', `Session ${sessionId} is already a Side Chat.`);
    }
    if (this.sessions.has(sessionId)) {
      throw new CodexProtocolError('CONFLICT', `Session ${sessionId} is already attached.`);
    }
    const hostServiceConfig = codexHostServiceConfig(params.hostServices);
    await this.catalog();
    const config = this.validateConfig(record(params.config), 'session');
    const native = record(params.nativeSession);
    const nativeSessionId = nonEmptyString(native.id);
    const history = nonEmptyString(native.history);
    const result = await this.service.createSession({
      cwd,
      ...(nativeSessionId ? { threadId: nativeSessionId } : {}),
      ...(hostServiceConfig ? { config: hostServiceConfig } : {}),
    });
    const serviceSession = result.session as {
      id: string;
      threadId: string;
      status: 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';
      lastError: string | null;
      createdAt: string;
      updatedAt: string;
    };
    const session: AttachedSession = {
      id: sessionId,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.threadId,
      streamId: randomUUID(),
      cwd,
      roots,
      state: serviceSession.status === 'needs-approval' ? 'waiting_interaction' : 'idle',
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      sessionConfig: sessionConfigFromRequested(
        this.advertised().filter((option) => option.binding === 'session'),
        config,
      ),
      sequence: 0,
    };
    this.restoreForkBoundaries(session, params.forkBoundaries);
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.ledger.attach(session.id, session.streamId);
    const replayTracker = new IncrementalReplayTracker();
    replayTracker.attach(
      replayCodexNativeSession(session.id, session.nativeSessionId, undefined, this.identityStore),
      Boolean(nativeSessionId) && history !== 'none',
    );
    this.replayTrackers.set(session.id, replayTracker);
    this.replayBySession.set(session.id, replayTracker.replay());
    const historyWatcher = new CodexNativeHistoryWatcher(
      session.nativeSessionId,
      () => {
        if (!this.sessions.has(session.id)) return;
        const full = replayCodexNativeSession(
          session.id,
          session.nativeSessionId,
          undefined,
          this.identityStore,
        );
        if (!replayTracker.observe(full)) return;
        this.replayBySession.set(session.id, replayTracker.replay());
        this.emitSessionEvent('history.changed', session, {
          reason: 'native-history-changed',
        });
      },
    );
    historyWatcher.start();
    this.historyWatchers.set(session.id, historyWatcher);
    void this.publishCatalogIfCommandsArrive(session);
    this.sessionCreateFingerprints.set(session.id, fingerprint);
    return { session: this.serialize(session) };
  }

  private async createSidechat(params: Record<string, unknown>) {
    const parentSessionId = nonEmptyString(params.parentSessionId);
    const parentStreamId = nonEmptyString(params.parentStreamId);
    const sidechatId = nonEmptyString(params.sidechatId);
    if (!parentSessionId || !parentStreamId || !sidechatId) {
      throw new CodexJsonRpcError(-32602, 'parentSessionId, parentStreamId, and sidechatId are required.');
    }
    const parent = this.requireOrdinaryAttached(parentSessionId, parentStreamId);
    const fingerprint = stableStringify({ parentSessionId, parentStreamId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw new CodexProtocolError('CONFLICT', 'sidechatId was reused with a different parent.');
      }
      return { sidechat: this.serializeSidechat(this.requireSession(sidechatId), existing) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new CodexProtocolError('CONFLICT', 'sidechatId already belongs to an ordinary Session.');
    }
    const anchor = this.sidechatAnchor(parent);
    const forked = await this.service.forkSession({
      sessionId: parent.serviceSessionId,
      ...(anchor.type === 'turn' ? { lastTurnId: anchor.sourceTurnId } : {}),
      ...(anchor.type === 'activeInput'
        ? {
            beforeTurnId: anchor.sourceTurnId,
            activeInput: (this.acceptedInputBatchesByTurn.get(
              this.turnKey(parent.id, anchor.turnId),
            ) ?? []).map((batch) => this.codexInput(batch)),
          }
        : {}),
    });
    const serviceSession = forked.session as ServiceSessionShape;
    const session = this.attachForkedSession(sidechatId, parent, serviceSession);
    const createdAt = new Date().toISOString();
    const resumeRef = this.resumeStore.seal({
      sidechatId,
      parentSessionId,
      nativeSessionId: session.nativeSessionId,
      anchor,
      sessionConfig: session.sessionConfig,
      createdAt,
    });
    const record: SidechatRecord = {
      parentSessionId,
      resumeRefId: resumeRef.id,
      anchor,
      createFingerprint: fingerprint,
    };
    this.sidechats.set(sidechatId, record);
    return { sidechat: this.serializeSidechat(session, record, createdAt) };
  }

  private async resumeSidechat(params: Record<string, unknown>) {
    const sidechatId = nonEmptyString(params.sidechatId);
    const parentSessionId = nonEmptyString(params.parentSessionId);
    const resumeRefId = nonEmptyString(record(params.resumeRef).id);
    if (!sidechatId || !parentSessionId || !resumeRefId) {
      throw new CodexJsonRpcError(-32602, 'sidechatId, parentSessionId, and resumeRef are required.');
    }
    if (this.resumeStore.closed(resumeRefId)) {
      throw new CodexProtocolError('SIDECHAT_UNAVAILABLE', 'Side Chat was already closed.');
    }
    const payload = this.resumeStore.open(resumeRefId);
    if (!payload) throw new CodexProtocolError('SIDECHAT_UNAVAILABLE', 'Side Chat resume reference is unavailable.');
    if (payload.sidechatId !== sidechatId || payload.parentSessionId !== parentSessionId) {
      throw new CodexProtocolError('CONFLICT', 'Side Chat resume identity does not match.');
    }
    const parent = this.requireOrdinarySession(parentSessionId);
    const fingerprint = stableStringify({ parentSessionId, resumeRefId });
    const existing = this.sidechats.get(sidechatId);
    if (existing) {
      if (existing.resumeFingerprint !== fingerprint) {
        throw new CodexProtocolError('CONFLICT', 'Side Chat is already attached with another resume reference.');
      }
      return { sidechat: this.serializeSidechat(this.requireSession(sidechatId), existing, payload.createdAt) };
    }
    if (this.sessions.has(sidechatId)) {
      throw new CodexProtocolError('CONFLICT', 'sidechatId already belongs to an ordinary Session.');
    }
    const resumed = await this.service.createSession({ cwd: parent.cwd, threadId: payload.nativeSessionId });
    const session = this.attachForkedSession(
      sidechatId,
      parent,
      resumed.session as ServiceSessionShape,
      payload.sessionConfig,
    );
    const next: SidechatRecord = {
      parentSessionId,
      resumeRefId,
      anchor: payload.anchor as SidechatAnchor,
      resumeFingerprint: fingerprint,
    };
    this.sidechats.set(sidechatId, next);
    return { sidechat: this.serializeSidechat(session, next, payload.createdAt) };
  }

  private async closeSidechat(params: Record<string, unknown>) {
    const sidechatId = nonEmptyString(params.sidechatId);
    const resumeRefId = nonEmptyString(record(params.resumeRef).id);
    const streamId = params.streamId === undefined ? null : nonEmptyString(params.streamId);
    if (!sidechatId || !resumeRefId || (params.streamId !== undefined && !streamId)) {
      throw new CodexJsonRpcError(-32602, 'sidechatId and resumeRef are required; streamId must be non-empty.');
    }
    const closed = this.resumeStore.closed(resumeRefId);
    if (closed) {
      return {
        ok: true as const,
        sidechatId,
        providerDataDeleted: closed.sidechatId === sidechatId ? closed.providerDataDeleted : false,
      };
    }
    const payload = this.resumeStore.open(resumeRefId);
    if (payload && payload.sidechatId !== sidechatId) {
      throw new CodexProtocolError('CONFLICT', 'resumeRef belongs to another live Side Chat.');
    }
    const live = this.sidechats.get(sidechatId);
    if (live && live.resumeRefId !== resumeRefId) {
      throw new CodexProtocolError('CONFLICT', 'resumeRef belongs to another Side Chat attachment.');
    }
    if (live) {
      const session = this.requireSession(sidechatId);
      if (streamId && session.streamId !== streamId) {
        throw new CodexProtocolError('SESSION_STALE', 'Side Chat stream is stale.');
      }
      await this.detachSession(session);
      this.sidechats.delete(sidechatId);
    }
    let providerDataDeleted = false;
    if (payload) {
      providerDataDeleted = await this.service.archiveNativeThread(payload.nativeSessionId);
    }
    this.resumeStore.rememberClosed(resumeRefId, { sidechatId, providerDataDeleted });
    return { ok: true as const, sidechatId, providerDataDeleted };
  }

  private async forkSession(params: Record<string, unknown>) {
    const sourceSessionId = nonEmptyString(params.sourceSessionId);
    const sourceStreamId = nonEmptyString(params.sourceStreamId);
    const sessionId = nonEmptyString(params.sessionId);
    const anchor = record(params.anchor);
    if (!sourceSessionId || !sourceStreamId || !sessionId || (anchor.type !== 'head' && anchor.type !== 'turn')) {
      throw new CodexJsonRpcError(-32602, 'sourceSessionId, sourceStreamId, sessionId, and anchor are required.');
    }
    const fingerprint = stableStringify({
      sourceSessionId,
      sourceStreamId,
      anchor,
      hostServices: params.hostServices,
    });
    const previous = this.forkResults.get(sessionId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new CodexProtocolError('CONFLICT', 'Fork sessionId was reused with another source boundary.');
      }
      return previous.result;
    }
    if (this.sessions.has(sessionId)) {
      throw new CodexProtocolError('CONFLICT', 'Fork sessionId already belongs to another Session.');
    }
    const source = this.requireOrdinaryAttached(sourceSessionId, sourceStreamId);
    const boundary = this.forkBoundary(source, anchor);
    const hostServiceConfig = codexHostServiceConfig(params.hostServices);
    const forked = await this.service.forkSession({
      sessionId: source.serviceSessionId,
      lastTurnId: boundary.sourceTurnId,
      ...(hostServiceConfig ? { config: hostServiceConfig } : {}),
    });
    const child = this.attachForkedSession(
      sessionId,
      source,
      forked.session as ServiceSessionShape,
    );
    this.attachNativeReplay(child, true);
    const result = {
      session: this.serialize(child),
      origin: {
        kind: 'fork' as const,
        sessionId: source.id,
        turnId: boundary.turnId,
        sourceTurnId: boundary.sourceTurnId,
      },
    };
    this.forkResults.set(sessionId, { fingerprint, result });
    return result;
  }

  private attachForkedSession(
    id: string,
    parent: AttachedSession,
    serviceSession: ServiceSessionShape,
    sessionConfig: Record<string, ConfigValue> = parent.sessionConfig,
  ): AttachedSession {
    const session: AttachedSession = {
      id,
      serviceSessionId: serviceSession.id,
      nativeSessionId: serviceSession.threadId,
      streamId: randomUUID(),
      cwd: parent.cwd,
      roots: [...parent.roots],
      state: serviceSession.status === 'needs-approval' ? 'waiting_interaction' : 'idle',
      lastError: serviceSession.lastError,
      createdAt: serviceSession.createdAt,
      updatedAt: serviceSession.updatedAt,
      sessionConfig: { ...sessionConfig },
      sequence: 0,
    };
    this.sessions.set(session.id, session);
    this.sessionByServiceId.set(session.serviceSessionId, session);
    this.ledger.attach(session.id, session.streamId);
    return session;
  }

  private attachNativeReplay(session: AttachedSession, importExisting: boolean): void {
    const replayTracker = new IncrementalReplayTracker();
    replayTracker.attach(
      replayCodexNativeSession(session.id, session.nativeSessionId, undefined, this.identityStore),
      importExisting,
    );
    this.replayTrackers.set(session.id, replayTracker);
    this.replayBySession.set(session.id, replayTracker.replay());
    const historyWatcher = new CodexNativeHistoryWatcher(
      session.nativeSessionId,
      () => {
        if (!this.sessions.has(session.id)) return;
        const full = replayCodexNativeSession(
          session.id,
          session.nativeSessionId,
          undefined,
          this.identityStore,
        );
        if (!replayTracker.observe(full)) return;
        this.replayBySession.set(session.id, replayTracker.replay());
        this.emitSessionEvent('history.changed', session, { reason: 'native-history-changed' });
      },
    );
    historyWatcher.start();
    this.historyWatchers.set(session.id, historyWatcher);
  }

  private sidechatAnchor(session: AttachedSession): SidechatAnchor {
    const activeTurnId = this.activeTurnBySession.get(session.id);
    if (activeTurnId) {
      const key = this.turnKey(session.id, activeTurnId);
      const sourceTurnId = this.sourceTurnByHostTurn.get(key);
      const inputBatches = this.acceptedInputBatchesByTurn.get(key);
      if (sourceTurnId && inputBatches?.length) {
        return { type: 'activeInput', turnId: activeTurnId, sourceTurnId };
      }
      throw new CodexProtocolError(
        'FORK_BOUNDARY_UNAVAILABLE',
        'The active input has not established a stable Provider Turn boundary yet.',
      );
    }
    if (session.state !== 'idle') {
      throw new CodexProtocolError('SESSION_BUSY', 'Side Chat requires an idle or active parent Session.');
    }
    const boundary = this.latestTerminalBoundary(session.id);
    if (boundary) return { type: 'turn', ...boundary };
    if ((this.replayBySession.get(session.id)?.events.length ?? 0) === 0) return { type: 'empty' };
    throw new CodexProtocolError(
      'FORK_BOUNDARY_UNAVAILABLE',
      'No stable Host turn identity is available in this attach generation.',
    );
  }

  private forkBoundary(
    session: AttachedSession,
    anchor: Record<string, unknown>,
  ): { turnId: string; sourceTurnId: string } {
    if (this.activeTurnBySession.has(session.id)) {
      throw new CodexProtocolError('SESSION_BUSY', 'Fork requires an idle source Session.');
    }
    if (anchor.type === 'head') {
      const latest = this.latestTerminalBoundary(session.id);
      if (latest) return latest;
    } else {
      const turnId = nonEmptyString(anchor.turnId);
      const sourceTurnId = nonEmptyString(anchor.sourceTurnId);
      if (
        turnId
        && sourceTurnId
        && this.terminalTurns.has(this.turnKey(session.id, turnId))
        && this.sourceTurnByHostTurn.get(this.turnKey(session.id, turnId)) === sourceTurnId
      ) {
        return { turnId, sourceTurnId };
      }
    }
    throw new CodexProtocolError('FORK_BOUNDARY_UNAVAILABLE', 'Fork requires the exact terminal Turn.');
  }

  private latestTerminalBoundary(sessionId: string): { turnId: string; sourceTurnId: string } | null {
    const turns = this.terminalOrderBySession.get(sessionId) ?? [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turnId = turns[index]!;
      const sourceTurnId = this.sourceTurnByHostTurn.get(this.turnKey(sessionId, turnId));
      if (sourceTurnId) return { turnId, sourceTurnId };
    }
    return null;
  }

  private restoreForkBoundaries(session: AttachedSession, value: unknown): void {
    if (!Array.isArray(value)) return;
    const order: string[] = [];
    for (const item of value) {
      const boundary = record(item);
      const turnId = nonEmptyString(boundary.turnId);
      const sourceTurnId = nonEmptyString(boundary.sourceTurnId);
      if (!turnId || !sourceTurnId || order.includes(turnId)) continue;
      const hostKey = this.turnKey(session.id, turnId);
      this.sourceTurnByHostTurn.set(hostKey, sourceTurnId);
      this.hostTurnBySourceTurn.set(this.turnKey(session.id, sourceTurnId), turnId);
      this.terminalTurns.add(hostKey);
      order.push(turnId);
    }
    if (order.length > 0) this.terminalOrderBySession.set(session.id, order);
  }

  private availableActions(session: AttachedSession) {
    const activeTurnId = this.activeTurnBySession.get(session.id);
    const activeKey = activeTurnId ? this.turnKey(session.id, activeTurnId) : null;
    const activeInputReady = Boolean(
      activeKey
      && this.sourceTurnByHostTurn.has(activeKey)
      && this.acceptedInputBatchesByTurn.get(activeKey)?.length,
    );
    const idle = !activeTurnId && session.state === 'idle';
    const boundary = this.latestTerminalBoundary(session.id);
    const historyEmpty = (this.replayBySession.get(session.id)?.events.length ?? 0) === 0;
    const sidechatEnabled = activeInputReady || (idle && (boundary !== null || historyEmpty));
    const sidechatReason = activeTurnId
      ? 'Wait for the active input boundary to become available.'
      : !idle
        ? 'The Session is not available for a Side Chat.'
        : 'No stable terminal turn is available in this attach generation.';
    const forkUnavailableReason = !idle
      ? 'Wait for the active turn to finish.'
      : 'No stable terminal turn is available in this attach generation.';
    return {
      'sidechat.create': {
        enabled: sidechatEnabled,
        ...(sidechatEnabled ? {} : { reason: sidechatReason }),
      },
      'session.fork': {
        enabled: idle && boundary !== null,
        ...(idle && boundary !== null ? {} : { reason: forkUnavailableReason }),
      },
      'session.fork.atTurn': {
        enabled: idle && boundary !== null,
        ...(idle && boundary !== null ? {} : { reason: forkUnavailableReason }),
      },
    };
  }

  private serializeSidechat(
    session: AttachedSession,
    sidechat: SidechatRecord,
    createdAt = session.createdAt,
  ) {
    return {
      id: session.id,
      parentSessionId: sidechat.parentSessionId,
      streamId: session.streamId,
      state: session.state,
      resumeRef: { id: sidechat.resumeRefId },
      anchor: sidechat.anchor,
      sessionConfig: session.sessionConfig,
      lastError: session.lastError,
      createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private async publishCatalogIfCommandsArrive(session: AttachedSession): Promise<void> {
    try {
      const listed = await this.service.listSlashCommands(session.cwd);
      if (listed.commands.length === 0) return;
      this.emitEvent('catalog.changed', {
        eventId: randomUUID(),
        emittedAt: new Date().toISOString(),
        data: { reason: 'available-commands', revision: this.catalogRevision },
      });
    } catch {
      /* slash discovery is optional */
    }
  }

  private codexInput(items: unknown[]): InputItem[] {
    return items.map((raw) => {
      const item = record(raw);
      switch (item.type) {
        case 'text':
          return { type: 'text' as const, text: String(item.text ?? '') };
        case 'localImage':
          return { type: 'localImage' as const, path: String(item.path ?? '') };
        case 'skill':
          return {
            type: 'skill' as const,
            name: String(item.name ?? ''),
            path: String(item.path ?? ''),
          };
        case 'localFile':
          throw new CodexProtocolError(
            'CAPABILITY_NOT_SUPPORTED',
            'Codex Proxy does not advertise input.localFile.',
          );
        default:
          throw new CodexJsonRpcError(-32602, 'Unsupported input item.');
      }
    });
  }

  private async startTurn(params: Record<string, unknown>, requestId: string) {
    const sessionId = String(params.sessionId ?? '');
    const streamId = String(params.streamId ?? '');
    const turnId = nonEmptyString(params.turnId);
    if (!turnId) throw new CodexJsonRpcError(-32602, 'turnId is required.');
    const session = this.requireAttached(sessionId, streamId);
    const input = Array.isArray(params.input) ? params.input : [];
    if (input.length === 0) throw new CodexJsonRpcError(-32602, 'input is required.');
    const config = this.validateConfig(record(params.config), 'turn');
    const accepted = this.ledger.accept({ sessionId, streamId, turnId, input, config });
    if (accepted === 'duplicate') return { accepted: true as const, turnId };
    if (this.activeTurnBySession.has(session.id)) {
      this.ledger.forget({ sessionId, streamId, turnId });
      throw new CodexProtocolError('SESSION_BUSY', 'Session already has an active turn.');
    }
    this.turnsByRequest.set(requestId, { sessionId: session.id, turnId });
    this.requestByTurn.set(this.turnKey(session.id, turnId), requestId);
    this.activeTurnBySession.set(session.id, turnId);
    this.openActivitiesByTurn.set(this.turnKey(session.id, turnId), new Map());
    this.activityOutputByTurn.set(this.turnKey(session.id, turnId), new Map());
    this.openContentByTurn.set(this.turnKey(session.id, turnId), new Map());
    this.pendingInputByTurn.set(this.turnKey(session.id, turnId), input);
    const firstInput = record(input[0]);
    const nativeCommand = firstInput.type === 'text' && typeof firstInput.text === 'string'
      ? firstInput.text.trim().split(/\s+/, 1)[0]
      : null;
    // /compact owns a synthetic Host turn id that is not a real app-server
    // fork boundary. Keep Side Chat unavailable until compaction terminates.
    if (nativeCommand !== '/compact') {
      this.acceptedInputBatchesByTurn.set(this.turnKey(session.id, turnId), [input]);
    }
    this.historyWatchers.get(session.id)?.pause();
    try {
      const turnConfig = sessionConfigFromRequested(
        this.advertised().filter((option) => option.binding === 'turn'),
        config,
      );
      const turnModel = configString(turnConfig, 'model');
      const turnEffort = configString(turnConfig, 'effort');
      const approvalMode = configChoice<CodexApprovalMode>(turnConfig, 'approval_mode', [
        'ask',
        'auto',
        'full-access',
        'custom',
      ]) ?? 'ask';
      await this.service.startTurn({
        sessionId: session.serviceSessionId,
        input: this.codexInput(input),
        additionalWorkspaceRoots: session.roots,
        ...(turnModel ? { model: turnModel } : {}),
        ...(turnEffort ? { thinking: turnEffort } : {}),
        ...approvalModeParams(approvalMode),
        serviceTier: turnConfig.service_tier === true ? 'fast' : null,
      }, requestId);
      return { accepted: true as const, turnId };
    } catch (error) {
      this.ledger.forget({ sessionId, streamId, turnId });
      this.clearTurn(session.id, turnId);
      this.historyWatchers.get(session.id)?.resume();
      this.rebaseHistory(session);
      throw standardError(error);
    }
  }

  private async steer(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    const input = Array.isArray(params.input) ? params.input : [];
    if (input.length === 0) throw new CodexJsonRpcError(-32602, 'input is required.');
    await this.service.steerTurn({
      sessionId: session.serviceSessionId,
      input: this.codexInput(input),
    });
    const key = this.turnKey(session.id, turnId);
    const batches = this.acceptedInputBatchesByTurn.get(key);
    if (batches) {
      batches.push(input);
      this.acceptedInputBatchesByTurn.set(key, batches);
    }
    return { accepted: true as const, turnId };
  }

  private async interruptTurn(params: Record<string, unknown>) {
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    await this.service.interruptTurn({ sessionId: session.serviceSessionId });
    this.interruptedTurns.add(this.turnKey(session.id, turnId));
    this.resolveInteractionsForTurn(session, turnId, 'cancelled');
    return { accepted: true as const, turnId };
  }

  private async respondInteraction(params: Record<string, unknown>) {
    const interactionId = nonEmptyString(params.interactionId);
    const responseId = nonEmptyString(params.responseId);
    const actionId = nonEmptyString(params.actionId);
    if (!interactionId || !responseId || !actionId) {
      throw new CodexJsonRpcError(-32602, 'interactionId, responseId, and actionId are required.');
    }
    const values = record(params.values);
    const fingerprint = stableStringify({
      sessionId: params.sessionId,
      streamId: params.streamId,
      turnId: params.turnId,
      interactionId,
      actionId,
      values,
    });
    const responseLedgerKey = this.turnKey(String(params.sessionId ?? ''), responseId);
    const completed = this.interactionResponses.get(responseLedgerKey);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new CodexProtocolError('CONFLICT', 'responseId was reused with a different payload.');
      }
      return completed.result;
    }
    const session = this.requireAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const turnId = String(params.turnId ?? '');
    this.requireActiveTurn(session.id, turnId);
    const interaction = this.interactions.get(interactionId);
    if (!interaction || interaction.sessionId !== session.id || interaction.turnId !== turnId) {
      throw new CodexProtocolError('INTERACTION_NOT_FOUND', 'Interaction not found.');
    }
    if (!interaction.actionIds.includes(actionId)) {
      throw new CodexProtocolError('INTERACTION_ACTION_NOT_FOUND', 'Interaction action is not available.');
    }
    validateInteractionValues(interaction.inputs, values);
    const previous = interaction.responses.get(responseId);
    if (previous) {
      if (previous.actionId !== actionId || JSON.stringify(previous.values) !== JSON.stringify(values)) {
        throw new CodexProtocolError('CONFLICT', 'responseId was reused with a different payload.');
      }
      return { accepted: true as const, interactionId, responseId };
    }
    const option = approvalResponse(interaction.serviceMethod, actionId);
    if (!option) {
      throw new CodexProtocolError('INTERACTION_ACTION_NOT_FOUND', 'Interaction action is not available.');
    }
    interaction.responses.set(responseId, { actionId, values });
    const answers = answersFromValues(values);
    try {
      await this.service.respondApproval({
        sessionId: session.serviceSessionId,
        approvalId: interaction.serviceApprovalId,
        ...option,
        ...(answers ? { answers } : {}),
      });
    } catch (error) {
      interaction.responses.delete(responseId);
      throw standardError(error);
    }
    const result = { accepted: true as const, interactionId, responseId };
    this.interactionResponses.set(responseLedgerKey, { sessionId: session.id, fingerprint, result });
    return result;
  }

  private async renameSession(params: Record<string, unknown>) {
    const session = this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const name = typeof params.name === 'string' ? params.name : '';
    if ([...name].length > 200) {
      throw new CodexJsonRpcError(-32602, 'Session name must not exceed 200 Unicode code points.');
    }
    await this.service.setName({ sessionId: session.serviceSessionId, name });
    return { ok: true as const };
  }

  private async closeSession(params: Record<string, unknown>) {
    const session = this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    return this.detachSession(session);
  }

  private async detachSession(session: AttachedSession) {
    const activeTurn = this.activeTurnBySession.get(session.id);
    if (activeTurn) {
      this.resolveInteractionsForTurn(session, activeTurn, 'turn_ended');
      this.closeOpenWork(session, activeTurn, 'cancelled');
      this.emitTurnEvent('turn.completed', session, activeTurn, { stopReason: 'cancelled' });
      this.clearTurn(session.id, activeTurn);
    }
    await this.service.closeSession({
      sessionId: session.serviceSessionId,
      ...(activeTurn ? { force: true } : {}),
    });
    this.historyWatchers.get(session.id)?.stop();
    this.historyWatchers.delete(session.id);
    this.ledger.close(session.id);
    // session.close ends one attachment generation, not the durable Host
    // identity. Force Recover creates a fresh facade with the same sessionId
    // and native thread, so its next session.create must establish a new
    // stream instead of being rejected as a permanently closed request.
    this.sessionCreateFingerprints.delete(session.id);
    this.sessions.delete(session.id);
    this.sessionByServiceId.delete(session.serviceSessionId);
    this.replayBySession.delete(session.id);
    this.replayTrackers.delete(session.id);
    this.replayPager.close(session.id);
    this.terminalOrderBySession.delete(session.id);
    for (const [responseId, response] of this.interactionResponses) {
      if (response.sessionId === session.id) this.interactionResponses.delete(responseId);
    }
    for (const key of this.hostTurnBySourceTurn.keys()) {
      if (key.startsWith(`${session.id}\u0000`)) this.hostTurnBySourceTurn.delete(key);
    }
    for (const key of this.sourceTurnByHostTurn.keys()) {
      if (key.startsWith(`${session.id}\u0000`)) this.sourceTurnByHostTurn.delete(key);
    }
    for (const key of this.terminalTurns) {
      if (key.startsWith(`${session.id}\u0000`)) this.terminalTurns.delete(key);
    }
    return { ok: true as const };
  }

  private async listNative(params: Record<string, unknown>) {
    const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
    let sessions;
    try {
      sessions = await this.service.listNativeThreads(cwd)
        ?? listCodexNativeSessions(cwd);
    } catch {
      sessions = listCodexNativeSessions(cwd);
    }
    const offset = params.cursor === null || params.cursor === undefined
      ? 0
      : Number.parseInt(String(params.cursor), 10);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > sessions.length) {
      throw new CodexJsonRpcError(-32602, 'Invalid native session cursor.');
    }
    const limit = typeof params.limit === 'number' ? params.limit : 100;
    const end = Math.min(offset + limit, sessions.length);
    return {
      sessions: sessions.slice(offset, end),
      nextCursor: end < sessions.length ? String(end) : null,
    };
  }

  private replay(params: Record<string, unknown>) {
    const session = this.requireOrdinaryAttached(String(params.sessionId ?? ''), String(params.streamId ?? ''));
    const state = this.replayBySession.get(session.id)
      ?? { streamId: stableId('replay', session.id), events: [] };
    const result = this.replayPager.page(
      session.id,
      state,
      params.cursor === null || typeof params.cursor === 'string' ? params.cursor : null,
      typeof params.limit === 'number' ? params.limit : 100,
    );
    if (result.nextCursor === null) {
      this.replayTrackers.get(session.id)?.acknowledge();
      const replay = this.replayTrackers.get(session.id)?.replay();
      if (replay) this.replayBySession.set(session.id, replay);
    }
    return result;
  }

  private translateEvent(method: string, params: Record<string, unknown>): void {
    const session = this.sessionByServiceId.get(String(params.sessionId ?? ''));
    if (!session) {
      if (method === 'runtime.error') {
        const data = record(params.data ?? params);
        this.emitEvent('runtime.error', {
          eventId: randomUUID(),
          emittedAt: new Date().toISOString(),
          data: {
            domainCode: 'RUNTIME_ERROR',
            message: String(data.message ?? 'Codex runtime error.'),
            retryable: false,
            details: {},
          },
        });
      }
      return;
    }
    const data = record(params.data);
    const requestRef = this.turnsByRequest.get(String(params.requestId ?? ''));
    const providerTurnId = nonEmptyString(params.turnId);
    if (providerTurnId && requestRef) {
      const hostKey = this.turnKey(session.id, requestRef.turnId);
      const input = this.pendingInputByTurn.get(hostKey) ?? [];
      const sourceTurnId = this.identityStore.recordLive(
        session.nativeSessionId,
        providerTurnId,
        input,
      );
      this.sourceTurnByHostTurn.set(hostKey, sourceTurnId);
      this.hostTurnBySourceTurn.set(this.turnKey(session.id, sourceTurnId), requestRef.turnId);
    }
    const interactionRef = method === 'approval.resolved'
      ? this.interactions.get(String(data.approvalId ?? ''))
      : undefined;
    const turnId = requestRef?.turnId
      ?? interactionRef?.turnId
      ?? (providerTurnId
        ? this.hostTurnBySourceTurn.get(this.turnKey(session.id, providerTurnId))
        : this.activeTurnBySession.get(session.id));
    const activeTurnId = this.activeTurnBySession.get(session.id);
    if (providerTurnId && !turnId) return;
    if (turnId && activeTurnId && turnId !== activeTurnId) return;

    switch (method) {
      case 'turn.started':
        if (!turnId || this.startedTurns.has(this.turnKey(session.id, turnId))) return;
        this.startedTurns.add(this.turnKey(session.id, turnId));
        this.updateSession(session, { state: 'running', lastError: null });
        this.emitTurnEvent('turn.started', session, turnId, {});
        if (!this.sidechats.has(session.id)) {
          this.emitSessionEvent('session.updated', session, sessionUpdatedData({
            state: session.state,
            lastError: session.lastError,
            availableActions: this.availableActions(session),
            updatedAt: session.updatedAt,
          }));
        }
        {
          const key = this.turnKey(session.id, turnId);
          const pendingUsage = this.pendingUsageByTurn.get(key);
          if (pendingUsage) {
            this.pendingUsageByTurn.delete(key);
            this.emitTurnEvent('usage.updated', session, turnId, pendingUsage);
          }
        }
        return;
      case 'output.text.delta':
        this.emitContent(session, turnId, data, 'text');
        return;
      case 'output.reasoning.delta':
        this.emitContent(session, turnId, data, 'reasoning');
        return;
      case 'output.plan.delta':
      case 'output.plan.final': {
        if (!turnId) return;
        const text = String(data.text ?? data.delta ?? '');
        if (!text) return;
        this.emitTurnEvent('plan.updated', session, turnId, {
          planId: nonEmptyString(data.itemId) ?? `plan:${turnId}`,
          title: text,
          steps: [],
        });
        return;
      }
      case 'output.command.delta': {
        if (!turnId) return;
        const activityId = nonEmptyString(data.itemId) ?? `command:${turnId}`;
        const turnKey = this.turnKey(session.id, turnId);
        const open = this.openActivitiesByTurn.get(turnKey);
        const outputs = this.activityOutputByTurn.get(turnKey);
        const previousOutput = outputs?.get(activityId) ?? '';
        const delta = typeof data.delta === 'string' ? data.delta : '';
        const output = boundedText(`${previousOutput}${delta}`) ?? '';
        outputs?.set(activityId, output);
        const descriptor = open?.get(activityId) ?? {
          kind: 'command',
          title: 'Command',
          presentation: {
            type: 'command',
            data: { command: nonEmptyString(data.command) ?? 'command' },
          },
        };
        open?.set(activityId, descriptor);
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId,
          ...descriptor,
          status: 'running',
          ...(output ? { summary: output } : {}),
        });
        return;
      }
      case 'codex.item': {
        if (!turnId) return;
        const activity = codexItemActivity(data);
        if (!activity) return;
        const turnKey = this.turnKey(session.id, turnId);
        const open = this.openActivitiesByTurn.get(turnKey);
        const streamedOutput = this.activityOutputByTurn.get(turnKey)?.get(activity.activityId);
        const descriptor = streamedOutput && !activity.descriptor.summary
          ? { ...activity.descriptor, summary: streamedOutput }
          : activity.descriptor;
        if (activity.status === 'running') open?.set(activity.activityId, descriptor);
        else {
          open?.delete(activity.activityId);
          this.activityOutputByTurn.get(turnKey)?.delete(activity.activityId);
        }
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId: activity.activityId,
          ...descriptor,
          status: activity.status,
        });
        return;
      }
      case 'codex.notice': {
        if (!turnId) return;
        const code = nonEmptyString(data.code) ?? 'codex.notice';
        const message = nonEmptyString(data.message) ?? nonEmptyString(data.title) ?? 'Codex notice';
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId: stableId('codex-notice', { turnId, code, message }),
          kind: 'notice',
          title: nonEmptyString(data.title) ?? 'Codex notice',
          status: 'succeeded',
          presentation: {
            type: 'notice',
            tone: data.tone === 'warning' || data.tone === 'danger' ? data.tone : 'info',
            data: { code, message },
          },
          ...(data.details !== undefined ? { details: boundedJsonValue(data.details) } : {}),
        });
        return;
      }
      case 'codex.unknown':
        // Unknown app-server notifications remain available to the proxy's
        // debug/diagnostic path, but are not conversation activities. Only a
        // semantic item lifecycle or explicit notice may cross the UI bridge.
        return;
      case 'diff.updated': {
        if (!turnId) return;
        const inner = record(data.params ?? data);
        const diff = String(inner.diff ?? inner.unified ?? '');
        if (!diff) return;
        this.emitTurnEvent('diff.updated', session, turnId, {
          diffId: nonEmptyString(data.itemId) ?? `diff:${turnId}`,
          diff,
          truncated: false,
        });
        return;
      }
      case 'token_usage.updated': {
        const usage = sanitizeUsage(data);
        if (!usage) return;
        if (turnId) {
          const key = this.turnKey(session.id, turnId);
          if (!this.startedTurns.has(key)) this.pendingUsageByTurn.set(key, usage);
          else this.emitTurnEvent('usage.updated', session, turnId, usage);
        }
        else this.emitSessionEvent('usage.updated', session, usage);
        return;
      }
      case 'codex.agent':
        if (!turnId || !Array.isArray(data.updates)) return;
        for (const raw of data.updates) {
          const update = record(raw);
          const agentId = nonEmptyString(update.agentId);
          if (!agentId) continue;
          const state = agentState(update.status);
          const open = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
          const descriptor: ActivityDescriptor = {
            kind: 'agent',
            title: nonEmptyString(update.description) ?? 'Agent',
            presentation: {
              type: 'agent',
              data: {
                agentId,
                state,
                ...(nonEmptyString(update.agentType) ? { displayName: update.agentType } : {}),
                ...(nonEmptyString(update.output) ? { output: update.output } : {}),
              },
            },
          };
          if (state === 'running') open?.set(agentId, descriptor);
          else open?.delete(agentId);
          this.emitTurnEvent('activity.updated', session, turnId, {
            activityId: agentId,
            ...descriptor,
            status: agentActivityStatus(state),
          });
        }
        return;
      case 'approval.requested': {
        if (!turnId) return;
        const interactionId = nonEmptyString(data.approvalId);
        if (!interactionId) return;
        const nativeMethod = String(data.method ?? '');
        const requestUserInput = nativeMethod === REQUEST_USER_INPUT_METHOD;
        const actions = interactionActions(nativeMethod, data.scopeOptions);
        const inputs = requestUserInput ? questionInputs(data.payload) : [];
        this.interactions.set(interactionId, {
          sessionId: session.id,
          turnId,
          serviceApprovalId: interactionId,
          serviceMethod: nativeMethod,
          actionIds: actions.map((action) => action.id),
          inputs,
          responses: new Map(),
        });
        this.updateSession(session, { state: 'waiting_interaction' });
        this.emitTurnEvent('interaction.requested', session, turnId, {
          interactionId,
          title: String(data.title ?? 'Review request'),
          description: String(data.reason ?? data.risk ?? ''),
          presentation: {
            kind: requestUserInput ? 'question' : 'permission',
            tone: requestUserInput ? 'neutral' : 'warning',
          },
          inputs,
          actions,
          ...(data.payload !== undefined ? { context: { subject: jsonValue(data.payload) } } : {}),
        });
        return;
      }
      case 'approval.resolved': {
        if (!turnId || !interactionRef) return;
        this.interactions.delete(String(data.approvalId ?? ''));
        const submitted = interactionRef.responses.size > 0;
        const last = [...interactionRef.responses.values()].at(-1);
        this.updateSession(session, { state: 'running' });
        this.emitTurnEvent('interaction.resolved', session, turnId, submitted && last
          ? {
            interactionId: String(data.approvalId ?? ''),
            outcome: 'submitted',
            actionId: last.actionId,
          }
          : {
            interactionId: String(data.approvalId ?? ''),
            outcome: 'cancelled',
          });
        return;
      }
      case 'session.rotated': {
        const nativeSessionId = nonEmptyString(data.newNativeSessionId);
        if (!nativeSessionId) return;
        this.updateSession(session, { nativeSessionId });
        this.historyWatchers.get(session.id)?.retarget(nativeSessionId);
        const tracker = this.replayTrackers.get(session.id);
        if (tracker) {
          tracker.attach(
            replayCodexNativeSession(session.id, nativeSessionId, undefined, this.identityStore),
            false,
          );
          this.replayBySession.set(session.id, tracker.replay());
        }
        this.emitSessionEvent('session.updated', session, sessionUpdatedData({
          nativeSession: { id: nativeSessionId },
          updatedAt: session.updatedAt,
        }));
        this.emitSessionEvent('usage.updated', session, {
          context: null,
          conversation: { mode: 'reset' },
        });
        return;
      }
      case 'runtime.error':
        if (turnId) {
          this.completeTurn(session, turnId, true, data);
        } else {
          this.updateSession(session, {
            state: 'error',
            lastError: String(data.message ?? 'Codex runtime error.'),
          });
          this.emitSessionEvent('runtime.error', session, {
            domainCode: 'RUNTIME_ERROR',
            message: session.lastError ?? 'Codex runtime error.',
            retryable: false,
            details: {},
          });
        }
        return;
      case 'turn.failed':
        if (turnId) {
          this.completeTurn(session, turnId, true, {
            message: String(data.message ?? 'Codex turn failed.'),
          });
        }
        return;
      case 'turn.completed':
        if (turnId) this.completeTurn(session, turnId, false, data);
        return;
    }
  }

  private emitContent(
    session: AttachedSession,
    turnId: string | undefined,
    data: Record<string, unknown>,
    kind: 'text' | 'reasoning',
  ): void {
    if (!turnId) return;
    const delta = String(data.delta ?? data.text ?? '');
    if (!delta) return;
    const contents = this.openContentByTurn.get(this.turnKey(session.id, turnId));
    if (!contents) return;
    const nativeContentId = nonEmptyString(data.itemId) ?? `${kind}:default`;
    let content = contents.get(nativeContentId);
    if (!content) {
      const ordinal = [...contents.values()].filter((item) => item.kind === kind).length + 1;
      content = { contentId: `${kind}:${ordinal}`, kind, content: '', deltaCount: 0 };
      contents.set(nativeContentId, content);
    }
    content.content += delta;
    content.deltaCount += 1;
    this.emitTurnEvent('content.delta', session, turnId, {
      contentId: content.contentId,
      kind,
      ...(kind === 'text' ? { format: 'plain' } : {}),
      delta,
    }, `${content.contentId}:delta:${content.deltaCount}`);
  }

  private completeTurn(
    session: AttachedSession,
    turnId: string,
    failed: boolean,
    data: Record<string, unknown>,
  ): void {
    const turnKey = this.turnKey(session.id, turnId);
    if (this.terminalTurns.has(turnKey)) return;
    this.terminalTurns.add(turnKey);
    const terminalOrder = this.terminalOrderBySession.get(session.id) ?? [];
    if (!terminalOrder.includes(turnId)) terminalOrder.push(turnId);
    this.terminalOrderBySession.set(session.id, terminalOrder);
    this.resolveInteractionsForTurn(session, turnId, failed ? 'runtime_ended' : 'turn_ended');
    this.closeOpenWork(session, turnId, failed ? 'failed' : 'succeeded');
    if (failed) {
      const message = String(data.message ?? 'Codex turn failed.');
      const retryable = data.retryable === true;
      const providerCode = nonEmptyString(data.code);
      this.updateSession(session, {
        state: retryable ? 'idle' : 'error',
        lastError: retryable ? null : message,
      });
      this.emitTurnEvent('turn.failed', session, turnId, {
        error: {
          domainCode: retryable ? 'RUNTIME_UNAVAILABLE' : 'RUNTIME_ERROR',
          message,
          retryable,
          details: providerCode ? { providerCode } : {},
        },
      });
    } else {
      const interrupted = this.interruptedTurns.has(this.turnKey(session.id, turnId));
      const nativeReason = String(data.stopReason ?? data.status ?? '');
      const stopReason = interrupted
        ? 'interrupted'
        : nativeReason === 'cancelled' || nativeReason === 'interrupted' ? 'cancelled'
          : nativeReason === 'length' || nativeReason === 'max_tokens' ? 'limit_reached'
            : nativeReason === 'refused' ? 'refused'
              : nativeReason === 'end_turn' || nativeReason === 'completed' ? 'completed' : 'other';
      this.updateSession(session, { state: 'idle', lastError: null });
      this.emitTurnEvent('turn.completed', session, turnId, { stopReason });
    }
    this.clearTurn(session.id, turnId);
    if (!this.sidechats.has(session.id)) {
      this.emitSessionEvent('session.updated', session, sessionUpdatedData({
        state: session.state,
        lastError: session.lastError,
        availableActions: this.availableActions(session),
        updatedAt: session.updatedAt,
      }));
    }
    this.historyWatchers.get(session.id)?.resume();
    this.rebaseHistory(session);
  }

  private closeOpenWork(
    session: AttachedSession,
    turnId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
  ): void {
    const contents = this.openContentByTurn.get(this.turnKey(session.id, turnId));
    if (contents) {
      for (const content of contents.values()) {
        this.emitTurnEvent('content.completed', session, turnId, {
          contentId: content.contentId,
          kind: content.kind,
          ...(content.kind === 'text' ? { format: 'plain' as const } : {}),
          content: content.content,
        }, content.contentId);
      }
      contents.clear();
    }
    const activities = this.openActivitiesByTurn.get(this.turnKey(session.id, turnId));
    if (activities) {
      for (const [activityId, descriptor] of activities) {
        this.emitTurnEvent('activity.updated', session, turnId, {
          activityId,
          ...descriptor,
          status,
        });
      }
      activities.clear();
    }
  }

  private resolveInteractionsForTurn(
    session: AttachedSession,
    turnId: string,
    outcome: 'cancelled' | 'turn_ended' | 'runtime_ended',
  ): void {
    for (const [interactionId, interaction] of this.interactions) {
      if (interaction.sessionId !== session.id || interaction.turnId !== turnId) continue;
      this.interactions.delete(interactionId);
      this.emitTurnEvent('interaction.resolved', session, turnId, {
        interactionId,
        outcome,
      });
    }
  }

  private rebaseHistory(session: AttachedSession): void {
    const tracker = this.replayTrackers.get(session.id);
    if (!tracker) return;
    tracker.rebase(replayCodexNativeSession(
      session.id,
      session.nativeSessionId,
      undefined,
      this.identityStore,
    ));
    this.replayBySession.set(session.id, tracker.replay());
  }

  private emitSessionEvent(
    method: string,
    session: AttachedSession,
    data: Record<string, unknown>,
  ): void {
    session.sequence += 1;
    this.emitEvent(method, {
      eventId: randomUUID(),
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      emittedAt: new Date().toISOString(),
      data,
    });
  }

  private emitTurnEvent(
    method: string,
    session: AttachedSession,
    turnId: string,
    data: Record<string, unknown>,
    identity?: string,
  ): void {
    const turnKey = this.turnKey(session.id, turnId);
    const sourceTurnId = this.sourceTurnByHostTurn.get(turnKey)
      ?? stableId('source-turn', { nativeSessionId: session.nativeSessionId, hostTurnId: turnId });
    const occurrenceKey = `${turnKey}\u0000${method}`;
    const occurrence = (this.eventOccurrences.get(occurrenceKey) ?? 0) + 1;
    this.eventOccurrences.set(occurrenceKey, occurrence);
    const entityIdentity = nonEmptyString(data.contentId)
      ?? nonEmptyString(data.activityId)
      ?? nonEmptyString(data.interactionId)
      ?? nonEmptyString(data.diffId)
      ?? nonEmptyString(data.planId);
    const factIdentity = identity
      ?? (method === 'turn.started' || method === 'turn.completed' || method === 'turn.failed'
        ? 'lifecycle'
        : entityIdentity
          ? stableId('snapshot', { identity: entityIdentity, data })
          : `occurrence:${occurrence}`);
    const eventId = stableId('provider-event', {
      nativeSessionId: session.nativeSessionId,
      sourceTurnId,
      method,
      identity: factIdentity,
    });
    const fingerprint = stableStringify({ method, data });
    const emitted = this.emittedFactsByTurn.get(turnKey) ?? new Map<string, string>();
    const existing = emitted.get(eventId);
    if (existing === fingerprint) return;
    if (existing !== undefined) {
      throw new CodexProtocolError('INTERNAL', `Event ${eventId} changed canonical content.`);
    }
    emitted.set(eventId, fingerprint);
    this.emittedFactsByTurn.set(turnKey, emitted);
    session.sequence += 1;
    this.emitEvent(method, {
      eventId,
      streamId: session.streamId,
      sequence: session.sequence,
      sessionId: session.id,
      turnId,
      sourceTurnId,
      emittedAt: new Date().toISOString(),
      data,
    });
  }

  private clearTurn(sessionId: string, turnId: string): void {
    const key = this.turnKey(sessionId, turnId);
    this.activeTurnBySession.delete(sessionId);
    this.startedTurns.delete(key);
    this.pendingUsageByTurn.delete(key);
    this.interruptedTurns.delete(key);
    this.openActivitiesByTurn.delete(key);
    this.activityOutputByTurn.delete(key);
    this.openContentByTurn.delete(key);
    this.emittedFactsByTurn.delete(key);
    this.pendingInputByTurn.delete(key);
    this.acceptedInputBatchesByTurn.delete(key);
    for (const occurrenceKey of this.eventOccurrences.keys()) {
      if (occurrenceKey.startsWith(`${key}\u0000`)) this.eventOccurrences.delete(occurrenceKey);
    }
    const requestKey = this.requestByTurn.get(key);
    if (requestKey) this.turnsByRequest.delete(requestKey);
    this.requestByTurn.delete(key);
  }

  private turnKey(sessionId: string, turnId: string): string {
    return `${sessionId}\u0000${turnId}`;
  }

  private updateSession(session: AttachedSession, patch: Partial<AttachedSession>): void {
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  }

  private serialize(session: AttachedSession) {
    return {
      id: session.id,
      nativeSession: { id: session.nativeSessionId },
      streamId: session.streamId,
      state: session.state,
      sessionConfig: session.sessionConfig,
      lastError: session.lastError,
      availableActions: this.availableActions(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private requireSession(sessionId: string): AttachedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new CodexProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    return session;
  }

  private requireOrdinarySession(sessionId: string): AttachedSession {
    if (this.sidechats.has(sessionId)) {
      throw new CodexProtocolError('SESSION_NOT_FOUND', 'Session not found.');
    }
    return this.requireSession(sessionId);
  }

  private requireAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireSession(sessionId);
    if (session.streamId !== streamId) {
      throw new CodexProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireOrdinaryAttached(sessionId: string, streamId: string): AttachedSession {
    const session = this.requireOrdinarySession(sessionId);
    if (session.streamId !== streamId) {
      throw new CodexProtocolError('SESSION_STALE', 'Session stream is stale.');
    }
    return session;
  }

  private requireActiveTurn(sessionId: string, turnId: string): void {
    if (this.activeTurnBySession.get(sessionId) !== turnId) {
      throw new CodexProtocolError('TURN_NOT_FOUND', 'Turn is not active.');
    }
  }
}
