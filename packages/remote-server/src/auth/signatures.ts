import {
  base64UrlToBytes,
  importP256PublicKey,
  verifyBytes,
} from '@gian/remote-protocol';

export async function verifyP256Signature(
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string },
  payload: string,
  signature: string,
): Promise<boolean> {
  const key = await importP256PublicKey(publicJwk, 'verify');
  return verifyBytes(key, new TextEncoder().encode(payload), base64UrlToBytes(signature));
}

export { selfRevokePayload } from '@gian/remote-protocol';
