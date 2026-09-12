import { Buffer } from 'node:buffer';
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import {
  CATALOG_ASSET_MANIFEST_FILE,
  CATALOG_SIGNATURE_ALGORITHM,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
} from './constants.js';
import {
  catalogSignatureEnvelopeV1Schema,
  type CatalogSignatureEnvelopeV1,
} from './schemas.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function asUtf8Bytes(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

function isEd25519Key(key: KeyObject): boolean {
  return key.type === 'public' && key.asymmetricKeyType === 'ed25519';
}

export function decodeEd25519PublicKey(publicKey: string | Uint8Array): KeyObject {
  if (typeof publicKey === 'string') {
    const trimmed = publicKey.trim();
    if (trimmed.includes('BEGIN PUBLIC KEY')) {
      const key = createPublicKey(trimmed);
      if (!isEd25519Key(key)) throw new Error('Public key is not Ed25519.');
      return key;
    }
    if (!/^[0-9A-Za-z+/=]+$/.test(trimmed) && !/^[0-9a-f]+$/i.test(trimmed)) {
      throw new Error('Public key encoding is not hex or base64.');
    }
    const raw = /^[0-9a-f]{64}$/i.test(trimmed)
      ? Buffer.from(trimmed, 'hex')
      : Buffer.from(trimmed, 'base64');
    return decodeEd25519PublicKey(raw);
  }

  const bytes = Buffer.from(publicKey);
  const key = bytes.byteLength === ED25519_PUBLIC_KEY_BYTES
    ? createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
      format: 'der',
      type: 'spki',
    })
    : createPublicKey({
      key: bytes,
      format: 'der',
      type: 'spki',
    });
  if (!isEd25519Key(key)) throw new Error('Public key is not Ed25519.');
  return key;
}

export function decodeEd25519Signature(signature: string | Uint8Array): Buffer {
  const bytes = typeof signature === 'string'
    ? Buffer.from(signature, 'base64')
    : Buffer.from(signature);
  if (bytes.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error(`Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes.`);
  }
  return bytes;
}

/**
 * Verify a detached Ed25519 signature over the exact message bytes.
 * Callers must pass the downloaded UTF-8 bytes; this helper does not parse
 * or reserialize JSON. Malformed input fails closed as false.
 */
export function verifyDetachedEd25519(input: {
  publicKey: string | Uint8Array;
  message: Uint8Array | string;
  signature: string | Uint8Array;
}): boolean {
  try {
    const key = decodeEd25519PublicKey(input.publicKey);
    const message = asUtf8Bytes(input.message);
    const signature = decodeEd25519Signature(input.signature);
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function verifyCatalogAssetManifestBytes(input: {
  publicKey: string | Uint8Array;
  assetManifestUtf8: Uint8Array | string;
  envelope: unknown;
}): boolean {
  try {
    const parsed = catalogSignatureEnvelopeV1Schema.safeParse(input.envelope);
    if (!parsed.success) return false;
    const envelope: CatalogSignatureEnvelopeV1 = parsed.data;
    if (envelope.algorithm !== CATALOG_SIGNATURE_ALGORITHM) return false;
    if (envelope.signedAsset !== CATALOG_ASSET_MANIFEST_FILE) return false;
    return verifyDetachedEd25519({
      publicKey: input.publicKey,
      message: input.assetManifestUtf8,
      signature: envelope.signature,
    });
  } catch {
    return false;
  }
}

/**
 * keyId must select a pinned key. An unknown or omitted keyId fails closed
 * even if some other public key would verify the bytes.
 */
export function verifyCatalogAssetManifestWithPinnedKeys(input: {
  pinnedPublicKeys: Readonly<Record<string, string | Uint8Array>>;
  assetManifestUtf8: Uint8Array | string;
  envelope: unknown;
}): boolean {
  const parsed = catalogSignatureEnvelopeV1Schema.safeParse(input.envelope);
  if (!parsed.success) return false;
  const pinned = input.pinnedPublicKeys[parsed.data.keyId];
  if (pinned == null) return false;
  return verifyCatalogAssetManifestBytes({
    publicKey: pinned,
    assetManifestUtf8: input.assetManifestUtf8,
    envelope: parsed.data,
  });
}
