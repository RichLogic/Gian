import { describe, expect, it } from 'vitest';
import { MemoryEncryptedHostCache } from '../src/cache/encrypted-cache.js';

describe('encrypted host cache', () => {
  it('keeps the AES key out of the sealed blob so a database dump cannot decrypt', async () => {
    const cache = new MemoryEncryptedHostCache();
    const hostId = '11111111-1111-4111-8111-111111111111';
    const snapshot = { type: 'state.snapshot', host: { id: hostId, name: 'Office' } };
    await cache.put(hostId, snapshot);
    const sealed = cache.sealed(hostId);
    const key = cache.cryptoKey(hostId);
    expect(sealed).toBeTruthy();
    expect(key).toBeTruthy();
    const dumped = JSON.stringify(sealed);
    expect(dumped).not.toContain('Office');
    expect(dumped).not.toContain('"key"');
    expect(dumped).not.toContain('"kty"');
    expect(dumped).not.toMatch(/"k":/);
    await expect(crypto.subtle.exportKey('jwk', key!)).rejects.toThrow();
    await expect(cache.get(hostId)).resolves.toEqual(snapshot);
  });
});
