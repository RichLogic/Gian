import { describe, expect, it, vi } from 'vitest';
import { readPairingLink } from '../src/pairing-link.js';
import { createProductionController } from '../src/controller/create.js';
import { MemoryBrowserIdentityStore } from '../src/transport/identity.js';
import { MemoryEncryptedHostCache } from '../src/cache/encrypted-cache.js';
import type { RemoteHttpClient } from '../src/transport/http.js';

describe('real QR pairing entry', () => {
  const nonce = 'a-valid-opaque-grant-nonce';
  it('consumes a fragment grant without leaving it in the request URL or browser history', () => {
    const parsed = readPairingLink('https://remote.test/pair?lang=en#nonce=' + nonce);
    expect(parsed).toEqual({ nonce, cleanUrl: '/pair?lang=en' });
    expect(readPairingLink('https://remote.test/pair?nonce=' + nonce + '&lang=en'))
      .toEqual({ nonce, cleanUrl: '/pair?lang=en' });
  });
  it('scrubs but rejects ambiguous, malformed and wrong-route grants', () => {
    for (const path of ['/pair?nonce=short', '/other#nonce=' + nonce,
      '/pair?nonce=' + nonce + '#nonce=' + nonce]) {
      const parsed = readPairingLink('https://remote.test' + path);
      expect(parsed.nonce).toBeUndefined();
      expect(parsed.cleanUrl).not.toContain('nonce');
    }
  });
  it('waits for explicit browser confirmation and submits grant_nonce once rather than fabricating a waiting state', async () => {
    const request = vi.fn(async (_path: string, _body: unknown) => { throw new Error('not available'); });
    const controller = createProductionController({
      baseUrl: 'https://remote.test', publicOrigin: 'https://remote.test',
      pairingNonce: nonce, identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      http: { request } as unknown as RemoteHttpClient,
    });
    try {
      expect(request).not.toHaveBeenCalled();
      expect(controller.state.auth).toMatchObject({ kind: 'pairing', pairing: { kind: 'qr-confirm' } });
      controller.actions.confirmQrPairing();
      controller.actions.confirmQrPairing();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request).toHaveBeenCalledWith('/api/v1/pairings/claim', expect.objectContaining({ grant_nonce: nonce }));
      expect(request.mock.calls[0]![1]).not.toHaveProperty('code');
    } finally { controller.close(); }
  });
  it('cancel during an outstanding QR claim prevents challenge/login continuation', async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(done => { resolve = done; }));
    const controller = createProductionController({
      baseUrl: 'https://remote.test', publicOrigin: 'https://remote.test', pairingNonce: nonce,
      identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      http: { request } as unknown as RemoteHttpClient, autoRestore: false,
    });
    try {
      controller.actions.confirmQrPairing();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      controller.actions.cancelPairing();
      resolve({
        protocol: 'gian.remote.auth/1', pairing_id: '11111111-1111-4111-8111-111111111111',
        host_id: '22222222-2222-4222-8222-222222222222', status: 'pending_confirmation',
        crypto_connection_id: '33333333-3333-4333-8333-333333333333',
      });
      await new Promise(done => setTimeout(done, 20));
      expect(request).toHaveBeenCalledTimes(1);
      expect(controller.state.auth).toMatchObject({ kind: 'pairing', pairing: { kind: 'failed', reason: 'cancelled' } });
    } finally { controller.close(); }
  });
});
