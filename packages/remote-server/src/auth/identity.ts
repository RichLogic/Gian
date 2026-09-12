import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
} from '@gian/remote-protocol';

export interface ServerIdentity {
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  fingerprint: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function loadOrCreateServerIdentity(dataDir: string): Promise<ServerIdentity> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'server-identity.json');
  let pair: CryptoKeyPair;
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { privateJwk: JsonWebKey; publicJwk: JsonWebKey };
    pair = {
      privateKey: await crypto.subtle.importKey('jwk', saved.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', saved.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
    };
  } catch {
    pair = await generateP256SigningKeyPair();
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicJwk = await exportPublicJwk(pair.publicKey);
    writeFileSync(path, `${JSON.stringify({ privateJwk, publicJwk }, null, 2)}\n`, { mode: 0o600 });
  }
  const publicJwk = await exportPublicJwk(pair.publicKey);
  return {
    publicJwk,
    fingerprint: await identityFingerprint(publicJwk),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}
