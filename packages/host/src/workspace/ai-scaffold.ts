import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The gian-managed `.ai/` scaffold (PRD-v3 P2a).
 *
 * One set per Workspace, created at init / adopt time and maintained by gian.
 * See `docs/PRD-v3-task-abstraction.md` §109-120 for the file table.
 *
 * Every helper here is **idempotent and non-destructive**: a file is only
 * created when MISSING. We never overwrite existing content (the user / a prior
 * Subtask may already own it) and we never touch `CLAUDE.md` / `AGENTS.md`.
 */

interface ScaffoldFile {
  /** Path relative to the workspace root. */
  rel: string;
  /** Full initial content written only when the file is absent. */
  content: string;
}

/**
 * The `.ai/*` files. Each carries a short header comment stating its purpose
 * and load policy, per the PRD table — so an agent (or human) opening the file
 * cold understands what it is and when gian injects it.
 */
const AI_FILES: ScaffoldFile[] = [
  {
    rel: '.ai/HANDOFF.md',
    content: [
      '<!-- gian:.ai/HANDOFF.md',
      '     用途：上一个 Subtask 给下一个 Subtask 的交接简报。',
      '     大小：小（一两段）。',
      '     加载策略：新 Subtask 启动时**注入**。 -->',
      '',
      '# Handoff',
      '',
      '_暂无交接内容。_',
      '',
    ].join('\n'),
  },
  {
    rel: '.ai/STATE.md',
    content: [
      '<!-- gian:.ai/STATE.md',
      '     用途：当前 Workspace 状态快照（保持精简）。',
      '     大小：小。',
      '     加载策略：新 Subtask 启动时**注入**，有 token 上限，超限截断。 -->',
      '',
      '# State',
      '',
      '_暂无状态快照。_',
      '',
    ].join('\n'),
  },
  {
    rel: '.ai/MEMORY.md',
    content: [
      '<!-- gian:.ai/MEMORY.md',
      '     用途：长期项目事实。',
      '     大小：慢慢长。',
      '     加载策略：**不**自动加载，agent 按需 Read。 -->',
      '',
      '# Memory',
      '',
      '_暂无长期事实。_',
      '',
    ].join('\n'),
  },
  {
    rel: '.ai/SESSION_LOG.md',
    content: [
      '<!-- gian:.ai/SESSION_LOG.md',
      '     用途：完成记录（append-only）。',
      '     大小：持续膨胀。',
      '     加载策略：**不**自动加载，按需 Read。 -->',
      '',
      '# Session Log',
      '',
    ].join('\n'),
  },
];

/** The ≤10-line pointer file telling the model what lives in `.ai/`. */
const CLAUDE_LOCAL_MD = [
  '<!-- gian-managed pointer — gitignored. Do not @-import growing files. -->',
  '# Workspace AI context',
  '',
  'gian 维护一套 `.ai/` 脚手架：',
  '',
  '- `.ai/HANDOFF.md` — 上一个 Subtask 给下一个的交接简报（启动时注入）。',
  '- `.ai/STATE.md` — 当前 Workspace 状态快照（启动时注入，保持精简）。',
  '- `.ai/MEMORY.md` — 长期项目事实（按需 Read）。',
  '- `.ai/SESSION_LOG.md` — 完成记录，append-only（按需 Read）。',
  '',
].join('\n');

const CLAUDE_LOCAL_REL = 'CLAUDE.local.md';
const GITIGNORE_LINE = 'CLAUDE.local.md';

export interface ScaffoldResult {
  /** Free-form notes about what was created — folded into init notes. */
  notes: string[];
}

/**
 * Idempotently write the `.ai/` scaffold + `CLAUDE.local.md` pointer into the
 * workspace at `target`, and ensure `CLAUDE.local.md` is gitignored.
 *
 * Only MISSING files are created; existing files are left untouched. Safe to
 * call repeatedly (fresh create AND adopt both invoke it).
 */
export function scaffoldAiDir(target: string): ScaffoldResult {
  const notes: string[] = [];

  mkdirSync(join(target, '.ai'), { recursive: true });

  for (const file of AI_FILES) {
    const abs = join(target, file.rel);
    if (!existsSync(abs)) {
      writeFileSync(abs, file.content, 'utf8');
      notes.push(`created ${file.rel}`);
    }
  }

  const claudeLocal = join(target, CLAUDE_LOCAL_REL);
  if (!existsSync(claudeLocal)) {
    writeFileSync(claudeLocal, CLAUDE_LOCAL_MD, 'utf8');
    notes.push(`created ${CLAUDE_LOCAL_REL}`);
  }

  if (ensureGitignoreLine(target)) {
    notes.push(`gitignored ${GITIGNORE_LINE}`);
  }

  return { notes };
}

/**
 * Append `CLAUDE.local.md` to the workspace `.gitignore` if it isn't already
 * ignored. Creates `.gitignore` when absent. Returns true if a line was added.
 *
 * Match is on whole, trimmed lines so we don't double-add and don't get fooled
 * by a substring (e.g. a different `foo/CLAUDE.local.md` entry).
 */
function ensureGitignoreLine(target: string): boolean {
  const gitignore = join(target, '.gitignore');
  if (existsSync(gitignore)) {
    const body = readFileSync(gitignore, 'utf8');
    const present = body
      .split('\n')
      .some(line => line.trim() === GITIGNORE_LINE);
    if (present) return false;
    // Append on its own line; guard against a missing trailing newline.
    const prefix = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
    appendFileSync(gitignore, `${prefix}${GITIGNORE_LINE}\n`, 'utf8');
    return true;
  }
  writeFileSync(gitignore, `${GITIGNORE_LINE}\n`, 'utf8');
  return true;
}
