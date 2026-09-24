import { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';

import {
  ACCESS_TOKEN_TTL_MS,
  ACCOUNT_PROTOCOL,
  accountLoginStartSchema,
  accountLoginPollSchema,
  accountLoginStartedSchema,
  accountLoginResultSchema,
  AUTH_PROTOCOL,
  AUTH_SIGNED_AT_SKEW_MS,
  REFRESH_SLIDING_MS,
  RemoteProtocolError,
  adminCreateEnrollmentRequestSchema,
  deviceChallengeRequestSchema,
  deviceLoginRequestSchema,
  generateCanonicalId,
  healthResultSchema,
  identityFingerprint,
  hostConnectorChallengeRequestSchema,
  hostConnectorLoginRequestSchema,
  hostCreatePairingRequestSchema,
  hostEnrollmentClaimRequestSchema,
  hostHeartbeatRequestSchema,
  hostUpdateProfileRequestSchema,
  hostRevokeDeviceRequestSchema,
  parseClosed,
  pairingClaimRequestSchema,
  pairingConfirmRequestSchema,
  parseRelayFrame,
  parseRelayHandshake,
  relayNoticeSchema,
  relayWsAuthSchema,
  selfRevokeRequestSchema,
  serverChallengePayload,
  sessionLogoutRequestSchema,
  sessionRefreshRequestSchema,
  signBytes,
  wsTicketRequestSchema,
} from '@gian/remote-protocol';

import { type RemoteServerConfig } from './config.js';
import { hashSecret, hashesEqual, randomSecret } from './crypto-hash.js';
import { logError } from './logging.js';
import { SlidingWindowLimiter } from './auth/rate-limit.js';
import { clearRefreshCookie, readRefreshCookie, writeRefreshCookie } from './auth/cookies.js';
import { TokenStore } from './auth/tokens.js';
import { RemoteAccountPeers } from './auth/account-peers.js';
import { GitHubUpstreamError, RemoteAccountLogin } from './auth/account-login.js';
import { GitHubIdentityVerifier } from './auth/github-identity.js';
import { loadOrCreateServerIdentity, type ServerIdentity } from './auth/identity.js';
import { selfRevokePayload, verifyP256Signature } from './auth/signatures.js';
import { generatePairingCode, normalizePairingCode } from './pairing/codes.js';
import { PresenceService } from './presence/leases.js';
import { RelayRouter, type RelayPeer } from './relay/router.js';
import { applySecurityHeaders } from './static/headers.js';
import { loadAndVerifyManifest, type StaticManifest } from './static/manifest.js';
import { serveRuntimeConfig, serveStaticArtifact } from './static/serve.js';
import { openRemoteDatabase, type RemoteDb } from './storage/db.js';
import { RemoteRepositories } from './storage/repositories.js';
import { installEnrollmentRoutes } from './enrollment-routes.js';

export interface RemoteAppServices {
  db: RemoteDb;
  repos: RemoteRepositories;
  tokens: TokenStore;
  accounts: RemoteAccountPeers;
  presence: PresenceService;
  relay: RelayRouter;
  identity: ServerIdentity;
  config: RemoteServerConfig;
  limiter: SlidingWindowLimiter;
  manifest?: StaticManifest;
  finalizeDeviceRevoke: (hostId: string, deviceId: string) => void;
}

export interface RemoteAppHandle {
  app: Hono;
  services: RemoteAppServices;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
  shutdown(): void;
}

const AUTH_PATHS = new Set([
  '/api/v1/account/start',
  '/api/v1/account/poll',
  '/api/v1/account/logout',
  '/api/v1/enrollment/account/start',
  '/api/v1/enrollment/account/poll',
  '/api/v1/enrollment/account/logout',
  '/api/v1/enrollment/account/cancel',
  '/api/v1/enrollment/tokens',
  '/api/v1/admin/host-enrollments',
  '/api/v1/host-enrollments/claim',
  '/api/v1/host/connector-challenge',
  '/api/v1/host/connector-login',
  '/api/v1/pairings/claim',
  '/api/v1/sessions/device-challenge',
  '/api/v1/sessions/device-login',
  '/api/v1/sessions/refresh',
  '/api/v1/sessions/logout',
  '/api/v1/ws-tickets',
]);

function jsonError(code: string) {
  return {
    protocol: AUTH_PROTOCOL,
    error: { code, message: code },
  };
}

function bearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

function clientIp(config: RemoteServerConfig, forwarded: string | undefined): string {
  if (config.trustedProxy && forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return 'direct';
}

function originAllowed(config: RemoteServerConfig, origin: string | undefined): boolean {
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
}

function familyIdFromCookie(cookie: string | undefined): string | undefined {
  if (!cookie?.includes('.')) return undefined;
  return cookie.slice(0, cookie.indexOf('.')) || undefined;
}

function authenticateRefreshCookie(input: {
  accounts: RemoteAccountPeers;
  repos: RemoteRepositories;
  tokens: TokenStore;
  cookie: string | undefined;
  now: number;
  revokeOnMismatch: boolean;
}): ReturnType<RemoteRepositories['getSession']> | undefined {
  const familyId = familyIdFromCookie(input.cookie);
  if (!familyId || !input.cookie) return undefined;
  const family = input.repos.getSession(familyId);
  if (!family || family.revoked_at || family.absolute_expires_at <= input.now || family.sliding_expires_at <= input.now) {
    return undefined;
  }
  try {
    if (!family.account_peer_id) return undefined;
    input.accounts.requirePeer('controller', family.account_peer_id);
  } catch { return undefined; }
  if (!hashesEqual(hashSecret(input.cookie), family.current_refresh_hash)) {
    if (input.revokeOnMismatch) {
      input.repos.revokeFamily(family.id);
      input.tokens.revokeFamily(family.id);
    }
    return undefined;
  }
  return family;
}

export async function createRemoteApp(config: RemoteServerConfig): Promise<RemoteAppHandle> {
  let shuttingDown = false;
  const db = openRemoteDatabase(config.dataDir);
  const repos = new RemoteRepositories(db, config.now);
  const tokens = new TokenStore(config.now);
  const presence = new PresenceService(repos, config);
  const relay = new RelayRouter(config, presence);
  const identity = await loadOrCreateServerIdentity(config.dataDir);
  const accounts = new RemoteAccountPeers(db, identity.fingerprint, config.now,
    new GitHubIdentityVerifier(config.githubFetch));
  const accountLogin = new RemoteAccountLogin(accounts, config.now, config.githubClientId, config.githubFetch);
  const limiter = new SlidingWindowLimiter(config.now, config.authRateLimitPerMinute);
  const accountPollLimiter = new SlidingWindowLimiter(config.now, Math.max(30, config.authRateLimitPerMinute));
  const manifest = config.staticDir ? loadAndVerifyManifest(config.staticDir) : undefined;
  const services = {
    db, repos, tokens, accounts, presence, relay, identity, config, limiter, manifest,
  };

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  const liveRoutes = new Map<string, { hostId: string; deviceId?: string; familyId?: string; close(): void }>();
  const routeAllowed = (route: { hostId: string; deviceId?: string; familyId?: string }): boolean => {
    try {
      accounts.requireHost(route.hostId);
      if (route.deviceId) {
        const owner = accounts.requirePairing(route.deviceId);
        const family = route.familyId ? repos.getSession(route.familyId) : undefined;
        if (!family || family.revoked_at !== null || family.account_peer_id !== owner.installation_id
          || family.absolute_expires_at <= config.now() || family.sliding_expires_at <= config.now()) return false;
      }
      return true;
    } catch { return false; }
  };
  const closeUnauthorizedRoutes = () => {
    for (const [id, route] of liveRoutes) {
      if (routeAllowed(route)) continue;
      route.close();
      relay.detach(id);
      liveRoutes.delete(id);
    }
  };
  const accountLeaseTimer = setInterval(closeUnauthorizedRoutes, 1000);
  accountLeaseTimer.unref();

  app.use('*', async (context, next) => {
    await next();
    applySecurityHeaders(context.res.headers, config.publicOrigin.startsWith('https://'));
  });

  app.use('/api/*', async (context, next) => {
    const origin = context.req.header('origin');
    if (origin && !originAllowed(config, origin)) {
      return context.json(jsonError('AUTH_REQUIRED'), 403);
    }
    if (originAllowed(config, origin)) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Vary', 'Origin');
      context.header('Access-Control-Allow-Credentials', 'true');
    }
    const path = new URL(context.req.url).pathname;
    if (AUTH_PATHS.has(path) && context.req.method !== 'GET' && context.req.method !== 'OPTIONS') {
      const ip = clientIp(config, context.req.header('x-forwarded-for'));
      const selectedLimiter = path.endsWith('/account/poll') ? accountPollLimiter : limiter;
      if (!selectedLimiter.allow(`${ip}:${path}`)) {
        return context.json(jsonError('RATE_LIMITED'), 429);
      }
    }
    await next();
  });

  app.get('/health', (context) => context.json(parseClosed(healthResultSchema, {
    ok: true,
    version: config.version,
    build_id: config.buildId,
  })));

  const closeEnrollment = installEnrollmentRoutes(app, config, accounts, repos);

  app.post('/api/v1/account/start', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(accountLoginStartSchema, await context.req.json());
    return context.json(parseClosed(accountLoginStartedSchema, await accountLogin.start(body.peer)));
  });
  app.post('/api/v1/account/poll', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(accountLoginPollSchema, await context.req.json());
    const result = await accountLogin.poll(body.login_id, body.signature);
    closeUnauthorizedRoutes();
    return context.json(parseClosed(accountLoginResultSchema, result));
  });
  app.get('/api/v1/account/me', context => {
    context.header('Cache-Control', 'no-store');
    const peer = accounts.requireToken(bearer(context.req.header('authorization')));
    return context.json({ protocol: ACCOUNT_PROTOCOL, installation_id: peer.installation_id,
      role: peer.role, account: { provider: 'github', id: peer.github_account_id, login: peer.github_login },
      expires_at: peer.expires_at });
  });
  app.post('/api/v1/account/logout', context => {
    const peer = accounts.requireToken(bearer(context.req.header('authorization')));
    accounts.revoke(peer.role, peer.installation_id);
    closeUnauthorizedRoutes();
    return context.json({ protocol: ACCOUNT_PROTOCOL, ok: true });
  });

  app.post('/api/v1/admin/host-enrollments', async (context) => {
    context.header('Cache-Control', 'no-store');
    const admin = bearer(context.req.header('authorization'));
    if (!admin || !hashesEqual(hashSecret(admin), hashSecret(config.adminToken))) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const body = parseClosed(adminCreateEnrollmentRequestSchema, await context.req.json());
    const accountId = body.github_account_id ?? (config.enrollmentGithubIds.length === 1 ? config.enrollmentGithubIds[0] : undefined);
    if (!accountId || !config.enrollmentGithubIds.includes(accountId)) return context.json(jsonError('AUTH_REQUIRED'), 403);
    const token = randomSecret();
    const created = repos.createEnrollment(token, accountId, body.label);
    return context.json({
      protocol: AUTH_PROTOCOL,
      enrollment_id: created.id,
      enrollment_token: token,
      expires_at: created.expires_at,
    });
  });

  app.post('/api/v1/host-enrollments/claim', async (context) => {
    const body = parseClosed(hostEnrollmentClaimRequestSchema, await context.req.json());
    const account = accounts.requireToken(context.req.header('x-gian-account-token'), 'host');
    if (!config.enrollmentGithubIds.includes(account.github_account_id)) return context.json(jsonError('AUTH_REQUIRED'), 403);
    if (account.public_key_fingerprint !== await identityFingerprint(body.host_public_key)) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const { host, refresh } = db.transaction(() => {
      accounts.requirePeer('host', account.installation_id);
      const host = repos.claimEnrollment(body.enrollment_token, {
        name: body.host_name, public_key_jwk: JSON.stringify(body.host_public_key),
      }, account.github_account_id);
      if (!host) throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment required');
      accounts.bindHost(host.id, account.installation_id);
      const refresh = randomSecret();
      repos.setHostCredential(host.id, refresh);
      return { host, refresh };
    })();
    return context.json({
      protocol: AUTH_PROTOCOL,
      host_id: host.id,
      connector_refresh_secret: refresh,
      server_identity: {
        algorithm: 'P-256',
        public_key: identity.publicJwk,
        fingerprint: identity.fingerprint,
      },
    });
  });

  app.post('/api/v1/host/connector-challenge', async (context) => {
    const body = parseClosed(hostConnectorChallengeRequestSchema, await context.req.json());
    if (!repos.getHost(body.host_id)) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const challenge = randomSecret();
    const created = repos.createConnectorChallenge(body.host_id, challenge, ACCESS_TOKEN_TTL_MS);
    const payload = serverChallengePayload({
      host_id: body.host_id,
      challenge_id: created.id,
      challenge,
      expires_at: created.expires_at,
      fingerprint: identity.fingerprint,
    });
    const signature = await signBytes(identity.privateKey, new TextEncoder().encode(payload));
    return context.json({
      protocol: AUTH_PROTOCOL,
      challenge_id: created.id,
      challenge,
      expires_at: created.expires_at,
      server_identity_fingerprint: identity.fingerprint,
      server_identity: {
        algorithm: 'P-256',
        public_key: identity.publicJwk,
        fingerprint: identity.fingerprint,
      },
      server_identity_signature: signature,
    });
  });

  app.post('/api/v1/host/connector-login', async (context) => {
    const body = parseClosed(hostConnectorLoginRequestSchema, await context.req.json());
    const host = repos.getHost(body.host_id);
    const creds = repos.getHostCredentials(body.host_id);
    if (!host || !creds) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const presented = hashSecret(body.refresh_secret);
    const matchesCurrent = hashesEqual(presented, creds.refresh_secret_hash);
    const matchesPrevious = Boolean(
      creds.previous_refresh_secret_hash
      && hashesEqual(presented, creds.previous_refresh_secret_hash),
    );
    if (!matchesCurrent && !matchesPrevious) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const ok = await verifyP256Signature(
      JSON.parse(host.public_key_jwk),
      body.challenge_id,
      body.signature,
    );
    if (!ok || !repos.consumeConnectorChallenge(body.challenge_id, body.host_id)) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const accountToken = context.req.header('x-gian-account-token');
    if (accountToken) {
      const peer = accounts.requireToken(accountToken, 'host');
      if (peer.public_key_fingerprint !== await identityFingerprint(JSON.parse(host.public_key_jwk))) {
        return context.json(jsonError('AUTH_REQUIRED'), 401);
      }
      accounts.bindHost(host.id, peer.installation_id);
    }
    const account = accounts.requireHost(host.id);
    const nextRefresh = randomSecret();
    if (matchesCurrent) repos.rotateHostCredential(host.id, nextRefresh);
    else repos.replaceCurrentRefreshHash(host.id, nextRefresh);
    const access = tokens.issue({ role: 'host', hostId: host.id, accountPeerId: account.installation_id });
    presence.heartbeat(host.id);
    return context.json({
      protocol: AUTH_PROTOCOL,
      connector_access_token: access.token,
      refresh_secret: nextRefresh,
      expires_at: access.expiresAt,
    });
  });

  const requireHost = (context: { req: { header: (name: string) => string | undefined } }) => {
    const token = bearer(context.req.header('authorization'));
    const record = token ? tokens.get(token) : undefined;
    if (!record || record.role !== 'host') return undefined;
    try {
      if (accounts.requireHost(record.hostId).installation_id !== record.accountPeerId) return undefined;
    } catch { return undefined; }
    return record;
  };

  const requireDevice = (context: { req: { header: (name: string) => string | undefined } }) => {
    const token = bearer(context.req.header('authorization'));
    const record = token ? tokens.get(token) : undefined;
    if (!record || record.role !== 'device' || !record.deviceId || !record.familyId) return undefined;
    if (!routeAllowed(record)) return undefined;
    if (accounts.requirePairing(record.deviceId).installation_id !== record.accountPeerId) return undefined;
    return record;
  };

  app.post('/api/v1/host/pairings', async (context) => {
    const hostAuth = requireHost(context);
    if (!hostAuth) return context.json(jsonError('AUTH_REQUIRED'), 401);
    parseClosed(hostCreatePairingRequestSchema, await context.req.json());
    const code = generatePairingCode();
    const nonce = randomSecret();
    const grant = repos.createPairingGrant(hostAuth.hostId, hashSecret(normalizePairingCode(code)), hashSecret(nonce));
    return context.json({
      protocol: AUTH_PROTOCOL,
      grant_id: grant.id,
      code,
      grant_nonce: nonce,
      expires_at: grant.expires_at,
    });
  });

  app.post('/api/v1/pairings/claim', async (context) => {
    const origin = context.req.header('origin');
    if (!originAllowed(config, origin)) return context.json(jsonError('AUTH_REQUIRED'), 403);
    const body = parseClosed(pairingClaimRequestSchema, await context.req.json());
    const grant = body.code
      ? repos.findGrantByCodeHash(hashSecret(normalizePairingCode(body.code)))
      : repos.findGrantByNonceHash(hashSecret(body.grant_nonce!));
    if (!grant || grant.expires_at <= config.now() || grant.rejected_at || grant.consumed_at || grant.claimed_at) {
      if (grant && !grant.claimed_at) repos.recordGrantFailure(grant.id);
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    if (grant.failed_claims >= 5) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const deviceFingerprint = await identityFingerprint(body.device_public_key);
    const owner = accounts.requireHost(grant.host_id);
    const accountToken = context.req.header('x-gian-account-token');
    const authenticated = accountToken !== undefined ? accounts.requireToken(accountToken, 'controller') : undefined;
    if (authenticated) accounts.requireSameAccount(owner.installation_id, authenticated.installation_id);
    repos.revokeExpiredOrUnboundPairings(grant.host_id);
    if (repos.countHostPairings(grant.host_id) >= config.maxDevicesPerHost) {
      return context.json(jsonError('RATE_LIMITED'), 429);
    }
    const { pairing, account } = db.transaction(() => {
      repos.ensureBrowser(body.browser_installation_id);
      const pairing = repos.claimGrantAndUpsertPairing({
        grantId: grant.id,
        browserInstallationId: body.browser_installation_id,
        hostId: grant.host_id,
        publicKeyJwk: JSON.stringify(body.device_public_key),
        platform: body.platform,
        userAgent: body.user_agent,
      });
      if (!pairing) throw new RemoteProtocolError('AUTH_REQUIRED', 'pairing unavailable');
      const account = authenticated ?? accounts.createPendingBrowserDelegation(grant.host_id, deviceFingerprint);
      db.prepare('UPDATE device_host_pairings SET account_peer_id = ? WHERE id = ?')
        .run(account.installation_id, pairing.id);
      return { pairing, account };
    })();
    relay.notifyHost(grant.host_id, parseClosed(relayNoticeSchema, {
      protocol: 'gian.relay/1',
      type: 'pairing.claimed',
      host_id: grant.host_id,
      pairing_id: pairing.id,
      grant_id: grant.id,
      crypto_connection_id: pairing.crypto_connection_id ?? undefined,
      device_public_key: body.device_public_key,
      account_id: account.github_account_id,
      platform: body.platform,
      user_agent: body.user_agent,
      sent_at: config.now(),
    }));
    return context.json({
      protocol: AUTH_PROTOCOL,
      pairing_id: pairing.id,
      host_id: grant.host_id,
      status: 'pending_confirmation',
      crypto_connection_id: pairing.crypto_connection_id,
    });
  });

  app.post('/api/v1/pairings/:id/confirm', async (context) => {
    const hostAuth = requireHost(context);
    if (!hostAuth) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const body = parseClosed(pairingConfirmRequestSchema, await context.req.json());
    if (body.pairing_id !== context.req.param('id')) return context.json(jsonError('AUTH_REQUIRED'), 400);
    const pairing = repos.getPairing(body.pairing_id);
    if (!pairing || pairing.host_id !== hostAuth.hostId) return context.json(jsonError('AUTH_REQUIRED'), 401);
    db.transaction(() => {
      accounts.requirePairing(pairing.id);
      const grant = repos.confirmGrant(body.pairing_id, body.decision);
      if (!grant) throw new RemoteProtocolError('AUTH_REQUIRED', 'pairing unavailable');
      if (body.decision === 'confirm') {
        repos.confirmPairing(pairing.id);
        accounts.confirmBrowserDelegation(pairing.id);
      } else repos.deletePairing(pairing.id);
    })();
    return context.json({
      protocol: AUTH_PROTOCOL,
      pairing_id: pairing.id,
      status: body.decision === 'confirm' ? 'confirmed' : 'rejected',
      device_id: body.decision === 'confirm' ? pairing.id : undefined,
      crypto_connection_id: body.decision === 'confirm' ? pairing.crypto_connection_id ?? undefined : undefined,
    });
  });

  app.post('/api/v1/sessions/device-challenge', async (context) => {
    if (!originAllowed(config, context.req.header('origin'))) {
      return context.json(jsonError('AUTH_REQUIRED'), 403);
    }
    const body = parseClosed(deviceChallengeRequestSchema, await context.req.json());
    const pairing = repos.getPairingByBrowserHost(body.browser_installation_id, body.host_id);
    if (!pairing || !pairing.confirmed_at) {
      return context.json(jsonError('DEVICE_NOT_PAIRED'), 401);
    }
    if (repos.isDeviceRouteClosed(pairing.id)) return context.json(jsonError('DEVICE_REVOKED'), 401);
    const challenge = randomSecret();
    const created = repos.createDeviceChallenge(body.browser_installation_id, body.host_id, challenge, ACCESS_TOKEN_TTL_MS);
    return context.json({
      protocol: AUTH_PROTOCOL,
      challenge_id: created.id,
      challenge,
      expires_at: created.expires_at,
    });
  });

  app.post('/api/v1/sessions/device-login', async (context) => {
    if (!originAllowed(config, context.req.header('origin'))) {
      return context.json(jsonError('AUTH_REQUIRED'), 403);
    }
    const body = parseClosed(deviceLoginRequestSchema, await context.req.json());
    const pairing = repos.getPairingByBrowserHost(body.browser_installation_id, body.host_id);
    if (!pairing || !pairing.confirmed_at || repos.isDeviceRouteClosed(pairing.id)) {
      return context.json(jsonError('DEVICE_REVOKED'), 401);
    }
    const ok = await verifyP256Signature(
      JSON.parse(pairing.public_key_jwk),
      body.challenge_id,
      body.signature,
    );
    if (!ok || !repos.consumeDeviceChallenge(body.challenge_id, body.browser_installation_id, body.host_id)) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const accountToken = context.req.header('x-gian-account-token');
    if (accountToken) accounts.rebindPairing(pairing.id, accountToken);
    const account = accounts.requirePairing(pairing.id);
    const refreshSecret = randomSecret();
    const family = repos.createRefreshFamily(body.browser_installation_id, `${'pending'}.${refreshSecret}`);
    const cookie = `${family.id}.${refreshSecret}`;
    repos.db.prepare('UPDATE device_sessions SET current_refresh_hash = ? WHERE id = ?')
      .run(hashSecret(cookie), family.id);
    db.prepare('UPDATE device_sessions SET account_peer_id = ? WHERE id = ?').run(account.installation_id, family.id);
    const access = tokens.issue({
      role: 'device',
      hostId: pairing.host_id,
      deviceId: pairing.id,
      familyId: family.id,
      accountPeerId: account.installation_id,
    });
    writeRefreshCookie(context, cookie, config.publicOrigin.startsWith('https://'), REFRESH_SLIDING_MS / 1000);
    let cryptoConnectionId = pairing.crypto_connection_id;
    if (!cryptoConnectionId) {
      cryptoConnectionId = generateCanonicalId();
      repos.setPairingCryptoConnectionId(pairing.id, cryptoConnectionId);
    }
    const enrolledHost = repos.getHost(pairing.host_id);
    if (!enrolledHost) return context.json(jsonError('AUTH_REQUIRED'), 401);
    return context.json({
      protocol: AUTH_PROTOCOL,
      access_token: access.token,
      expires_at: access.expiresAt,
      device_id: pairing.id,
      host_id: pairing.host_id,
      crypto_connection_id: cryptoConnectionId,
      host_public_key: JSON.parse(enrolledHost.public_key_jwk),
    });
  });

  app.post('/api/v1/sessions/refresh', async (context) => {
    const body = parseClosed(
      sessionRefreshRequestSchema,
      await context.req.json().catch(() => ({ protocol: AUTH_PROTOCOL })),
    );
    const cookie = readRefreshCookie(context);
    const family = authenticateRefreshCookie({
      accounts,
      repos,
      tokens,
      cookie,
      now: config.now(),
      revokeOnMismatch: true,
    });
    if (!family) {
      clearRefreshCookie(context, config.publicOrigin.startsWith('https://'));
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const nextSecret = randomSecret();
    const nextCookie = `${family.id}.${nextSecret}`;
    const rotated = repos.rotateRefresh(family.id, family.current_refresh_hash, nextCookie);
    if (!rotated) {
      repos.revokeFamily(family.id);
      tokens.revokeFamily(family.id);
      clearRefreshCookie(context, config.publicOrigin.startsWith('https://'));
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const pairings = repos.listPairingsForBrowser(family.browser_installation_id)
      .filter((row) => row.confirmed_at && !row.revoked_at
        && row.account_peer_id === family.account_peer_id && accounts.pairingAllowed(row.id));
    const pairing = body.host_id
      ? pairings.find((row) => row.host_id === body.host_id)
      : pairings.length === 1
        ? pairings[0]
        : undefined;
    writeRefreshCookie(context, nextCookie, config.publicOrigin.startsWith('https://'), REFRESH_SLIDING_MS / 1000);
    if (!pairing) {
      return context.json(jsonError(body.host_id ? 'DEVICE_NOT_PAIRED' : 'AUTH_REQUIRED'), 401);
    }
    const access = tokens.issue({
      role: 'device',
      hostId: pairing.host_id,
      deviceId: pairing.id,
      familyId: family.id,
      accountPeerId: family.account_peer_id!,
    });
    return context.json({
      protocol: AUTH_PROTOCOL,
      access_token: access.token,
      expires_at: access.expiresAt,
    });
  });

  app.post('/api/v1/sessions/logout', async (context) => {
    parseClosed(sessionLogoutRequestSchema, await context.req.json().catch(() => ({ protocol: AUTH_PROTOCOL })));
    const cookie = readRefreshCookie(context);
    const family = authenticateRefreshCookie({
      accounts,
      repos,
      tokens,
      cookie,
      now: config.now(),
      revokeOnMismatch: false,
    });
    if (family) {
      repos.revokeFamily(family.id);
      tokens.revokeFamily(family.id);
    }
    clearRefreshCookie(context, config.publicOrigin.startsWith('https://'));
    return context.json({ protocol: AUTH_PROTOCOL, ok: true });
  });

  app.post('/api/v1/ws-tickets', async (context) => {
    if (!originAllowed(config, context.req.header('origin'))) {
      return context.json(jsonError('AUTH_REQUIRED'), 403);
    }
    const device = requireDevice(context);
    if (!device) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const body = parseClosed(wsTicketRequestSchema, await context.req.json());
    const pairing = repos.getPairing(device.deviceId!);
    if (!pairing || pairing.host_id !== body.host_id || repos.isDeviceRouteClosed(pairing.id)) {
      return context.json(jsonError('DEVICE_REVOKED'), 401);
    }
    const ticket = randomSecret();
    const created = repos.createWsTicket({
      role: 'device',
      hostId: body.host_id,
      deviceId: pairing.id,
      familyId: device.familyId,
      ticket,
    });
    return context.json({
      protocol: AUTH_PROTOCOL,
      ticket,
      expires_at: created.expires_at,
    });
  });

  const signedRevokeNotice = (input: {
    hostId: string;
    deviceId: string;
    signedAt: number;
    signature: string;
    publicKeyJwk: string;
  }) => parseClosed(relayNoticeSchema, {
    protocol: 'gian.relay/1',
    type: 'device.revoked',
    host_id: input.hostId,
    device_id: input.deviceId,
    signed_at: input.signedAt,
    signature: input.signature,
    device_public_key: JSON.parse(input.publicKeyJwk),
    sent_at: config.now(),
  });

  const finalizeDeviceRevoke = (hostId: string, deviceId: string): void => {
    const pairing = repos.getPairing(deviceId);
    if (!pairing || pairing.host_id !== hostId) return;
    if (!pairing.revoked_at) repos.revokePairing(pairing.id);
    else repos.recordRevokedKey(pairing);
    relay.closeDevice(hostId, deviceId);
    tokens.revokeDevice(deviceId);
    const remaining = repos.listPairingsForBrowser(pairing.browser_installation_id)
      .filter((row) => row.confirmed_at && !row.revoked_at);
    if (remaining.length === 0) {
      repos.revokeBrowserFamilies(pairing.browser_installation_id);
    }
    repos.markTombstoneDeliveredFor(hostId, deviceId);
  };

  app.post('/api/v1/host/devices/:id/revoke', async (context) => {
    const hostAuth = requireHost(context);
    if (!hostAuth) return context.json(jsonError('AUTH_REQUIRED'), 401);
    parseClosed(hostRevokeDeviceRequestSchema, await context.req.json().catch(() => ({ protocol: AUTH_PROTOCOL })));
    const deviceId = context.req.param('id');
    const pairing = repos.getPairing(deviceId);
    if (!pairing || pairing.host_id !== hostAuth.hostId) {
      return context.json(jsonError('DEVICE_NOT_PAIRED'), 401);
    }
    finalizeDeviceRevoke(hostAuth.hostId, pairing.id);
    return context.json({
      protocol: AUTH_PROTOCOL,
      host_id: hostAuth.hostId,
      device_id: pairing.id,
      status: 'revoked',
    });
  });

  app.delete('/api/v1/hosts/:host_id/pairing', async (context) => {
    const body = parseClosed(selfRevokeRequestSchema, await context.req.json());
    const hostId = context.req.param('host_id');
    if (body.host_id !== hostId) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const device = requireDevice(context);
    const replayed = repos.findTombstoneBySignature(hostId, body.signature);
    const pairing = device?.deviceId
      ? repos.getPairing(device.deviceId)
      : replayed
        ? repos.getPairing(replayed.device_id)
        : undefined;
    if (!pairing || pairing.host_id !== hostId) return context.json(jsonError('DEVICE_NOT_PAIRED'), 401);
    if (device && (device.hostId !== hostId || device.deviceId !== pairing.id)) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    if (!device && !replayed) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const now = config.now();
    if (body.signed_at - now > AUTH_SIGNED_AT_SKEW_MS || now - body.signed_at > AUTH_SIGNED_AT_SKEW_MS) {
      return context.json(jsonError('AUTH_REQUIRED'), 401);
    }
    const ok = await verifyP256Signature(
      JSON.parse(pairing.public_key_jwk),
      selfRevokePayload({ hostId, deviceId: pairing.id, signedAt: body.signed_at }),
      body.signature,
    );
    if (!ok) return context.json(jsonError('AUTH_REQUIRED'), 401);
    repos.insertTombstone({
      hostId,
      deviceId: pairing.id,
      signedAt: body.signed_at,
      signature: body.signature,
      publicKeyJwk: pairing.public_key_jwk,
    });
    const notice = signedRevokeNotice({
      hostId,
      deviceId: pairing.id,
      signedAt: body.signed_at,
      signature: body.signature,
      publicKeyJwk: pairing.public_key_jwk,
    });
    if (pairing.revoked_at) {
      return context.json({
        protocol: AUTH_PROTOCOL,
        host_id: hostId,
        status: 'tombstoned',
      });
    }
    if (relay.hasHost(hostId)) {
      relay.closeDevice(hostId, pairing.id);
      relay.notifyHost(hostId, notice);
      return context.json({
        protocol: AUTH_PROTOCOL,
        host_id: hostId,
        status: 'pending_host',
      });
    }
    relay.closeDevice(hostId, pairing.id);
    tokens.revokeDevice(pairing.id);
    return context.json({
      protocol: AUTH_PROTOCOL,
      host_id: hostId,
      status: 'tombstoned',
    });
  });

  const hostsForFamily = (family: NonNullable<ReturnType<RemoteRepositories['getSession']>>) => (
    repos.listPairingsForBrowser(family.browser_installation_id)
      .filter((row) => row.confirmed_at && !row.revoked_at
        && row.account_peer_id === family.account_peer_id && accounts.pairingAllowed(row.id))
      .map((row) => {
        const host = repos.getHost(row.host_id);
        return {
          host_id: row.host_id,
          name: host?.name ?? 'host',
          online: presence.isOnline(row.host_id),
          pairing_status: 'confirmed' as const,
        };
      })
  );

  app.get('/api/v1/me', (context) => {
    const family = authenticateRefreshCookie({
      accounts,
      repos,
      tokens,
      cookie: readRefreshCookie(context),
      now: config.now(),
      revokeOnMismatch: false,
    });
    if (!family) return context.json(jsonError('AUTH_REQUIRED'), 401);
    return context.json({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: family.browser_installation_id,
      hosts: hostsForFamily(family),
    });
  });

  app.get('/api/v1/hosts', (context) => {
    const family = authenticateRefreshCookie({
      accounts,
      repos,
      tokens,
      cookie: readRefreshCookie(context),
      now: config.now(),
      revokeOnMismatch: false,
    });
    if (!family) return context.json(jsonError('AUTH_REQUIRED'), 401);
    return context.json({ protocol: AUTH_PROTOCOL, hosts: hostsForFamily(family) });
  });

  app.post('/api/v1/host/profile', async (context) => {
    const hostAuth = requireHost(context);
    if (!hostAuth) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const body = parseClosed(hostUpdateProfileRequestSchema, await context.req.json());
    repos.renameHost(hostAuth.hostId, body.name);
    return context.json({ protocol: AUTH_PROTOCOL, host_id: hostAuth.hostId, name: body.name });
  });

  app.post('/api/v1/host/heartbeat', async (context) => {
    const hostAuth = requireHost(context);
    if (!hostAuth) return context.json(jsonError('AUTH_REQUIRED'), 401);
    parseClosed(hostHeartbeatRequestSchema, await context.req.json().catch(() => ({ protocol: AUTH_PROTOCOL })));
    const lease = presence.heartbeat(hostAuth.hostId);
    return context.json({ protocol: AUTH_PROTOCOL, lease_expires_at: lease });
  });

  app.post('/api/v1/host/ws-tickets', async (context) => {
    const hostAuth = requireHost(context);
    if (!hostAuth) return context.json(jsonError('AUTH_REQUIRED'), 401);
    const ticket = randomSecret();
    const created = repos.createWsTicket({
      role: 'host',
      hostId: hostAuth.hostId,
      ticket,
    });
    return context.json({
      protocol: AUTH_PROTOCOL,
      ticket,
      expires_at: created.expires_at,
    });
  });

  app.get('/ws', upgradeWebSocket(() => ({
    onMessage(event, ws) {
      if (shuttingDown) { ws.close(1001, 'server_shutdown'); return; }
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        const parsed = JSON.parse(raw) as { type?: string };
        if (parsed.type === 'ws.auth') {
          if ((ws as unknown as { __remoteConnectionId?: string }).__remoteConnectionId) {
            ws.close(4002, 'already_authenticated'); return;
          }
          const auth = parseClosed(relayWsAuthSchema, parsed);
          const ticket = repos.consumeWsTicket(auth.ticket);
          if (!ticket) {
            ws.close(4001, 'auth_required');
            return;
          }
          const route = { hostId: ticket.host_id, deviceId: ticket.device_id ?? undefined,
            familyId: ticket.family_id ?? undefined, close: () => ws.close(4001, 'account_required') };
          if (!routeAllowed(route)) { route.close(); return; }
          if (ticket.role === 'device') {
            const pairing = ticket.device_id ? repos.getPairing(ticket.device_id) : undefined;
            if (!pairing || pairing.revoked_at) {
              ws.close(4001, 'device_revoked');
              return;
            }
          } else {
            presence.heartbeat(ticket.host_id);
          }
          const connectionId = generateCanonicalId();
          const routeId = ticket.device_id ?? ticket.host_id;
          const peer: RelayPeer = {
            role: ticket.role,
            hostId: ticket.host_id,
            deviceId: ticket.device_id ?? undefined,
            routeId,
            connectionId,
            send(frame) {
              if (!routeAllowed(route)) { route.close(); return; }
              ws.send(JSON.stringify(frame));
            },
            close(reason) {
              ws.close(4003, reason);
            },
          };
          const socketState = ws as unknown as {
            __remoteConnectionId?: string;
            __remoteRole?: string;
            __remoteHostId?: string;
          };
          socketState.__remoteConnectionId = connectionId;
          socketState.__remoteRole = ticket.role;
          socketState.__remoteHostId = ticket.host_id;
          liveRoutes.set(connectionId, route);
          relay.attach(peer);
          ws.send(JSON.stringify({
            protocol: 'gian.relay/1',
            type: 'ws.bound',
            host_id: ticket.host_id,
            device_id: ticket.device_id ?? undefined,
            route_id: routeId,
            connection_id: connectionId,
            sent_at: config.now(),
          }));
          if (ticket.role === 'host') {
            relay.notifyDevices(ticket.host_id, parseClosed(relayNoticeSchema, {
              protocol: 'gian.relay/1',
              type: 'host.online',
              host_id: ticket.host_id,
              sent_at: config.now(),
            }));
            for (const tombstone of repos.pendingTombstones(ticket.host_id)) {
              if (!tombstone.signature || !tombstone.public_key_jwk) continue;
              ws.send(JSON.stringify(signedRevokeNotice({
                hostId: tombstone.host_id,
                deviceId: tombstone.device_id,
                signedAt: tombstone.signed_at,
                signature: tombstone.signature,
                publicKeyJwk: tombstone.public_key_jwk,
              })));
            }
          }
          return;
        }
        const socketState = ws as unknown as {
          __remoteConnectionId?: string;
          __remoteRole?: string;
          __remoteHostId?: string;
        };
        const connectionId = socketState.__remoteConnectionId;
        if (!connectionId) {
          ws.close(4001, 'auth_required');
          return;
        }
        const route = liveRoutes.get(connectionId);
        if (!route || !routeAllowed(route)) { ws.close(4001, 'account_required'); return; }
        if (parsed.type === 'crypto.offer' || parsed.type === 'crypto.accept') {
          relay.handleHandshake(connectionId, parseRelayHandshake(parsed));
          return;
        }
        if (parsed.type === 'device.revoked.ack') {
          const notice = parseClosed(relayNoticeSchema, parsed);
          if (socketState.__remoteRole !== 'host' || !notice.device_id || notice.host_id !== socketState.__remoteHostId) {
            ws.close(4002, 'invalid_frame');
            return;
          }
          finalizeDeviceRevoke(notice.host_id, notice.device_id);
          return;
        }
        parseRelayFrame(parsed);
        relay.handleFrame(connectionId, parsed);
      } catch (error) {
        logError(config.logger, error);
        const code = error instanceof RemoteProtocolError && error.code === 'HOST_OFFLINE' ? 4004 : 4002;
        ws.close(code, error instanceof RemoteProtocolError ? error.code : 'invalid_frame');
      }
    },
    onClose(_event, ws) {
      if (shuttingDown) return;
      const socketState = ws as unknown as {
        __remoteConnectionId?: string;
        __remoteRole?: string;
        __remoteHostId?: string;
      };
      const connectionId = socketState.__remoteConnectionId;
      if (connectionId) { relay.detach(connectionId); liveRoutes.delete(connectionId); }
      // A replaced Host socket must not mark the host offline while its
      // successor is already bound.
      if (
        socketState.__remoteRole === 'host'
        && socketState.__remoteHostId
        && !relay.hasHost(socketState.__remoteHostId)
      ) {
        presence.expire(socketState.__remoteHostId);
        relay.notifyDevices(socketState.__remoteHostId, parseClosed(relayNoticeSchema, {
          protocol: 'gian.relay/1',
          type: 'host.offline',
          host_id: socketState.__remoteHostId,
          sent_at: config.now(),
        }));
      }
    },
  })));

  app.get('/__gian_remote_runtime.js', (context) => {
    if (!manifest) return context.body('not found', 404);
    return serveRuntimeConfig(context, config.publicOrigin, manifest.build_id);
  });

  app.get('/*', (context) => {
    if (!config.staticDir || !manifest) return context.body('not found', 404);
    const served = serveStaticArtifact(context, config.staticDir, manifest);
    return served ?? context.body('not found', 404);
  });

  app.onError((error, context) => {
    logError(config.logger, error);
    if (error instanceof GitHubUpstreamError) {
      context.header('Retry-After', String(error.retryAfterSeconds));
      return context.json({ error: { code: 'UPSTREAM_FAILED' } }, 503);
    }
    if (error instanceof RemoteProtocolError) {
      return context.json(jsonError(error.code), error.code === 'AUTH_REQUIRED' ? 401 : 400);
    }
    return context.json(jsonError('INVALID_FRAME'), 400);
  });

  return {
    app,
    services: { ...services, finalizeDeviceRevoke } satisfies RemoteAppServices,
    injectWebSocket,
    shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(accountLeaseTimer);
      accountLogin.close();
      closeEnrollment();
      accounts.close();
      for (const route of liveRoutes.values()) route.close();
      liveRoutes.clear();
      relay.restart();
      db.close();
    },
  };
}
