import type { Hono } from 'hono';
import { constants, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Db } from '../../storage/db.js';
import { runGit } from '../../workspace/async-command.js';
import {
  fileReadFailure,
  isLikelyBinary,
  readBoundedFile,
} from '../../workspace/bounded-file.js';
import { resolveWithinWorkspace } from '../../workspace/safe-path.js';

type FileEntry = Stats;

class ClaudeMdPathConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeMdPathConflictError';
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function optionalLstat(path: string): Promise<FileEntry | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function assertClaudeMdRegularFile(entry: FileEntry): void {
  if (entry.isSymbolicLink()) {
    throw new ClaudeMdPathConflictError(
      'CLAUDE.md symlinks are not supported; replace it with a regular file before editing',
    );
  }
  if (!entry.isFile()) {
    throw new Error('CLAUDE.md is a directory or another non-regular file');
  }
}

function sameFileIdentity(left: FileEntry, right: FileEntry): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readClaudeMdNoFollow(target: string): Promise<string | null> {
  const before = await optionalLstat(target);
  if (!before) return null;
  assertClaudeMdRegularFile(before);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (hasErrnoCode(error, 'ELOOP')) {
      throw new ClaudeMdPathConflictError('CLAUDE.md changed to a symlink while opening');
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new ClaudeMdPathConflictError('CLAUDE.md changed while opening; retry the read');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    await handle.sync();
  } catch (error) {
    // Windows cannot fsync a directory handle. The temporary file itself was
    // already fsynced before rename, so only skip this unsupported final step.
    if (process.platform === 'win32'
      && ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].some(code => hasErrnoCode(error, code))) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeClaudeMdAtomic(workspace: string, content: string): Promise<void> {
  // Rows created before workspace-path canonicalization may still contain a
  // directory symlink. Resolve it once and use that stable directory for the
  // entire transaction: O_NOFOLLOW should protect CLAUDE.md itself, not turn
  // a legitimate legacy workspace alias into a post-publish fsync failure.
  const canonicalWorkspace = await realpath(workspace);
  const target = resolve(canonicalWorkspace, 'CLAUDE.md');
  const before = await optionalLstat(target);
  if (before) assertClaudeMdRegularFile(before);

  const temporary = resolve(canonicalWorkspace, `.CLAUDE.md.gian-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let published = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      before ? before.mode & 0o777 : 0o666,
    );
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    const current = await optionalLstat(target);
    if (current) assertClaudeMdRegularFile(current);
    if ((before === null) !== (current === null)
      || (before !== null && current !== null && !sameFileIdentity(before, current))) {
      throw new ClaudeMdPathConflictError('CLAUDE.md changed while saving; reload and retry');
    }

    await rename(temporary, target);
    published = true;
    await syncDirectory(canonicalWorkspace);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

export function registerWorkspaceFileRoutes(
  app: Hono,
  db: Db,
): void {
  app.get('/api/workspaces/:id/tree', async c => {
    const relativePath = c.req.query('path') ?? '';
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const target = await resolveWithinWorkspace(workspace, relativePath);
    if (!target) return c.json({ error: 'path escapes workspace' }, 400);
    try {
      const entries = await readdir(target, { withFileTypes: true });
      return c.json(entries
        .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' as const : 'file' as const,
          path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
        }))
        .sort((left, right) => {
          if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
          return left.name.localeCompare(right.name);
        }));
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
  });

  app.get('/api/workspaces/:id/file', async c => {
    const relativePath = c.req.query('path') ?? '';
    if (!relativePath) return c.json({ error: 'path required' }, 400);
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const target = await resolveWithinWorkspace(workspace, relativePath);
    if (!target) return c.json({ error: 'path escapes workspace' }, 400);
    try {
      const bytes = await readBoundedFile(target, 1024 * 1024);
      if (isLikelyBinary(bytes)) {
        return c.json({ error: 'binary file; use raw endpoint' }, 415);
      }
      return c.json({
        path: relativePath,
        size: bytes.length,
        content: bytes.toString('utf8'),
      });
    } catch (error) {
      const failure = fileReadFailure(error);
      return c.json({ error: failure.error }, failure.status);
    }
  });

  app.get('/api/workspaces/:id/diff', async c => {
    const relativePath = c.req.query('path') ?? '';
    if (!relativePath) return c.json({ error: 'path required' }, 400);
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!await resolveWithinWorkspace(workspace, relativePath)) {
      return c.json({ error: 'path escapes workspace' }, 400);
    }
    return c.json({ diff: await computeWorkspaceFileDiff(workspace, relativePath) });
  });

  app.get('/api/workspaces/:id/claude_md', async c => {
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    try {
      const content = await readClaudeMdNoFollow(resolve(workspace, 'CLAUDE.md'));
      if (content !== null) return c.json({ content });

      const workspaceEntry = await stat(workspace);
      if (!workspaceEntry.isDirectory()) {
        throw new Error('workspace path is not a directory');
      }
      return c.json({ content: '' });
    } catch (error) {
      return c.json(
        { error: String(error) },
        error instanceof ClaudeMdPathConflictError ? 409 : 500,
      );
    }
  });

  app.put('/api/workspaces/:id/claude_md', async c => {
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }
    try {
      await writeClaudeMdAtomic(workspace, body.content);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: String(error) },
        error instanceof ClaudeMdPathConflictError ? 409 : 500,
      );
    }
  });

  app.get('/api/workspaces/:id/file_meta', async c => {
    const relativePath = c.req.query('path') ?? '';
    if (!relativePath) return c.json({ error: 'path required' }, 400);
    const workspace = workspacePath(db, c.req.param('id'));
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!await resolveWithinWorkspace(workspace, relativePath)) {
      return c.json({ error: 'path escapes workspace' }, 400);
    }

    let uncommitted = false;
    try {
      uncommitted = (await runGit(
        ['status', '--porcelain', '--', relativePath],
        { cwd: workspace, timeoutMs: 5_000 },
      )).stdout.trim().length > 0;
    } catch {
      // Non-git workspaces simply have no git status.
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 19).replace('T', ' ');
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM events
       WHERE (type = 'file_change'
              OR (json_valid(data) AND json_extract(data, '$.display.type') = 'activity.file-change'))
         AND data LIKE ? AND created_at >= ?`,
    ).get(`%"path":"${relativePath}"%`, todayIso) as { n: number };
    return c.json({ uncommitted, edit_count_today: row.n });
  });
}

async function computeWorkspaceFileDiff(cwd: string, relativePath: string): Promise<string> {
  try {
    const diff = (await runGit(
      ['diff', 'HEAD', '--', relativePath],
      { cwd, timeoutMs: 5_000 },
    )).stdout;
    if (diff) return diff;
  } catch {
    return '';
  }
  try {
    await runGit(
      ['ls-files', '--error-unmatch', '--', relativePath],
      { cwd, timeoutMs: 5_000 },
    );
    return '';
  } catch {
    try {
      const result = await runGit(
        ['diff', '--no-index', '--', '/dev/null', relativePath],
        { cwd, timeoutMs: 5_000, acceptableExitCodes: [0, 1] },
      );
      if (result.exitCode === 1) return result.stdout;
      return '';
    } catch {
      return '';
    }
  }
}

function workspacePath(db: Db, id: string): string | null {
  const row = db.prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(id) as { path: string } | undefined;
  return row?.path ?? null;
}
