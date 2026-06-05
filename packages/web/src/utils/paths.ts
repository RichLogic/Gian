// Path helpers for routing absolute file paths back to a working tree.
//
// The key hazard: this project has sibling roots like `/…/Gian` and
// `/…/Gian-Dev`. A naive `abs.startsWith(root)` makes `/…/Gian-Dev/x` match the
// `Gian` root, so opens / Finder / Terminal / raw-URL route to the wrong tree.
// These helpers are path-boundary aware and pick the longest matching root.

/** True when `abs` is `root` itself or sits strictly under it. */
export function isWithinRoot(root: string, abs: string): boolean {
  const r = root.replace(/\/+$/, '');
  return abs === r || abs.startsWith(r + '/');
}

/** The tree whose root contains `abs`, preferring the deepest (longest) root so
 *  a parent never shadows a nested sibling. Undefined if none contain it. */
export function longestRootMatch<T extends { path: string }>(trees: T[], abs: string): T | undefined {
  return trees
    .filter(t => isWithinRoot(t.path, abs))
    .sort((a, b) => b.path.replace(/\/+$/, '').length - a.path.replace(/\/+$/, '').length)[0];
}
