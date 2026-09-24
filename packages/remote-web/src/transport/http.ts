import { AUTH_PROTOCOL, RemoteProtocolError, isRemoteErrorCode } from '@gian/remote-protocol';

export interface CookieJar {
  header(): string;
  store(setCookie: string[]): void;
}

export class MemoryCookieJar implements CookieJar {
  private readonly cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  store(setCookie: string[]): void {
    for (const line of setCookie) {
      const pair = line.split(';', 1)[0];
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  clear(): void {
    this.cookies.clear();
  }
}

export interface RemoteHttpClient {
  request(path: string, body?: Record<string, unknown>, accessToken?: string): Promise<Record<string, unknown>>;
  get(path: string, accessToken?: string): Promise<Record<string, unknown>>;
  setAccountToken?(token: string | null): void;
  del(path: string, body?: Record<string, unknown>, accessToken?: string): Promise<Record<string, unknown>>;
  cookies: CookieJar;
}

export function createRemoteHttpClient(input: {
  baseUrl: string;
  origin: string;
  fetchFn?: typeof fetch;
  cookies?: CookieJar;
  timeoutMs?: number;
}): RemoteHttpClient {
  const fetchFn = input.fetchFn ?? fetch;
  const cookies = input.cookies ?? new MemoryCookieJar();
  const base = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`;
  const timeoutMs = input.timeoutMs ?? 10_000;
  let accountToken: string | null = null;

  async function send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { origin: input.origin };
    if (accountToken) headers['x-gian-account-token'] = accountToken;
    if (method === 'POST' || method === 'DELETE') headers['content-type'] = 'application/json';
    const cookie = cookies.header();
    if (cookie) headers.cookie = cookie;
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(new URL(path.replace(/^\//, ''), base).toString(), {
        method,
        redirect: 'error',
        headers,
        body: method === 'GET' ? undefined : JSON.stringify({ protocol: AUTH_PROTOCOL, ...body }),
        credentials: 'include',
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        throw new RemoteProtocolError('HOST_OFFLINE', 'remote server request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const setCookie = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    cookies.store(setCookie);
    const json = await response.json() as Record<string, unknown> & { error?: { code?: string } };
    if (!response.ok) {
      const code = json.error?.code ?? 'AUTH_REQUIRED';
      if (isRemoteErrorCode(code)) {
        throw new RemoteProtocolError(code, `remote server ${response.status}`);
      }
      throw new Error(code);
    }
    return json;
  }

  return {
    cookies,
    setAccountToken(token) { accountToken = token; },
    request(path, body = { protocol: AUTH_PROTOCOL }, accessToken) {
      return send('POST', path, body, accessToken);
    },
    get(path, accessToken) {
      return send('GET', path, undefined, accessToken);
    },
    del(path, body = { protocol: AUTH_PROTOCOL }, accessToken) {
      return send('DELETE', path, body, accessToken);
    },
  };
}
