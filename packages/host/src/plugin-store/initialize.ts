import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  HostProtocolValidator,
  PROTOCOL_NAME,
  PROTOCOL_V22,
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolRangeIncludes,
  type ManifestV4,
} from '@gian/proxy-protocol';

import type { AgentUpdateLease } from '../agents/update-lock.js';
import { runProtectedProxyChild, writeJsonRpc } from '../proxy/protected-handshake.js';
import { shutdownProxyProcess } from '../proxy/process-shutdown.js';
import { pluginChildEnvironment } from './child-env.js';
import { PluginStoreError } from './errors.js';
import { PLUGIN_INITIALIZE_TIMEOUT_MS } from './limits.js';

export const NO_RUNTIME_ACTIVATION_PROTOCOL_VERSIONS = [PROTOCOL_V22] as const;

export function offeredProtocolVersionsForRange(
  range: string,
  hostVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): string[] {
  const offered = hostVersions.filter((version) => protocolRangeIncludes(range, version));
  if (offered.length === 0) {
    throw new PluginStoreError(
      'PLUGIN_PROTOCOL_INCOMPATIBLE',
      'Package protocol range matches no Host-offered gian.proxy version.',
    );
  }
  return [...offered];
}

/**
 * Install/handshake offer. Current production uses the compatible subset of
 * SUPPORTED_PROTOCOL_VERSIONS (2.3 before the 2.2 baseline). During a staged
 * upgrade, a caller with an older session offer may still validate a v4-only
 * package through the exact 2.2 activation protocol without widening that
 * caller's ordinary Session offer.
 */
export function offeredProtocolVersionsForInstall(
  range: string,
  hostVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): string[] {
  const offered = hostVersions.filter((version) => protocolRangeIncludes(range, version));
  if (offered.length > 0) return [...offered];
  if (protocolRangeIncludes(range, PROTOCOL_V22)) return [PROTOCOL_V22];
  throw new PluginStoreError(
    'PLUGIN_PROTOCOL_INCOMPATIBLE',
    'Package protocol range matches no Host-offered gian.proxy version.',
  );
}

export function noRuntimeActivationEnvironment(input: {
  pluginId: string;
  dataDir?: string;
}): NodeJS.ProcessEnv {
  return pluginChildEnvironment({
    pluginId: input.pluginId,
    protocolVersions: NO_RUNTIME_ACTIVATION_PROTOCOL_VERSIONS,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    bootstrap: true,
  });
}

