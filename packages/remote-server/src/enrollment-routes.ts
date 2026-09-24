import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  ACCOUNT_PROTOCOL, AUTH_PROTOCOL, RemoteProtocolError, accountLoginStartSchema,
  accountLoginPollSchema, adminCreateEnrollmentRequestSchema, parseClosed,
} from '@gian/remote-protocol';
import type { RemoteServerConfig } from './config.js';
import type { RemoteAccountPeers } from './auth/account-peers.js';
import { RemoteAccountLogin } from './auth/account-login.js';
import type { RemoteRepositories } from './storage/repositories.js';
import { hashSecret, randomSecret } from './crypto-hash.js';

const COOKIE = 'gian_remote_enrollment';
const PATH = '/api/v1/enrollment';
const SESSION_TTL = 60 * 60 * 1000;

export function installEnrollmentRoutes(app: Hono, config: RemoteServerConfig,
  accounts: RemoteAccountPeers, repos: RemoteRepositories): () => void {
  // Separate login exchanges and cookies: signing out here cannot erase a paired browser.
  const login = new RemoteAccountLogin(accounts, config.now, config.githubClientId, config.githubFetch);
  const cookieOptions = { path: PATH, secure: true, httpOnly: true, sameSite: 'Strict' as const };
  const allowed = (id: string) => config.enrollmentGithubIds.includes(id);
  const requireSession = (token: string | undefined) => {
    if (!token || token.length > 256) throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment login required');
    const row = repos.db.prepare('SELECT account_peer_id FROM enrollment_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(hashSecret(token), config.now()) as { account_peer_id: string } | undefined;
    if (!row) throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment login required');
    const peer = accounts.requirePeer('controller', row.account_peer_id);
    if (peer.delegated_host_id || !allowed(peer.github_account_id)) throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment access denied');
    return peer;
  };
  app.use(`${PATH}/*`, async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (context.req.method !== 'GET' && !config.allowedOrigins.includes(context.req.header('origin') ?? '')) {
      return context.json({ error: { code: 'AUTH_REQUIRED' } }, 403);
    }
    await next();
  });
  app.post(`${PATH}/account/start`, async context => {
    if (!config.enrollmentGithubIds.length) return context.json({ error: { code: 'ENROLLMENT_DISABLED' } }, 403);
    const body = parseClosed(accountLoginStartSchema, await context.req.json());
    if (body.peer.role !== 'controller') throw new RemoteProtocolError('AUTH_REQUIRED', 'invalid enrollment peer');
    return context.json(await login.start(body.peer));
  });
  app.post(`${PATH}/account/poll`, async context => {
    const body = parseClosed(accountLoginPollSchema, await context.req.json());
    const result = await login.poll(body.login_id, body.signature);
    if (result.status !== 'authorized') return context.json(result);
    if (!allowed(result.account.id)) {
      accounts.revoke(result.role, result.installation_id);
      return context.json({ protocol: ACCOUNT_PROTOCOL, status: 'denied' });
    }
    accounts.requireToken(result.account_token, 'controller');
    const token = randomSecret();
    repos.db.transaction(() => {
      repos.db.prepare('DELETE FROM enrollment_sessions WHERE expires_at <= ? OR account_peer_id = ?')
        .run(config.now(), result.installation_id);
      repos.db.prepare('INSERT INTO enrollment_sessions(token_hash, account_peer_id, expires_at) VALUES (?, ?, ?)')
        .run(hashSecret(token), result.installation_id, config.now() + SESSION_TTL);
    })();
    setCookie(context, COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL / 1000 });
    return context.json({ protocol: ACCOUNT_PROTOCOL, status: 'authorized', account: result.account });
  });
  app.get(`${PATH}/account`, context => {
    const peer = requireSession(getCookie(context, COOKIE));
    return context.json({ account: { id: peer.github_account_id, login: peer.github_login } });
  });
  app.post(`${PATH}/account/cancel`, async context => {
    const body = parseClosed(accountLoginPollSchema, await context.req.json());
    await login.cancel(body.login_id, body.signature);
    deleteCookie(context, COOKIE, cookieOptions);
    return context.json({ ok: true });
  });
  app.post(`${PATH}/account/logout`, context => {
    const token = getCookie(context, COOKIE);
    if (token) repos.db.prepare('DELETE FROM enrollment_sessions WHERE token_hash = ?').run(hashSecret(token));
    deleteCookie(context, COOKIE, cookieOptions);
    return context.json({ ok: true });
  });
  app.post(`${PATH}/tokens`, async context => {
    const peer = requireSession(getCookie(context, COOKIE));
    const body = parseClosed(adminCreateEnrollmentRequestSchema, await context.req.json());
    if (body.github_account_id && body.github_account_id !== peer.github_account_id) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'account mismatch');
    }
    const token = randomSecret();
    const created = repos.createEnrollment(token, peer.github_account_id, body.label);
    return context.json({ protocol: AUTH_PROTOCOL, enrollment_id: created.id,
      enrollment_token: token, expires_at: created.expires_at });
  });
  return () => login.close();
}
