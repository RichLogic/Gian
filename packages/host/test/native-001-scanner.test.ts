// Coverage for traceability rows:
//   NATIVE-001 — Native Sessions tab must scan claude / codex on-disk
//                JSONL and surface metadata (id, executor, cwd, mtime,
//                fileSize, turnCount, firstUserMessage).
//   NATIVE-002 — Adopt native session must replay JSONL into Gian
//                turns/events tables and never double-adopt the same
//                native id.
//
// The scanner walks `homedir()`; we drive it through the A3 HOME
// injection (`scanNativeSessions(workspacePath, { homeDir })`) so a
// failing test never touches the developer's real ~/.claude / ~/.codex.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  scanNativeSessions,
  clearNativeSessionsCache,
} from '../src/native/scanner.js';
import { replayNativeJsonl } from '../src/native/replay.js';
import { openDatabase } from '../src/storage/db.js';
import { makeNativeHome } from './fixtures/native-home.js';

function workspaceCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-native-001-'));
  const db = openDatabase(dir);
  const home = makeNativeHome();
  // Use a stable virtual workspace path that the scanner uses as the cwd
  // filter. The actual filesystem path doesn't need to exist — the scanner
  // only matches strings against session_meta.cwd and the encoded cc
  // project-dir name.
  const workspacePath = '/Users/test-user/projects/demo';
  return {
    dir,
    db,
    home,
    workspacePath,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      home.cleanup();
      clearNativeSessionsCache();
    },
  };
}

// ---------------------------------------------------------------------------
// NATIVE-001 — scanner output shape
// ---------------------------------------------------------------------------

