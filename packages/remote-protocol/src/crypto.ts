import {
  AES_GCM_KEY_BITS,
  AES_GCM_NONCE_BYTES,
  RELAY_PROTOCOL,
  REMOTE_PROTOCOL,
} from './constants.js';
import { RemoteProtocolError } from './errors.js';
import { type TransportDirection } from './relay.js';
import {
  asBufferSource,
  bytesToBase64Url,
  canonicalJson,
  canonicalSha256Hex,
  concatBytes,
  sha256Bytes,
  writeUint64Be,
} from './serialize.js';
import { p256PublicJwkSchema, parseClosed } from './validation.js';

export interface RelayAadInput {
  host_generation: string;
  host_id: string;
  device_id: string;
  route_id: string;
  connection_id: string;
  direction: TransportDirection;
  transport_sequence: number;
}

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new RemoteProtocolError('INVALID_FRAME', 'WebCrypto is required.');
  }
  return globalThis.crypto;
}

export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return webCrypto().subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
}

export async function generateP256SigningKeyPair(): Promise<CryptoKeyPair> {
  return webCrypto().subtle.generateKey(ECDSA_PARAMS, true, ['sign', 'verify']);
}

export async function exportPublicJwk(key: CryptoKey): Promise<{ kty: 'EC'; crv: 'P-256'; x: string; y: string }> {
  const jwk = await webCrypto().subtle.exportKey('jwk', key);
  return parseClosed(p256PublicJwkSchema, {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  });
}

export async function importP256PublicKey(
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string },
  usage: 'deriveBits' | 'verify',
): Promise<CryptoKey> {
  const parsed = parseClosed(p256PublicJwkSchema, jwk);
  if (usage === 'verify') {
    return webCrypto().subtle.importKey('jwk', parsed, ECDSA_PARAMS, true, ['verify']);
  }
  return webCrypto().subtle.importKey('jwk', parsed, ECDH_PARAMS, true, []);
}

export async function identityFingerprint(jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }): Promise<string> {
  return canonicalSha256Hex(parseClosed(p256PublicJwkSchema, jwk));
}

export async function deriveNonce(
  connectionId: string,
  direction: TransportDirection,
  sequence: number,
): Promise<Uint8Array> {
  const material = concatBytes(
    new TextEncoder().encode('gian.relay.nonce/1'),
    new TextEncoder().encode(`\0${connectionId}\0${direction}\0`),
    writeUint64Be(sequence),
  );
  const digest = await sha256Bytes(material);
  return digest.slice(0, AES_GCM_NONCE_BYTES);
}

export function buildRelayAad(input: RelayAadInput): Uint8Array {
  return new TextEncoder().encode(canonicalJson({
    protocol: RELAY_PROTOCOL,
    inner_protocol: REMOTE_PROTOCOL,
    host_generation: input.host_generation,
    host_id: input.host_id,
    device_id: input.device_id,
    route_id: input.route_id,
    connection_id: input.connection_id,
    direction: input.direction,
    transport_sequence: input.transport_sequence,
  }));
}

export async function handshakeTranscriptHash(input: {
  host_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  device_identity: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  host_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  device_ephemeral: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  connection_id: string;
}): Promise<Uint8Array> {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(input)));
}

export async function deriveDirectionKeys(
  localPrivate: CryptoKey,
  remotePublic: CryptoKey,
  transcriptHash: Uint8Array,
): Promise<{ host_to_device: CryptoKey; device_to_host: CryptoKey }> {
  const shared = await webCrypto().subtle.deriveBits(
    { name: 'ECDH', public: remotePublic },
    localPrivate,
    256,
  );
  const [hostToDevice, deviceToHost] = await Promise.all([
    importAesKey(await hkdfSha256(shared, transcriptHash, 'gian.remote/1|host_to_device|aes-256-gcm')),
    importAesKey(await hkdfSha256(shared, transcriptHash, 'gian.remote/1|device_to_host|aes-256-gcm')),
  ]);
  return {
    host_to_device: hostToDevice,
    device_to_host: deviceToHost,
  };
}

async function hkdfSha256(
  ikm: Uint8Array | ArrayBuffer,
  salt: Uint8Array | ArrayBuffer,
  info: string,
): Promise<ArrayBuffer> {
  const baseKey = await webCrypto().subtle.importKey('raw', asBufferSource(ikm), 'HKDF', false, ['deriveBits']);
  return webCrypto().subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asBufferSource(salt),
      info: new TextEncoder().encode(info),
    },
    baseKey,
    AES_GCM_KEY_BITS,
  );
}

async function importAesKey(bits: ArrayBuffer): Promise<CryptoKey> {
  return webCrypto().subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptRemotePayload(
  key: CryptoKey,
  aad: RelayAadInput,
  plaintext: Uint8Array,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = await deriveNonce(aad.connection_id, aad.direction, aad.transport_sequence);
  const encrypted = new Uint8Array(await webCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: asBufferSource(nonce),
      additionalData: asBufferSource(buildRelayAad(aad)),
      tagLength: 128,
    },
    key,
    asBufferSource(plaintext),
  ));
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(encrypted),
  };
}

export async function decryptRemotePayload(
  key: CryptoKey,
  aad: RelayAadInput,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const nonce = await deriveNonce(aad.connection_id, aad.direction, aad.transport_sequence);
  try {
    return new Uint8Array(await webCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(nonce),
        additionalData: asBufferSource(buildRelayAad(aad)),
        tagLength: 128,
      },
      key,
      asBufferSource(ciphertext),
    ));
  } catch {
    throw new RemoteProtocolError('INVALID_FRAME', 'AEAD authentication failed.');
  }
}

export async function signBytes(privateKey: CryptoKey, data: Uint8Array | ArrayBuffer): Promise<string> {
  const signature = new Uint8Array(await webCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    asBufferSource(data),
  ));
  return bytesToBase64Url(signature);
}

export async function verifyBytes(
  publicKey: CryptoKey,
  data: Uint8Array | ArrayBuffer,
  signature: Uint8Array,
): Promise<boolean> {
  return webCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    asBufferSource(signature),
    asBufferSource(data),
  );
}
