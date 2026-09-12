import { createHash } from 'node:crypto';

import {
  PROTOCOL_V22,
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolRangeIncludes,
} from '@gian/proxy-protocol';
import { parseProxyPluginId, type Executor } from '@gian/shared';

import { RuntimeResolverError, type RuntimeResolver } from '../runtime/resolver.js';
import { createSavedPathRuntimeLease } from '../runtime/saved-path.js';
import type { TrustedLaunch } from '../runtime/trusted-launch.js';
import type { RuntimeLease } from '../runtime/types.js';
import type { ProxyLaunchBinding } from './launch-binding.js';

/**
 * The only launch adapter for rows that predate proxy_binding_json. It is
 * deliberately data-driven: the trusted package supplies identity, version,
 * protocol range, scope, entry, and Runtime metadata. No Provider registry is
 * consulted and no current package is substituted for a requested version.
 */
export interface LegacyLaunchResolution {
  binding: ProxyLaunchBinding;
  acquireLease: () => Promise<RuntimeLease | null>;
  offeredProtocolVersions: readonly string[];
  retireOnFailedAttach: boolean;
  executor: Executor;
}

function offeredProtocols(launch: TrustedLaunch): string[] {
  if (launch.schemaVersion === 4) {
    if (!protocolRangeIncludes(launch.protocolRange, PROTOCOL_V22)) {
      throw new Error('Manifest v4 legacy adapter requires gian.proxy/2.2.');
    }
    return [PROTOCOL_V22];
  }
  const offered = SUPPORTED_PROTOCOL_VERSIONS.filter(version => (
    protocolRangeIncludes(launch.protocolRange, version)
  ));
  if (offered.length === 0) {
    throw new Error(
      `Trusted package ${launch.pluginId}@${launch.pluginVersion} has no Host-supported protocol.`,
    );
  }
  return offered;
}

export async function resolveLegacyLaunch(input: {
  executor: Executor;
  launch: TrustedLaunch;
  runtimeResolver?: RuntimeResolver;
  cliPath: string | null;
  agentId?: string;
}): Promise<LegacyLaunchResolution> {
  const pluginId = parseProxyPluginId(input.launch.pluginId);
  const offeredProtocolVersions = offeredProtocols(input.launch);
  const runtimeIdentity = officialRuntimeIdentity({
    pluginId,
    pluginVersion: input.launch.pluginVersion,
    manifestSha256: input.launch.manifestSha256,
    path: input.cliPath ?? '',
  });

  const acquireLease = async (): Promise<RuntimeLease | null> => {
    if (input.launch.schemaVersion < 4) {
      return input.cliPath
        ? createSavedPathRuntimeLease(input.cliPath, '0.0.0')
        : null;
    }
    if (input.launch.runtime.kind === 'none') return null;
    if (!input.runtimeResolver) {
      throw new RuntimeResolverError(
        'RUNTIME_RESOLVER_REQUIRED',
        'Manifest v4 legacy attachment requires RuntimeResolver.',
      );
    }
    if (!input.launch.runtime.id || !input.launch.runtime.displayName) {
      throw new RuntimeResolverError(
        'RUNTIME_MANIFEST_INVALID',
        'Trusted Manifest Runtime facts are incomplete.',
      );
    }
    const resolved = await input.runtimeResolver.resolve({
      pluginId,
      pluginVersion: input.launch.pluginVersion,
      agentId: input.agentId ?? String(input.executor),
      entryPath: input.launch.entryPath,
      processScope: input.launch.processScope,
      runtime: {
        kind: 'external',
        id: input.launch.runtime.id,
        displayName: input.launch.runtime.displayName,
        verifiedVersions: [...(input.launch.runtime.verifiedVersions ?? [])],
      },
      selectedPath: input.cliPath,
    });
    if (resolved.readinessIssue || !resolved.lease) {
      throw new RuntimeResolverError(
        resolved.readinessIssue?.code ?? 'RUNTIME_NOT_READY',
        resolved.readinessIssue?.message ?? 'Runtime is not ready.',
      );
    }
    return resolved.lease;
  };

  return {
    binding: {
      pluginId,
      pluginVersion: input.launch.pluginVersion,
      manifestSha256: input.launch.manifestSha256,
      entryPath: input.launch.entryPath,
      processScope: input.launch.processScope,
      protocolVersion: offeredProtocolVersions[0]!,
      runtimeProfile: { identity: runtimeIdentity },
    },
    acquireLease,
    offeredProtocolVersions,
    retireOnFailedAttach: false,
    executor: input.executor,
  };
}

export function officialRuntimeIdentity(facts: Record<string, string>): string {
  const canonical = Object.fromEntries(
    Object.entries(facts).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
