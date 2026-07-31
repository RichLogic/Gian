// Detects `git worktree add` invocations inside shell command strings seen in
// `command_execution` session events (cc Bash tool_use, codex
// commandExecution, kimi ACP execute tool_call). Pure module — no I/O beyond
// `os.homedir()` for `~` expansion — so it is exhaustively unit-testable.
//
// Git syntax:  git [<global options>] worktree add [<options>] <path> [<commit-ish>]
// The path is the FIRST positional argument after option-stripping.

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Minimal shell tokenizer: splits on unquoted whitespace, understands
 *  single/double quotes and backslash escapes, and yields the shell command
 *  separators (`&&`, `||`, `;`, `|`) as standalone tokens so callers can
 *  split compound commands into segments. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (has || cur.length > 0) tokens.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && i + 1 < input.length && ['"', '\\', '$', '`'].includes(input[i + 1]!)) {
        cur += input[i + 1]!;
        i++;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1]!;
      has = true;
      i++;
    } else if (/\s/.test(ch)) {
      push();
    } else if (ch === ';' || ch === '|' || (ch === '&' && input[i + 1] === '&')) {
      push();
      tokens.push(ch === '&' ? '&&' : ch);
      if (ch === '&') i++;
    } else {
      cur += ch;
      has = true;
    }
  }
  push();
  return tokens;
}

// git GLOBAL options that consume the following token as their value.
// (`--git-dir=...` / `--work-tree=...` inline forms are handled by the
// startsWith('-') skip below.)
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

// `worktree add` options that consume the following token as their value.
const ADD_VALUE_FLAGS = new Set(['-b', '-B', '--orphan', '--reason']);

/** Expand a leading `~` / `~/...` against the user's home directory. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/**
 * Parse `command` for a `git worktree add` invocation and return the ABSOLUTE
 * path of the worktree being created, or null when the command is not a
 * worktree-add (or the path cannot be made absolute — a relative path is only
 * resolvable when a `git -C <repo>` prefix tells us where it anchors).
 *
 * Handles: quoted paths, `~` expansion, `-b/-B/--orphan/--reason` value
 * flags, boolean flags (`--detach`, `--track`, `--force`, …), `--` separator,
 * and compound commands (`cd repo && git worktree add …`).
 */
export function detectWorktreeAddPath(command: string): string | null {
  const tokens = tokenize(command);
  // Split into segments at shell separators; each segment may be its own
  // command, and any one of them may be the git invocation.
  const segments: string[][] = [[]];
  for (const t of tokens) {
    if (t === '&&' || t === '||' || t === ';' || t === '|') segments.push([]);
    else segments[segments.length - 1]!.push(t);
  }

  for (const seg of segments) {
    const found = parseSegment(seg);
    if (found) return found;
  }
  return null;
}

function parseSegment(seg: string[]): string | null {
  if (seg.length === 0 || seg[0] !== 'git') return null;
  let i = 1;
  let baseDir: string | null = null;

  // git global options, up to the subcommand.
  for (; i < seg.length; i++) {
    const t = seg[i]!;
    if (t === 'worktree') break;
    if (GIT_GLOBAL_VALUE_FLAGS.has(t)) {
      const value = seg[i + 1];
      if (value === undefined) return null;
      if (t === '-C') baseDir = expandTilde(value);
      i++;
    } else if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')
      || t.startsWith('--namespace=') || t.startsWith('--exec-path=')) {
      // inline value form — no extra token consumed
    } else if (t.startsWith('-')) {
      // boolean global option (-P, --no-pager, --bare, …)
    } else {
      // First non-flag token that isn't `worktree` — not a worktree cmd.
      return null;
    }
  }
  if (seg[i] !== 'worktree') return null;
  i++;
  if (seg[i] !== 'add') return null;
  i++;

  // `worktree add` options, up to the first positional (the path).
  let rawPath: string | null = null;
  for (; i < seg.length; i++) {
    const t = seg[i]!;
    if (t === '--') {
      rawPath = seg[i + 1] ?? null;
      break;
    }
    if (ADD_VALUE_FLAGS.has(t)) {
      i++; // skip the flag's value
      continue;
    }
    if (t.startsWith('-')) continue; // boolean flag, or --flag=value form
    rawPath = t;
    break;
  }
  if (!rawPath) return null;

  const expanded = expandTilde(rawPath);
  if (isAbsolute(expanded)) return expanded;
  if (baseDir) return resolve(baseDir, expanded);
  return null;
}
