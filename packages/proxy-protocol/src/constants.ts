export const PROTOCOL_NAME = 'gian.proxy' as const;
export const PROTOCOL_V2 = '2.1' as const;
export const PROTOCOL_V2_LEGACY = '2.0' as const;
export const PROTOCOL_V22 = '2.2' as const;
export const PROTOCOL_V23 = '2.3' as const;
export const NEXT_PROTOCOL_VERSION = PROTOCOL_V23;
export const KNOWN_PROTOCOL_VERSIONS = [
  PROTOCOL_V23,
  PROTOCOL_V22,
  PROTOCOL_V2,
  PROTOCOL_V2_LEGACY,
] as const;
/** 2.3 extends 2.2 Runtime control with read-only Customization Inventory. */
export const SUPPORTED_PROTOCOL_VERSIONS = KNOWN_PROTOCOL_VERSIONS;

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
  'runtime.discover': 'runtime.discover',
  'runtime.probe': 'runtime.probe',
  'customization.list': 'customization.list',
  'customization.detail': 'customization.list',
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
  'session.create.hostBindingProof',
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
  'runtime.discover',
  'runtime.probe',
  'customization.list',
] as const;

export const PROTOCOL_V22_ONLY_CAPABILITIES = [
  'runtime.discover',
  'runtime.probe',
] as const;

export const PROTOCOL_V22_ONLY_METHODS = [
  'runtime.discover',
  'runtime.probe',
] as const;

/** Host-set marker that selects the no-Runtime bootstrap server.
 *  A real 2.2 Session must never set this. */
export const RUNTIME_BOOTSTRAP_ENV = 'GIAN_RUNTIME_BOOTSTRAP';
export const RUNTIME_BOOTSTRAP_VALUE = '1';

export const RUNTIME_CANDIDATE_SOURCES = [
  'configured',
  'official-user',
  'official-system',
  'path',
] as const;

export const MAX_RUNTIME_CANDIDATES = 32;
export const MAX_RUNTIME_SETUP_ACTIONS = 16;
export const MAX_RUNTIME_CONTENT_ROOTS = 32;
/** v4-only bound. Do not apply to legacy v2/v3 `verifiedCliVersions`. */
export const MAX_MANIFEST_V4_VERIFIED_VERSIONS = 32;
/** v4-only bound. Matches compiled Catalog range text; v2/v3 ranges stay unbounded. */
export const MAX_MANIFEST_V4_PROTOCOL_RANGE_CHARS = 64;
/** Shape grammar for compiled/v4 range text. Tokens match protocolRangeIncludes
 *  (`^`, `~`, `x|X|*`, comparators, pipe, digits, dot, ASCII space). Controls
 *  and other characters fail closed before semantic exclusivity. */
export const MANIFEST_V4_PROTOCOL_RANGE_PATTERN = /^[0-9.<>=|^~xX* ]+$/;
export const MAX_RUNTIME_PATH_CHARS = 4096;
export const MAX_RUNTIME_LABEL_CHARS = 128;
export const MAX_RUNTIME_ID_CHARS = 64;
export const MAX_RUNTIME_MESSAGE_CHARS = 512;
export const MAX_RUNTIME_CODE_CHARS = 64;
export const MAX_RUNTIME_URL_CHARS = 1024;

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

// ---------------------------------------------------------------------------
// Customization Inventory (gian.proxy/2.3, Issue #50)
// ---------------------------------------------------------------------------

/** Read-only asset kinds a Proxy may inventory. */
export const CUSTOMIZATION_KINDS = ['skill', 'mcp', 'hook', 'rule'] as const;

/** Per-kind result status. Non-`ok` results always carry empty `items`. */
export const CUSTOMIZATION_LIST_STATUSES = [
  'ok',
  'provider_unsupported',
  'proxy_unsupported',
  'unavailable',
] as const;

/** Honesty about how much of the provider surface the result covers. */
export const INVENTORY_COMPLETENESS = [
  'effective',
  'configured',
  'partial',
  'none',
] as const;

/** Whether an item is usable in a fresh runtime, when the Provider states it. */
export const CUSTOMIZATION_ACTIVATIONS = [
  'enabled',
  'disabled',
  'shadowed',
  'pending_trust',
  'invalid',
  'unknown',
] as const;

