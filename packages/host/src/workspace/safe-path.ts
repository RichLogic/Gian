import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Resolve `rel` against `wsRoot` and verify the result physically stays
 * inside `wsRoot` after symlink resolution. Plain `resolve()` only catches
 * `..` traversal and absolute paths — a symlink at any depth inside the
 * workspace can still point at /etc, /home, etc.
 *
 * Strategy: realpath both ends. If the target doesn't exist yet (e.g. a new
 * file path passed to /diff or /file_meta), walk up to the deepest existing
 * ancestor, realpath that, then re-attach the remaining tail. The tail
 * components don't exist so they can't be symlinks.
 *
 * Returns the verified absolute path on success, null on escape attempt or
 * if the workspace root itself can't be resolved.
 */
export async function resolveWithinWorkspace(wsRoot: string, rel: string): Promise<string | null> {
  let rootReal: string;
  try {
    rootReal = await realpath(resolve(wsRoot));
  } catch {
    return null;
  }
  const target = resolve(rootReal, rel);
  if (target === rootReal) return rootReal;
  if (!target.startsWith(rootReal + sep)) return null;

  let probe = target;
  while (probe !== rootReal && probe !== dirname(probe)) {
    try {
      const probeReal = await realpath(probe);
      if (probeReal !== rootReal && !probeReal.startsWith(rootReal + sep)) {
        return null;
      }
      const tail = target.slice(probe.length);
      return probeReal + tail;
    } catch {
      probe = dirname(probe);
    }
  }
  // Walked all the way up to root: every intermediate component is missing,
  // so the path is rooted under the verified real root and safe.
  return target;
}
