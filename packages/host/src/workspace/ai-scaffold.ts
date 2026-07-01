import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GIAN_TASK_SKILL_FILES } from '../task/skill-templates.js';

/**
 * The gian-managed `.ai/` scaffold (PRD-v3 P2a; extended for the gian-task
 * context engine, proposal gian-task-pm-engineer §4.3 / §4.7).
 *
 * One set per Workspace, created at init / adopt time and maintained by gian.
 *
 * Layout:
 *   .ai/MEMORY.md            canonical long-term truth (committable, plane A)
 *   .ai/STATE.md/HANDOFF.md  legacy single-file scaffold (kept for back-compat)
 *   .ai/SESSION_LOG.md       legacy completion log (kept for back-compat)
 *   .ai/sessions/            per-session shards `<id>.state.md` / `<id>.report.md`
 *   .ai/log/                 per-session append-only logs
 *   .ai/.history/            atomic-write backups (created lazily by backups)
 *   .ai/STATE.view.md        HOST-generated merge view (see ai-views.ts)
 *   .ai/gian-task/<role>.md  the gian-task role playbooks (Gian-owned templates)
 *
 * The user-content files (`MEMORY.md` etc.) are **idempotent and non-destructive**:
 * created only when MISSING, never overwritten, and we never touch
 * `CLAUDE.md` / `AGENTS.md`. The gian-task playbooks are Gian-owned templates,
 * so they are (re)written every call to stay fresh; derived files
 * (`sessions/`, `log/`, `.history/`, `STATE.view.md`, `gian-task/`) are gitignored.
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

/** Directories created under the workspace (relative paths). `.ai/.history/`
 *  is intentionally NOT here — it is created lazily by `backupToHistory` only
 *  when a backup is actually made (so its presence means "a backup happened"). */
const AI_SUBDIRS = ['.ai/sessions', '.ai/log', '.ai/gian-task'];

/** Directory the gian-task role playbooks are materialized into. */
const GIAN_TASK_DIR_REL = '.ai/gian-task';

/** The ≤10-line pointer file telling the model what lives in `.ai/`. */
const CLAUDE_LOCAL_MD = [
  '<!-- gian-managed pointer — gitignored. Do not @-import growing files. -->',
  '# Workspace AI context',
  '',
  'gian 维护一套 `.ai/` 脚手架（gian-task context engine）：',
  '',
  '- `.ai/MEMORY.md` — 长期项目事实（canonical，按需 Read）。',
  '- `.ai/STATE.view.md` — 各 session 状态分片的合并视图（Gian 生成，只读）。',
  '- `.ai/sessions/<id>.state.md` / `.report.md` — 每个 session 只写自己的分片。',
  '- `.ai/gian-task/<role>.md` — 角色 playbook（Gian 注入的 ROLE 头会指向它）。',
  '- `.ai/HANDOFF.md` / `.ai/STATE.md` / `.ai/SESSION_LOG.md` — 旧版单文件（兼容保留）。',
  '',
].join('\n');

const CLAUDE_LOCAL_REL = 'CLAUDE.local.md';

/** Lines gian ensures are gitignored: the pointer + every derived (host-owned)
 *  `.ai/` path. `MEMORY.md` and the legacy single files stay committable. */
const GITIGNORE_LINES = [
  'CLAUDE.local.md',
  '.ai/sessions/',
  '.ai/log/',
  '.ai/.history/',
  '.ai/STATE.view.md',
  '.ai/gian-task/',
];

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
  for (const sub of AI_SUBDIRS) {
    mkdirSync(join(target, sub), { recursive: true });
  }

  // User-content files: create only when missing (non-destructive).
  for (const file of AI_FILES) {
    const abs = join(target, file.rel);
    if (!existsSync(abs)) {
      writeFileSync(abs, file.content, 'utf8');
      notes.push(`created ${file.rel}`);
    }
  }

  // gian-task role playbooks: Gian-owned templates, (re)written every call so
  // improvements propagate. Agents read but never edit these.
  for (const skill of GIAN_TASK_SKILL_FILES) {
    writeFileSync(join(target, GIAN_TASK_DIR_REL, skill.name), skill.content, 'utf8');
  }

  const claudeLocal = join(target, CLAUDE_LOCAL_REL);
  if (!existsSync(claudeLocal)) {
    writeFileSync(claudeLocal, CLAUDE_LOCAL_MD, 'utf8');
    notes.push(`created ${CLAUDE_LOCAL_REL}`);
  }

  const added = ensureGitignoreLines(target, GITIGNORE_LINES);
  if (added.length > 0) {
    notes.push(`gitignored ${added.join(', ')}`);
  }

  return { notes };
}

/**
 * Ensure each of `lines` is present in the workspace `.gitignore`. Creates
 * `.gitignore` when absent. Returns the lines that were newly added.
 *
 * Match is on whole, trimmed lines so we don't double-add and don't get fooled
 * by a substring (e.g. a different `foo/CLAUDE.local.md` entry).
 */
function ensureGitignoreLines(target: string, lines: string[]): string[] {
  const gitignore = join(target, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const present = new Set(existing.split('\n').map(l => l.trim()));

  const toAdd = lines.filter(l => !present.has(l));
  if (toAdd.length === 0) return [];

  const block = toAdd.join('\n');
  if (existing.length === 0) {
    writeFileSync(gitignore, `${block}\n`, 'utf8');
  } else {
    const prefix = existing.endsWith('\n') ? '' : '\n';
    appendFileSync(gitignore, `${prefix}${block}\n`, 'utf8');
  }
  return toAdd;
}
