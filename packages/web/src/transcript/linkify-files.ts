// Auto-linkify file references in transcript prose.
//
// The transcript renders assistant text and reasoning through react-markdown.
// This module provides:
//   1. `findFileRefs` — scan a string for path-like tokens + optional line
//      suffix (`foo.ts:42`, `src/foo.ts`, `App.tsx (line 771)`).
//   2. `buildFileRefIndex` — resolve a token against the working tree's file
//      list (from GET …/files), so only *real* files become links and a bare
//      basename resolves to its full path when unambiguous.
//   3. `makeFileLinkifyRehype` — a rehype plugin that rewrites matching text
//      nodes into `<a data-file-abs …>` elements; the markdown renderer's `a`
//      override turns those into in-app FileLinks.
//
// Pure (1)+(2) so the matching/resolution logic is unit-testable without a DOM.

export interface FileRef {
  /** Offset of the whole match (path + optional line suffix) in the source. */
  start: number;
  end: number;
  /** The bare path token, e.g. `src/App.tsx`. */
  path: string;
  /** 1-based line number when the ref carried `:N` or `(line N)`. */
  line?: number;
}

// A path token is an optional leading `/` (absolute paths), then zero-or-more
// `dir/` segments, then `name.ext`, where the extension starts with a letter
// (so version strings like `v10.1.0` and numbers like `3.14` never match). An
// optional `:N[:C]` or ` (line N)` trailer is captured as the line.
const REF_RE =
  /(\/?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z][A-Za-z0-9_]*)(?::(\d+)(?::\d+)?|\s*\(line\s+(\d+)\))?/g;

export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text)) !== null) {
    const path = m[1]!;
    const lineStr = m[2] ?? m[3];
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      path,
      ...(lineStr ? { line: Number(lineStr) } : {}),
    });
  }
  return out;
}

export interface FileRefIndex {
  /** Resolve a token to a working-tree-relative path, or null if it isn't a
   *  real file (or is ambiguous). */
  resolve(token: string): string | null;
  /** Number of indexed files — for callers that want to skip work when empty. */
  readonly size: number;
}

export function buildFileRefIndex(relPaths: string[], root?: string): FileRefIndex {
  const full = new Set<string>();
  const byBase = new Map<string, string[]>();
  // Trailing-slash-normalized root prefix used to fold absolute tokens that
  // live under the working tree back into relative paths.
  const rootPrefix = root ? root.replace(/\/+$/, '') + '/' : null;
  for (const raw of relPaths) {
    const p = raw.replace(/^\.\//, '');
    if (!p) continue;
    full.add(p);
    const base = p.slice(p.lastIndexOf('/') + 1);
    const arr = byBase.get(base);
    if (arr) arr.push(p);
    else byBase.set(base, [p]);
  }
  return {
    size: full.size,
    resolve(token: string): string | null {
      let t = token.replace(/^\.\//, '');
      if (!t) return null;
      // Absolute path: only resolvable if it's under this tree's root.
      if (t.startsWith('/')) {
        if (rootPrefix && t.startsWith(rootPrefix)) t = t.slice(rootPrefix.length);
        else return null;
      }
      if (full.has(t)) return t;
      const base = t.slice(t.lastIndexOf('/') + 1);
      const cands = byBase.get(base);
      if (!cands || cands.length === 0) return null;
      if (!t.includes('/')) {
        // Bare basename: only link when it points at exactly one file.
        return cands.length === 1 ? cands[0]! : null;
      }
      // Partial path (e.g. `src/App.tsx`): match by path suffix, unique only.
      const suf = cands.filter(c => c === t || c.endsWith('/' + t));
      return suf.length === 1 ? suf[0]! : null;
    },
  };
}

// ─── rehype plugin ──────────────────────────────────────────────────────────
// Hast nodes are loosely typed here to avoid pulling in @types/hast.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Build a rehype plugin that linkifies file references in text nodes.
 * `toAbs` maps a resolved relative path to the absolute on-disk path the
 * in-app opener expects. Skips text inside existing `<a>` and `<pre>` (code
 * blocks) so links and code fences aren't mangled.
 */
export function makeFileLinkifyRehype(
  index: FileRefIndex,
  toAbs: (relPath: string) => string,
) {
  function splitText(value: string): HastNode[] {
    const refs = findFileRefs(value);
    if (refs.length === 0) return [{ type: 'text', value }];
    const nodes: HastNode[] = [];
    let pos = 0;
    let linked = false;
    for (const r of refs) {
      const rel = index.resolve(r.path);
      if (!rel) continue; // leave unresolved tokens as plain text
      if (r.start > pos) nodes.push({ type: 'text', value: value.slice(pos, r.start) });
      const abs = toAbs(rel);
      nodes.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['file-link', 'file-link-auto'],
          href: `vscode://file/${encodeURI(abs)}${r.line ? ':' + r.line : ''}`,
          dataFileAbs: abs,
          ...(r.line != null ? { dataFileLine: String(r.line) } : {}),
        },
        children: [{ type: 'text', value: value.slice(r.start, r.end) }],
      });
      pos = r.end;
      linked = true;
    }
    if (!linked) return [{ type: 'text', value }];
    if (pos < value.length) nodes.push({ type: 'text', value: value.slice(pos) });
    return nodes;
  }

  function walk(node: HastNode, skip: boolean): void {
    const kids = node.children;
    if (!Array.isArray(kids)) return;
    const out: HastNode[] = [];
    for (const child of kids) {
      if (child.type === 'text' && !skip) {
        out.push(...splitText(child.value ?? ''));
      } else {
        if (child.type === 'element') {
          const childSkip = skip || child.tagName === 'a' || child.tagName === 'pre';
          walk(child, childSkip);
        }
        out.push(child);
      }
    }
    node.children = out;
  }

  // unified plugin: returns a transformer over the hast tree.
  return function rehypeLinkifyFiles() {
    return (tree: HastNode) => {
      if (index.size === 0) return;
      walk(tree, false);
    };
  };
}
