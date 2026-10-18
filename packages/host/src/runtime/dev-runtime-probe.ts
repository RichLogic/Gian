import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { runtimeProbeParamsSchema, runtimeProbeResultSchema, type RuntimeProbeResult } from '@gian/proxy-protocol';

import {
  assertSafeProbeResult,
  runRuntimeBootstrap,
  RUNTIME_BOOTSTRAP_CLEANUP_MS,
  RUNTIME_BOOTSTRAP_TIMEOUT_MS,
  RuntimeBootstrapError,
  type RuntimeBootstrapRequest,
} from './bootstrap.js';
import type { ProtocolV2Client } from '../proxy/protocol-v2-client.js';

/** Allow for a nested Runtime startup inside the Proxy-owned probe. */
const DEV_RUNTIME_NESTED_STARTUP_TIMEOUT_MS = 15_000;

/**
 * Finite outer budget for one proxy probe. runRuntimeBootstrap still owns
 * its 15s work timeout unless this larger finite value is passed, and it
 * still owns the 5s process-tree cleanup afterward. The extra 15s covers
 * Runtime startup inside runtime.probe, and the cleanup window is headroom so
 * those two budgets are not added on the same instant.
 */
export const DEV_RUNTIME_PROXY_PROBE_TIMEOUT_MS =
  RUNTIME_BOOTSTRAP_TIMEOUT_MS
  + DEV_RUNTIME_NESTED_STARTUP_TIMEOUT_MS
  + RUNTIME_BOOTSTRAP_CLEANUP_MS;

export class DevRuntimeProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DevRuntimeProbeError';
    this.code = code;
  }
}

/** Identity the caller expects runtime.probe to confirm. */
export interface DevRuntimeProxyProbeTarget {
  pluginId: string;
  runtimeId: string;
  version: string;
  probe?: { kind: string };
}

/**
 * Host-internal declaration fields. declarationsFromProxyEntries fills the
 * optional Manifest fields from the trusted package it already read.
 */
export interface DevRuntimeProxyProbeDeclaration {
  pluginId: string;
  runtimeId: string;
  versions: readonly string[];
  pluginVersion?: string;
  processScope?: 'shared' | 'session';
  /** Manifest runtime displayName, not the Proxy product name. */
  displayName?: string;
  /** Exact trusted Proxy entry. Never a PATH search. */
  entryPath?: string;
}

export interface DevRuntimeProxyBinding {
  pluginId: string;
  runtimeId: string;
  pluginVersion: string;
  processScope: 'shared' | 'session';
  displayName: string;
  entryPath: string;
}

export interface ProbeDevRuntimeVersionInput {
  /** Absolute installed Runtime path passed to runtime.probe. */
  executable: string;
  coordinate: DevRuntimeProxyProbeTarget;
  declaration: DevRuntimeProxyProbeDeclaration;
  hostVersion?: string;
  /**
   * Shortens the finite outer budget in tests. Values above
   * DEV_RUNTIME_PROXY_PROBE_TIMEOUT_MS are rejected.
   */
  timeoutMs?: number;
  /** Test seam. Production uses runRuntimeBootstrap. */
  bootstrap?: (
    request: RuntimeBootstrapRequest,
    work: (client: ProtocolV2Client) => Promise<string>,
  ) => Promise<string>;
  /** Test seam. Production removes the isolated home with fs.rm. */
  removeDirectory?: (
    directory: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
}

export function requireDevRuntimeProxyBinding(
  coordinate: DevRuntimeProxyProbeTarget,
  declaration: DevRuntimeProxyProbeDeclaration | undefined,
): DevRuntimeProxyBinding {
  if (
    !declaration
    || declaration.pluginId !== coordinate.pluginId
    || declaration.runtimeId !== coordinate.runtimeId
    || !declaration.versions.includes(coordinate.version)
  ) {
    throw new DevRuntimeProbeError(
      'BINDING_MISSING',
      `${coordinate.pluginId} Runtime ${coordinate.runtimeId} ${coordinate.version} has no Proxy declaration binding.`,
    );
  }
  if (
    !declaration.pluginVersion
    || (declaration.processScope !== 'shared' && declaration.processScope !== 'session')
    || !declaration.displayName
    || !declaration.entryPath
    || !isAbsolute(declaration.entryPath)
  ) {
    throw new DevRuntimeProbeError(
      'BINDING_MISSING',
      `${coordinate.pluginId} Runtime ${coordinate.runtimeId} ${coordinate.version} requires an exact Proxy entry binding. Refusing to guess PATH.`,
    );
  }
  return {
    pluginId: declaration.pluginId,
    runtimeId: declaration.runtimeId,
    pluginVersion: declaration.pluginVersion,
    processScope: declaration.processScope,
    displayName: declaration.displayName,
    entryPath: declaration.entryPath,
  };
}

function probeTempParent(): string {
  // darwin per-user TMPDIR can be long enough that a Runtime unix socket
  // under the isolated home exceeds sun_path. /tmp stays a temp directory.
  return process.platform === 'darwin' ? '/tmp' : tmpdir();
}

function finiteProbeTimeout(timeoutMs: number | undefined): number {
  const budget = timeoutMs ?? DEV_RUNTIME_PROXY_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(budget) || budget <= 0 || budget > DEV_RUNTIME_PROXY_PROBE_TIMEOUT_MS) {
    throw new DevRuntimeProbeError(
      'RUNTIME_PROBE_INVALID',
      'Dev Runtime proxy probe timeout must be a finite positive duration within the outer budget.',
    );
  }
  return budget;
}

