import { describe, expect, it } from 'vitest';

import { createRemoteHttpClient } from '../src/transport/http.js';

describe('Remote HTTP client', () => {
  it('aborts a hung authentication request with a recoverable offline error', async () => {
    const client = createRemoteHttpClient({
      baseUrl: 'https://remote.test',
      origin: 'https://remote.test',
      timeoutMs: 10,
      fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }),
    });

    await expect(client.get('/api/v1/me')).rejects.toMatchObject({
      code: 'HOST_OFFLINE',
      message: 'remote server request timed out',
    });
  });
});