export async function runNoRuntimeActivationHandshake(input: {
  pluginId: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  entryPath: string;
  dataDir: string;
  hostVersion: string;
  protector: AgentUpdateLease;
  label: string;
  timeoutMs?: number;
  shutdownProcess?: typeof shutdownProxyProcess;
}): Promise<string> {
  const offered = [...NO_RUNTIME_ACTIVATION_PROTOCOL_VERSIONS];
  const probeDirectory = join(
    input.dataDir,
    'compatibility-probes',
    `activation-${input.pluginId}-${randomUUID()}`,
  );
  await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
  const validator = new HostProtocolValidator({
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    processScope: input.processScope,
  });
  const env = noRuntimeActivationEnvironment({
    pluginId: input.pluginId,
    dataDir: probeDirectory,
  });

  try {
    return await runProtectedProxyChild({
      label: input.label,
      args: [input.entryPath],
      env,
      protector: input.protector,
      timeoutMs: input.timeoutMs ?? PLUGIN_INITIALIZE_TIMEOUT_MS,
      probeDirectory,
      shutdownProcess: input.shutdownProcess,
      async work(context) {
        const request = async (
          id: string,
          method: string,
          params: Record<string, unknown> = {},
        ) => {
          const payload = { jsonrpc: '2.0', id, method, params };
          validator.registerRequest(payload);
          if (context.isExited()) {
            throw new PluginStoreError(
              'PLUGIN_INITIALIZE',
              `${input.pluginId} initialize process stopped: ${context.processFailureDetail()}`,
            );
          }
          await writeJsonRpc(context.child, payload, context.deadline);
          while (true) {
            const next = await Promise.race([context.iterator.next(), context.deadline]);
            if (next.done) {
              throw new PluginStoreError(
                'PLUGIN_INITIALIZE',
                `${input.pluginId} initialize process stopped: ${context.processFailureDetail()}`,
              );
            }
            const accepted = validator.acceptLine(next.value);
            if (accepted === null || !('id' in accepted)) continue;
            if (accepted.id !== id) continue;
            if (accepted.error !== undefined) {
              throw new PluginStoreError('PLUGIN_INITIALIZE', `${input.pluginId} ${method} failed.`);
            }
            return accepted.result;
          }
        };

        await request('req-1', 'initialize', {
          protocol: { name: PROTOCOL_NAME, versions: offered },
          host: { name: 'Gian', version: input.hostVersion },
        });
        const result = validator.initializeResult;
        if (!result) {
          throw new PluginStoreError('PLUGIN_INITIALIZE', 'Validator did not record a negotiated protocol.');
        }
        if (result.protocol.version !== PROTOCOL_V22) {
          throw new PluginStoreError(
            'PLUGIN_INITIALIZE',
            `No-Runtime activation negotiated ${result.protocol.version}, expected ${PROTOCOL_V22}.`,
          );
        }
        if (result.plugin.id !== input.pluginId || result.plugin.version !== input.pluginVersion) {
          throw new PluginStoreError(
            'PLUGIN_INITIALIZE',
            'No-Runtime activation identity does not match the trusted package.',
          );
        }
        if (result.process.scope !== input.processScope) {
          throw new PluginStoreError(
            'PLUGIN_INITIALIZE',
            'No-Runtime activation process scope does not match the trusted package.',
          );
        }
        if (result.capabilities['runtime.discover'] !== 1 || result.capabilities['runtime.probe'] !== 1) {
          throw new PluginStoreError(
            'PLUGIN_INITIALIZE',
            'No-Runtime activation requires runtime.discover and runtime.probe.',
          );
        }
        await request('req-2', 'catalog.list');
        await request('req-3', 'shutdown');
        return PROTOCOL_V22;
      },
    });
  } catch (error) {
    if (error instanceof PluginStoreError) throw error;
    if (error instanceof AggregateError) {
      const wrapped = error.errors.map((item) => (
        item instanceof PluginStoreError
          ? item
          : new PluginStoreError('PLUGIN_INITIALIZE', item instanceof Error ? item.message : String(item))
      ));
      throw new AggregateError(wrapped, error.message);
    }
    throw new PluginStoreError(
      'PLUGIN_INITIALIZE',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function initializeCatalogPackage(input: {
  directory: string;
  manifest: ManifestV4;
  dataDir: string;
  hostVersion: string;
  hostVersions?: readonly string[];
  protector: AgentUpdateLease;
  shutdownProcess?: typeof shutdownProxyProcess;
}): Promise<string> {
  if (!protocolRangeIncludes(input.manifest.protocol.range, PROTOCOL_V22)) {
    throw new PluginStoreError(
      'PLUGIN_PROTOCOL_INCOMPATIBLE',
      'No-Runtime package activation requires a protocol range that includes gian.proxy/2.2.',
    );
  }
  return runNoRuntimeActivationHandshake({
    pluginId: input.manifest.id,
    pluginVersion: input.manifest.pluginVersion,
    processScope: input.manifest.process.scope,
    entryPath: join(input.directory, input.manifest.entry),
    dataDir: input.dataDir,
    hostVersion: input.hostVersion,
    protector: input.protector,
    label: `${input.manifest.id} catalog initialize`,
    timeoutMs: PLUGIN_INITIALIZE_TIMEOUT_MS,
    ...(input.shutdownProcess ? { shutdownProcess: input.shutdownProcess } : {}),
  });
}