/**
 * Read one Dev Runtime version through the trusted Proxy entry.
 * Calls runtime.probe only. Does not authenticate, create a session, or
 * spawn the Runtime CLI with --version. HOME, GEMINI_HOME, and
 * GIAN_AGENT_HOME are an empty temp directory for this call.
 * Returns the confirmed version. Capability, identity, timeout, and
 * cleanup failures reject.
 */
export async function probeDevRuntimeVersion(
  input: ProbeDevRuntimeVersionInput,
): Promise<string> {
  if (input.coordinate.probe?.kind !== 'proxy') {
    throw new DevRuntimeProbeError(
      'RUNTIME_PROBE_INVALID',
      `${input.coordinate.runtimeId} has an unsupported Dev Runtime probe.`,
    );
  }
  const binding = requireDevRuntimeProxyBinding(input.coordinate, input.declaration);
  const params = runtimeProbeParamsSchema.safeParse({ path: input.executable });
  if (!params.success) {
    throw new DevRuntimeProbeError(
      'RUNTIME_PROBE_INVALID',
      `${input.coordinate.runtimeId} probe path must be an absolute Host path.`,
    );
  }
  const timeoutMs = finiteProbeTimeout(input.timeoutMs);
  const hostVersion = input.hostVersion ?? process.env.GIAN_RELEASE_VERSION ?? '0.0.0';
  if (hostVersion.trim() === '') {
    throw new DevRuntimeProbeError(
      'RUNTIME_PROBE_INVALID',
      'Dev Runtime proxy probe requires a Host version.',
    );
  }
  const entryInfo = await lstat(binding.entryPath).catch(() => {
    throw new DevRuntimeProbeError(
      'BINDING_MISSING',
      `Proxy entry is not an exact regular file: ${binding.entryPath}`,
    );
  });
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) {
    throw new DevRuntimeProbeError(
      'BINDING_MISSING',
      `Proxy entry is not an exact regular file: ${binding.entryPath}`,
    );
  }
  const home = await mkdtemp(join(probeTempParent(), 'gian-dev-runtime-probe-'));
  const removeDirectory = input.removeDirectory ?? rm;
  const bootstrap = input.bootstrap ?? runRuntimeBootstrap;
  let workError: unknown;
  try {
    return await bootstrap({
      entryPath: binding.entryPath,
      pluginId: binding.pluginId,
      pluginVersion: binding.pluginVersion,
      processScope: binding.processScope,
      dataDir: join(home, 'bootstrap'),
      hostVersion,
      timeoutMs,
      env: {
        HOME: home,
        GEMINI_HOME: home,
        GIAN_AGENT_HOME: home,
      },
    }, async (client) => {
      const result = await client.request<RuntimeProbeResult>('runtime.probe', {
        path: params.data.path,
      });
      const parsed = runtimeProbeResultSchema.parse(result);
      assertSafeProbeResult(parsed, params.data.path);
      if (parsed.runtimeId !== input.coordinate.runtimeId) {
        throw new DevRuntimeProbeError(
          'RUNTIME_ID_MISMATCH',
          `${input.coordinate.runtimeId} runtime.probe returned runtimeId ${parsed.runtimeId}.`,
        );
      }
      if (parsed.displayName !== binding.displayName) {
        throw new DevRuntimeProbeError(
          'RUNTIME_DISPLAY_MISMATCH',
          `${input.coordinate.runtimeId} runtime.probe returned displayName ${parsed.displayName}.`,
        );
      }
      if (parsed.version !== input.coordinate.version) {
        throw new DevRuntimeProbeError(
          'RUNTIME_VERSION_MISMATCH',
          `${input.coordinate.runtimeId} runtime.probe returned ${parsed.version}, expected ${input.coordinate.version}.`,
        );
      }
      return parsed.version;
    });
  } catch (error) {
    workError = error;
    throw error;
  } finally {
    let removalError: unknown;
    try {
      await removeDirectory(home, { recursive: true, force: true });
    } catch (error) {
      removalError = error instanceof RuntimeBootstrapError
        ? error
        : new RuntimeBootstrapError(
          'RUNTIME_BOOTSTRAP_CLEANUP',
          error instanceof Error ? error.message : String(error),
        );
    }
    if (workError && removalError) {
      throw new AggregateError(
        [workError, removalError],
        'Dev Runtime probe failed and its isolated home could not be removed.',
      );
    }
    if (removalError) throw removalError;
  }
}
