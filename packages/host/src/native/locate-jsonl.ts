import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the on-disk JSONL path for a native (cc / codex) session.
 *
 *   - cc: deterministic. `~/.claude/projects/<encoded cwd>/<id>.jsonl`,
 *     where encoding replaces every `/` with `-`.
 *   - codex: NOT deterministic from id alone — codex stores rollouts under
 *     `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. We walk that
 *     tree and match by filename suffix `<id>.jsonl`.
 *
 * Returns null when the file isn't found. The watcher tolerates this and
 * just won't watch the session until/unless it later locates the file (the
 * proxy's first turn typically creates the file before user can resume from
 * a terminal).
 */
export function locateNativeJsonl(
  executor: 'claude' | 'codex',
  nativeSessionId: string,
  cwd: string,
): string | null {
  if (executor === 'claude') return locateCcJsonl(nativeSessionId, cwd);
  return locateCodexJsonl(nativeSessionId);
}

/** cc storage: `~/.claude/projects/<cwd-with-slashes-as-dashes>/<id>.jsonl`.
 *  Path is deterministic from inputs — we return it whether or not the file
 *  exists yet. cc CLI lazily creates the file on first turn; the watcher
 *  tolerates missing files (poll fallback detects creation). */
export function locateCcJsonl(nativeSessionId: string, cwd: string): string | null {
  const projectDir = join(
    homedir(),
    '.claude',
    'projects',
    cwd.replaceAll('/', '-'),
  );
  return join(projectDir, `${nativeSessionId}.jsonl`);
}

/**
 * Find a codex rollout file by thread id by walking
 * `~/.codex/sessions/YYYY/MM/DD/`. Returns the most recent match by mtime
 * if multiple exist (paranoia — id collision shouldn't happen but if it
 * does we want the live one).
 */
export function locateCodexJsonl(threadId: string): string | null {
  const sessionsRoot = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsRoot)) return null;

  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        stat.isFile() &&
        entry.startsWith('rollout-') &&
        entry.endsWith(`-${threadId}.jsonl`)
      ) {
        candidates.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(sessionsRoot, 0);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.path;
}

/**
 * SESSION-NAME-001: append a Claude `custom-title` record to a session JSONL so
 * the Gian name shows in `claude --resume` / Remote Control listings. `parseCcLine`
 * ignores non-message lines, so this produces no transcript row / event / status
 * change. Control chars are stripped and the name capped; an empty result is a
 * no-op (we never clear an existing title). Returns whether a line was written.
 */
export function appendCcCustomTitle(
  filePath: string,
  claudeSessionId: string,
  name: string,
): boolean {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 200);
  if (!clean) return false;
  const line = JSON.stringify({
    type: 'custom-title',
    customTitle: clean,
    sessionId: claudeSessionId,
  }) + '\n';
  appendFileSync(filePath, line, 'utf8');
  return true;
}

/**
 * Read the cwd from a codex rollout's session_meta header. Used by the host
 * during boot when only the threadId is known but we want to verify the
 * file matches the workspace (defensive — currently unused, exported for
 * possible future use).
 */
export function readCodexCwdFromJsonl(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, 'utf8');
    const firstLine = content.split('\n', 1)[0];
    if (!firstLine) return null;
    const meta = JSON.parse(firstLine) as Record<string, unknown>;
    if (meta.type !== 'session_meta') return null;
    const payload = meta.payload as Record<string, unknown> | undefined;
    if (!payload) return null;
    return typeof payload.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  }
}
