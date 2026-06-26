import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { scaffoldAiDir } from './ai-scaffold.js';

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
}

export interface InitWorkspaceResult {
  ok: boolean;
  /** Free-form notes about what was done — surfaced in the response. */
  notes: string[];
  error?: string;
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
 * Adopt mode (`adopt: true`) skips mkdir/clone/git-init and the default
 * CLAUDE.md / AGENTS.md scaffolding — we don't write into the user's existing
 * project files. It DOES still get the gian-managed `.ai/` scaffold +
 * `CLAUDE.local.md` pointer (PRD-v3 §121): those are gian's own,
 * non-destructive, gitignored files, so creating them on adopt is intended.
 */
export function initWorkspace(input: InitWorkspaceInput): InitWorkspaceResult {
  const notes: string[] = [];
  const target = resolve(input.path);

  if (input.adopt) {
    if (!existsSync(target)) {
      return { ok: false, notes, error: `path does not exist: ${target}` };
    }
    if (input.gitRemote) {
      return { ok: false, notes, error: 'git_remote is not allowed when adopting an existing path' };
    }
    notes.push(`adopted existing path: ${target}`);
  } else {
    if (existsSync(target)) {
      const entries = readdirSync(target);
      const meaningful = entries.filter(e => e !== '.DS_Store');
      if (meaningful.length > 0) {
        return { ok: false, notes, error: `path already exists and is non-empty: ${target}` };
      }
    }

    try {
      if (input.gitRemote) {
        // git clone needs the parent dir to exist; the target itself must NOT
        // exist as a non-empty dir (git clone would refuse).
        const parent = resolve(target, '..');
        mkdirSync(parent, { recursive: true });
        execFileSync('git', ['clone', input.gitRemote, target], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        });
        notes.push(`cloned ${input.gitRemote}`);
      } else {
        mkdirSync(target, { recursive: true });
        // Idempotent — `git init` on an existing repo is a no-op.
        execFileSync('git', ['init'], { cwd: target, stdio: ['ignore', 'pipe', 'pipe'] });
        notes.push('git init');
      }
    } catch (err) {
      return { ok: false, notes, error: `git op failed: ${(err as Error).message}` };
    }
  }

  if (!input.adopt) {
    const claudeMd = join(target, 'CLAUDE.md');
    if (!existsSync(claudeMd)) {
      writeFileSync(claudeMd, defaultClaudeMd(input.name), 'utf8');
      notes.push('created CLAUDE.md');
    }

    // Symlink AGENTS.md → CLAUDE.md so codex (which reads AGENTS.md) and
    // claude code (which reads CLAUDE.md) see the same content. Skip if
    // AGENTS.md already exists — the user / repo owns that file.
    const agentsMd = join(target, 'AGENTS.md');
    if (!existsSync(agentsMd)) {
      try {
        symlinkSync('CLAUDE.md', agentsMd);
        notes.push('linked AGENTS.md → CLAUDE.md');
      } catch (err) {
        // Symlink can fail on some filesystems (e.g. mounted FAT). Non-fatal.
        notes.push(`symlink AGENTS.md failed: ${(err as Error).message}`);
      }
    }
  }

  // Always provision the gian-managed `.ai/` scaffold + `CLAUDE.local.md`
  // pointer — for fresh creates AND adopts. It's idempotent and only writes
  // gian's own gitignored files, never the user's CLAUDE.md / AGENTS.md.
  try {
    const scaffold = scaffoldAiDir(target);
    notes.push(...scaffold.notes);
  } catch (err) {
    // Non-fatal: a workspace without `.ai/` is degraded but usable.
    notes.push(`.ai/ scaffold failed: ${(err as Error).message}`);
  }

  return { ok: true, notes };
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