test('NATIVE-001: scanner returns [] for a workspace with no native sessions', async () => {
  const ctx = workspaceCtx();
  try {
    const sessions = await scanNativeSessions(ctx.workspacePath, {
      homeDir: ctx.home.path,
      noCache: true,
    });
    assert.deepEqual(sessions, [],
      'workspace with no .claude/projects or .codex/sessions entries must yield []');
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-001: scanner picks up Claude Code sessions and surfaces id/executor/cwd/turnCount/firstUserMessage', async () => {
  const ctx = workspaceCtx();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-fixed-id-12345',
      lines: [
        { type: 'user', message: { content: 'first turn — kick off' } },
        // System-noise line; must NOT count toward turnCount.
        { type: 'user', message: { content: '<system-reminder>refreshed</system-reminder>' } },
        { type: 'user', message: { content: 'second turn' } },
      ],
    });

    const sessions = await scanNativeSessions(ctx.workspacePath, {
      homeDir: ctx.home.path,
      noCache: true,
    });
    assert.equal(sessions.length, 1, 'one cc session must surface');
    const s = sessions[0]!;
    assert.equal(s.id, sid);
    assert.equal(s.executor, 'claude');
    assert.equal(s.cwd, ctx.workspacePath);
    assert.equal(s.turnCount, 2,
      'turnCount must skip system-reminder lines (only real user messages count)');
    assert.equal(s.firstUserMessage, 'first turn — kick off',
      'firstUserMessage must come from the first real user line, not the noise');
    assert.ok(s.fileSize > 0, 'fileSize must be populated from stat()');
    assert.ok(s.updatedAt, 'updatedAt must be populated from mtime');
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-001: scanner picks up Codex sessions and reads session_meta.id / cwd / git.branch', async () => {
  const ctx = workspaceCtx();
  try {
    const sid = ctx.home.addCodexSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'codex-thread-abc',
      followupLines: [
        { type: 'event_msg', payload: { type: 'user_message', message: 'hello codex' } },
        { type: 'event_msg', payload: { type: 'user_message', message: 'second message' } },
      ],
    });

    const sessions = await scanNativeSessions(ctx.workspacePath, {
      homeDir: ctx.home.path,
      noCache: true,
    });
    const codex = sessions.find(s => s.executor === 'codex');
    assert.ok(codex, 'codex session must surface');
    assert.equal(codex!.id, sid);
    assert.equal(codex!.cwd, ctx.workspacePath);
    assert.equal(codex!.turnCount, 2,
      'codex turnCount must count event_msg user_message lines');
    assert.equal(codex!.firstUserMessage, 'hello codex');
    assert.equal(codex!.gitBranch, 'main',
      'gitBranch must round-trip from session_meta.payload.git.branch');
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-001: scanner does NOT surface codex sessions belonging to a different workspace cwd', async () => {
  const ctx = workspaceCtx();
  try {
    ctx.home.addCodexSession({
      workspacePath: '/Users/test-user/projects/other-repo',
      sessionId: 'leak-attempt',
    });
    ctx.home.addCodexSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'mine',
    });

    const sessions = await scanNativeSessions(ctx.workspacePath, {
      homeDir: ctx.home.path,
      noCache: true,
    });
    const ids = sessions.map(s => s.id).sort();
    assert.deepEqual(ids, ['mine'],
      'codex sessions with a different cwd must be filtered out (no cross-workspace leakage)');
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-001: cc sessions are addressed by encoded project dir (`/` → `-`), not by cwd field', async () => {
  // cc's project-dir naming convention encodes the workspace path. If the
  // scanner just trusted some payload field it would risk reading the wrong
  // dir; the per-test home guarantees we exercise the encoding path.
  const ctx = workspaceCtx();
  try {
    ctx.home.addClaudeSession({ workspacePath: ctx.workspacePath, sessionId: 'cc-a' });
    ctx.home.addClaudeSession({
      workspacePath: '/Users/test-user/projects/another',
      sessionId: 'cc-b',
    });

    const sessions = await scanNativeSessions(ctx.workspacePath, {
      homeDir: ctx.home.path,
      noCache: true,
    });
    const ccIds = sessions.filter(s => s.executor === 'claude').map(s => s.id).sort();
    assert.deepEqual(ccIds, ['cc-a'],
      'only the cc session under the encoded project dir for THIS workspace must surface');
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-001: scanner merges cc + codex output sorted by updatedAt desc', async () => {
  const ctx = workspaceCtx();
  try {
    const tOld = Date.now() - 60_000;
    const tNew = Date.now() - 5_000;
    ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath, sessionId: 'cc-old', mtimeMs: tOld,
    });
    ctx.home.addCodexSession({
      workspacePath: ctx.workspacePath, sessionId: 'codex-new', mtimeMs: tNew,
    });

    const sessions = await scanNativeSessions(ctx.workspacePath, {
      homeDir: ctx.home.path,
      noCache: true,
    });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.id, 'codex-new',
      'most-recent (codex-new) must come first');
    assert.equal(sessions[1]!.id, 'cc-old');
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-001: clearNativeSessionsCache forces re-scan after fixture changes', async () => {
  // Drive the production 30-second cache: a second call before clear must
  // return the cached result; after clear, it picks up new sessions.
  const ctx = workspaceCtx();
  try {
    // Use the default-cached call (no noCache) so we exercise the cache path.
    const first = await scanNativeSessions(ctx.workspacePath, { homeDir: ctx.home.path });
    assert.equal(first.length, 0);

    ctx.home.addClaudeSession({ workspacePath: ctx.workspacePath, sessionId: 'cc-late' });

    // Without clearing the cache, the cached empty result wins.
    const cached = await scanNativeSessions(ctx.workspacePath, { homeDir: ctx.home.path });
    assert.equal(cached.length, 0,
      'second scan within TTL must return the cached empty list (not re-read disk)');

    clearNativeSessionsCache();
    const fresh = await scanNativeSessions(ctx.workspacePath, { homeDir: ctx.home.path });
    assert.equal(fresh.length, 1,
      'after clearNativeSessionsCache, the new session is discovered');
    assert.equal(fresh[0]!.id, 'cc-late');
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// NATIVE-002 — replay into turns/events
// ---------------------------------------------------------------------------

test('NATIVE-002: replayNativeJsonl creates turn rows + events for an adopted cc session', () => {
  const ctx = workspaceCtx();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-replay-target',
      lines: [
        { type: 'user', message: { content: 'turn 1 input' } },
        { type: 'user', message: { content: 'turn 2 input' } },
      ],
    });

    // Seed workspace + sessions row matching the adopt endpoint.
    const wsId = randomUUID();
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(wsId, 'demo', ctx.workspacePath);

    const gianSessionId = randomUUID();
    const now = new Date().toISOString();
    ctx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode, turns,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'adopted', 'coding', ?, 'claude', NULL, 'ask', 1,
              'web', 'new', 0, ?, ?, ?)
    `).run(gianSessionId, wsId, sid, now, now);

    const filePath = join(
      ctx.home.path, '.claude', 'projects',
      ctx.workspacePath.replaceAll('/', '-'),
      `${sid}.jsonl`,
    );
    const stats = replayNativeJsonl(ctx.db, gianSessionId, filePath, 'claude');
    assert.ok(stats.turnCount >= 2, `replay must create >= 2 turns; got ${stats.turnCount}`);
    assert.ok(stats.eventCount > 0, 'replay must create at least one event per turn');

    const turns = ctx.db.prepare('SELECT status FROM turns WHERE session_id = ?')
      .all(gianSessionId) as Array<{ status: string }>;
    assert.equal(turns.length, stats.turnCount);
    for (const t of turns) {
      assert.equal(t.status, 'completed',
        'replayed turns must land as completed (they are historical, not active)');
    }
  } finally {
    ctx.cleanup();
  }
});

test('NATIVE-002: replayNativeJsonl throws on missing file — the adopt endpoint pre-checks via scanner', () => {
  // The adopt route in `web/app.ts` always verifies the native session
  // exists via `scanNativeSessions` BEFORE calling replay, so replay is
  // never invoked on a missing file in production. We pin that contract
  // here: replay does NOT silently no-op — it propagates the ENOENT so a
  // future regression where the adopt pre-check is removed becomes loud.
  const ctx = workspaceCtx();
  try {
    const wsId = randomUUID();
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(wsId, 'demo', ctx.workspacePath);
    const gianSessionId = randomUUID();
    const now = new Date().toISOString();
    ctx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode, turns,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'adopted', 'coding', ?, 'claude', NULL, 'ask', 1,
              'web', 'new', 0, 'missing-id', ?, ?)
    `).run(gianSessionId, wsId, now, now);

    assert.throws(
      () => replayNativeJsonl(ctx.db, gianSessionId, '/this/path/does/not/exist.jsonl', 'claude'),
      /ENOENT|no such file/,
      'replay must surface ENOENT so the adopt pre-check is the only guard',
    );
  } finally {
    ctx.cleanup();
  }
});
