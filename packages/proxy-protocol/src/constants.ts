export const PROTOCOL_NAME = 'gian.proxy' as const;
export const PROTOCOL_V1 = '1.0' as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_V1] as const;

export const MAX_NDJSON_LINE_BYTES = 16 * 1024 * 1024;

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
  'slash.list': 'slash.list',
  'session.rename': 'session.rename',
  'session.native.list': 'session.nativeList',
  'session.replay': 'session.replay',
  'session.config.set': 'session.config',
  'turn.steer': 'turn.steer',
  'approval.respond': 'approval.relay',
} as const;

export const CAPABILITY_NAMES = [
  'input.localFile',
  'input.localImage',
  'input.skill',
  ...Object.values(OPTIONAL_METHOD_CAPABILITIES),
  'event.reasoning',
  'event.plan',
  'event.command',
  'event.status',
  'event.tool',
  'event.diff',
  'event.usage',
  'event.agent',
  'event.notice',
  'extension.events',
] as const;

export const SESSION_STATUSES = [
  'idle',
  'running',
  'needs-approval',
  'stale',
  'closed',
  'error',
] as const;

export const CONTENT_KINDS = [
  'text',
  'reasoning',
  'plan',
  'command',
  'status',
] as const;

export const STOP_REASONS = [
  'completed',
  'interrupted',
  'cancelled',
  'limit_reached',
  'refused',
  'other',
] as const;

export const APPROVAL_OPTION_KINDS = [
  'allow_once',
  'allow_session',
  'allow_always',
  'reject_once',
  'reject_always',
] as const;

export const PROTOCOL_ERROR_CODES = [
  'INVALID_REQUEST',
  'METHOD_NOT_FOUND',
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
  'APPROVAL_NOT_FOUND',
  'APPROVAL_OPTION_NOT_FOUND',
  'NATIVE_SESSION_NOT_FOUND',
  'CONFLICT',
  'POLICY_NOT_SUPPORTED',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_AUTH_REQUIRED',
  'RUNTIME_ERROR',
  'CANCELLED',
  'INTERNAL',
] as const;

export type CoreMethod = typeof CORE_METHODS[number];
export type OptionalMethod = keyof typeof OPTIONAL_METHOD_CAPABILITIES;
export type ProxyMethod = CoreMethod | OptionalMethod;
export type CapabilityName = typeof CAPABILITY_NAMES[number];
export type ProtocolErrorCode = typeof PROTOCOL_ERROR_CODES[number];

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
