import { homedir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Cleanup-only contract for the global instruction block retired by ADR-0048.
// Gian no longer creates or updates these files.

export const MANAGED_BLOCK_BEGIN = '<!-- gian:begin -->';
export const MANAGED_BLOCK_END = '<!-- gian:end -->';

export interface AgentInstructionTarget {
  agent: 'codex' | 'claude' | 'kimi' | 'grok';
  path: string;
}

export function agentInstructionTargets(home: string = homedir()): AgentInstructionTarget[] {
  return [
    { agent: 'codex', path: join(home, '.codex', 'AGENTS.md') },
    { agent: 'claude', path: join(home, '.claude', 'CLAUDE.md') },
    { agent: 'kimi', path: join(home, '.kimi-code', 'AGENTS.md') },
    { agent: 'grok', path: join(home, '.grok', 'AGENTS.md') },
  ];
}

export function buildManagedBlock(workspaceRoot: string): string {
  return [
    MANAGED_BLOCK_BEGIN,
    '',
    '## Gian 工作区约定（此区块由 Gian 自动维护，请勿手动编辑）',
    '',
    `- 工作区根目录：\`${workspaceRoot}\``,
    `- 所有 git worktree 统一创建在「工作区根目录/worktrees/」之下，即 \`${workspaceRoot}/worktrees/\``,
    '',
    MANAGED_BLOCK_END,
  ].join('\n');
}

/** Remove only Gian's legacy marked block. Missing files, malformed marker
 * pairs, and every byte outside the exact pair remain untouched. */
export function removeManagedBlock(existing: string): string {
  const begin = existing.indexOf(MANAGED_BLOCK_BEGIN);
  const end = existing.indexOf(MANAGED_BLOCK_END);
  if (begin === -1 || end === -1 || end < begin) return existing;
  return `${existing.slice(0, begin)}${existing.slice(end + MANAGED_BLOCK_END.length)}`;
}

/** One-way cleanup for the instruction mutation retired by ADR-0048. The
 * function never creates a file and subsequent starts become read-only no-ops. */
export async function cleanupAgentInstructionBlocks(
  home: string = homedir(),
): Promise<string[]> {
  const written: string[] = [];
  const failures: string[] = [];
  for (const target of agentInstructionTargets(home)) {
    try {
      let existing: string;
      try {
        existing = await readFile(target.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const next = removeManagedBlock(existing);
      if (next === existing) continue;
      await writeFile(target.path, next, 'utf8');
      written.push(target.path);
    } catch (error) {
      failures.push(`${target.path}: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`agent instruction cleanup failed for ${failures.join('; ')}`);
  }
  return written;
}
