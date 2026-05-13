import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getUsernameForToken } from './tokens.js';

const AUTH_REQUIRED = process.env['GIAN_AUTH_REQUIRED'] === 'true';

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/me',
  '/health',
  '/ws',
]);

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (!AUTH_REQUIRED) {
      await next();
      return;
    }

    const path = new URL(c.req.url).pathname;
    if (PUBLIC_PATHS.has(path)) {
      await next();
      return;
    }

    const cookie = getCookie(c, 'gian_session');
    if (cookie && getUsernameForToken(cookie) !== null) {
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (getUsernameForToken(token) !== null) {
        await next();
        return;
      }
    }

    return c.json({ error: 'unauthorized' }, 401);
  };
}

export { AUTH_REQUIRED };
