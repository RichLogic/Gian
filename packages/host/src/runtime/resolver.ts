import { createHash } from 'node:crypto';
import { delimiter, dirname } from 'node:path';

import type { RuntimeDiscoverResult, RuntimeProbeResult } from '@gian/proxy-protocol';
import { isCanonicalAbsolutePath, type OpenRuntimeProfile, type ProxyPluginId } from '@gian/shared';

import { acquireAgentRuntimeUseLock, type AgentUpdateLease } from '../agents/update-lock.js';
import { runRuntimeBootstrap, assertSafeDiscoverResult, assertSafeProbeResult } from './bootstrap.js';
import { classifyRuntimeVersion } from './classify-version.js';
import { hostRuntimeFingerprint, RuntimeFingerprintError } from './fingerprint.js';
import type { RuntimeLease, RuntimeSource } from './types.js';

const SYSTEM_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export type RuntimeKind = 'none' | 'external';

export interface RuntimeResolveInput {
  pluginId: ProxyPluginId;
  pluginVersion: string;
  agentId: string;
  entryPath: string;
  processScope: 'shared' | 'session';
  runtime: {
    kind: RuntimeKind;
    id?: string;
    displayName?: string;
    verifiedVersions?: readonly string[];
  };
  selectedPath: string | null;
}

export interface RuntimeReadinessIssue {
  code: string;
  message: string;
  repairable: boolean;
}

export interface RuntimeObservation {
  pluginId: ProxyPluginId;
  pluginVersion: string;
  selectedPath: string;
  configHome: string | null;
  contentRoots: Array<{ path: string; mode: 'file' | 'directory' }>;
  fingerprint: string;
}

export interface ResolvedRuntime {
  profile: OpenRuntimeProfile;
  lease: RuntimeLease | null;
  readinessIssue?: RuntimeReadinessIssue;
  observation?: RuntimeObservation;
}

interface ActiveRuntime {
  key: string;
  identity: string;
  pluginId: ProxyPluginId;
  pluginVersion: string;
  path: string | null;
  fingerprint: string | null;
  probe: RuntimeProbeResult | null;
  source: RuntimeSource | null;
  env: Readonly<Record<string, string>>;
  leases: number;
  generation: number;
  claim: AgentUpdateLease | null;
  retired: boolean;
  retirement?: Promise<void>;
  retirementComplete: boolean;
  retirementFailure?: unknown;
}

interface FailedResolutionClaim {
  key: string;
  claim: AgentUpdateLease;
  retirement?: Promise<void>;
  failure: unknown;
}

export class RuntimeResolverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeResolverError';
    this.code = code;
  }
}

export function openRuntimeIdentity(
  pluginId: string,
  path: string | null,
  fingerprint: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([pluginId, path, fingerprint]))
    .digest('hex');
}

function lockName(pluginId: string, path: string | null): string {
  return createHash('sha256').update(`${pluginId}\0${path ?? 'none'}`).digest('hex');
}

