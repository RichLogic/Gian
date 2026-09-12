import type { OpenRuntimeProfile } from '@gian/shared';

import type { RuntimeResolver } from '../src/runtime/resolver.js';
import type { RuntimeLease } from '../src/runtime/types.js';

export const V4_PROTOCOL_DESCRIPTORS = {
  claudeProxy: {
    pluginVersion: '0.2.0',
    processScope: 'session' as const,
    schemaVersion: 4 as const,
    runtimeBootstrap: true,
    runtimeId: 'claude',
    runtimeDisplayName: 'Claude Code',
  },
  codexProxy: {
    pluginVersion: '0.2.0',
    processScope: 'shared' as const,
    schemaVersion: 4 as const,
    runtimeBootstrap: true,
    runtimeId: 'codex',
    runtimeDisplayName: 'Codex CLI',
  },
  kimiProxy: {
    pluginVersion: '0.2.0',
    processScope: 'shared' as const,
    schemaVersion: 4 as const,
    runtimeBootstrap: true,
    runtimeId: 'kimi',
    runtimeDisplayName: 'Kimi Code',
  },
  grokProxy: {
    pluginVersion: '0.3.0',
    processScope: 'session' as const,
    schemaVersion: 4 as const,
    runtimeBootstrap: true,
    runtimeId: 'grok',
    runtimeDisplayName: 'Grok CLI',
  },
};

export function idleRuntimeResolver(): RuntimeResolver {
  return resolverFromAcquire(async () => null);
}

export function resolverFromAcquire(
  acquire: (cli?: string, overridePath?: string | null) => Promise<RuntimeLease | null>,
): RuntimeResolver {
  return {
    async resolve(input) {
      const lease = await acquire(undefined, input.selectedPath);
      const profile: OpenRuntimeProfile = {
        id: `lease:${lease?.binaryPath ?? input.pluginId}`,
        agentId: input.agentId,
        pluginId: input.pluginId,
        runtimeId: input.runtime.id ?? null,
        path: lease?.binaryPath ?? input.selectedPath,
        version: lease?.version ?? '0.0.0',
        configHome: null,
        contentFingerprint: null,
        verifiedVersions: [...(input.runtime.verifiedVersions ?? [])],
        verification: 'unverified',
      };
      return { profile, lease };
    },
    invalidate() {
      return true;
    },
    async detectExternalChanges() {
      return [];
    },
  } as RuntimeResolver;
}
