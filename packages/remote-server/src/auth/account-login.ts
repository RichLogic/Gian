import {
  ACCOUNT_PROTOCOL,
  RemoteProtocolError,
  generateCanonicalId,
  remoteAccountChallengePayload,
  type AccountLoginResult,
  type AccountLoginStarted,
  type RemoteAccountChallenge,
  type RemoteAccountPeer,
} from '@gian/remote-protocol';
import type { Clock } from '../clock.js';
import { RemoteAccountPeers } from './account-peers.js';
import { verifyP256Signature } from './signatures.js';

interface Login {
  challenge: RemoteAccountChallenge;
  deviceCode: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  result?: AccountLoginResult;
  inFlight?: Promise<AccountLoginResult>;
  cancelled?: boolean;
}

/** Upstream failures are retryable availability errors, never proof of bad credentials. */
export class GitHubUpstreamError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds = 5) {
    super('GitHub authorization is temporarily unavailable');
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
      ? Math.min(60, Math.max(5, Math.ceil(retryAfterSeconds))) : 5;
  }
}

/** GitHub tokens exist only during this Server-owned exchange. Clients see
 * a GitHub user code and an opaque Gian account session, never OAuth tokens. */
export class RemoteAccountLogin {
  private readonly pending = new Map<string, Login>();
  private starting = 0;
  private closed = false;

