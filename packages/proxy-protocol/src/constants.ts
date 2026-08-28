export const PROTOCOL_NAME = 'gian.proxy' as const;
export const PROTOCOL_V2 = '2.1' as const;
export const PROTOCOL_V2_LEGACY = '2.0' as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_V2, PROTOCOL_V2_LEGACY] as const;

export const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_DIFF_UTF8_BYTES = 8 * 1024 * 1024;
export const MAX_ACTIVITY_JSON_BYTES = 1 * 1024 * 1024;
export const MAX_REQUEST_JSON_BYTES = 1 * 1024 * 1024;

export const JSONRPC_VERSION = '2.0' as const;

export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  DOMAIN_ERROR: -32000,
} as const;

export const PROCESS_SCOPES = ['shared', 'session'] as const;

export const CORE_METHODS = [
  'initialize',
  'catalog.list',
  'session.create',
  'session.get',
  'turn.start',
  'turn.interrupt',
  'session.close',
  'shutdown',
] as const;

export const OPTIONAL_METHOD_CAPABILITIES = {
  'catalog.resolve': 'catalog.resolve',
  'session.rename': 'session.rename',
  'session.native.list': 'session.native.list',
  'session.native.delete': 'session.native.delete',
  'session.replay': 'session.replay',
  'sidechat.create': 'sidechat',
  'sidechat.resume': 'sidechat',
  'sidechat.close': 'sidechat',
  'session.fork': 'session.fork',
  'turn.steer': 'turn.steer',
  'interaction.respond': 'interaction',
} as const;

export const CAPABILITY_NAMES = [
  'input.localFile',
  'input.localImage',
  'input.skill',
  'catalog.resolve',
  'session.rename',
  'session.native.list',
  'session.native.delete',
  'session.replay',
  'session.create.forkBoundaries',
  'sidechat',
  'session.fork',
  'session.fork.atTurn',
  'turn.steer',
  'interaction',
  'event.reasoning',
  'event.plan',
  'event.diff',
  'event.usage',
  'event.step',
  'event.request',
  'integration.mcp.streamableHttp',
] as const;

export const CATALOG_ACTION_IDS = [
  'sidechat.create',
  'session.fork',
  'session.fork.atTurn',
] as const;

export const ACTION_REQUIRED_CAPABILITIES = {
  'sidechat.create': 'sidechat',
  'session.fork': 'session.fork',
  'session.fork.atTurn': 'session.fork.atTurn',
} as const;

export const CAPABILITY_DEPENDENCIES = {
  'session.fork': ['session.replay'],
  'session.fork.atTurn': ['session.fork'],
} as const;

export const SIDECHAT_ALLOWED_METHODS = [
  'turn.start',
  'turn.interrupt',
  'turn.steer',
  'interaction.respond',
  'sidechat.create',
  'sidechat.resume',
  'sidechat.close',
] as const;

export const SIDECHAT_REJECTED_SESSION_METHODS = [
  'session.get',
  'session.rename',
  'session.replay',
  'session.close',
  'catalog.resolve',
] as const;

export const SESSION_STATES = [
  'idle',
  'running',
  'waiting_interaction',
  'stale',
  'closed',
  'error',
] as const;

export const CONTENT_KINDS = [
  'text',
  'reasoning',
  'status',
] as const;

export const CONTENT_FORMATS = ['plain', 'markdown'] as const;

export const STOP_REASONS = [
  'completed',
  'interrupted',
  'cancelled',
  'limit_reached',
  'refused',
  'other',
] as const;

export const CONFIG_BINDINGS = ['session', 'turn'] as const;

export const CONFIG_CONTROLS = ['select', 'boolean', 'number', 'text'] as const;

/** Protocol 2.0 compatibility only. Protocol 2.1 uses specialCatalogs. */
export const CONFIG_ROLES = [
  'model',
  'effort',
  'fast',
  'approval_mode',
  'execution_mode',
] as const;

export const INPUT_TYPES = ['text', 'localFile', 'localImage', 'skill'] as const;

export const INTERACTION_KINDS = [
  'question',
  'choice',
  'confirmation',
  'permission',
] as const;

export const INTERACTION_INPUT_TYPES = [
  'text',
  'multiline_text',
  'single_select',
  'multi_select',
  'boolean',
] as const;

export const INTERACTION_ACTION_STYLES = [
  'primary',
  'secondary',
  'danger',
] as const;

export const INTERACTION_OUTCOMES = [
  'submitted',
  'cancelled',
  'expired',
  'turn_ended',
  'runtime_ended',
] as const;

export const PRESENTATION_TONES = [
  'neutral',
  'info',
  'warning',
  'danger',
] as const;

