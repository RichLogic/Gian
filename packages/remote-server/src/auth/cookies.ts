import { type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const REFRESH_COOKIE = 'gian_remote_refresh';

export function readRefreshCookie(context: Context): string | undefined {
  return getCookie(context, REFRESH_COOKIE);
}

export function writeRefreshCookie(context: Context, token: string, secure: boolean, maxAgeSec: number): void {
  setCookie(context, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: maxAgeSec,
  });
}

export function clearRefreshCookie(context: Context, secure: boolean): void {
  deleteCookie(context, REFRESH_COOKIE, {
    path: '/',
    secure,
    httpOnly: true,
    sameSite: 'Strict',
  });
}
