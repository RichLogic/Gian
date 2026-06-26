export { initWorkspace, expandHome } from './init.js';
export type { InitWorkspaceInput, InitWorkspaceResult } from './init.js';
export { scaffoldAiDir } from './ai-scaffold.js';
export type { ScaffoldResult } from './ai-scaffold.js';
export { detectDefaultBranch, createWorktree, mergeBranch, removeWorktree, isGitRepo } from './git.js';
