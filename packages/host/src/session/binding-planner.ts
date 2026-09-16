import type { InitializeResult } from '@gian/proxy-protocol';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolRangeIncludes,
} from '@gian/proxy-protocol';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  isOpenRuntimeProfile,
  parseProxyPluginId,
  productExecutorForPluginId,
  sessionRuntimeCliPath,
  type OpenRuntimeProfile,
  type SessionProxyBinding,
  type SessionRuntimeProfile,
  type UserAgent,
} from '@gian/shared';

import type { ProxyLaunchBinding } from '../proxy/launch-binding.js';
import { openRuntimeIdentity, type RuntimeResolver } from '../runtime/resolver.js';
import { createSavedPathRuntimeLease } from '../runtime/saved-path.js';
import type { TrustedLaunch } from '../runtime/trusted-launch.js';
import type { RuntimeLease } from '../runtime/types.js';
import { providerHomeEnvironment } from '../agents/home.js';

export class SessionBindingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionBindingError';
    this.code = code;
  }
}

export interface PreparedSessionLaunch {
  sessionBinding: SessionProxyBinding;
  launchBinding: ProxyLaunchBinding;
  /** Set only when the stored Runtime profile drifted in launchable facts
   *  (version/fingerprint/verification metadata) while identity held; the
   *  caller must persist this re-minted binding after a successful bring-up. */
  remintedBinding?: SessionProxyBinding;
  acquireLease: () => Promise<RuntimeLease | null>;
  /** Releases the initially resolved lease when ProxyManager reused an
   * existing process and therefore never consumed it. Idempotent on success. */
  releaseUnusedLease: () => Promise<void>;
}

export interface SessionBindingPlannerOptions {
  resolveCurrent: (pluginId: string) => Promise<TrustedLaunch | null>;
  resolveExact: (input: {
    pluginId: string;
    pluginVersion: string;
    expectedManifestSha256: string;
  }) => Promise<TrustedLaunch>;
  runtimeResolver?: RuntimeResolver;
}

function pinnedProtocol(launch: TrustedLaunch): string {
  const selected = SUPPORTED_PROTOCOL_VERSIONS.find(version => (
    protocolRangeIncludes(launch.protocolRange, version)
  ));
  if (selected) return selected;
  throw new SessionBindingError(
    'BINDING_PROTOCOL_UNSUPPORTED',
    `Trusted package ${launch.pluginId}@${launch.pluginVersion} has no Host-supported protocol.`,
  );
}

interface PreparedLeaseSource {
  acquire: () => Promise<RuntimeLease | null>;
  releaseUnused: () => Promise<void>;
}

function preparedLeaseSource(input: {
  initial: RuntimeLease | null;
  reacquire?: () => Promise<RuntimeLease | null>;
}): PreparedLeaseSource {
  let initial = input.initial;
  let releasing: Promise<void> | null = null;
  return {
    acquire: async () => {
      if (releasing) await releasing;
      if (initial) {
        const lease = initial;
        initial = null;
        return lease;
      }
      return input.reacquire?.() ?? null;
    },
    releaseUnused: async () => {
      if (!initial) {
        if (releasing) await releasing;
        return;
      }
      if (!releasing) {
        const lease = initial;
        releasing = lease.release().then(() => {
          if (initial === lease) initial = null;
        }).finally(() => {
          releasing = null;
        });
      }
      await releasing;
    },
  };
}

function scopeProfileToHome(
  profile: OpenRuntimeProfile,
  configHome: string | null,
): OpenRuntimeProfile {
  if (profile.configHome === configHome) return profile;
  return {
    ...profile,
    id: createHash('sha256').update(JSON.stringify([profile.id, configHome])).digest('hex'),
    configHome,
  };
}

function scopeLeaseToHome(
  lease: RuntimeLease,
  pluginId: ReturnType<typeof parseProxyPluginId>,
  configHome: string | null,
): RuntimeLease {
  if (!configHome) return lease;
  return {
    ...lease,
    env: Object.freeze({
      ...lease.env,
      ...providerHomeEnvironment(pluginId, configHome),
    }),
  };
}

function noneProfile(
  agentId: string,
  pluginId: ReturnType<typeof parseProxyPluginId>,
  configHome: string | null,
): OpenRuntimeProfile {
  return {
    id: createHash('sha256').update(JSON.stringify([
      openRuntimeIdentity(pluginId, null, null),
      configHome,
    ])).digest('hex'),
    agentId,
    pluginId,
    runtimeId: null,
    path: null,
    version: null,
    configHome,
    contentFingerprint: null,
    verifiedVersions: [],
    verification: 'verified',
  };
}

