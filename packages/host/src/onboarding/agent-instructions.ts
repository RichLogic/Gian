import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Gian owns a marked block inside each agent CLI's global instruction file.
// The block tells agents where the workspace root is and that every git
// worktree must live under `<root>/worktrees/`. Content outside the markers
// is user-owned and never touched.

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

/** Insert or replace the managed block in `existing` (null = file missing). */
export function upsertManagedBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') return `${block}\n`;
  const begin = existing.indexOf(MANAGED_BLOCK_BEGIN);
  const end = existing.indexOf(MANAGED_BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const after = end + MANAGED_BLOCK_END.length;
    return `${existing.slice(0, begin)}${block}${existing.slice(after)}`;
  }
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

/**
 * Write the managed block into every agent's global instruction file.
 * Returns the paths that were actually modified (already up-to-date files
 * are skipped). Failures on individual files are collected and rethrown as
 * one error so a missing/unwritable file never blocks host startup.
 */
export async function syncAgentInstructionBlocks(
  workspaceRoot: string,
  home: string = homedir(),
): Promise<string[]> {
  const block = buildManagedBlock(workspaceRoot);
  const written: string[] = [];
  const failures: string[] = [];
  for (const target of agentInstructionTargets(home)) {
    try {
      let existing: string | null = null;
      try {
        existing = await readFile(target.path, 'utf8');
      } catch {
        // File does not exist yet — it will be created.
      }
      const next = upsertManagedBlock(existing, block);
      if (next === existing) continue;
      await mkdir(dirname(target.path), { recursive: true });
      await writeFile(target.path, next, 'utf8');
      written.push(target.path);
    } catch (error) {
      failures.push(`${target.path}: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`agent instruction sync failed for ${failures.join('; ')}`);
  }
  return written;
}
