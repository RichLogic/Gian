import { describe, expect, it, vi } from 'vitest';
import { preparePairingLink, readPairingLink } from '../src/pairing-link.js';
import { createProductionController } from '../src/controller/create.js';
import { MemoryBrowserIdentityStore } from '../src/transport/identity.js';
import { MemoryEncryptedHostCache } from '../src/cache/encrypted-cache.js';
import type { RemoteHttpClient } from '../src/transport/http.js';

describe('real QR pairing entry', () => {
  const nonce = 'a-valid-opaque-grant-nonce';
  it('parses the grant and computes the URL to use after confirmation', () => {
    const parsed = readPairingLink('https://remote.test/pair?lang=en#nonce=' + nonce);
    expect(parsed).toEqual({ nonce, cleanUrl: '/pair?lang=en' });
    expect(readPairingLink('https://remote.test/pair?nonce=' + nonce + '&lang=en'))
      .toEqual({ nonce, cleanUrl: '/pair?lang=en' });
  });
  it('preserves an unclaimed scanner invitation for a second browser, without auto-claim or old-Host restore', () => {
    let scannerUrl = 'https://remote.test/#nonce=' + nonce;
    const replaceScannerUrl = vi.fn((url: string) => { scannerUrl = new URL(url, scannerUrl).href; });
    const scannerLink = preparePairingLink(scannerUrl, replaceScannerUrl);
    const request = vi.fn();
    const get = vi.fn();
    const scanner = createProductionController({
      baseUrl: 'https://remote.test', publicOrigin: 'https://remote.test',
      pairingNonce: scannerLink.nonce, onPairingLinkDismissed: scannerLink.dismiss,
      identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      http: { request, get } as unknown as RemoteHttpClient,
    });
    // The scanner's "Open in browser" transfers its current address, not
    // its JavaScript memory, cookie, or device key.
    const browserLink = preparePairingLink(scannerUrl, vi.fn());
    const browser = createProductionController({
      baseUrl: 'https://remote.test', publicOrigin: 'https://remote.test',
      pairingNonce: browserLink.nonce, onPairingLinkDismissed: browserLink.dismiss,
      identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      http: { request, get } as unknown as RemoteHttpClient,
    });
    try {
      expect(replaceScannerUrl).not.toHaveBeenCalled();
      expect(browserLink.nonce).toBe(nonce);
      for (const controller of [scanner, browser]) {
        expect(controller.state.auth).toMatchObject({
          kind: 'pairing', pairing: { kind: 'qr-confirm', pairingUrl: scannerUrl },
        });
      }
      expect(request).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    } finally { scanner.close(); browser.close(); }
  });
  it('moves legacy query grants into the fragment and preserves unrelated URL state', () => {
    const replace = vi.fn();
    const link = preparePairingLink('https://remote.test/pair?nonce=' + nonce + '&lang=en#view=pair', replace);
    expect(replace).toHaveBeenLastCalledWith('/pair?lang=en#view=pair&nonce=' + nonce);
    link.dismiss();
    link.dismiss();
    expect(replace).toHaveBeenLastCalledWith('/pair?lang=en#view=pair');
    expect(replace).toHaveBeenCalledTimes(2);
  });
  it('scrubs but rejects ambiguous, malformed and wrong-route grants', () => {
    for (const path of ['/pair?nonce=short', '/other#nonce=' + nonce,
      '/pair?nonce=' + nonce + '#nonce=' + nonce]) {
      const parsed = readPairingLink('https://remote.test' + path);
      expect(parsed.nonce).toBeUndefined();
      expect(parsed.cleanUrl).not.toContain('nonce');
      const replace = vi.fn();
      const link = preparePairingLink('https://remote.test' + path, replace);
      expect(link.nonce).toBeUndefined();
      expect(replace).toHaveBeenCalledWith(parsed.cleanUrl);
    }
  });
  it('waits for explicit browser confirmation and submits grant_nonce once rather than fabricating a waiting state', async () => {
    const replace = vi.fn();
    const link = preparePairingLink('https://remote.test/#nonce=' + nonce, replace);
    const request = vi.fn(async (_path: string, _body: unknown) => {
      throw new Error('not available');
    });
    const controller = createProductionController({
      baseUrl: 'https://remote.test', publicOrigin: 'https://remote.test',
      pairingNonce: link.nonce, onPairingLinkDismissed: link.dismiss,
      identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      http: { request } as unknown as RemoteHttpClient,
    });
    try {
      expect(request).not.toHaveBeenCalled();
      expect(controller.state.auth).toMatchObject({ kind: 'pairing', pairing: { kind: 'qr-confirm' } });
      controller.actions.confirmQrPairing();
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/');
      expect(JSON.stringify(controller.state.auth)).not.toContain(nonce);
      controller.actions.confirmQrPairing();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(replace.mock.invocationCallOrder[0]!).toBeLessThan(request.mock.invocationCallOrder[0]!);
      expect(request).toHaveBeenCalledWith('/api/v1/pairings/claim', expect.objectContaining({ grant_nonce: nonce }));
      expect(request.mock.calls[0]![1]).not.toHaveProperty('code');
    } finally { controller.close(); }
  });
  it.each(['cancelPairing', 'restartPairing'] as const)('%s discards an unclaimed link without submitting it', action => {
    const replace = vi.fn();
    const link = preparePairingLink('https://remote.test/#nonce=' + nonce, replace);
    const request = vi.fn();
    const controller = createProductionController({
      baseUrl: 'https://remote.test', publicOrigin: 'https://remote.test',
      pairingNonce: link.nonce, onPairingLinkDismissed: link.dismiss,
      identity: new MemoryBrowserIdentityStore(), cache: new MemoryEncryptedHostCache(),
      http: { request } as unknown as RemoteHttpClient,
    });
    try {
      controller.actions[action]();
      controller.actions.confirmQrPairing();
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/');
      expect(request).not.toHaveBeenCalled();
      expect(JSON.stringify(controller.state.auth)).not.toContain(nonce);
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