function resolveInput(launch: TrustedLaunch, agentId: string, selectedPath: string | null) {
  return {
    pluginId: parseProxyPluginId(launch.pluginId),
    pluginVersion: launch.pluginVersion,
    agentId,
    entryPath: launch.entryPath,
    processScope: launch.processScope,
    runtime: launch.runtime,
    selectedPath,
  };
}

function assertLaunchableProfile(profile: OpenRuntimeProfile): void {
  if (profile.verification === 'incompatible') {
    throw new SessionBindingError(
      'BINDING_RUNTIME_INCOMPATIBLE',
      'Exact Runtime profile is incompatible with this Host.',
    );
  }
}

export function assertHandshakeMatchesBinding(
  initialized: InitializeResult,
  binding: SessionProxyBinding,
): void {
  if (initialized.protocol.version !== binding.protocolVersion) {
    throw new SessionBindingError(
      'BINDING_PROTOCOL_MISMATCH',
      `Handshake negotiated ${initialized.protocol.version}, binding pinned ${binding.protocolVersion}.`,
    );
  }
  if (
    initialized.plugin.id !== binding.pluginId
    || initialized.plugin.version !== binding.pluginVersion
  ) {
    throw new SessionBindingError(
      'BINDING_IDENTITY_MISMATCH',
      'Handshake plugin identity does not match the Session binding.',
    );
  }
  if (initialized.process.scope !== binding.processScope) {
    throw new SessionBindingError(
      'BINDING_SCOPE_MISMATCH',
      'Handshake process scope does not match the Session binding.',
    );
  }
}

export class SessionBindingPlanner {
  constructor(private readonly options: SessionBindingPlannerOptions) {}

  async prepareCurrent(input: {
    agent: UserAgent;
    selectedPath: string | null;
    runtimeProfile?: SessionRuntimeProfile | null;
  }): Promise<PreparedSessionLaunch> {
    const pluginId = parseProxyPluginId(input.agent.pluginId);
    const launch = await this.options.resolveCurrent(pluginId);
    if (!launch) {
      throw new SessionBindingError(
        'BINDING_PACKAGE_UNAVAILABLE',
        `No trusted Proxy package is available for ${pluginId}.`,
      );
    }
    if (launch.schemaVersion !== 4 && !productExecutorForPluginId(pluginId)) {
      throw new SessionBindingError(
        'BINDING_SCHEMA_UNSUPPORTED',
        'Unknown plugins require a Manifest v4 package.',
      );
    }
    return this.prepareFromLaunch(
      launch,
      input.agent.id,
      input.selectedPath,
      input.runtimeProfile,
      undefined,
      input.agent.home?.path ?? null,
    );
  }

