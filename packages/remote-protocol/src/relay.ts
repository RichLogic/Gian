import { z } from 'zod';

import {
  FRAME_CLASSES,
  MAX_RELAY_FRAME_BYTES,
  RELAY_NOTICE_TYPES,
  RELAY_PROTOCOL,
  TRANSPORT_DIRECTIONS,
} from './constants.js';
import { RemoteProtocolError } from './errors.js';
import { canonicalJson, utf8ByteLength } from './serialize.js';
import {
  base64UrlSchema,
  boundedStringSchema,
  canonicalIdSchema,
  nameSchema,
  p256PublicJwkSchema,
  nonNegativeSafeIntegerSchema,
  parseClosed,
  relayProtocolSchema,
  unixMsSchema,
} from './validation.js';

export type TransportDirection = (typeof TRANSPORT_DIRECTIONS)[number];
export type FrameClass = (typeof FRAME_CLASSES)[number];

export const transportDirectionSchema = z.enum(TRANSPORT_DIRECTIONS);
export const frameClassSchema = z.enum(FRAME_CLASSES);

export const relayFrameSchema = z.strictObject({
  protocol: relayProtocolSchema,
  frame_id: canonicalIdSchema,
  frame_class: frameClassSchema,
  route_id: canonicalIdSchema,
  host_id: canonicalIdSchema,
  device_id: canonicalIdSchema,
  connection_id: canonicalIdSchema,
  transport_sequence: nonNegativeSafeIntegerSchema,
  transport_ack: nonNegativeSafeIntegerSchema,
  sent_at: unixMsSchema,
  ciphertext: base64UrlSchema,
});

export const relayWsAuthSchema = z.strictObject({
  protocol: relayProtocolSchema,
  type: z.literal('ws.auth'),
  ticket: boundedStringSchema,
});

export const relayNoticeSchema = z.strictObject({
  protocol: relayProtocolSchema,
  type: z.enum(RELAY_NOTICE_TYPES),
  host_id: canonicalIdSchema,
  sent_at: unixMsSchema,
  device_id: canonicalIdSchema.optional(),
  route_id: canonicalIdSchema.optional(),
  pairing_id: canonicalIdSchema.optional(),
  grant_id: canonicalIdSchema.optional(),
  crypto_connection_id: canonicalIdSchema.optional(),
  device_public_key: p256PublicJwkSchema.optional(),
  platform: nameSchema.optional(),
  user_agent: boundedStringSchema.optional(),
  device_name: nameSchema.optional(),
  signed_at: unixMsSchema.optional(),
  signature: boundedStringSchema.optional(),
});

export const cryptoOfferSchema = z.strictObject({
  protocol: relayProtocolSchema,
  type: z.literal('crypto.offer'),
  host_id: canonicalIdSchema,
  device_id: canonicalIdSchema,
  crypto_connection_id: canonicalIdSchema,
  handshake_nonce: canonicalIdSchema,
  device_identity: p256PublicJwkSchema,
  device_ephemeral: p256PublicJwkSchema,
  signature: boundedStringSchema,
  sent_at: unixMsSchema,
});

export const cryptoAcceptSchema = z.strictObject({
  protocol: relayProtocolSchema,
  type: z.literal('crypto.accept'),
  host_id: canonicalIdSchema,
  device_id: canonicalIdSchema,
  crypto_connection_id: canonicalIdSchema,
  handshake_nonce: canonicalIdSchema,
  host_generation: canonicalIdSchema,
  host_identity: p256PublicJwkSchema,
  host_ephemeral: p256PublicJwkSchema,
  device_ephemeral: p256PublicJwkSchema,
  signature: boundedStringSchema,
  sent_at: unixMsSchema,
});

export function cryptoOfferPayload(input: {
  host_id: string;
  device_id: string;
  crypto_connection_id: string;
  handshake_nonce: string;
  sent_at: number;
  device_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  device_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}): string {
  return canonicalJson({
    type: 'gian.remote.crypto_offer/1',
    host_id: input.host_id,
    device_id: input.device_id,
    crypto_connection_id: input.crypto_connection_id,
    handshake_nonce: input.handshake_nonce,
    sent_at: input.sent_at,
    device_identity: input.device_identity,
    device_ephemeral: input.device_ephemeral,
  });
}

export function cryptoAcceptPayload(input: {
  host_id: string;
  device_id: string;
  crypto_connection_id: string;
  handshake_nonce: string;
  sent_at: number;
  host_generation: string;
  host_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  device_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  host_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  device_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}): string {
  return canonicalJson({
    type: 'gian.remote.crypto_accept/1',
    host_id: input.host_id,
    device_id: input.device_id,
    crypto_connection_id: input.crypto_connection_id,
    handshake_nonce: input.handshake_nonce,
    sent_at: input.sent_at,
    host_generation: input.host_generation,
    host_identity: input.host_identity,
    device_identity: input.device_identity,
    host_ephemeral: input.host_ephemeral,
    device_ephemeral: input.device_ephemeral,
  });
}

export type RelayFrame = z.infer<typeof relayFrameSchema>;
export type RelayWsAuth = z.infer<typeof relayWsAuthSchema>;
export type RelayNotice = z.infer<typeof relayNoticeSchema>;
export type CryptoOffer = z.infer<typeof cryptoOfferSchema>;
export type CryptoAccept = z.infer<typeof cryptoAcceptSchema>;
export type RelayHandshake = CryptoOffer | CryptoAccept;

export function parseRelayHandshake(value: unknown): RelayHandshake {
  const record = value && typeof value === 'object' ? value as { type?: string } : {};
  if (record.type === 'crypto.offer') return parseClosed(cryptoOfferSchema, value);
  if (record.type === 'crypto.accept') return parseClosed(cryptoAcceptSchema, value);
  throw new RemoteProtocolError('INVALID_FRAME', `unsupported handshake type ${String(record.type)}`);
}

export interface RelayRouteBinding {
  host_id: string;
  device_id: string;
  route_id: string;
  connection_id: string;
  direction: TransportDirection;
}

export function parseRelayFrame(value: unknown): RelayFrame {
  const frame = parseClosed(relayFrameSchema, value);
  if (utf8ByteLength(JSON.stringify(frame)) > MAX_RELAY_FRAME_BYTES) {
    throw new RemoteProtocolError('FRAME_TOO_LARGE', 'relay frame exceeds 512 KiB.');
  }
  return frame;
}

export function assertRelayRoute(frame: RelayFrame, binding: RelayRouteBinding): void {
  if (
    frame.host_id !== binding.host_id
    || frame.device_id !== binding.device_id
    || frame.route_id !== binding.route_id
    || frame.connection_id !== binding.connection_id
  ) {
    throw new RemoteProtocolError('INVALID_FRAME', 'relay frame crossed its route binding.');
  }
}

export class TransportSequenceGuard {
  #next = 0;

  constructor(next = 0) {
    this.#next = next;
  }

  get next(): number {
    return this.#next;
  }

  accept(sequence: number): void {
    if (sequence < this.#next) {
      throw new RemoteProtocolError('INVALID_FRAME', 'transport sequence replay or rollback.');
    }
    if (sequence !== this.#next) {
      throw new RemoteProtocolError('INVALID_FRAME', 'transport sequence gap.');
    }
    this.#next += 1;
  }
}

export function isControlFrame(frame: RelayFrame): boolean {
  return frame.frame_class === 'control';
}

export function isContentFrame(frame: RelayFrame): boolean {
  return frame.frame_class === 'content';
}

export const RELAY_PROTOCOL_NAME = RELAY_PROTOCOL;
