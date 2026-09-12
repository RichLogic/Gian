import { request as requestHttp } from 'node:http';
import { isAbsolute } from 'node:path';
import type { RemoteIdentityMaterial, RemotePublicIdentity } from './identity.js';

const BROKER_PATH = '/v1/remote-identity';
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export class RemoteIdentityBrokerClient implements RemoteIdentityMaterial {
  readonly kind = 'broker' as const;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!isAbsolute(socketPath)) {
      throw new Error('Remote identity broker socket must be an absolute path');
    }
  }

  async ensurePublic(): Promise<RemotePublicIdentity> {
    const data = await this.call({ op: 'ensure' });
    const public_key = data['public_key'] as RemotePublicIdentity['public_key'];
    const fingerprint = String(data['fingerprint'] ?? '');
    if (!public_key || fingerprint.length !== 64) {
      throw new Error('Remote identity broker returned an invalid public identity');
    }
    return { public_key, fingerprint };
  }

  async sign(bytes: Uint8Array): Promise<string> {
    const data = await this.call({ op: 'sign', bytes_b64: Buffer.from(bytes).toString('base64url') });
    const signature = String(data['signature'] ?? '');
    if (!signature) throw new Error('Remote identity broker returned an empty signature');
    return signature;
  }

  async getRefreshSecret(): Promise<string | null> {
    const data = await this.call({ op: 'secret.get' });
    const secret = data['refresh_secret'];
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  }

  async setRefreshSecret(secret: string): Promise<void> {
    await this.call({ op: 'secret.set', refresh_secret: secret });
  }

  private call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = requestHttp({
        socketPath: this.socketPath,
        path: BROKER_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            reject(new Error('Remote identity broker response is too large'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if (status >= 400) {
            reject(new Error(String(parsed['error'] ?? 'Remote identity broker failed')));
            return;
          }
          resolve(parsed);
        });
      });
      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        reject(new Error('Remote identity broker timed out'));
      });
      request.on('error', error => reject(error));
      request.end(payload);
    });
  }
}
