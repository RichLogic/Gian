import {
  AUTH_RATE_LIMIT_PER_MINUTE,
  CONTROL_OUTBOX_MAX_BYTES,
  CONTROL_OUTBOX_MAX_FRAMES,
  MAX_CIPHERTEXT_BYTES_PER_SECOND,
  MAX_CONNECTIONS_PER_DEVICE,
  MAX_CONTROL_FRAMES_PER_SECOND,
  MAX_DEVICES_PER_HOST,
  PRESENCE_LEASE_MS,
} from '@gian/remote-protocol';

import { type Clock, systemClock } from './clock.js';
import { type LogSink, createLogger } from './logging.js';

export interface RemoteServerConfig {
  dataDir: string;
  publicOrigin: string;
  allowedOrigins: string[];
  adminToken: string;
  staticDir?: string;
  version: string;
  buildId: string;
  now: Clock;
  logger: LogSink;
  trustedProxy: boolean;
  maxDevicesPerHost: number;
  maxConnectionsPerDevice: number;
  authRateLimitPerMinute: number;
  maxControlFramesPerSecond: number;
  maxCiphertextBytesPerSecond: number;
  controlOutboxMaxFrames: number;
  controlOutboxMaxBytes: number;
  presenceLeaseMs: number;
  githubClientId?: string;
  githubFetch?: typeof fetch;
  enrollmentGithubIds: string[];
}

export function createConfig(overrides: Partial<RemoteServerConfig> & Pick<RemoteServerConfig, 'dataDir' | 'publicOrigin' | 'adminToken'>): RemoteServerConfig {
  return {
    allowedOrigins: overrides.allowedOrigins ?? [overrides.publicOrigin],
    staticDir: overrides.staticDir,
    version: overrides.version ?? '1.0.0',
    buildId: overrides.buildId ?? 'dev',
    now: overrides.now ?? systemClock,
    logger: overrides.logger ?? createLogger(),
    trustedProxy: overrides.trustedProxy ?? false,
    maxDevicesPerHost: overrides.maxDevicesPerHost ?? MAX_DEVICES_PER_HOST,
    maxConnectionsPerDevice: overrides.maxConnectionsPerDevice ?? MAX_CONNECTIONS_PER_DEVICE,
    authRateLimitPerMinute: overrides.authRateLimitPerMinute ?? AUTH_RATE_LIMIT_PER_MINUTE,
    maxControlFramesPerSecond: overrides.maxControlFramesPerSecond ?? MAX_CONTROL_FRAMES_PER_SECOND,
    maxCiphertextBytesPerSecond: overrides.maxCiphertextBytesPerSecond ?? MAX_CIPHERTEXT_BYTES_PER_SECOND,
    controlOutboxMaxFrames: overrides.controlOutboxMaxFrames ?? CONTROL_OUTBOX_MAX_FRAMES,
    controlOutboxMaxBytes: overrides.controlOutboxMaxBytes ?? CONTROL_OUTBOX_MAX_BYTES,
    presenceLeaseMs: overrides.presenceLeaseMs ?? PRESENCE_LEASE_MS,
    dataDir: overrides.dataDir,
    publicOrigin: overrides.publicOrigin,
    adminToken: overrides.adminToken,
    githubClientId: overrides.githubClientId,
    githubFetch: overrides.githubFetch,
    enrollmentGithubIds: parseEnrollmentGithubIds((overrides.enrollmentGithubIds ?? []).join(',')),
  };
}

export function parseEnrollmentGithubIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = value.split(',').map(id => id.trim());
  if (ids.some(id => !/^[1-9][0-9]{0,19}$/.test(id))) {
    throw new Error('GIAN_REMOTE_ENROLLMENT_GITHUB_IDS must contain comma-separated GitHub numeric account IDs');
  }
  return [...new Set(ids)];
}
