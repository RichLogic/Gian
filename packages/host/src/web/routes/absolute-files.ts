import type { Hono } from 'hono';
import { isAbsolute, resolve } from 'node:path';
import {
  fileReadFailure,
  isLikelyBinary,
  readBoundedFile,
} from '../../workspace/bounded-file.js';
import {
  buildRawPreviewHeaders,
  RAW_PREVIEW_MAX_BYTES,
} from '../../workspace/preview-headers.js';

const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * Preview an absolute path the user already clicked. Working-tree routes stay
 * scoped with resolveWithinWorkspace; this pair exists so Files can still
 * render attachments and other regular files that sit outside every
 * registered root.
 */
export function resolveAbsolutePreviewPath(raw: string): string | null {
  if (!raw || !isAbsolute(raw)) return null;
  return resolve(raw);
}

export function registerAbsoluteFileRoutes(app: Hono): void {
  app.get('/api/files/content', async c => {
    const raw = c.req.query('path') ?? '';
    if (!raw) return c.json({ error: 'path required' }, 400);
    const target = resolveAbsolutePreviewPath(raw);
    if (!target) return c.json({ error: 'absolute path required' }, 400);
    try {
      const bytes = await readBoundedFile(target, TEXT_PREVIEW_MAX_BYTES);
      if (isLikelyBinary(bytes)) {
        return c.json({ error: 'binary file; use raw endpoint' }, 415);
      }
      return c.json({
        path: target,
        size: bytes.length,
        content: bytes.toString('utf8'),
      });
    } catch (error) {
      const failure = fileReadFailure(error);
      return c.json({ error: failure.error }, failure.status);
    }
  });

  app.get('/api/files/raw', async c => {
    const raw = c.req.query('path') ?? '';
    if (!raw) return c.json({ error: 'path required' }, 400);
    const target = resolveAbsolutePreviewPath(raw);
    if (!target) return c.json({ error: 'absolute path required' }, 400);
    try {
      const bytes = await readBoundedFile(target, RAW_PREVIEW_MAX_BYTES);
      const { headers } = buildRawPreviewHeaders({ rel: target, size: bytes.length });
      return new Response(new Uint8Array(bytes), { status: 200, headers });
    } catch (error) {
      const failure = fileReadFailure(error);
      return c.json({ error: failure.error }, failure.status);
    }
  });
}
