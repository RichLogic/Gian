import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export const DESKTOP_TOKEN_HEADER = 'X-Gian-Desktop-Token';

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
export function requireDesktopClient(
  expectedToken = process.env['GIAN_DESKTOP_TOKEN']?.trim() ?? '',
  expectedOrigin?: string,
): MiddlewareHandler {
  return async (context, next) => {
    if (!expectedToken) {
      await next();
      return;
    }

    const supplied = context.req.header(DESKTOP_TOKEN_HEADER) ?? '';
    if (!safeEqual(supplied, expectedToken)) {
      return context.json({ error: 'desktop_client_required' }, 401);
    }

    const path = new URL(context.req.url).pathname;
    if (path === '/ws' && expectedOrigin) {
      const origin = context.req.header('origin') ?? '';
      if (origin !== expectedOrigin) {
        return context.json({ error: 'desktop_origin_required' }, 403);
      }
    }

    await next();
  };
}
