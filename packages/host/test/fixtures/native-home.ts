// Tmp `$HOME` builder for native-session tests. Materializes the
// `.claude/projects/<encoded>/<id>.jsonl` and `.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<id>.jsonl` layouts the scanner walks, so tests can drive
// `scanNativeSessions(workspacePath, { homeDir })` without touching the
// developer's real home.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NativeHome {
  path: string;
  /** Create a Claude Code JSONL for `workspacePath`. Returns the JSONL's
   *  session id (the file basename without `.jsonl`). */
  addClaudeSession(opts: ClaudeSessionInput): string;
  /** Create a Codex rollout JSONL. Returns the session id (matches the
   *  `session_meta.payload.id` field). */
  addCodexSession(opts: CodexSessionInput): string;
  cleanup(): void;
}

export interface ClaudeSessionInput {
  /** Absolute workspace path; the scanner encodes `/` → `-` to find the
   *  per-project dir. */
  workspacePath: string;
  /** Override the session id. Defaults to a fresh uuid. */
  sessionId?: string;
  /** Lines to write into the JSONL. Each entry is JSON-stringified before
   *  write. Defaults to a couple of user messages so meta extraction has
   *  something to read. */
  lines?: Array<Record<string, unknown>>;
  /** mtime override (ms since epoch). Useful for ordering / cache tests. */
  mtimeMs?: number;
}

export interface CodexSessionInput {
  /** Absolute workspace cwd; the scanner filters by exact match. */
  workspacePath: string;
  /** Override the session id. Defaults to a fresh uuid. */
  sessionId?: string;
  /** Date-stamp the rollout file (`YYYY/MM/DD` subdirs). Defaults to today. */
  date?: Date;
  /** Lines to write after the session_meta header. Defaults to a couple of
   *  user_message events. */
  followupLines?: Array<Record<string, unknown>>;
  mtimeMs?: number;
}

function defaultClaudeLines(): Array<Record<string, unknown>> {
  return [
    {
      type: 'user',
      message: { content: 'Hello, can you help me?' },
    },
    {
      type: 'user',
      message: { content: 'Second turn — try this.' },
    },
  ];
}

function defaultCodexLines(): Array<Record<string, unknown>> {
  return [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Hello codex' } },
  ];
}

export function makeNativeHome(): NativeHome {
  const root = mkdtempSync(join(tmpdir(), 'gian-native-home-'));

  function addClaudeSession(opts: ClaudeSessionInput): string {
    const sessionId = opts.sessionId ?? randomUUID();
    const projectDir = join(
      root, '.claude', 'projects',
      opts.workspacePath.replaceAll('/', '-'),
    );
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    const lines = opts.lines ?? defaultClaudeLines();
    writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n'));
    if (opts.mtimeMs !== undefined) {
      const t = opts.mtimeMs / 1000;
      utimesSync(filePath, t, t);
    }
    return sessionId;
  }

  function addCodexSession(opts: CodexSessionInput): string {
    const sessionId = opts.sessionId ?? randomUUID();
    const date = opts.date ?? new Date();
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const dayDir = join(root, '.codex', 'sessions', yyyy, mm, dd);
    mkdirSync(dayDir, { recursive: true });
    const filePath = join(dayDir, `rollout-${date.getTime()}-${sessionId}.jsonl`);
    const meta = {
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: opts.workspacePath,
        git: { branch: 'main' },
      },
    };
    const followups = opts.followupLines ?? defaultCodexLines();
    const allLines = [meta, ...followups].map(l => JSON.stringify(l)).join('\n');
    writeFileSync(filePath, allLines);
    if (opts.mtimeMs !== undefined) {
      const t = opts.mtimeMs / 1000;
      utimesSync(filePath, t, t);
    }
    return sessionId;
  }

  return {
    path: root,
    addClaudeSession,
    addCodexSession,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
