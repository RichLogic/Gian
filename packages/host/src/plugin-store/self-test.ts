import { join } from 'node:path';

import type { ManifestV4 } from '@gian/proxy-protocol';

import type { AgentUpdateLease } from '../agents/update-lock.js';
import { runProtectedProxyChild } from '../proxy/protected-handshake.js';
import { shutdownProxyProcess } from '../proxy/process-shutdown.js';
import { pluginChildEnvironment } from './child-env.js';
import { PluginStoreError } from './errors.js';
import { PLUGIN_SELF_TEST_TIMEOUT_MS } from './limits.js';

export async function runCatalogProxySelfTest(
  directory: string,
  manifest: ManifestV4,
  offeredProtocolVersions: readonly string[],
  protector: AgentUpdateLease,
  shutdownProcess?: typeof shutdownProxyProcess,
): Promise<void> {
  const entry = join(directory, manifest.entry);
  try {
    await runProtectedProxyChild({
      label: `${manifest.id} catalog self-test`,
      args: [entry, '--self-test'],
      env: pluginChildEnvironment({
        pluginId: manifest.id,
        protocolVersions: offeredProtocolVersions,
      }),
      protector,
      timeoutMs: PLUGIN_SELF_TEST_TIMEOUT_MS,
      allowAlreadyEmpty: true,
      collectStdout: true,
      shutdownProcess,
      async work(context) {
        const exit = await Promise.race([context.waitForExit(), context.deadline]);
        if (context.stdoutOverflow()) {
          throw new PluginStoreError(
            'PLUGIN_SELF_TEST',
            `${manifest.id} proxy self-test exceeded the bounded stdout limit.`,
          );
        }
        if (exit.code !== 0 || exit.signal !== null) {
          throw new PluginStoreError(
            'PLUGIN_SELF_TEST',
            `${manifest.id} proxy self-test exited ${exit.signal ?? exit.code}.`,
          );
        }
        const stdout = context.stdout().trim();
        let response: {
          schemaVersion?: unknown;
          id?: unknown;
          pluginVersion?: unknown;
          ok?: unknown;
        };
        try {
          response = JSON.parse(stdout) as typeof response;
        } catch {
          throw new PluginStoreError(
            'PLUGIN_SELF_TEST',
            `${manifest.id} proxy self-test returned invalid JSON.`,
          );
        }
        if (
          response.schemaVersion !== manifest.schemaVersion
          || response.pluginVersion !== manifest.pluginVersion
          || response.id !== manifest.id
          || response.ok !== true
        ) {
          throw new PluginStoreError(
            'PLUGIN_SELF_TEST',
            `${manifest.id} proxy self-test returned an invalid result.`,
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof PluginStoreError) throw error;
    if (error instanceof AggregateError) {
      const wrapped = error.errors.map((item) => (
        item instanceof PluginStoreError
          ? item
          : new PluginStoreError('PLUGIN_SELF_TEST', item instanceof Error ? item.message : String(item))
      ));
      throw new AggregateError(wrapped, error.message);
    }
    throw new PluginStoreError(
      'PLUGIN_SELF_TEST',
      error instanceof Error ? error.message : String(error),
    );
  }
}
