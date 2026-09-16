import { isCanonicalAbsolutePath } from './bounded-path.js';
import { PRODUCT_EXECUTOR_IDS } from './legacy-plugin-aliases.js';
import { pluginIdForExecutorId } from './legacy-plugin-aliases.js';
import { isProxyPluginId, type ProxyPluginId } from './plugin-id.js';
import type { AgentRuntimeProfile } from './agents.js';

export { isCanonicalAbsolutePath } from './bounded-path.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const KNOWN_BINDING_PROTOCOL_VERSIONS = ['2.3', '2.2', '2.1', '2.0'] as const;
const MAX_PROFILE_ID_CHARS = 128;
const MAX_PROFILE_PATH_CHARS = 4_096;
const MAX_VERIFIED_VERSIONS = 32;

export interface OpenRuntimeProfile {
  id: string;
  agentId: string;
  pluginId: ProxyPluginId;
  runtimeId: string | null;
  path: string | null;
  version: string | null;
  configHome: string | null;
  contentFingerprint: string | null;
  verifiedVersions: string[];
  verification: 'verified' | 'unverified' | 'incompatible';
}

export type SessionRuntimeProfile = OpenRuntimeProfile | AgentRuntimeProfile;

export interface SessionProxyBinding {
  schemaVersion: 1;
  pluginId: ProxyPluginId;
  pluginVersion: string;
  manifestSha256: string;
  protocolVersion: string;
  processScope: 'shared' | 'session';
  runtimeProfile: SessionRuntimeProfile | null;
}

export type SessionProxyBindingParseResult =
  | { ok: true; binding: SessionProxyBinding }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isBoundedIdentity(value: unknown, max = MAX_PROFILE_ID_CHARS): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !value.includes('\0');
}

function isBoundedOptionalString(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !value.includes('\0');
}

function isBoundedPath(value: unknown): value is string {
  return isBoundedOptionalString(value, MAX_PROFILE_PATH_CHARS)
    && isCanonicalAbsolutePath(value);
}

function isBoundedVersion(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 64
    && SEMVER_PATTERN.test(value);
}

const OPEN_PROFILE_KEYS = [
  'id',
  'agentId',
  'pluginId',
  'runtimeId',
  'path',
  'version',
  'configHome',
  'contentFingerprint',
  'verifiedVersions',
  'verification',
] as const;

const LEGACY_PROFILE_KEYS = [
  'id',
  'agentId',
  'pluginId',
  'proxy',
  'cliPath',
  'cliVersion',
  'configHome',
  'cliFingerprint',
  'proxyVersion',
  'verifiedCliVersions',
  'verification',
  'skill',
] as const;

export function isOpenRuntimeProfile(value: unknown): value is OpenRuntimeProfile {
  if (!isRecord(value) || !hasExactKeys(value, OPEN_PROFILE_KEYS)) return false;
  return isBoundedIdentity(value.id)
    && isBoundedIdentity(value.agentId)
    && isProxyPluginId(value.pluginId)
    && (value.runtimeId === null || isBoundedIdentity(value.runtimeId, 64))
    && (value.path === null || isBoundedPath(value.path))
    && (value.version === null || isBoundedVersion(value.version))
    && (value.configHome === null || isBoundedPath(value.configHome))
    && (value.contentFingerprint === null || isBoundedOptionalString(value.contentFingerprint, 256))
    && Array.isArray(value.verifiedVersions)
    && value.verifiedVersions.length <= MAX_VERIFIED_VERSIONS
    && value.verifiedVersions.every(isBoundedVersion)
    && (value.verification === 'verified'
      || value.verification === 'unverified'
      || value.verification === 'incompatible');
}

/** Same REST/WS AgentRuntimeProfile predicate used by runtime-contracts. */
export function isAgentRuntimeProfile(value: unknown): value is AgentRuntimeProfile {
  if (!isRecord(value) || !hasExactKeys(value, LEGACY_PROFILE_KEYS) || !isRecord(value.skill)) return false;
  const skill = value.skill;
  if (!hasExactKeys(skill, ['name', 'version', 'state'])) return false;
  return isBoundedIdentity(value.id)
    && isBoundedIdentity(value.agentId)
    && isProxyPluginId(value.pluginId)
    && (PRODUCT_EXECUTOR_IDS as readonly string[]).includes(value.proxy as string)
    && isBoundedPath(value.cliPath)
    && isBoundedVersion(value.cliVersion)
    && (value.configHome === null || isBoundedPath(value.configHome))
    && (value.cliFingerprint === null || isBoundedOptionalString(value.cliFingerprint, 256))
    && isBoundedVersion(value.proxyVersion)
    && Array.isArray(value.verifiedCliVersions)
    && value.verifiedCliVersions.length <= MAX_VERIFIED_VERSIONS
    && value.verifiedCliVersions.every(isBoundedVersion)
    && (value.verification === 'verified'
      || value.verification === 'unverified'
      || value.verification === 'incompatible')
    && skill.name === 'gian-session'
    && isBoundedVersion(skill.version)
    && (skill.state === 'ready'
      || skill.state === 'missing'
      || skill.state === 'conflict'
      || skill.state === 'invalid');
}

