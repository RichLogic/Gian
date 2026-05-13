import type { Session } from './model.js';

/**
 * NativeSession represents a session that exists on disk in the underlying
 * CLI's storage (claude code: `~/.claude/projects/<path-hash>/<id>.jsonl`;
 * codex: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`).
 *
 * Surfaced in Gian's Spaces view → Native Sessions tab so users can see all
 * sessions that ran inside this workspace's path and adopt any of them as
 * a Gian session. Adoption sets the Gian session's `native_session_id` to
 * this id, and from then on cc-proxy's `--resume <id>` / codex-proxy's
 * `thread/resume <id>` mean the same on-disk file is the source of truth —
 * users can switch back to the raw CLI at any time.
 */
export interface NativeSession {
  /** Native session UUID (cc session id or codex thread id). */
  id: string;
  executor: 'claude' | 'codex';
  /** Absolute path of the .jsonl file on disk. */
  filePath: string;
  /** Working directory the session ran in. For cc this is decoded from the
   *  parent dir name; for codex it's read from session_meta. */
  cwd: string;
  /** ISO timestamp of file mtime. */
  updatedAt: string;
  /** JSONL file size in bytes (from fs stat). */
  fileSize: number;
  /** Approximate turn count (number of user/assistant message events). */
  turnCount: number;
  /** First user message preview, truncated to ~120 chars. */
  firstUserMessage: string;
  /** Codex only — branch from session_meta.git.branch. cc has no equivalent
   *  field in its JSONL header. */
  gitBranch?: string;
  /** When this native session is already linked to a Gian session, the
   *  binding info. Populated by the host endpoint via DB cross-reference. */
  adoptedBy?: {
    gianSessionId: string;
    gianSessionName: string | null;
  };
}

export interface ListNativeSessionsResponse {
  sessions: NativeSession[];
}

export interface AdoptNativeSessionRequest {
  executor: 'claude' | 'codex';
  native_session_id: string;
  /** Optional Gian session name. Auto-generated if absent. */
  name?: string;
  /** Optional approval mode. Defaults to 'ask' if omitted. */
  approval_mode?: 'plan' | 'ask' | 'auto';
}

export interface AdoptNativeSessionResponse {
  /** The newly created Gian session (full row, like POST /sessions). */
  session: Session;
}

export interface DeleteNativeSessionRequest {
  executor: 'claude' | 'codex';
  native_session_id: string;
}