export const ACTIVITY_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const STEP_STATUSES = ['running', 'completed', 'failed'] as const;

export const REQUEST_REASONS = ['initial', 'resume', 'change'] as const;

export const ACTIVITY_PRESENTATION_TYPES = [
  'generic',
  'tool',
  'command',
  'search',
  'file',
  'agent',
  'notice',
] as const;

export const FILE_OPERATIONS = ['read', 'write', 'delete', 'rename'] as const;

export const AGENT_STATES = [
  'running',
  'completed',
  'failed',
  'interrupted',
] as const;

export const PLAN_STEP_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
] as const;

export const DIFF_FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
] as const;

export const NATIVE_HISTORY_MODES = ['none', 'replay'] as const;

export const DOMAIN_CODES = [
  'NOT_INITIALIZED',
  'ALREADY_INITIALIZED',
  'INCOMPATIBLE_PROTOCOL',
  'CAPABILITY_NOT_SUPPORTED',
  'SESSION_NOT_FOUND',
  'SESSION_CLOSED',
  'SESSION_STALE',
  'SESSION_ERROR',
  'SESSION_BUSY',
  'TURN_NOT_FOUND',
  'INTERACTION_NOT_FOUND',
  'INTERACTION_ACTION_NOT_FOUND',
  'CONFIG_REQUIRED',
  'CONFIG_VALUE_INVALID',
  'CONFIG_BINDING_INVALID',
  'NATIVE_SESSION_NOT_FOUND',
  'SIDECHAT_UNAVAILABLE',
  'FORK_BOUNDARY_UNAVAILABLE',
  'CONFLICT',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_AUTH_REQUIRED',
  'RUNTIME_ERROR',
  'CANCELLED',
  'INTERNAL',
] as const;

export const FINGERPRINT_EXCLUDED_FIELDS = [
  'jsonrpc',
  'eventId',
  'sessionId',
  'turnId',
  'streamId',
  'replayStreamId',
  'sequence',
  'emittedAt',
] as const;

export type CoreMethod = typeof CORE_METHODS[number];
export type OptionalMethod = keyof typeof OPTIONAL_METHOD_CAPABILITIES;
export type ProxyMethod = CoreMethod | OptionalMethod;
export type CapabilityName = typeof CAPABILITY_NAMES[number];
export type CatalogActionId = typeof CATALOG_ACTION_IDS[number];
export type DomainCode = typeof DOMAIN_CODES[number];
export type ProtocolErrorCode = DomainCode;

export function isCatalogActionId(value: string): value is CatalogActionId {
  return (CATALOG_ACTION_IDS as readonly string[]).includes(value);
}

export function isSidechatAllowedMethod(method: string): boolean {
  return (SIDECHAT_ALLOWED_METHODS as readonly string[]).includes(method);
}

export function isSidechatRejectedSessionMethod(method: string): boolean {
  return (SIDECHAT_REJECTED_SESSION_METHODS as readonly string[]).includes(method);
}

interface ParsedProtocolVersion {
  major: number;
  minor: number;
}

function parseProtocolVersion(value: string): ParsedProtocolVersion | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function compareProtocolVersions(
  left: ParsedProtocolVersion,
  right: ParsedProtocolVersion,
): number {
  return left.major === right.major
    ? left.minor - right.minor
    : left.major - right.major;
}

function comparatorMatches(
  comparator: string,
  version: ParsedProtocolVersion,
): boolean {
  const wildcard = /^(0|[1-9]\d*)\.(?:x|\*)$/i.exec(comparator);
  if (wildcard) return version.major === Number(wildcard[1]);

  const compatible = /^(\^|~)(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(comparator);
  if (compatible) {
    const floor = { major: Number(compatible[2]), minor: Number(compatible[3]) };
    if (compareProtocolVersions(version, floor) < 0) return false;
    return compatible[1] === '^'
      ? version.major === floor.major
      : version.major === floor.major && version.minor === floor.minor;
  }

  const match = /^(>=|<=|>|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(comparator);
  if (!match) return false;
  const target = { major: Number(match[2]), minor: Number(match[3]) };
  const comparison = compareProtocolVersions(version, target);
  switch (match[1] ?? '=') {
    case '>=': return comparison >= 0;
    case '<=': return comparison <= 0;
    case '>': return comparison > 0;
    case '<': return comparison < 0;
    default: return comparison === 0;
  }
}

export function protocolRangeIncludes(range: string, version: string): boolean {
  const parsed = parseProtocolVersion(version);
  if (!parsed) return false;
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    return comparators.length > 0
      && comparators.every((comparator) => comparatorMatches(comparator, parsed));
  });
}
