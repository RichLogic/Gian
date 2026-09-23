import { z } from 'zod';

import { AUTH_PROTOCOL } from './constants.js';
import { canonicalJson } from './serialize.js';
import { githubAccountIdSchema } from './account.js';
import {
  authProtocolSchema,
  boundedStringSchema,
  canonicalIdSchema,
  nameSchema,
  p256PublicJwkSchema,
  sha256HexSchema,
  unixMsSchema,
} from './validation.js';

const pairingStatusSchema = z.enum([
  'pending_claim',
  'pending_confirmation',
  'confirmed',
  'rejected',
  'expired',
  'consumed',
]);

export const authRequestBase = {
  protocol: authProtocolSchema,
};

export const adminCreateEnrollmentRequestSchema = z.strictObject({
  ...authRequestBase,
  label: nameSchema.optional(),
  github_account_id: githubAccountIdSchema.optional(),
});

export const adminCreateEnrollmentResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  enrollment_id: canonicalIdSchema,
  enrollment_token: boundedStringSchema,
  expires_at: unixMsSchema,
});

export const hostEnrollmentClaimRequestSchema = z.strictObject({
  ...authRequestBase,
  enrollment_token: boundedStringSchema,
  host_name: nameSchema,
  host_version: boundedStringSchema,
  host_public_key: p256PublicJwkSchema,
});

export const serverIdentitySchema = z.strictObject({
  algorithm: z.literal('P-256'),
  public_key: p256PublicJwkSchema,
  fingerprint: sha256HexSchema,
});

export const hostEnrollmentClaimResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  host_id: canonicalIdSchema,
  connector_refresh_secret: boundedStringSchema,
  server_identity: serverIdentitySchema,
});

export const hostConnectorChallengeRequestSchema = z.strictObject({
  ...authRequestBase,
  host_id: canonicalIdSchema,
});

export const hostConnectorChallengeResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  challenge_id: canonicalIdSchema,
  challenge: boundedStringSchema,
  expires_at: unixMsSchema,
  server_identity_fingerprint: sha256HexSchema,
  server_identity: serverIdentitySchema,
  server_identity_signature: boundedStringSchema,
});

export function serverChallengePayload(input: {
  host_id: string;
  challenge_id: string;
  challenge: string;
  expires_at: number;
  fingerprint: string;
}): string {
  return canonicalJson({
    type: 'gian.remote.server_challenge/1',
    host_id: input.host_id,
    challenge_id: input.challenge_id,
    challenge: input.challenge,
    expires_at: input.expires_at,
    fingerprint: input.fingerprint,
  });
}

export const hostConnectorLoginRequestSchema = z.strictObject({
  ...authRequestBase,
  host_id: canonicalIdSchema,
  challenge_id: canonicalIdSchema,
  signature: boundedStringSchema,
  refresh_secret: boundedStringSchema,
});

export const hostConnectorLoginResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  connector_access_token: boundedStringSchema,
  refresh_secret: boundedStringSchema,
  expires_at: unixMsSchema,
});

export const hostCreatePairingRequestSchema = z.strictObject({
  ...authRequestBase,
});

export const hostCreatePairingResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  grant_id: canonicalIdSchema,
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  grant_nonce: boundedStringSchema,
  expires_at: unixMsSchema,
});

export const pairingClaimRequestSchema = z.strictObject({
  ...authRequestBase,
  browser_installation_id: canonicalIdSchema,
  device_public_key: p256PublicJwkSchema,
  platform: nameSchema,
  user_agent: boundedStringSchema,
  code: z.string().min(4).max(16).optional(),
  grant_nonce: boundedStringSchema.optional(),
}).refine(
  (value) => Boolean(value.code) !== Boolean(value.grant_nonce),
  'Claim must use exactly one of code or grant_nonce.',
);

export const pairingClaimResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  pairing_id: canonicalIdSchema,
  host_id: canonicalIdSchema,
  status: z.literal('pending_confirmation'),
  crypto_connection_id: canonicalIdSchema,
});

export const pairingConfirmRequestSchema = z.strictObject({
  ...authRequestBase,
  pairing_id: canonicalIdSchema,
  decision: z.enum(['confirm', 'reject']),
});

export const pairingConfirmResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  pairing_id: canonicalIdSchema,
  status: z.enum(['confirmed', 'rejected']),
  device_id: canonicalIdSchema.optional(),
  crypto_connection_id: canonicalIdSchema.optional(),
});

export const deviceChallengeRequestSchema = z.strictObject({
  ...authRequestBase,
  browser_installation_id: canonicalIdSchema,
  host_id: canonicalIdSchema,
});

export const deviceChallengeResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  challenge_id: canonicalIdSchema,
  challenge: boundedStringSchema,
  expires_at: unixMsSchema,
});

export const deviceLoginRequestSchema = z.strictObject({
  ...authRequestBase,
  browser_installation_id: canonicalIdSchema,
  host_id: canonicalIdSchema,
  challenge_id: canonicalIdSchema,
  signature: boundedStringSchema,
});

export const deviceLoginResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  access_token: boundedStringSchema,
  expires_at: unixMsSchema,
  device_id: canonicalIdSchema,
  host_id: canonicalIdSchema,
  crypto_connection_id: canonicalIdSchema,
  host_public_key: p256PublicJwkSchema,
});

