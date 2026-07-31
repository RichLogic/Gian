import type { MiddlewareHandler } from 'hono';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveWebDistDir(): string | null {
  const override = process.env['GIAN_WEB_DIST'];
  if (override) return override;
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    resolve(here, '../../../web/dist'),
    resolve(here, '../../web/dist'),
  ];
  return candidates.find(dir => existsSync(resolve(dir, 'index.html'))) ?? null;
}

export function staticFiles(rootDir: string): MiddlewareHandler {
  const rootReal = resolve(rootDir);
  return async (context, next) => {
    if (context.req.method !== 'GET' && context.req.method !== 'HEAD') return next();
    const requestPath = new URL(context.req.url).pathname;
    if (requestPath.startsWith('/api/') || requestPath === '/ws' || requestPath === '/health') {
      return next();
    }
    const relativePath = requestPath.replace(/^\/+/, '');
    const target = resolve(rootReal, relativePath || 'index.html');
    if (target !== rootReal && !target.startsWith(rootReal + sep)) return next();

    const tryRead = async (path: string) => {
      const info = await stat(path);
      return info.isDirectory() ? readFile(resolve(path, 'index.html')) : readFile(path);
    };
    try {
      return context.body(new Uint8Array(await tryRead(target)), 200, contentTypeFor(target));
    } catch {
      try {
        const body = await readFile(resolve(rootReal, 'index.html'));
        return context.body(new Uint8Array(body), 200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      } catch {
        return next();
      }
    }
  };
}

function contentTypeFor(path: string): Record<string, string> {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
  };
  return { 'Content-Type': types[extension] ?? 'application/octet-stream' };
}
