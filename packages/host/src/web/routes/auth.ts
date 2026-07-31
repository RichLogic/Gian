import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { AUTH_REQUIRED } from '../../auth/middleware.js';
import { hashPassword, verifyPassword } from '../../auth/passwords.js';
import {
  createSessionToken,
  deleteToken,
  getUsernameForToken,
} from '../../auth/tokens.js';
import {
  loadConfig,
  loadPasswordHash,
  saveConfig,
  savePasswordHash,
} from '../../storage/config.js';
import type { Db } from '../../storage/db.js';

function requestToken(cookie: string, authorization: string): string {
  const cookieToken = cookie.match(/(?:^|;\s*)gian_session=([^;]+)/)?.[1] ?? '';
  const bearerToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';
  return cookieToken || bearerToken;
}

export function ensureAuthConfigured(db: Db): void {
  const envUsername = process.env['GIAN_AUTH_USERNAME'];
  const envPassword = process.env['GIAN_AUTH_PASSWORD'];

  if (envUsername) saveConfig(db, { auth_username: envUsername });
  if (envPassword) {
    void hashPassword(envPassword).then(hash => savePasswordHash(db, hash));
    return;
  }
  if (loadPasswordHash(db)) return;

  const plain = randomBytes(12).toString('base64url');
  void hashPassword(plain).then(hash => {
    savePasswordHash(db, hash);
    console.log(`[gian] initial password: ${plain}`);
  });
}

export function registerAuthRoutes(app: Hono, db: Db): void {
  app.post('/api/auth/login', async c => {
    const body = await c.req.json<{ username?: string; password?: string }>();
    const username = loadConfig(db).auth_username || 'admin';
    if (!body.username || !body.password) {
      return c.json({ error: 'username and password required' }, 400);
    }
    if (body.username !== username) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    const storedHash = loadPasswordHash(db);
    if (!storedHash || !await verifyPassword(body.password, storedHash)) {
      return c.json({ error: 'invalid credentials' }, 401);
    }
    const token = await createSessionToken(username);
    setCookie(c, 'gian_session', token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    });
    return c.json({ user: username });
  });

  app.get('/api/auth/me', c => {
    if (!AUTH_REQUIRED) {
      return c.json({ user: loadConfig(db).auth_username || 'dev' });
    }
    const token = requestToken(
      c.req.header('cookie') ?? '',
      c.req.header('Authorization') ?? '',
    );
    const username = token ? getUsernameForToken(token) : null;
    return username
      ? c.json({ user: username })
      : c.json({ error: 'unauthorized' }, 401);
  });

  app.get('/api/auth/ws-token', c => {
    if (!AUTH_REQUIRED) return c.json({ token: 'dev-token' });
    const token = requestToken(
      c.req.header('cookie') ?? '',
      c.req.header('Authorization') ?? '',
    );
    if (!token || !getUsernameForToken(token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ token });
  });

  app.post('/api/auth/logout', c => {
    const token = requestToken(
      c.req.header('cookie') ?? '',
      c.req.header('Authorization') ?? '',
    );
    if (token) deleteToken(token);
    deleteCookie(c, 'gian_session', { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/api/auth/password', async c => {
    if (!AUTH_REQUIRED) return c.json({ error: 'auth not enabled' }, 400);
    const body = await c.req.json<{
      current_password?: string;
      new_password?: string;
    }>();
    if (!body.current_password || !body.new_password) {
      return c.json({ error: 'current_password and new_password required' }, 400);
    }
    const storedHash = loadPasswordHash(db);
    if (!storedHash || !await verifyPassword(body.current_password, storedHash)) {
      return c.json({ error: 'invalid current password' }, 401);
    }
    savePasswordHash(db, await hashPassword(body.new_password));
    return c.json({ ok: true });
  });
}
