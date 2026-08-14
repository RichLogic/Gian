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
 * inspector can locate it. A null source tree still previews via the
 * absolute-path file API; it only means the inspector cannot reveal a row.
 */
export function resolveFilePanelRoute(
  absPath: string,
  currentTree: WorkingTree | null,
  workingTrees: WorkingTree[],
  currentFiles: ReadonlySet<string>,
): FilePanelRoute {
  const matchedTree = longestRootMatch(workingTrees, absPath) ?? null;
  const matchedRel = matchedTree ? relativeTo(matchedTree.path, absPath) : null;
  const insideCurrent = !!currentTree && isWithinRoot(currentTree.path, absPath);
  // Agent output sometimes anchors a project-relative file to the workspace
  // primary path even while the user is viewing an agent-created worktree.
  // Remap only primary-checkout paths, only within the same workspace, and
  // only when the relative file is known to exist in the viewed tree.
  const primaryAlias = !!currentTree
    && !!matchedTree
    && matchedTree.kind === 'workspace'
    && matchedTree.id !== currentTree.id
    && matchedTree.workspace_id === currentTree.workspace_id
    && !!matchedRel
    && currentFiles.has(matchedRel);
  const currentRel = insideCurrent && currentTree
    ? relativeTo(currentTree.path, absPath)
    : primaryAlias
      ? matchedRel
      : null;
  const inCurrentFiles = !!currentRel && currentFiles.has(currentRel);

  // Prefer the current tree whenever it contains the path, including hidden
  // files omitted from the Files index. A verified primary-path alias also
  // belongs to the viewed tree; otherwise use the path's registered tree.
  const sourceTree = insideCurrent || primaryAlias ? currentTree : matchedTree;
  const sourceRel = sourceTree === currentTree ? currentRel : matchedRel;

  return {
    sourceTree,
    sourceRel,
    revealRel: inCurrentFiles ? currentRel : null,
    inCurrentFiles,
  };
}