export const sessionRefreshRequestSchema = z.strictObject({
  ...authRequestBase,
  host_id: canonicalIdSchema.optional(),
});

export const sessionRefreshResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  access_token: boundedStringSchema,
  expires_at: unixMsSchema,
});

export const sessionLogoutRequestSchema = z.strictObject({
  ...authRequestBase,
});

export const sessionLogoutResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  ok: z.literal(true),
});

export const wsTicketRequestSchema = z.strictObject({
  ...authRequestBase,
  host_id: canonicalIdSchema,
});

export const wsTicketResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  ticket: boundedStringSchema,
  expires_at: unixMsSchema,
});

export const selfRevokeRequestSchema = z.strictObject({
  ...authRequestBase,
  host_id: canonicalIdSchema,
  signed_at: unixMsSchema,
  signature: boundedStringSchema,
});

export const selfRevokeResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  host_id: canonicalIdSchema,
  status: z.enum(['revoked', 'tombstoned', 'pending_host']),
});

export const hostRevokeDeviceRequestSchema = z.strictObject({
  ...authRequestBase,
});

export function selfRevokePayload(input: { hostId: string; deviceId: string; signedAt: number }): string {
  return canonicalJson({
    action: 'self_revoke',
    host_id: input.hostId,
    device_id: input.deviceId,
    signed_at: input.signedAt,
  });
}

export const hostPresenceSchema = z.strictObject({
  host_id: canonicalIdSchema,
  name: nameSchema,
  online: z.boolean(),
  pairing_status: pairingStatusSchema,
});

export const meResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  browser_installation_id: canonicalIdSchema,
  hosts: z.array(hostPresenceSchema).max(20),
});

export const hostsResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  hosts: z.array(hostPresenceSchema).max(20),
});

export const healthResultSchema = z.strictObject({
  ok: z.literal(true),
  version: boundedStringSchema,
  build_id: boundedStringSchema.optional(),
});

export const hostHeartbeatRequestSchema = z.strictObject({
  ...authRequestBase,
});

export const hostUpdateProfileRequestSchema = z.strictObject({
  ...authRequestBase,
  name: nameSchema.trim().min(1),
});

export const hostHeartbeatResultSchema = z.strictObject({
  protocol: authProtocolSchema,
  lease_expires_at: unixMsSchema,
});

export type AdminCreateEnrollmentRequest = z.infer<typeof adminCreateEnrollmentRequestSchema>;
export type AdminCreateEnrollmentResult = z.infer<typeof adminCreateEnrollmentResultSchema>;
export type HostEnrollmentClaimRequest = z.infer<typeof hostEnrollmentClaimRequestSchema>;
export type HostEnrollmentClaimResult = z.infer<typeof hostEnrollmentClaimResultSchema>;
export type HostConnectorChallengeRequest = z.infer<typeof hostConnectorChallengeRequestSchema>;
export type HostConnectorChallengeResult = z.infer<typeof hostConnectorChallengeResultSchema>;
export type HostConnectorLoginRequest = z.infer<typeof hostConnectorLoginRequestSchema>;
export type HostConnectorLoginResult = z.infer<typeof hostConnectorLoginResultSchema>;
export type HostCreatePairingRequest = z.infer<typeof hostCreatePairingRequestSchema>;
export type HostCreatePairingResult = z.infer<typeof hostCreatePairingResultSchema>;
export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;
export type PairingClaimResult = z.infer<typeof pairingClaimResultSchema>;
export type PairingConfirmRequest = z.infer<typeof pairingConfirmRequestSchema>;
export type PairingConfirmResult = z.infer<typeof pairingConfirmResultSchema>;
export type DeviceChallengeRequest = z.infer<typeof deviceChallengeRequestSchema>;
export type DeviceChallengeResult = z.infer<typeof deviceChallengeResultSchema>;
export type DeviceLoginRequest = z.infer<typeof deviceLoginRequestSchema>;
export type DeviceLoginResult = z.infer<typeof deviceLoginResultSchema>;
export type SessionRefreshRequest = z.infer<typeof sessionRefreshRequestSchema>;
export type SessionRefreshResult = z.infer<typeof sessionRefreshResultSchema>;
export type SessionLogoutRequest = z.infer<typeof sessionLogoutRequestSchema>;
export type SessionLogoutResult = z.infer<typeof sessionLogoutResultSchema>;
export type WsTicketRequest = z.infer<typeof wsTicketRequestSchema>;
export type WsTicketResult = z.infer<typeof wsTicketResultSchema>;
export type SelfRevokeRequest = z.infer<typeof selfRevokeRequestSchema>;
export type SelfRevokeResult = z.infer<typeof selfRevokeResultSchema>;
export type HostRevokeDeviceRequest = z.infer<typeof hostRevokeDeviceRequestSchema>;
export type MeResult = z.infer<typeof meResultSchema>;
export type HostsResult = z.infer<typeof hostsResultSchema>;
export type HealthResult = z.infer<typeof healthResultSchema>;
export type HostHeartbeatRequest = z.infer<typeof hostHeartbeatRequestSchema>;
export type HostHeartbeatResult = z.infer<typeof hostHeartbeatResultSchema>;
export type ServerIdentity = z.infer<typeof serverIdentitySchema>;

export const AUTH_PROTOCOL_NAME = AUTH_PROTOCOL;