export const CUSTOMIZATION_SCOPE_LEVELS = [
  'user',
  'workspace',
  'directory',
  'system',
  'unknown',
] as const;

export const CUSTOMIZATION_ORIGIN_KINDS = [
  'builtin',
  'user_file',
  'project_file',
  'plugin',
  'managed',
  'unknown',
] as const;

export const CUSTOMIZATION_DISCOVERY_METHODS = [
  'provider_api',
  'provider_cli',
  'config_parse',
  'filesystem_scan',
] as const;

/** Stable Gian-wide diagnostics codes. Provider-native wording belongs in the
 *  already-sanitized `message` only, never in `code`. */
export const CUSTOMIZATION_DIAGNOSTIC_CODES = [
  'INVENTORY_TRUNCATED',
  'SOURCE_UNREADABLE',
  'SOURCE_MALFORMED',
  'SOURCE_UNTRUSTED',
  'SOURCE_NOT_ENUMERABLE',
  'PROVIDER_INSPECTION_FAILED',
  'EFFECTIVE_STATE_UNRESOLVED',
  'PROXY_UPGRADE_REQUIRED',
  'FIELD_REDACTED',
] as const;

/** Rules-specific status facts. UI wording is owned by the Web layer; the
 *  wire contract never uses override/fallback terminology. `configured`
 *  means the file is a declared candidate whose runtime selection cannot be
 *  proven by this Proxy (e.g. a fallback candidate behind an unreadable
 *  provider config). */
export const RULE_EFFECT_STATUSES = [
  'effective',
  'imported',
  'subtree',
  'inactive',
  'unreadable',
  'unknown',
  'configured',
] as const;

export const CUSTOMIZATION_SKILL_FORMATS = [
  'agent-skill',
  'legacy-command',
  'provider-builtin',
  'unknown',
] as const;

export const CUSTOMIZATION_MCP_TRANSPORTS = [
  'stdio',
  'http',
  'sse',
  'websocket',
  'other',
  'unknown',
] as const;

export const CUSTOMIZATION_DETAIL_STATUSES = ['ok', 'unavailable'] as const;

/** Stable item id prefix: `ci1_` + 32 lowercase hex chars (128-bit SHA-256
 *  prefix). Conformance rejects other id spellings. */
export const CUSTOMIZATION_STABLE_ID_PREFIX = 'ci1_' as const;
export const CUSTOMIZATION_STABLE_ID_HEX_CHARS = 32 as const;

export const MAX_CUSTOMIZATION_ITEMS = 500;
export const MAX_CUSTOMIZATION_DIAGNOSTICS = 50;
export const MAX_CUSTOMIZATION_WARNINGS = 20;
export const MAX_CUSTOMIZATION_ID_UTF8_BYTES = 128;
export const MAX_CUSTOMIZATION_NAME_UTF8_BYTES = 256;
export const MAX_CUSTOMIZATION_TEXT_UTF8_BYTES = 4096;
export const MAX_CUSTOMIZATION_PATH_UTF8_BYTES = 4096;
export const MAX_CUSTOMIZATION_DETAIL_UTF8_BYTES = 1024 * 1024;

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
export type ProtocolV22OnlyCapability = typeof PROTOCOL_V22_ONLY_CAPABILITIES[number];
export type ProtocolV22OnlyMethod = typeof PROTOCOL_V22_ONLY_METHODS[number];
export type RuntimeCandidateSource = typeof RUNTIME_CANDIDATE_SOURCES[number];

export function isProtocolV22OnlyMethod(method: string): method is ProtocolV22OnlyMethod {
  return (PROTOCOL_V22_ONLY_METHODS as readonly string[]).includes(method);
}

export function isProtocolV22OnlyCapability(name: string): name is ProtocolV22OnlyCapability {
  return (PROTOCOL_V22_ONLY_CAPABILITIES as readonly string[]).includes(name);
}
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

/** Manifest v4 includes the 2.2 baseline and excludes legacy 2.1/2.0. */
export function isManifestV4ExclusiveProtocolRange(range: string): boolean {
  return protocolRangeIncludes(range, PROTOCOL_V22)
    && !protocolRangeIncludes(range, PROTOCOL_V2)
    && !protocolRangeIncludes(range, PROTOCOL_V2_LEGACY);
}
