import { request as httpRequest } from 'node:http';
import { isAbsolute } from 'node:path';
import type {
  GianToolError,
  GianToolMethod,
  GianToolMethodData,
  GianToolMethodParams,
} from '@gian/shared';
import { GianToolServiceError } from './errors.js';

export const BROWSER_USE_BROKER_SOCKET_ENV = 'GIAN_DESKTOP_BROWSER_BROKER_SOCKET';

const BROKER_PATH = '/v1/browser-use';
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;

interface BrowserBrokerResponse {
  ok: boolean;
  data?: unknown;
  error?: GianToolError;
}

export interface BrowserToolClient {
  call<M extends GianToolMethod>(
    method: M,
    params: GianToolMethodParams[M],
    actor: { callerId: string; sessionId: string | null },
  ): Promise<GianToolMethodData[M]>;
}

export class DesktopBrowserBrokerClient implements BrowserToolClient {
  constructor(private readonly socketPath: string) {
    if (!socketPath || !isAbsolute(socketPath) || socketPath.includes('\0')) {
      throw new Error('Desktop Browser broker socket path is invalid');
    }
  }

  async call<M extends GianToolMethod>(
    method: M,
    params: GianToolMethodParams[M],
    actor: { callerId: string; sessionId: string | null },
  ): Promise<GianToolMethodData[M]> {
    const response = await this.request({
      method,
      params,
      actor: { caller_id: actor.callerId, session_id: actor.sessionId },
    });
    if (!response.ok) {
      const error = response.error;
      throw new GianToolServiceError(
        error?.code ?? 'INTERNAL_ERROR',
        error?.message ?? 'Gian Browser operation failed',
        error?.details,
      );
    }
    return response.data as GianToolMethodData[M];
  }

  private request(body: unknown): Promise<BrowserBrokerResponse> {
    const encoded = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: BrowserBrokerResponse) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value!);
      };
      const request = httpRequest({
        socketPath: this.socketPath,
        path: BROKER_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(encoded.byteLength),
        },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            finish(new GianToolServiceError('INTERNAL_ERROR', 'Desktop Browser broker response is too large'));
            return;
          }
          chunks.push(buffer);
        });
        response.once('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrowserBrokerResponse;
            if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
              finish(new GianToolServiceError('INTERNAL_ERROR', 'Desktop Browser broker returned an invalid response'));
              return;
            }
            finish(undefined, parsed);
          } catch {
            finish(new GianToolServiceError('INTERNAL_ERROR', 'Desktop Browser broker returned invalid JSON'));
          }
        });
        response.once('error', () => finish(new GianToolServiceError(
          'EXECUTOR_NOT_READY',
          'Desktop Browser broker response failed',
        )));
      });
      request.once('error', () => finish(new GianToolServiceError(
        'EXECUTOR_NOT_READY',
        'Gian Browser is unavailable; open the Gian Desktop app',
      )));
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy();
        finish(new GianToolServiceError('TIMEOUT', 'Desktop Browser broker timed out'));
      });
      request.end(encoded);
    });
  }
}
