import { describe, expect, it } from 'vitest';
import { AUTH_SIGNED_AT_SKEW_MS, generateCanonicalId } from '@gian/remote-protocol';
import { acceptMatchesOffer, type FrozenCryptoOffer } from '../src/transport/handshake.js';
import type { CryptoAccept } from '@gian/remote-protocol';

function offer(): FrozenCryptoOffer {
  return {
    handshake_nonce: generateCanonicalId(),
    device_ephemeral: { kty: 'EC', crv: 'P-256', x: 'current-x', y: 'current-y' },
    sent_at: 1_778_000_000_000,
  };
}

function accept(current: FrozenCryptoOffer, patch: Partial<CryptoAccept> = {}): CryptoAccept {
  return {
    protocol: 'gian.relay/1',
    type: 'crypto.accept',
    host_id: generateCanonicalId(),
    device_id: generateCanonicalId(),
    crypto_connection_id: generateCanonicalId(),
    handshake_nonce: current.handshake_nonce,
    host_generation: generateCanonicalId(),
    host_identity: { kty: 'EC', crv: 'P-256', x: 'host-x', y: 'host-y' },
    host_ephemeral: { kty: 'EC', crv: 'P-256', x: 'host-eph-x', y: 'host-eph-y' },
    device_ephemeral: current.device_ephemeral,
    signature: 'c2ln',
    sent_at: current.sent_at + 10,
    ...patch,
  };
}

describe('crypto.accept offer binding', () => {
  it('accepts an accept that repeats the current offer nonce, ephemeral, and freshness', () => {
    const current = offer();
    expect(acceptMatchesOffer(accept(current), current, current.sent_at + 20)).toBe(true);
  });

  it('rejects a replayed accept with a stale nonce or ephemeral', () => {
    const current = offer();
    const replayed = accept(current, { handshake_nonce: generateCanonicalId() });
    expect(acceptMatchesOffer(replayed, current, current.sent_at + 20)).toBe(false);
    expect(acceptMatchesOffer(accept(current, {
      device_ephemeral: { kty: 'EC', crv: 'P-256', x: 'old-x', y: 'old-y' },
    }), current, current.sent_at + 20)).toBe(false);
  });

  it('rejects an accept outside the signed-at freshness window', () => {
    const current = offer();
    const stale = accept(current, { sent_at: current.sent_at - AUTH_SIGNED_AT_SKEW_MS - 1 });
    expect(acceptMatchesOffer(stale, current, current.sent_at)).toBe(false);
    const skewed = accept(current, { sent_at: current.sent_at + AUTH_SIGNED_AT_SKEW_MS + 1 });
    expect(acceptMatchesOffer(skewed, current, current.sent_at)).toBe(false);
  });
});
