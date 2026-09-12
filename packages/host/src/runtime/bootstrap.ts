import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { PROTOCOL_V22 } from '@gian/proxy-protocol';
import type { RuntimeDiscoverResult, RuntimeProbeResult } from '@gian/proxy-protocol';

import { ProtocolV2Client } from '../proxy/protocol-v2-client.js';
import { isPublicHttpsSetupUrl } from './setup-url.js';

export const RUNTIME_BOOTSTRAP_TIMEOUT_MS = 15_000;
export const RUNTIME_BOOTSTRAP_CLEANUP_MS = 5_000;

export class RuntimeBootstrapError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeBootstrapError';
    this.code = code;
  }
}

export interface RuntimeBootstrapRequest {
  entryPath: string;
  pluginId: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  dataDir: string;
  hostVersion: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new RuntimeBootstrapError(
            'RUNTIME_BOOTSTRAP_TIMEOUT',
            `Runtime bootstrap exceeded ${timeoutMs}ms.`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function attemptDataDir(request: RuntimeBootstrapRequest): string {
  const plugin = request.pluginId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(request.dataDir, `${plugin}-${randomUUID()}`);
}

async function proveProcessTreeEmpty(client: ProtocolV2Client): Promise<void> {
  try {
    await client.waitUntilProcessGroupEmpty(RUNTIME_BOOTSTRAP_CLEANUP_MS);
  } catch (error) {
    throw new RuntimeBootstrapError(
      'RUNTIME_BOOTSTRAP_CLEANUP',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function runRuntimeBootstrap<T>(
  request: RuntimeBootstrapRequest,
  work: (client: ProtocolV2Client) => Promise<T>,
): Promise<T> {
  const timeoutMs = request.timeoutMs ?? RUNTIME_BOOTSTRAP_TIMEOUT_MS;
  const dataDir = attemptDataDir(request);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const client = new ProtocolV2Client({
    entry: request.entryPath,
    pluginId: request.pluginId,
    pluginVersion: request.pluginVersion,
    processScope: request.processScope,
    dataDir,
    hostVersion: request.hostVersion,
    protocolVersions: [PROTOCOL_V22],
    runtimeBootstrap: true,
    ...(request.env ? { env: request.env } : {}),
  });
  let workError: unknown;
  try {
    return await withTimeout((async () => {
      const initialized = await client.initialize();
      if (initialized.protocol.version !== PROTOCOL_V22) {
        throw new RuntimeBootstrapError(
          'RUNTIME_BOOTSTRAP_PROTOCOL',
          `Runtime bootstrap negotiated ${initialized.protocol.version}, expected ${PROTOCOL_V22}.`,
        );
      }
      const capabilities = initialized.capabilities ?? {};
      if (capabilities['runtime.discover'] !== 1 || capabilities['runtime.probe'] !== 1) {
        throw new RuntimeBootstrapError(
          'RUNTIME_BOOTSTRAP_CAPABILITY',
          'Runtime bootstrap requires runtime.discover and runtime.probe.',
        );
      }
      return work(client);
    })(), timeoutMs, () => {
      client.forceKill();
    });
  } catch (error) {
    workError = error;
    client.forceKill();
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (!workError) {
        try {
          await withTimeout(client.shutdown(), 3_000, () => client.forceKill());
        } catch {
          client.forceKill();
        }
      }
      await proveProcessTreeEmpty(client);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch (error) {
      const removal = new RuntimeBootstrapError(
        'RUNTIME_BOOTSTRAP_CLEANUP',
        error instanceof Error ? error.message : String(error),
      );
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, removal], 'Runtime bootstrap cleanup failed.')
        : removal;
    }
    if (workError && cleanupError) {
      throw new AggregateError(
        [workError, cleanupError],
        'Runtime bootstrap failed and its process tree could not be proven empty.',
      );
    }
    if (cleanupError) throw cleanupError;
  }
}

export function assertSafeDiscoverResult(result: RuntimeDiscoverResult): void {
  for (const action of result.setupActions) {
    if (action.kind === 'open_url' && !isPublicHttpsSetupUrl(action.url)) {
      throw new RuntimeBootstrapError(
        'RUNTIME_SETUP_URL_INVALID',
        'runtime.discover open_url actions must use a public HTTPS URL.',
      );
    }
  }
}

export function assertSafeProbeResult(
  result: RuntimeProbeResult,
  requestedPath: string,
): void {
  if (result.path !== requestedPath) {
    throw new RuntimeBootstrapError(
      'RUNTIME_PROBE_PATH_MISMATCH',
      'runtime.probe result.path must exactly match the Host-authorized path.',
    );
  }
}
