import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';

import { type Context } from 'hono';

import { type StaticManifest } from './manifest.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function serveStaticArtifact(
  context: Context,
  staticDir: string,
  manifest: StaticManifest,
): Response | null {
  const urlPath = context.req.path === '/' || context.req.path === '/enrollment' ? '/index.html' : context.req.path;
  const relativePath = urlPath.replace(/^\//, '');
  if (!manifest.files[relativePath]) return null;
  const absolute = normalize(join(staticDir, relativePath));
  if (relative(staticDir, absolute).split(sep).includes('..') || !existsSync(absolute)) {
    return context.body('not found', 404);
  }
  let body = readFileSync(absolute);
  if (relativePath === 'index.html') {
    const html = body.toString('utf8').replace(
      '</head>',
      '<script src="/__gian_remote_runtime.js"></script></head>',
    );
    body = Buffer.from(html);
  }
  return context.body(body, 200, {
    'Content-Type': TYPES[extname(relativePath)] ?? 'application/octet-stream',
  });
}

export function serveRuntimeConfig(
  context: Context,
  publicOrigin: string,
  buildId: string,
): Response {
  const body = `window.__GIAN_REMOTE__=${JSON.stringify({ publicOrigin, buildId })};`;
  return context.body(body, 200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}