  async prepareExact(binding: SessionProxyBinding): Promise<PreparedSessionLaunch> {
    const launch = await this.options.resolveExact({
      pluginId: binding.pluginId,
      pluginVersion: binding.pluginVersion,
      expectedManifestSha256: binding.manifestSha256,
    });
    if (launch.pluginId !== binding.pluginId
      || launch.pluginVersion !== binding.pluginVersion
      || launch.manifestSha256 !== binding.manifestSha256
      || launch.processScope !== binding.processScope) {
      throw new SessionBindingError(
        'BINDING_PACKAGE_MISMATCH',
        'Retained package facts do not match the stored Session binding.',
      );
    }
    if (!protocolRangeIncludes(launch.protocolRange, binding.protocolVersion)) {
      throw new SessionBindingError(
        'BINDING_PROTOCOL_MISMATCH',
        `Retained package protocol range does not include binding ${binding.protocolVersion}.`,
      );
    }
    const agentId = binding.runtimeProfile?.agentId ?? 'session';
    const storedPath = sessionRuntimeCliPath(binding.runtimeProfile);
    const prepared = await this.prepareFromLaunch(
      launch,
      agentId,
      storedPath,
      binding.runtimeProfile,
      binding.protocolVersion,
      binding.runtimeProfile?.configHome ?? null,
    );
    let runtimeDrifted = false;
    try {
      runtimeDrifted = this.assertExactRuntime(binding, prepared.sessionBinding);
    } catch (error) {
      try {
        await prepared.releaseUnusedLease();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Exact Runtime validation failed and its prepared lease could not be released.',
        );
      }
      throw error;
    }
    if (runtimeDrifted) {
      const remintedBinding: SessionProxyBinding = {
        ...binding,
        runtimeProfile: prepared.sessionBinding.runtimeProfile,
      };
      return {
        sessionBinding: remintedBinding,
        launchBinding: prepared.launchBinding,
        remintedBinding,
        acquireLease: prepared.acquireLease,
        releaseUnusedLease: prepared.releaseUnusedLease,
      };
    }
    return {
      sessionBinding: binding,
      launchBinding: {
        ...prepared.launchBinding,
        runtimeProfile: binding.runtimeProfile && isOpenRuntimeProfile(binding.runtimeProfile)
          ? { identity: binding.runtimeProfile.id }
          : prepared.launchBinding.runtimeProfile,
      },
      acquireLease: prepared.acquireLease,
      releaseUnusedLease: prepared.releaseUnusedLease,
    };
  }

  async captureLegacyAttach(input: {
    pluginId: string;
    agentId: string;
    selectedPath: string | null;
    runtimeProfile?: SessionRuntimeProfile | null;
  }): Promise<PreparedSessionLaunch | null> {
    const launch = await this.options.resolveCurrent(input.pluginId);
    if (!launch) return null;
    return this.prepareFromLaunch(launch, input.agentId, input.selectedPath, input.runtimeProfile);
  }

  private async prepareFromLaunch(
    launch: TrustedLaunch,
    agentId: string,
    selectedPath: string | null,
    providedProfile?: SessionRuntimeProfile | null,
    exactProtocolVersion?: string,
    configHome: string | null = null,
  ): Promise<PreparedSessionLaunch> {
    const protocolVersion = exactProtocolVersion ?? pinnedProtocol(launch);
    const pluginId = parseProxyPluginId(launch.pluginId);
    let runtimeProfile: SessionRuntimeProfile | null;
    let leaseSource: PreparedLeaseSource;

    if (launch.schemaVersion < 4) {
      const profile = providedProfile && (
        isOpenRuntimeProfile(providedProfile) || 'cliPath' in providedProfile
      )
        ? providedProfile
        : null;
      if (!profile) {
        throw new SessionBindingError(
          'BINDING_RUNTIME_PROFILE_REQUIRED',
          'Legacy official launches require a stored Runtime profile.',
        );
      }
      const savedPath = sessionRuntimeCliPath(profile);
      if (!savedPath) {
        throw new SessionBindingError(
          'BINDING_RUNTIME_PATH_REQUIRED',
          'Legacy official launches require a stored Runtime path.',
        );
      }
      const version = isOpenRuntimeProfile(profile) ? profile.version : profile.cliVersion;
      const effectiveHome = configHome ?? profile.configHome;
      const initial = scopeLeaseToHome(
        await createSavedPathRuntimeLease(savedPath, version ?? '0.0.0'),
        pluginId,
        effectiveHome,
      );
      runtimeProfile = isOpenRuntimeProfile(profile)
        ? scopeProfileToHome(profile, effectiveHome)
        : profile;
      leaseSource = preparedLeaseSource({
        initial,
        reacquire: async () => scopeLeaseToHome(
          await createSavedPathRuntimeLease(savedPath, version ?? '0.0.0'),
          pluginId,
          effectiveHome,
        ),
      });
    } else if (launch.runtime.kind === 'none') {
      if (selectedPath !== null) {
        throw new SessionBindingError(
          'BINDING_RUNTIME_NONE_HAS_PATH',
          'A none Runtime package cannot bind a selected CLI path.',
        );
      }
      if (this.options.runtimeResolver) {
        const resolved = await this.options.runtimeResolver.resolve(
          resolveInput(launch, agentId, null),
        );
        runtimeProfile = scopeProfileToHome({ ...resolved.profile, agentId }, configHome);
        leaseSource = preparedLeaseSource({
          initial: resolved.lease
            ? scopeLeaseToHome(resolved.lease, pluginId, configHome)
            : null,
        });
      } else {
        runtimeProfile = noneProfile(agentId, pluginId, configHome);
        leaseSource = preparedLeaseSource({ initial: null });
      }
    } else {
      if (!this.options.runtimeResolver) {
        throw new SessionBindingError(
          'BINDING_RUNTIME_UNAVAILABLE',
          'External Runtime v4 launches require RuntimeResolver.',
        );
      }
      if (!selectedPath) {
        throw new SessionBindingError(
          'BINDING_RUNTIME_PATH_REQUIRED',
          'External Runtime binding requires the stored selected path.',
        );
      }
      const resolved = await this.options.runtimeResolver.resolve(
        resolveInput(launch, agentId, selectedPath),
      );
      if (resolved.readinessIssue || !resolved.lease) {
        throw new SessionBindingError(
          resolved.readinessIssue?.code ?? 'BINDING_RUNTIME_UNREADY',
          resolved.readinessIssue?.message ?? 'Exact Runtime is not ready.',
        );
      }
      try {
        assertLaunchableProfile(resolved.profile);
        if (resolved.profile.path !== selectedPath) {
          throw new SessionBindingError(
            'BINDING_RUNTIME_PATH_MISMATCH',
            'Resolved Runtime path drifted from the selected path.',
          );
        }
      } catch (error) {
        await resolved.lease.release();
        throw error;
      }
      runtimeProfile = scopeProfileToHome({ ...resolved.profile, agentId }, configHome);
      const expectedProfile = runtimeProfile;
      const reacquire = async (): Promise<RuntimeLease> => {
        const next = await this.options.runtimeResolver!.resolve(
          resolveInput(launch, agentId, selectedPath),
        );
        if (next.readinessIssue || !next.lease) {
          throw new SessionBindingError(
            next.readinessIssue?.code ?? 'BINDING_RUNTIME_UNREADY',
            next.readinessIssue?.message ?? 'Exact Runtime is not ready.',
          );
        }
        try {
          this.assertRuntimeProfilesEqual(expectedProfile, { ...next.profile, agentId });
          return scopeLeaseToHome(next.lease, pluginId, configHome);
        } catch (error) {
          await next.lease.release();
          throw error;
        }
      };
      leaseSource = preparedLeaseSource({
        initial: scopeLeaseToHome(resolved.lease, pluginId, configHome),
        reacquire,
      });
    }

    const identity = isOpenRuntimeProfile(runtimeProfile)
      ? runtimeProfile.id
      : runtimeProfile.id;
    const sessionBinding: SessionProxyBinding = {
      schemaVersion: 1,
      pluginId,
      pluginVersion: launch.pluginVersion,
      manifestSha256: launch.manifestSha256,
      protocolVersion,
      processScope: launch.processScope,
      runtimeProfile,
    };
    return {
      sessionBinding,
      launchBinding: {
        pluginId,
        pluginVersion: launch.pluginVersion,
        manifestSha256: launch.manifestSha256,
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        protocolVersion,
        runtimeProfile: { identity },
      },
      acquireLease: leaseSource.acquire,
      releaseUnusedLease: leaseSource.releaseUnused,
    };
  }

  /** Validates the stored Runtime profile against the freshly probed one.
   *  Open Runtime profiles are compared on identity fields only: launchable
   *  drift in version, content fingerprint, or verification metadata (for
   *  example an in-place CLI self-update) is accepted and re-minted rather
   *  than rejected. Returns true when the resolved profile drifted and the
   *  stored binding must be re-minted. */
  private assertExactRuntime(
    stored: SessionProxyBinding,
    resolved: SessionProxyBinding,
  ): boolean {
    const storedProfile = stored.runtimeProfile;
    const resolvedProfile = resolved.runtimeProfile;
    if (!storedProfile && !resolvedProfile) return false;
    if (!storedProfile || !resolvedProfile) {
      throw new SessionBindingError(
        'BINDING_RUNTIME_MISMATCH',
        'Stored Runtime profile does not match the reacquired generation.',
      );
    }
    if (isOpenRuntimeProfile(storedProfile) && isOpenRuntimeProfile(resolvedProfile)) {
      for (const field of ['pluginId', 'agentId', 'runtimeId', 'path', 'configHome'] as const) {
        if (storedProfile[field] !== resolvedProfile[field]) {
          throw new SessionBindingError(
            'BINDING_RUNTIME_MISMATCH',
            `Stored Runtime profile identity (${field}) does not match the reacquired generation.`,
          );
        }
      }
      return !isDeepStrictEqual(storedProfile, resolvedProfile);
    }
    this.assertRuntimeProfilesEqual(storedProfile, resolvedProfile);
    return false;
  }

  private assertRuntimeProfilesEqual(
    storedProfile: SessionRuntimeProfile,
    resolvedProfile: SessionRuntimeProfile,
  ): void {
    if (!isDeepStrictEqual(storedProfile, resolvedProfile)) {
      throw new SessionBindingError(
        'BINDING_RUNTIME_MISMATCH',
        'Stored Runtime profile does not exactly match the reacquired generation.',
      );
    }
  }
}
