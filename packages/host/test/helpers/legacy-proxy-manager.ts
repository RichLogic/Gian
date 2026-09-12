import { createHash } from 'node:crypto';

import { pluginIdForExecutorId, type Executor } from '@gian/shared';

import type { ProxyManagerConfig, ProxyProtocolDescriptor } from '../../src/proxy/manager.js';
import { resolveLegacyLaunch } from '../../src/proxy/legacy-launch.js';
import type { RuntimeResolver } from '../../src/runtime/resolver.js';
import type { TrustedLaunch } from '../../src/runtime/trusted-launch.js';

interface LegacyNamedConfig {
  dataDir: string;
  hostVersion?: string;
  ccProxyEntry: string;
  claudeProxy?: ProxyProtocolDescriptor;
  codexProxyEntry?: string;
  codexProxy?: ProxyProtocolDescriptor;
  kimiProxyEntry?: string;
  kimiProxy?: ProxyProtocolDescriptor;
  grokProxyEntry?: string;
  grokProxy?: ProxyProtocolDescriptor;
  dshProxyEntry?: string;
  dshProxy?: ProxyProtocolDescriptor;
  zcodeProxyEntry?: string;
  zcodeProxy?: ProxyProtocolDescriptor;
  codexBin?: string;
  runtimeResolver?: RuntimeResolver;
  verifiedVersions?: Partial<Record<Executor, readonly string[]>>;
  resolveProxyVersion?: (
    executor: Executor,
    version: string,
  ) => Promise<{ entryPath: string; protocol?: ProxyProtocolDescriptor }>;
  resolveCurrentProxy?: (
    executor: Executor,
  ) => Promise<{ entryPath: string; protocol?: ProxyProtocolDescriptor }>;
}

function namedEntry(
  input: LegacyNamedConfig,
  executor: Executor,
): { entryPath: string | undefined; protocol: ProxyProtocolDescriptor | undefined } {
  switch (executor) {
    case 'claude': return { entryPath: input.ccProxyEntry, protocol: input.claudeProxy };
    case 'codex': return { entryPath: input.codexProxyEntry, protocol: input.codexProxy };
    case 'kimi': return { entryPath: input.kimiProxyEntry, protocol: input.kimiProxy };
    case 'grok': return { entryPath: input.grokProxyEntry, protocol: input.grokProxy };
    case 'dsh': return { entryPath: input.dshProxyEntry, protocol: input.dshProxy };
    case 'zcode': return { entryPath: input.zcodeProxyEntry, protocol: input.zcodeProxy };
  }
}

function trustedLaunch(
  input: LegacyNamedConfig,
  executor: Executor,
  entryPath: string,
  protocol: ProxyProtocolDescriptor,
): TrustedLaunch {
  const pluginId = pluginIdForExecutorId(executor);
  const schemaVersion = protocol.schemaVersion ?? (protocol.runtimeBootstrap ? 4 : 3);
  return {
    pluginId,
    pluginVersion: protocol.pluginVersion,
    manifestSha256: createHash('sha256')
      .update(JSON.stringify([pluginId, protocol.pluginVersion, entryPath]))
      .digest('hex'),
    protocolRange: schemaVersion === 4 ? '>=2.2 <3.0' : '>=2.0 <2.2',
    entryPath,
    processScope: protocol.processScope,
    schemaVersion,
    runtime: schemaVersion === 4
      ? {
        kind: 'external',
        id: protocol.runtimeId ?? String(executor),
        displayName: protocol.runtimeDisplayName ?? String(executor),
        verifiedVersions: input.verifiedVersions?.[executor] ?? [],
      }
      : { kind: 'external' },
    source: 'official-development',
  };
}

/** Compatibility factory kept in tests only while old Session fixtures still
 * use the historical named launch options. Production has no such fields. */
export function legacyProxyManagerConfig(input: LegacyNamedConfig): ProxyManagerConfig {
  return {
    dataDir: input.dataDir,
    ...(input.hostVersion ? { hostVersion: input.hostVersion } : {}),
    resolveLegacyLaunch: async (executor, options) => {
      let resolved = options.proxyVersion && input.resolveProxyVersion
        ? await input.resolveProxyVersion(executor, options.proxyVersion)
        : undefined;
      if (!resolved && input.resolveCurrentProxy) {
        resolved = await input.resolveCurrentProxy(executor);
      }
      const named = namedEntry(input, executor);
      const entryPath = resolved?.entryPath ?? named.entryPath;
      const protocol = resolved?.protocol ?? named.protocol;
      if (!entryPath || !protocol) {
        throw new Error(`legacy ${executor} test launch is not configured`);
      }
      const launch = await resolveLegacyLaunch({
        executor,
        launch: trustedLaunch(input, executor, entryPath, protocol),
        ...(input.runtimeResolver ? { runtimeResolver: input.runtimeResolver } : {}),
        cliPath: options.cliPath ?? (executor === 'codex' ? input.codexBin ?? null : null),
      });
      return {
        ...launch,
        // Historical Kimi fixtures verify the old failed-attach retirement
        // contract. Production v4 packages use the generic exact path.
        retireOnFailedAttach: executor === 'kimi',
      };
    },
  };
}
