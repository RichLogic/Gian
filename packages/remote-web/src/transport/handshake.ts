import { AUTH_SIGNED_AT_SKEW_MS, type CryptoAccept } from '@gian/remote-protocol';

export interface FrozenCryptoOffer {
  handshake_nonce: string;
  device_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  sent_at: number;
}

export function sameP256Jwk(
  left: { kty: string; crv: string; x: string; y: string },
  right: { kty: string; crv: string; x: string; y: string },
): boolean {
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
}

export function acceptMatchesOffer(
  accept: CryptoAccept,
  offer: FrozenCryptoOffer,
  now = Date.now(),
): boolean {
  if (accept.handshake_nonce !== offer.handshake_nonce) return false;
  if (!sameP256Jwk(accept.device_ephemeral, offer.device_ephemeral)) return false;
  if (accept.sent_at + AUTH_SIGNED_AT_SKEW_MS < offer.sent_at) return false;
  if (Math.abs(accept.sent_at - now) > AUTH_SIGNED_AT_SKEW_MS) return false;
  return true;
}
