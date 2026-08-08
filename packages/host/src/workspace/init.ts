import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { scaffoldAiDir } from './ai-scaffold.js';
import {
  CommandExecutionError,
  commandErrorMessage,
  GitQueueFullError,
  runGit,
} from './async-command.js';

export interface InitWorkspaceInput {
  /** Absolute path on disk where the workspace should live. */
  path: string;
  /** Optional git remote URL — if provided, clone into `path` instead of mkdir+init. */
  gitRemote?: string;
  /** Display name (used for the default CLAUDE.md heading). */
  name: string;
  /** Adopt an existing path as-is: skip mkdir/clone/git-init AND skip the
   *  default CLAUDE.md / AGENTS.md scaffolding — adopting is a read-only
   *  registration; we don't write into the user's existing project. */
  adopt?: boolean;
  signal?: AbortSignal;
}

export interface InitWorkspaceResult {
  ok: boolean;
  /** Free-form notes about what was done — surfaced in the response. */
  notes: string[];
  error?: string;
  errorStatus?: 400 | 500 | 503 | 504;
}

class WorkspaceTargetConflictError extends Error {
  constructor(path: string) {
    super(`workspace target appeared during initialization: ${path}`);
    this.name = 'WorkspaceTargetConflictError';
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Provision a new workspace directory:
 *   1. mkdir + git clone (or git init)
 *   2. ensure CLAUDE.md exists with default content
 *   3. symlink AGENTS.md → CLAUDE.md when AGENTS.md isn't already present
 *
 * Idempotent on the parent — fails if the target dir is already non-empty
 * (we don't want to clobber an existing project the user has there).
 *
 * Adopt mode (`adopt: true`) is registration-only: it validates the existing
 * directory but never creates or changes files inside it. Gian-managed
 * scaffolding is reserved for freshly provisioned workspaces.
 */
export async function initWorkspace(input: InitWorkspaceInput): Promise<InitWorkspaceResult> {
  const notes: string[] = [];
  const target = resolve(input.path);
  let stagingPath: string | null = null;
  let targetEntry: Awaited<ReturnType<typeof lstat>> | null;
  try {
    targetEntry = await lstat(target);
  } catch (error) {
    if (!isMissingPathError(error)) {
      return {
        ok: false,
        notes,
        error: `workspace path check failed: ${commandErrorMessage(error, 'path check failed')}`,
        errorStatus: 500,
      };
    }
    targetEntry = null;
  }
  const targetExisted = targetEntry !== null;

  if (input.adopt) {
    try {
      if (!(await stat(target)).isDirectory()) {
        return { ok: false, notes, error: `path is not a directory: ${target}` };
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return { ok: false, notes, error: `path does not exist: ${target}` };
      }
      return {
        ok: false,
        notes,
        error: `workspace path check failed: ${commandErrorMessage(error, 'path check failed')}`,
        errorStatus: 500,
      };
    }
    if (input.gitRemote) {
      return { ok: false, notes, error: 'git_remote is not allowed when adopting an existing path' };
    }
    notes.push(`adopted existing path: ${target}`);
    return { ok: true, notes };
  }

  if (targetEntry) {
    if (!targetEntry.isDirectory()) {
      return { ok: false, notes, error: `path is not a directory: ${target}` };
    }
    const entries = await readdir(target);
    const meaningful = entries.filter(e => e !== '.DS_Store');
    if (meaningful.length > 0) {
      return { ok: false, notes, error: `path already exists and is non-empty: ${target}` };
    }
  }

  // A fresh target is provisioned completely in a Gian-owned sibling and
  // published with one atomic rename. This covers both clone and git init:
  // timeout/failure cannot strand a partial .git directory at the requested
  // path, while a pre-existing empty directory remains user-owned.
  let provisionPath = target;
  try {
    if (!targetExisted) {
      const parent = resolve(target, '..');
      await mkdir(parent, { recursive: true });
      stagingPath = await mkdtemp(join(parent, `.${basename(target)}.gian-init-`));
      provisionPath = stagingPath;
    }

    if (input.gitRemote) {
      await runGit(
        ['clone', input.gitRemote, provisionPath],
        { timeoutMs: 120_000, ...(input.signal ? { signal: input.signal } : {}) },
      );
      notes.push(`cloned ${input.gitRemote}`);
    } else {
      // Idempotent — `git init` on a pre-existing empty repo is a no-op.
      await runGit(
        ['init'],
        {
          cwd: provisionPath,
          timeoutMs: 30_000,
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      notes.push('git init');
    }
    input.signal?.throwIfAborted();

    const claudeMd = join(provisionPath, 'CLAUDE.md');
    try {
      await access(claudeMd);
    } catch {
      await writeFile(claudeMd, defaultClaudeMd(input.name), 'utf8');
      notes.push('created CLAUDE.md');
    }

    // Symlink AGENTS.md → CLAUDE.md so codex (which reads AGENTS.md) and
    // claude code (which reads CLAUDE.md) see the same content. Skip if
    // AGENTS.md already exists — the user / repo owns that file.
    const agentsMd = join(provisionPath, 'AGENTS.md');
    try {
      await access(agentsMd);
    } catch {
      try {
        await symlink('CLAUDE.md', agentsMd);
        notes.push('linked AGENTS.md → CLAUDE.md');
      } catch (err) {
        // Symlink can fail on some filesystems (e.g. mounted FAT). Non-fatal.
        notes.push(`symlink AGENTS.md failed: ${(err as Error).message}`);
      }
    }

    addAiScaffold(provisionPath, notes);
    input.signal?.throwIfAborted();
    if (stagingPath) {
      // Recheck immediately before publication and refuse a dangling symlink
      // or empty directory another actor created while Git/scaffolding ran.
      try {
        await lstat(target);
        throw new WorkspaceTargetConflictError(target);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
      await rename(stagingPath, target);
      stagingPath = null;
    }
    return { ok: true, notes };
  } catch (err) {
    // This exact staging path was created by Gian; user-owned/pre-existing
    // targets are never deleted on failure.
    if (stagingPath) await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    const gitError = err instanceof GitQueueFullError || err instanceof CommandExecutionError;
    let errorStatus: NonNullable<InitWorkspaceResult['errorStatus']> = 500;
    if (err instanceof WorkspaceTargetConflictError) errorStatus = 400;
    else if (err instanceof GitQueueFullError) errorStatus = 503;
    else if (err instanceof CommandExecutionError && err.timedOut) errorStatus = 504;
    else if (err instanceof CommandExecutionError && err.exitCode != null) errorStatus = 400;
    let error: string;
    if (err instanceof WorkspaceTargetConflictError) error = err.message;
    else if (gitError) error = `git op failed: ${commandErrorMessage(err, 'git operation failed')}`;
    else error = `workspace initialization failed: ${commandErrorMessage(err, 'initialization failed')}`;
    return {
      ok: false,
      notes,
      error,
      errorStatus,
    };
  }
}

function addAiScaffold(path: string, notes: string[]): void {
  // Freshly provisioned workspaces get the Gian-managed `.ai/` scaffold and
  // `CLAUDE.local.md` pointer. Adopted paths intentionally never call this
  // helper because adopting is a read-only registration boundary.
  try {
    const scaffold = scaffoldAiDir(path);
    notes.push(...scaffold.notes);
  } catch (err) {
    // Non-fatal: a workspace without `.ai/` is degraded but usable.
    notes.push(`.ai/ scaffold failed: ${(err as Error).message}`);
  }
}

function defaultClaudeMd(name: string): string {
  return `# ${name}\n\nNotes for AI agents working in this repository.\n`;
}

/** Resolve a `~`-prefixed path against the user's home dir. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
