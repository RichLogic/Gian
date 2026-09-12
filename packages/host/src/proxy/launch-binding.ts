import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

import { KNOWN_PROTOCOL_VERSIONS } from '@gian/proxy-protocol';
import { parseProxyPluginId, type Executor, type ProxyPluginId } from '@gian/shared';

export interface ProxyProtocolDescriptor {
  pluginVersion: string;
  processScope: 'shared' | 'session';
  schemaVersion?: 2 | 3 | 4;
  runtimeBootstrap?: boolean;
  runtimeId?: string;
  runtimeDisplayName?: string;
}

export interface RuntimeProfileIdentity {
  readonly identity: string;
}

/**
 * Exact, already-validated facts required to spawn one Proxy process.
 * The generic supervisor keys and launches from this object only.
 * Official multi-version offer and failed-attach retirement stay on the
 * isolated legacy adapter, not on this binding.
 */
export interface ProxyLaunchBinding {
  pluginId: ProxyPluginId;
  pluginVersion: string;
  manifestSha256: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  protocolVersion: string;
  runtimeProfile: RuntimeProfileIdentity | null;
}

export type CanonicalRuntime =
  | { readonly kind: 'null' }
  | { readonly kind: 'profile'; readonly identity: string };

export interface ValidatedLaunchBinding extends ProxyLaunchBinding {
  readonly runtime: CanonicalRuntime;
}

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RUNTIME_IDENTITY_CHARS = 1024;
/** Exact pinned launches may opt into any known version, including 2.2. */
const PINNED_PROTOCOL = new Set<string>(KNOWN_PROTOCOL_VERSIONS);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function canonicalRuntime(
  profile: RuntimeProfileIdentity | null,
): CanonicalRuntime {
  if (profile === null) return { kind: 'null' };
  if (!profile || typeof profile.identity !== 'string') {
    throw new Error('runtimeProfile must be null or { identity }.');
  }
  const identity = profile.identity;
  if (identity.length === 0 || identity.length > MAX_RUNTIME_IDENTITY_CHARS) {
    throw new Error('runtimeProfile.identity is empty or exceeds the identity bound.');
  }
  if (identity.trim() !== identity) {
    throw new Error('runtimeProfile.identity must already be canonical.');
  }
  if (hasControlCharacter(identity)) {
    throw new Error('runtimeProfile.identity must not contain control characters.');
  }
  return { kind: 'profile', identity };
}

export function validateLaunchBinding(binding: ProxyLaunchBinding): ValidatedLaunchBinding {
  const record = binding as ProxyLaunchBinding & {
    offeredProtocolVersions?: unknown;
    retireOnFailedAttach?: unknown;
  };
  if (record.offeredProtocolVersions !== undefined) {
    throw new Error('Generic launch binding cannot set offeredProtocolVersions.');
  }
  if (record.retireOnFailedAttach !== undefined) {
    throw new Error('Generic launch binding cannot set retireOnFailedAttach.');
  }
  const pluginId = parseProxyPluginId(binding.pluginId);
  if (!SEMVER.test(binding.pluginVersion)) {
    throw new Error('pluginVersion must be SemVer.');
  }
  if (!SHA256.test(binding.manifestSha256)) {
    throw new Error('manifestSha256 must be a lowercase SHA-256 hex digest.');
  }
  if (binding.processScope !== 'shared' && binding.processScope !== 'session') {
    throw new Error('processScope must be shared or session.');
  }
  if (!PINNED_PROTOCOL.has(binding.protocolVersion)) {
    throw new Error(`protocolVersion ${binding.protocolVersion} is not a known exact protocol.`);
  }
  if (typeof binding.entryPath !== 'string' || binding.entryPath.length === 0) {
    throw new Error('entryPath must be a non-empty absolute path.');
  }
  if (binding.entryPath.includes('\0')) {
    throw new Error('entryPath must not contain a NUL.');
  }
  if (!isAbsolute(binding.entryPath)) {
    throw new Error('entryPath must be an absolute path.');
  }
  if (normalize(binding.entryPath) !== binding.entryPath) {
    throw new Error('entryPath must already be normalized.');
  }
  const runtime = canonicalRuntime(binding.runtimeProfile);
  return {
    pluginId,
    pluginVersion: binding.pluginVersion,
    manifestSha256: binding.manifestSha256,
    entryPath: binding.entryPath,
    processScope: binding.processScope,
    protocolVersion: binding.protocolVersion,
    runtimeProfile: binding.runtimeProfile,
    runtime,
  };
}

function processKeyPayload(binding: ValidatedLaunchBinding): string {
  return JSON.stringify({
    pluginId: binding.pluginId,
    pluginVersion: binding.pluginVersion,
    protocolVersion: binding.protocolVersion,
    processScope: binding.processScope,
    runtime: binding.runtime,
    manifestSha256: binding.manifestSha256,
    entryPath: binding.entryPath,
  });
}

export function sharedProcessKey(binding: ProxyLaunchBinding): string {
  return createHash('sha256')
    .update(processKeyPayload(validateLaunchBinding(binding)))
    .digest('hex');
}

export function sessionProcessKey(
  binding: ProxyLaunchBinding,
  sessionId: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      process: processKeyPayload(validateLaunchBinding(binding)),
      sessionId,
    }))
    .digest('hex');
}

export function genericLaunchId(binding: ProxyLaunchBinding): string {
  return sharedProcessKey(binding);
}

export function officialSessionLaunchId(input: {
  executor: Executor;
  cliPath: string | null;
  proxyVersion: string | null;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: 'official',
      executor: input.executor,
      cliPath: input.cliPath,
      proxyVersion: input.proxyVersion,
    }))
    .digest('hex');
}
