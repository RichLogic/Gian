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
  };
}