export function isSessionRuntimeProfile(value: unknown): value is SessionRuntimeProfile {
  return isOpenRuntimeProfile(value) || isAgentRuntimeProfile(value);
}

export type SessionRuntimeFacts = {
  proxy_binding?: SessionProxyBinding | null;
  proxy_binding_error?: string | null;
  runtime_profile?: SessionRuntimeProfile | null;
} | null | undefined;

export function sessionRuntimeCliPath(
  profile: SessionRuntimeProfile | null | undefined,
): string | null {
  if (!profile) return null;
  return 'cliPath' in profile ? profile.cliPath : profile.path;
}

export function sessionRuntimeProxyVersion(
  profile: SessionRuntimeProfile | null | undefined,
): string | null {
  if (!profile || !('proxyVersion' in profile)) return null;
  return profile.proxyVersion;
}

export function sessionHasExactBinding(
  session: SessionRuntimeFacts,
): session is { proxy_binding: SessionProxyBinding } {
  return isSessionProxyBinding(session?.proxy_binding);
}

export function sessionAllowsLegacyRuntimeFallback(session: SessionRuntimeFacts): boolean {
  return !session?.proxy_binding && !session?.proxy_binding_error;
}

/** Present exact-binding damage must not be reinterpreted as "use provider default". */
export function sessionExactBindingError(session: SessionRuntimeFacts): string | null {
  if (typeof session?.proxy_binding_error === 'string' && session.proxy_binding_error.length > 0) {
    return session.proxy_binding_error;
  }
  if (session?.proxy_binding != null && !isSessionProxyBinding(session.proxy_binding)) {
    return 'PROXY_BINDING_INVALID';
  }
  return null;
}

export function sessionBoundRuntimeProfile(
  session: SessionRuntimeFacts,
): SessionRuntimeProfile | null {
  if (session?.proxy_binding_error) return null;
  if (session?.proxy_binding) {
    return isSessionProxyBinding(session.proxy_binding)
      ? session.proxy_binding.runtimeProfile
      : null;
  }
  return session?.runtime_profile ?? null;
}

export function sessionBoundRuntimeCliPath(session: SessionRuntimeFacts): string | null {
  return sessionRuntimeCliPath(sessionBoundRuntimeProfile(session));
}

export function sessionProxyPluginVersion(session: SessionRuntimeFacts): string | null {
  if (session?.proxy_binding_error) return null;
  if (session?.proxy_binding) {
    return isSessionProxyBinding(session.proxy_binding)
      ? session.proxy_binding.pluginVersion
      : null;
  }
  return sessionRuntimeProxyVersion(session?.runtime_profile);
}

export function isSessionProxyBinding(value: unknown): value is SessionProxyBinding {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const expected = [
    'schemaVersion',
    'pluginId',
    'pluginVersion',
    'manifestSha256',
    'protocolVersion',
    'processScope',
    'runtimeProfile',
  ];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    return false;
  }
  return value.schemaVersion === 1
    && isProxyPluginId(value.pluginId)
    && typeof value.pluginVersion === 'string'
    && SEMVER_PATTERN.test(value.pluginVersion)
    && typeof value.manifestSha256 === 'string'
    && SHA256_PATTERN.test(value.manifestSha256)
    && typeof value.protocolVersion === 'string'
    && (KNOWN_BINDING_PROTOCOL_VERSIONS as readonly string[]).includes(value.protocolVersion)
    && (value.processScope === 'shared' || value.processScope === 'session')
    && runtimeProfileMatchesBinding(value.runtimeProfile, value.pluginId);
}

function runtimeProfileMatchesBinding(
  profile: unknown,
  pluginId: ProxyPluginId,
): profile is SessionRuntimeProfile | null {
  if (profile === null) return true;
  if (!isSessionRuntimeProfile(profile) || profile.pluginId !== pluginId) return false;
  if ('proxy' in profile) return pluginIdForExecutorId(profile.proxy) === pluginId;
  return true;
}

/**
 * Strict stored-binding parser. Absent JSON is not an error (legacy rows have
 * pluginId backfill only). Present but malformed JSON fails closed and stays
 * diagnosable — callers must not invent version, digest, scope, or protocol.
 */
/** A stored binding that can still launch later: valid exact facts and no
 *  binding error. Archived, completed, and finalized-worktree Sessions all
 *  remain resumable (ADR-0080). */
export function isResumableSessionBinding(session: {
  proxy_binding?: SessionProxyBinding | null;
  proxy_binding_error?: string | null;
} | null | undefined): boolean {
  return isSessionProxyBinding(session?.proxy_binding)
    && !session?.proxy_binding_error;
}

export function parseSessionProxyBinding(value: unknown): SessionProxyBindingParseResult {
  if (value == null || value === '') {
    return { ok: false, error: 'PROXY_BINDING_ABSENT' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'PROXY_BINDING_INVALID' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: 'PROXY_BINDING_INVALID' };
  }
  if (!isSessionProxyBinding(parsed)) {
    return { ok: false, error: 'PROXY_BINDING_INVALID' };
  }
  return { ok: true, binding: parsed };
}