function uniquePath(entries: Array<string | undefined>): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of entries) {
    for (const entry of (value ?? '').split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result.join(delimiter);
}

function companionEnv(selectedPath: string | null): Readonly<Record<string, string>> {
  if (!selectedPath) return Object.freeze({});
  return Object.freeze({
    PATH: uniquePath([
      dirname(process.execPath),
      dirname(selectedPath),
      process.env.PATH,
      ...SYSTEM_PATHS,
    ]),
  });
}

function mapSource(
  selectedPath: string,
  discover: RuntimeDiscoverResult,
): RuntimeSource {
  const match = discover.candidates.find((candidate) => candidate.path === selectedPath);
  if (!match) return 'override';
  return match.source === 'configured' ? 'override' : match.source;
}

function assertTrustedRuntimeManifest(input: RuntimeResolveInput): void {
  if (input.runtime.kind !== 'external') {
    throw new RuntimeResolverError('RUNTIME_MANIFEST_INVALID', 'External resolution requires an external Runtime.');
  }
  if (!input.runtime.id || input.runtime.id.trim() !== input.runtime.id) {
    throw new RuntimeResolverError(
      'RUNTIME_MANIFEST_INVALID',
      'Trusted Manifest Runtime id is required before taking a claim.',
    );
  }
  if (!input.runtime.displayName || input.runtime.displayName.trim() !== input.runtime.displayName) {
    throw new RuntimeResolverError(
      'RUNTIME_MANIFEST_INVALID',
      'Trusted Manifest Runtime displayName is required before taking a claim.',
    );
  }
  if (!Array.isArray(input.runtime.verifiedVersions)) {
    throw new RuntimeResolverError(
      'RUNTIME_MANIFEST_INVALID',
      'Trusted Manifest Runtime verifiedVersions is required before the first bootstrap spawn.',
    );
  }
}

function assertTrustedRuntimeInput(input: RuntimeResolveInput, selectedPath: string): void {
  assertTrustedRuntimeManifest(input);
  if (!isCanonicalAbsolutePath(selectedPath)) {
    throw new RuntimeResolverError(
      'RUNTIME_PATH_INVALID',
      'Selected Runtime path must be a canonical absolute path.',
    );
  }
}

export class RuntimeResolver {
  private readonly active = new Map<string, ActiveRuntime>();
  private readonly observations = new Map<string, RuntimeObservation>();
  private readonly resolving = new Map<string, {
    generation: number;
    promise: Promise<ActiveRuntime>;
  }>();
  private readonly generations = new Map<string, number>();
  private readonly retirementsByKey = new Map<string, Set<ActiveRuntime>>();
  private readonly failedResolutionClaimsByKey = new Map<string, Set<FailedResolutionClaim>>();

  constructor(private readonly options: {
    dataDir: string;
    updateLockDataDir: string;
    hostVersion: string;
    bootstrapTimeoutMs?: number;
    bootstrapEnv?: Readonly<Record<string, string>>;
    homeDir?: string;
    acquireLock?: typeof acquireAgentRuntimeUseLock;
  }) {}

  async discover(input: RuntimeResolveInput): Promise<RuntimeDiscoverResult> {
    if (input.runtime.kind === 'none') {
      return { candidates: [], setupActions: [] };
    }
    assertTrustedRuntimeManifest(input);
    return this.bootstrapDiscover(input);
  }

  async resolve(input: RuntimeResolveInput): Promise<ResolvedRuntime> {
    if (input.runtime.kind === 'none') {
      if (input.selectedPath !== null) {
        throw new RuntimeResolverError(
          'RUNTIME_NONE_HAS_PATH',
          'A none Runtime profile cannot carry a selected path.',
        );
      }
      return {
        profile: this.noneProfile(input),
        lease: null,
      };
    }
    assertTrustedRuntimeManifest(input);
    const selected = await this.resolveSelectedPath(input);
    const selectedPath = selected.selectedPath;
    const key = this.generationKey(input, selectedPath);
    while (true) {
      const retirement = this.retryRetirements(key);
      if (retirement) {
        await retirement;
        continue;
      }
      const generation = this.generations.get(key) ?? 0;
      let active = this.active.get(key);
      if (active?.generation !== generation || active?.retired) active = undefined;
      if (!active) {
        let pending = this.resolving.get(key);
        if (pending?.generation !== generation) {
          const promise = this.resolveExternal(input, selectedPath, generation, key, selected.discover);
          pending = { generation, promise };
          this.resolving.set(key, pending);
        }
        try {
          active = await pending.promise;
        } finally {
          if (this.resolving.get(key)?.promise === pending.promise) this.resolving.delete(key);
        }
      }
      if (active.retired) continue;
      if ((this.generations.get(key) ?? 0) !== generation) {
        if (active.leases === 0) await this.retire(active);
        continue;
      }
      if (active.probe?.readinessIssue) {
        const readinessIssue = active.probe.readinessIssue;
        if (this.active.get(key) === active) this.active.delete(key);
        if (active.claim && active.leases === 0) await this.retire(active);
        return {
          profile: this.profileFromActive(input, active),
          lease: null,
          readinessIssue,
          ...(this.observationFromActive(active)),
        };
      }
      await this.assertUnchanged(active);
      active.leases += 1;
      return {
        profile: this.profileFromActive(input, active),
        lease: this.makeLease(active),
        ...(this.observationFromActive(active)),
      };
    }
  }

  invalidate(pluginId: ProxyPluginId, selectedPath?: string | null): boolean {
    for (const [key, observation] of [...this.observations]) {
      if (observation.pluginId !== pluginId) continue;
      if (selectedPath && observation.selectedPath !== selectedPath) continue;
      this.observations.delete(key);
    }
    let idle = true;
    for (const key of this.keysFor(pluginId, selectedPath)) {
      const generation = this.generations.get(key) ?? 0;
      this.generations.set(key, generation + 1);
      const wasResolving = this.resolving.get(key)?.generation === generation;
      const active = this.active.get(key);
      this.active.delete(key);
      if (active?.leases === 0) {
        void this.retire(active).catch((error) => {
          console.error('[runtime] failed to retire idle claim:', error);
        });
      }
      if (wasResolving || (active && active.leases > 0)) idle = false;
    }
    return idle;
  }

  async detectExternalChanges(
    extra: readonly RuntimeObservation[] = [],
  ): Promise<ProxyPluginId[]> {
    const watched = new Map<string, RuntimeObservation>();
    for (const observation of this.observations.values()) {
      watched.set(this.observationContractKey(observation), observation);
    }
    for (const observation of extra) {
      watched.set(this.observationContractKey(observation), observation);
    }
    for (const active of this.active.values()) {
      const observation = this.observationFromActive(active)?.observation;
      if (observation) {
        watched.set(this.observationContractKey(observation), observation);
      }
    }
    const checks = Array.from(watched.values()).map(async (observation) => {
      try {
        await this.assertObservationUnchanged(observation);
        return null;
      } catch {
        return observation.pluginId;
      }
    });
    const changed = await Promise.all(checks);
    return [...new Set(changed.filter((pluginId): pluginId is ProxyPluginId => pluginId !== null))];
  }

  async drain(pluginId: ProxyPluginId): Promise<void> {
    while (true) {
      let progressed = false;
      for (const key of this.keysFor(pluginId)) {
        const resolving = this.resolving.get(key)?.promise;
        if (resolving) {
          await resolving.catch(() => undefined);
          await Promise.resolve();
          progressed = true;
          continue;
        }
        const active = this.active.get(key);
        if (active && active.leases === 0) {
          await this.retire(active);
          progressed = true;
          continue;
        }
        const retirement = this.retryRetirements(key);
        if (retirement) {
          await retirement;
          progressed = true;
        }
      }
      if (!progressed) return;
    }
  }

  private async bootstrapDiscover(input: RuntimeResolveInput): Promise<RuntimeDiscoverResult> {
    return runRuntimeBootstrap({
      entryPath: input.entryPath,
      pluginId: input.pluginId,
      pluginVersion: input.pluginVersion,
      processScope: input.processScope,
      dataDir: this.options.dataDir,
      hostVersion: this.options.hostVersion,
      ...(this.options.bootstrapTimeoutMs ? { timeoutMs: this.options.bootstrapTimeoutMs } : {}),
      ...(this.options.bootstrapEnv ? { env: this.options.bootstrapEnv } : {}),
    }, async (client) => {
      const result = await client.request<RuntimeDiscoverResult>('runtime.discover', {});
      assertSafeDiscoverResult(result);
      return result;
    });
  }

  private async resolveSelectedPath(input: RuntimeResolveInput): Promise<{
    selectedPath: string;
    discover: RuntimeDiscoverResult | null;
  }> {
    if (input.selectedPath !== null) {
      const authorized = this.authorizedPath(input.selectedPath);
      if (!authorized) {
        throw new RuntimeResolverError(
          'RUNTIME_PATH_INVALID',
          'Selected Runtime path must be a canonical absolute path.',
        );
      }
      return { selectedPath: authorized, discover: null };
    }
    const discover = await this.bootstrapDiscover(input);
    const first = discover.candidates[0]?.path;
    if (!first || !isCanonicalAbsolutePath(first)) {
      throw new RuntimeResolverError(
        'RUNTIME_NOT_INSTALLED',
        'No usable Runtime candidate is available.',
      );
    }
    return { selectedPath: first, discover };
  }

  private async resolveExternal(
    input: RuntimeResolveInput,
    selectedPath: string,
    generation: number,
    key: string,
    discovered: RuntimeDiscoverResult | null,
  ): Promise<ActiveRuntime> {
    assertTrustedRuntimeInput(input, selectedPath);
    const acquireLock = this.options.acquireLock ?? acquireAgentRuntimeUseLock;
    const claim = await acquireLock(
      this.options.updateLockDataDir,
      lockName(input.pluginId, selectedPath),
      `${input.pluginId} Runtime use`,
    );
    try {
      const discover = discovered ?? (
        input.selectedPath === null
          ? await this.bootstrapDiscover(input)
          : { candidates: [], setupActions: [] }
      );
      const authorized = selectedPath;
      const fingerprintBefore = await this.safeLauncherFingerprint(authorized, null);
      const probe = await runRuntimeBootstrap({
        entryPath: input.entryPath,
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        processScope: input.processScope,
        dataDir: this.options.dataDir,
        hostVersion: this.options.hostVersion,
        ...(this.options.bootstrapTimeoutMs ? { timeoutMs: this.options.bootstrapTimeoutMs } : {}),
        ...(this.options.bootstrapEnv ? { env: this.options.bootstrapEnv } : {}),
      }, async (client) => {
        const result = await client.request<RuntimeProbeResult>('runtime.probe', { path: authorized });
        assertSafeProbeResult(result, authorized);
        return result;
      });
      if (probe.runtimeId !== input.runtime.id) {
        throw new RuntimeResolverError(
          'RUNTIME_ID_MISMATCH',
          'runtime.probe runtimeId must match the trusted Manifest Runtime id.',
        );
      }
      if (probe.displayName !== input.runtime.displayName) {
        throw new RuntimeResolverError(
          'RUNTIME_DISPLAY_MISMATCH',
          'runtime.probe displayName must match the trusted Manifest Runtime displayName.',
        );
      }
      const fingerprint = await hostRuntimeFingerprint({
        selectedPath: authorized,
        configHome: probe.configHome,
        contentRoots: probe.contentRoots,
        ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
      });
      const fingerprintAfter = await this.safeLauncherFingerprint(authorized, probe.configHome);
      if (fingerprintBefore !== null && fingerprintAfter !== null && fingerprintBefore !== fingerprintAfter) {
        throw new RuntimeResolverError(
          'RUNTIME_MUTATED',
          'Runtime content changed while its version was being probed.',
        );
      }
      const resolved: ActiveRuntime = {
        key,
        identity: openRuntimeIdentity(input.pluginId, authorized, fingerprint),
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        path: authorized,
        fingerprint,
        probe,
        source: input.selectedPath !== null ? 'override' : mapSource(authorized, discover),
        env: companionEnv(authorized),
        leases: 0,
        generation,
        claim,
        retired: false,
        retirementComplete: false,
      };
      const observation = this.observationFromActive(resolved).observation;
      if (observation) {
        this.observations.set(this.observationContractKey(observation), observation);
      }
      if ((this.generations.get(key) ?? 0) === generation) {
        this.active.set(key, resolved);
      }
      return resolved;
    } catch (error) {
      const wrapped = error instanceof RuntimeFingerprintError
        ? new RuntimeResolverError(error.code, error.message)
        : error;
      try {
        await claim.release();
      } catch (cleanupError) {
        this.trackFailedResolutionClaim(key, claim, cleanupError);
        throw new AggregateError(
          [wrapped, cleanupError],
          'Runtime resolution failed and its shared claim could not be retired.',
        );
      }
      throw wrapped;
    }
  }

  private async safeLauncherFingerprint(
    selectedPath: string,
    configHome: string | null,
  ): Promise<string | null> {
    try {
      return await hostRuntimeFingerprint({
        selectedPath,
        configHome,
        contentRoots: [{ path: selectedPath, mode: 'file' }],
        ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
      });
    } catch (error) {
      if (error instanceof RuntimeFingerprintError && error.code === 'RUNTIME_ROOT_INVALID') {
        return null;
      }
      throw error;
    }
  }

  private async assertUnchanged(active: ActiveRuntime): Promise<void> {
    if (!active.probe || !active.path || !active.fingerprint) return;
    const current = await hostRuntimeFingerprint({
      selectedPath: active.path,
      configHome: active.probe.configHome,
      contentRoots: active.probe.contentRoots,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
    });
    if (current !== active.fingerprint) {
      this.invalidate(active.pluginId, active.path);
      throw new RuntimeResolverError(
        'RUNTIME_MUTATED',
        'Runtime content changed after it was leased.',
      );
    }
  }

  private authorizedPath(selectedPath: string | null): string | null {
    if (selectedPath === null) return null;
    if (!isCanonicalAbsolutePath(selectedPath)) {
      throw new RuntimeResolverError(
        'RUNTIME_PATH_INVALID',
        'Selected Runtime path must be a canonical absolute path.',
      );
    }
    return selectedPath;
  }

  private noneProfile(input: RuntimeResolveInput): OpenRuntimeProfile {
    return {
      id: openRuntimeIdentity(input.pluginId, null, null),
      agentId: input.agentId,
      pluginId: input.pluginId,
      runtimeId: null,
      path: null,
      version: null,
      configHome: null,
      contentFingerprint: null,
      verifiedVersions: [],
      verification: 'verified',
    };
  }

  private profileFromActive(input: RuntimeResolveInput, active: ActiveRuntime): OpenRuntimeProfile {
    const verifiedVersions = [...(input.runtime.verifiedVersions ?? [])];
    return {
      id: active.identity,
      agentId: input.agentId,
      pluginId: input.pluginId,
      runtimeId: input.runtime.id ?? active.probe?.runtimeId ?? null,
      path: active.path,
      version: active.probe?.version ?? null,
      configHome: active.probe?.configHome ?? null,
      contentFingerprint: active.fingerprint,
      verifiedVersions,
      verification: classifyRuntimeVersion(active.probe?.version ?? null, verifiedVersions),
    };
  }

  private makeLease(active: ActiveRuntime): RuntimeLease {
    if (!active.path || !active.probe || !active.source) {
      throw new RuntimeResolverError('RUNTIME_NONE_HAS_PATH', 'A none Runtime cannot produce a lease.');
    }
    let counted = false;
    let releasePromise: Promise<void> | undefined;
    return {
      binaryPath: active.path,
      version: active.probe.version,
      source: active.source,
      env: active.env,
      reserveProcessGroup: async () => {
        if (!active.claim) {
          throw new RuntimeResolverError('RUNTIME_LEASE_INVALID', 'Runtime lease has no update claim.');
        }
        await this.assertUnchanged(active);
        return active.claim.reserveProcessGroup();
      },
      release: () => {
        if (releasePromise) return releasePromise;
        if (!counted) {
          counted = true;
          active.leases = Math.max(0, active.leases - 1);
        }
        releasePromise = active.leases === 0
          ? this.retire(active)
          : Promise.resolve();
        return releasePromise.finally(() => {
          releasePromise = undefined;
        });
      },
    };
  }

  private generationKey(input: RuntimeResolveInput, path: string | null): string {
    return [
      input.pluginId,
      input.pluginVersion,
      input.entryPath,
      input.runtime.kind,
      input.runtime.id ?? '',
      input.runtime.displayName ?? '',
      (input.runtime.verifiedVersions ?? []).join(','),
      path ?? 'none',
    ].join('\0');
  }

  private observationContractKey(observation: RuntimeObservation): string {
    return [
      observation.pluginId,
      observation.pluginVersion,
      observation.selectedPath,
      observation.fingerprint,
      observation.configHome ?? '',
      JSON.stringify(observation.contentRoots),
    ].join('\0');
  }

  private observationFromActive(
    active: ActiveRuntime,
  ): { observation: RuntimeObservation } | Record<string, never> {
    if (!active.path || !active.fingerprint || !active.probe) return {};
    return {
      observation: {
        pluginId: active.pluginId,
        pluginVersion: active.pluginVersion,
        selectedPath: active.path,
        configHome: active.probe.configHome,
        contentRoots: active.probe.contentRoots,
        fingerprint: active.fingerprint,
      },
    };
  }

  private async assertObservationUnchanged(observation: RuntimeObservation): Promise<void> {
    const current = await hostRuntimeFingerprint({
      selectedPath: observation.selectedPath,
      configHome: observation.configHome,
      contentRoots: observation.contentRoots,
      ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}),
    });
    if (current !== observation.fingerprint) {
      this.invalidate(observation.pluginId, observation.selectedPath);
      throw new RuntimeResolverError(
        'RUNTIME_MUTATED',
        'Runtime content changed after it was observed.',
      );
    }
  }

  private keysFor(pluginId: ProxyPluginId, selectedPath?: string | null): string[] {
    const keys = new Set<string>();
    const prefix = `${pluginId}\0`;
    const suffix = selectedPath !== undefined ? `\0${selectedPath ?? 'none'}` : null;
    for (const key of [
      ...this.active.keys(),
      ...this.resolving.keys(),
      ...this.generations.keys(),
      ...this.retirementsByKey.keys(),
      ...this.failedResolutionClaimsByKey.keys(),
    ]) {
      if (!key.startsWith(prefix)) continue;
      if (suffix !== null && !key.endsWith(suffix)) continue;
      keys.add(key);
    }
    return [...keys];
  }

  private retire(active: ActiveRuntime): Promise<void> {
    if (active.retirementComplete) return Promise.resolve();
    if (!active.claim) {
      active.retirementComplete = true;
      return Promise.resolve();
    }
    const bindingKey = active.key;
    let retirements = this.retirementsByKey.get(bindingKey);
    if (!retirements) {
      retirements = new Set();
      this.retirementsByKey.set(bindingKey, retirements);
    }
    retirements.add(active);
    if (active.retirement) return active.retirement;
    active.retired = true;
    if (this.active.get(bindingKey) === active) this.active.delete(bindingKey);
    active.retirementFailure = undefined;
    const retirement = active.claim.release().then(
      () => {
        active.retirementComplete = true;
        retirements!.delete(active);
        if (retirements!.size === 0 && this.retirementsByKey.get(bindingKey) === retirements) {
          this.retirementsByKey.delete(bindingKey);
        }
      },
      (error) => {
        active.retirementFailure = error;
        throw error;
      },
    ).finally(() => {
      if (active.retirement === retirement && !active.retirementComplete) {
        active.retirement = undefined;
      }
    });
    active.retirement = retirement;
    return active.retirement;
  }

  private retryRetirements(key: string): Promise<void> | null {
    const retirements = Array.from(this.retirementsByKey.get(key) ?? []);
    const failedResolutions = Array.from(this.failedResolutionClaimsByKey.get(key) ?? []);
    if (retirements.length === 0 && failedResolutions.length === 0) return null;
    return Promise.all([
      ...retirements.map((active) => this.retire(active)),
      ...failedResolutions.map((failed) => this.retireFailedResolutionClaim(failed)),
    ]).then(() => undefined);
  }

  private trackFailedResolutionClaim(
    key: string,
    claim: AgentUpdateLease,
    failure: unknown,
  ): void {
    let failed = this.failedResolutionClaimsByKey.get(key);
    if (!failed) {
      failed = new Set();
      this.failedResolutionClaimsByKey.set(key, failed);
    }
    failed.add({ key, claim, failure });
  }

  private retireFailedResolutionClaim(failed: FailedResolutionClaim): Promise<void> {
    if (failed.retirement) return failed.retirement;
    const retirement = failed.claim.release().then(
      () => {
        const claims = this.failedResolutionClaimsByKey.get(failed.key);
        claims?.delete(failed);
        if (claims?.size === 0) this.failedResolutionClaimsByKey.delete(failed.key);
      },
      (error) => {
        failed.failure = error;
        throw error;
      },
    ).finally(() => {
      if (failed.retirement === retirement) failed.retirement = undefined;
    });
    failed.retirement = retirement;
    return retirement;
  }
}
