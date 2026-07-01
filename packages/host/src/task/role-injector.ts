// RoleInjector (proposal gian-task-pm-engineer §4A.C / §4.8 ①).
//
// Builds the small, stable ROLE header Gian injects at the top of a task
// session. The header is the ONLY per-session injection for the context engine;
// the role playbook and workspace views are READ by the agent (native file
// tools), not injected — keeping the injection surface bounded and small.
//
// Pure and side-effect-free. The live wiring (structured = prepend to the first
// message; Claude TTY = SessionStart hook additionalContext) lives in the
// session/tty managers and calls into here.

import { GIAN_ROLE_OPEN, GIAN_ROLE_CLOSE, type Role } from '@gian/shared';
import type { SessionType } from '@gian/shared';

/** Map a session type to its context-engine role. `coding` → INDIVIDUAL (the
 *  safe default: work directly, don't spawn subtasks), `subtask` → ENGINEER,
 *  `manager` → PM. */
export function roleForSessionType(type: SessionType): Role {
  switch (type) {
    case 'subtask':
      return 'engineer';
    case 'manager':
      return 'pm';
    case 'coding':
    default:
      return 'individual';
  }
}

export interface RoleHeaderInput {
  role: Role;
  /** The session's own id — used for its shard / report paths. */
  sessionId: string;
  /** Absolute workspace path (plane A: the repo the `.ai/` scaffold lives in). */
  workspacePath: string;
  /** Task name — present for ENGINEER / PM, absent for INDIVIDUAL. */
  taskName?: string | null;
}

const ROLE_LABEL: Record<Role, string> = {
  individual: 'INDIVIDUAL',
  engineer: 'ENGINEER',
  pm: 'PM',
};

/** Join path parts with '/' (POSIX — these are repo-relative-ish display paths
 *  the agent reads, not host fs ops). Avoids importing node:path for a join. */
function joinPosix(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter(Boolean)
    .join('/');
}

/** The inner ROLE-header body (no sentinels). Stable and small. */
export function buildRoleHeader(input: RoleHeaderInput): string {
  const { role, sessionId, workspacePath, taskName } = input;
  const lines: string[] = [`ROLE: ${ROLE_LABEL[role]}`];
  // INDIVIDUAL has no task; ENGINEER / PM do.
  if (role !== 'individual' && taskName && taskName.trim()) {
    lines.push(`TASK: ${taskName.trim()}`);
  }
  lines.push(`WORKSPACE: ${workspacePath}`);
  // INDIVIDUAL and ENGINEER write their own report shard; PM does not.
  if (role !== 'pm') {
    lines.push(`REPORT_PATH: ${joinPosix(workspacePath, '.ai/sessions', `${sessionId}.report.md`)}`);
  }
  const playbook = joinPosix(workspacePath, '.ai/gian-task', `${role}.md`);
  lines.push(
    `→ Act per ${playbook}: open by orienting on this workspace's .ai/ views ` +
      `(MEMORY.md, STATE.view.md); close by writing ONLY your own shard.`,
  );
  return lines.join('\n');
}

/** The ROLE header wrapped in sentinels, ready to prepend to the first user
 *  message (structured / Codex path). The web strips it via
 *  `stripGianRolePrefix`. */
export function buildFirstTurnRolePrefix(input: RoleHeaderInput): string {
  return `${GIAN_ROLE_OPEN}\n${buildRoleHeader(input)}\n${GIAN_ROLE_CLOSE}`;
}
