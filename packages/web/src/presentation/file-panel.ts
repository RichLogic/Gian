import type { WorkingTree } from '../api.js';
import { isWithinRoot, longestRootMatch } from '../utils/paths.js';

export interface FilePanelRoute {
  sourceTree: WorkingTree | null;
  sourceRel: string | null;
  revealRel: string | null;
  inCurrentFiles: boolean;
}

function relativeTo(root: string, absPath: string): string {
  return absPath.slice(root.replace(/\/+$/, '').length).replace(/^\/+/, '');
}

/**
 * Resolve an absolute transcript file reference without conflating two
 * separate questions: which tree can serve it, and whether the current Files
 * inspector can locate it.
 */
export function resolveFilePanelRoute(
  absPath: string,
  currentTree: WorkingTree | null,
  workingTrees: WorkingTree[],
  currentFiles: ReadonlySet<string>,
): FilePanelRoute {
  const insideCurrent = !!currentTree && isWithinRoot(currentTree.path, absPath);
  const currentRel = insideCurrent && currentTree ? relativeTo(currentTree.path, absPath) : null;
  const inCurrentFiles = !!currentRel && currentFiles.has(currentRel);

  // Prefer the current tree whenever it contains the path, including hidden
  // files omitted from the Files index. Otherwise use another registered tree.
  const sourceTree = insideCurrent ? currentTree : (longestRootMatch(workingTrees, absPath) ?? null);
  const sourceRel = sourceTree ? relativeTo(sourceTree.path, absPath) : null;

  return {
    sourceTree,
    sourceRel,
    revealRel: inCurrentFiles ? currentRel : null,
    inCurrentFiles,
  };
}
