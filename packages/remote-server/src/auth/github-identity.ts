import { RemoteProtocolError, type RemoteAccountIdentity } from '@gian/remote-protocol';

/** Server-owned OAuth exchanges call this verifier; no public API accepts a
 * client-supplied profile or exports the Desktop's existing OAuth token. */
export class GitHubIdentityVerifier {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async verify(accessToken: string): Promise<RemoteAccountIdentity> {
    if (!accessToken || accessToken.length > 4096 || /\s/.test(accessToken)) throw denied();
    try {
      const response = await this.fetchImpl('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'Gian-Remote',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) throw denied();
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object') throw denied();
      const user = body as Record<string, unknown>;
      if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0
        || typeof user.login !== 'string' || !user.login || user.login.length > 256
        || user.type !== 'User') throw denied();
      return { provider: 'github', id: String(user.id), login: user.login };
    } catch {
      // Upstream errors can contain URLs, headers or credential material.
      throw denied();
    }
  }
}

function denied(): RemoteProtocolError {
  return new RemoteProtocolError('AUTH_REQUIRED', 'GitHub account verification failed');
}
