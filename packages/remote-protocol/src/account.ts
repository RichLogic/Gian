import { z } from 'zod';
import { REFRESH_SLIDING_MS } from './constants.js';
import { canonicalJson } from './serialize.js';
import {
  base64UrlSchema,
  canonicalIdSchema,
  p256PublicJwkSchema,
  sha256HexSchema,
  unixMsSchema,
} from './validation.js';

export const githubAccountIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const ACCOUNT_PROTOCOL = 'gian.remote.account/1' as const;
export const ACCOUNT_SESSION_TTL_MS = REFRESH_SLIDING_MS;
export const remotePeerRoleSchema = z.enum(['host', 'controller']);
export const remoteAccountIdentitySchema = z.strictObject({
  provider: z.literal('github'),
  id: githubAccountIdSchema,
  login: z.string().min(1).max(256),
});

export const remoteAccountPeerSchema = z.strictObject({
  role: remotePeerRoleSchema,
  installation_id: canonicalIdSchema,
  public_key: p256PublicJwkSchema.extend({ x: base64UrlSchema.length(43), y: base64UrlSchema.length(43) }),
});

export const remoteAccountChallengeSchema = z.strictObject({
  type: z.literal('gian.remote.account_challenge/1'),
  challenge_id: canonicalIdSchema,
  nonce: base64UrlSchema.max(256),
  server_identity_fingerprint: sha256HexSchema,
  peer: remoteAccountPeerSchema,
  expires_at: unixMsSchema,
});

export function remoteAccountChallengePayload(challenge: RemoteAccountChallenge): string {
  return canonicalJson(remoteAccountChallengeSchema.parse(challenge));
}

export type RemoteAccountIdentity = z.infer<typeof remoteAccountIdentitySchema>;
export type RemoteAccountPeer = z.infer<typeof remoteAccountPeerSchema>;
export type RemoteAccountChallenge = z.infer<typeof remoteAccountChallengeSchema>;

export const accountLoginStartSchema = z.strictObject({
  protocol: z.literal(ACCOUNT_PROTOCOL),
  peer: remoteAccountPeerSchema,
});
export const accountLoginStartedSchema = z.strictObject({
  protocol: z.literal(ACCOUNT_PROTOCOL),
  login_id: canonicalIdSchema,
  challenge: remoteAccountChallengeSchema,
  user_code: z.string().min(1).max(64),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_at: unixMsSchema,
  interval_seconds: z.number().int().min(5).max(60),
});
export const accountLoginPollSchema = z.strictObject({
  protocol: z.literal(ACCOUNT_PROTOCOL),
  login_id: canonicalIdSchema,
  signature: base64UrlSchema.max(1024),
});
export const accountLoginResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ protocol: z.literal(ACCOUNT_PROTOCOL), status: z.literal('pending'), interval_seconds: z.number().int().min(5).max(60) }),
  z.strictObject({ protocol: z.literal(ACCOUNT_PROTOCOL), status: z.literal('denied') }),
  z.strictObject({ protocol: z.literal(ACCOUNT_PROTOCOL), status: z.literal('expired') }),
  z.strictObject({
    protocol: z.literal(ACCOUNT_PROTOCOL), status: z.literal('authorized'),
    account: remoteAccountIdentitySchema, account_token: base64UrlSchema.max(256),
    installation_id: canonicalIdSchema, role: remotePeerRoleSchema, expires_at: unixMsSchema,
  }),
]);
export type AccountLoginStarted = z.infer<typeof accountLoginStartedSchema>;
export type AccountLoginResult = z.infer<typeof accountLoginResultSchema>;