  constructor(
    private readonly accounts: RemoteAccountPeers,
    private readonly now: Clock,
    private readonly clientId: string | undefined,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async start(peer: RemoteAccountPeer): Promise<AccountLoginStarted> {
    if (this.closed || !this.clientId) throw new RemoteProtocolError('AUTH_REQUIRED', 'GitHub login is not configured');
    this.cleanup();
    if (this.pending.size + this.starting >= 1000) throw new RemoteProtocolError('RATE_LIMITED', 'too many pending logins');
    this.starting += 1;
    try {
      const body = await this.github('https://github.com/login/device/code', { client_id: this.clientId });
      if (typeof body.device_code !== 'string' || !body.device_code || body.device_code.length > 4096
        || typeof body.user_code !== 'string' || !body.user_code || body.user_code.length > 64
        || body.verification_uri !== 'https://github.com/login/device'
        || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0
        || typeof body.interval !== 'number' || !Number.isFinite(body.interval) || body.interval <= 0) throw new GitHubUpstreamError();
      const challenge = this.accounts.challenge(peer);
      const expiresAt = Math.min(challenge.expires_at, this.now() + body.expires_in * 1000);
      const interval = Math.min(60, Math.max(5, Math.ceil(body.interval)));
      const loginId = generateCanonicalId();
      this.pending.set(loginId, {
        challenge, deviceCode: body.device_code, expiresAt, interval,
        nextPollAt: this.now(),
      });
      return {
        protocol: ACCOUNT_PROTOCOL, login_id: loginId, challenge,
        user_code: body.user_code, verification_uri: 'https://github.com/login/device',
        expires_at: expiresAt, interval_seconds: interval,
      };
    } finally { this.starting -= 1; }
  }

  async poll(loginId: string, signature: string): Promise<AccountLoginResult> {
    const login = this.pending.get(loginId);
    if (this.closed || !login || login.cancelled || login.expiresAt <= this.now()) {
      this.pending.delete(loginId);
      return { protocol: ACCOUNT_PROTOCOL, status: 'expired' };
    }
    let valid = false;
    try {
      valid = await verifyP256Signature(login.challenge.peer.public_key,
        remoteAccountChallengePayload(login.challenge), signature);
    } catch { /* invalid key or signature */ }
    if (!valid) throw denied();
    if (login.cancelled) return { protocol: ACCOUNT_PROTOCOL, status: 'expired' };
    if (login.result) return login.result;
    if (login.inFlight) return login.inFlight;
    if (this.now() < login.nextPollAt) return this.waiting(login);
    login.nextPollAt = this.now() + login.interval * 1000;
    const request = this.exchange(login, signature).catch(error => {
      if (error instanceof GitHubUpstreamError) {
        // RFC 8628: connection timeouts reduce polling frequency, not revoke
        // the authorization the user is still completing in their browser.
        login.interval = Math.min(60, Math.max(login.interval * 2, error.retryAfterSeconds));
        login.nextPollAt = this.now() + login.interval * 1000;
        throw new GitHubUpstreamError(login.interval);
      }
      throw error;
    }).finally(() => { login.inFlight = undefined; });
    login.inFlight = request;
    return request;
  }

  close(): void { this.closed = true; this.pending.clear(); }

  async cancel(loginId: string, signature: string): Promise<void> {
    const login = this.pending.get(loginId);
    if (!login) return;
    let valid = false;
    try {
      valid = await verifyP256Signature(login.challenge.peer.public_key,
        remoteAccountChallengePayload(login.challenge), signature);
    } catch { /* fail closed */ }
    if (!valid) throw denied();
    login.cancelled = true;
    this.pending.delete(loginId);
    if (login.result?.status === 'authorized') this.accounts.revoke(login.result.role, login.result.installation_id);
  }

  private async exchange(login: Login, signature: string): Promise<AccountLoginResult> {
    const body = await this.github('https://github.com/login/oauth/access_token', {
      client_id: this.clientId!, device_code: login.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (this.closed || login.cancelled || login.expiresAt <= this.now()) return { protocol: ACCOUNT_PROTOCOL, status: 'expired' };
    if (body.error === 'authorization_pending') return this.waiting(login);
    if (body.error === 'slow_down') {
      login.interval = Math.min(60, login.interval + 5);
      login.nextPollAt = this.now() + login.interval * 1000;
      return this.waiting(login);
    }
    if (body.error === 'access_denied' || body.error === 'expired_token') {
      const result: AccountLoginResult = {
        protocol: ACCOUNT_PROTOCOL, status: body.error === 'access_denied' ? 'denied' : 'expired',
      };
      login.result = result;
      return result;
    }
    if (typeof body.access_token !== 'string' || !body.access_token
      || body.token_type?.toString().toLowerCase() !== 'bearer') throw new GitHubUpstreamError();
    const authenticated = await this.accounts.authenticate({
      challengeId: login.challenge.challenge_id, nonce: login.challenge.nonce,
      signature, accessToken: body.access_token,
    });
    if (login.cancelled) {
      this.accounts.revoke(login.challenge.peer.role, login.challenge.peer.installation_id);
      return { protocol: ACCOUNT_PROTOCOL, status: 'expired' };
    }
    login.result = {
      protocol: ACCOUNT_PROTOCOL, status: 'authorized', account: authenticated.account,
      account_token: authenticated.token, expires_at: authenticated.expiresAt,
      installation_id: login.challenge.peer.installation_id, role: login.challenge.peer.role,
    };
    // Keep the signed result briefly so a lost HTTP response is recoverable.
    login.deviceCode = '';
    login.expiresAt = this.now() + 60_000;
    return login.result;
  }

  private waiting(login: Login): AccountLoginResult {
    return { protocol: ACCOUNT_PROTOCOL, status: 'pending', interval_seconds: login.interval };
  }

  private cleanup(): void {
    for (const [id, login] of this.pending) if (login.expiresAt <= this.now()) this.pending.delete(id);
  }

  private async github(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Gian-Remote' },
        body: new URLSearchParams(params),
      });
    } catch { throw new GitHubUpstreamError(); }
    if (!response.ok) throw new GitHubUpstreamError(Number(response.headers.get('retry-after')) || 5);
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubUpstreamError();
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GitHubUpstreamError) throw error;
      throw new GitHubUpstreamError();
    }
  }
}

function denied(): RemoteProtocolError {
  return new RemoteProtocolError('AUTH_REQUIRED', 'GitHub authorization failed');
}
