import type { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { Db } from '../../storage/db.js';
import { resolveDataDir } from '../../storage/paths.js';
import {
  fileReadFailure,
  isLikelyBinary,
  readBoundedFile,
} from '../../workspace/bounded-file.js';
import {
  buildRawPreviewHeaders,
  RAW_PREVIEW_MAX_BYTES,
} from '../../workspace/preview-headers.js';
import { resolveWithinWorkspace } from '../../workspace/safe-path.js';
import { respondResolvedOpen } from '../open-launch.js';
import { runOpen, type OpenCommand } from '../open-with.js';
import type { ApplicationRouteOptions } from './applications.js';

const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

export interface AbsoluteFileRouteOptions extends ApplicationRouteOptions {
  dataDir?: string;
}

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

export function attachmentsRoot(dataDir: string): string {
  return resolve(dataDir, 'attachments');
}

/** OS Open is narrower than preview: only a regular file under the Gian
 *  attachments directory, after symlink resolution. */
export async function resolveAttachmentOpenPath(
  raw: string,
  dataDir: string,
): Promise<string | null> {
  if (!raw || !isAbsolute(raw)) return null;
  const root = attachmentsRoot(dataDir);
  const normalized = resolve(raw);
  const rel = relative(root, normalized);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolveWithinWorkspace(root, rel || '.');
}

export function registerAbsoluteFileRoutes(
  app: Hono,
  db: Db,
  options: AbsoluteFileRouteOptions = {},
): void {
  const dataDir = options.dataDir ?? resolveDataDir();
  const platform = options.platform ?? process.platform;
  const runOpenSync = options.runOpenSync ?? ((command: OpenCommand) => {
    execFileSync(command.command, command.argv, { timeout: 5000, stdio: 'ignore' });
  });
  const runOpenDetached = options.runOpen ?? runOpen;

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

  app.post('/api/files/open', async c => {
    let body: { path?: string; editor_id?: string; app?: string; builtin?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path required' }, 400);
    }
    if (!isAbsolute(body.path)) {
      return c.json({ error: 'absolute path required' }, 400);
    }
    const absPath = await resolveAttachmentOpenPath(body.path, dataDir);
    if (!absPath) {
      return c.json({ error: 'path outside attachments' }, 400);
    }
    try {
      const st = statSync(absPath);
      if (!st.isFile()) return c.json({ error: 'not a file' }, 400);
    } catch {
      return c.json({ error: 'file not found' }, 404);
    }
    return respondResolvedOpen(c, absPath, body, {
      platform,
      db,
      runOpenSync,
      runOpenDetached,
    });
  });
}
