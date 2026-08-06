import type { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { Db } from '../../storage/db.js';
import { detectDefaultBranch, listGitWorktrees } from '../../workspace/git.js';
import {
  buildRawPreviewHeaders,
  rawPreviewOversize,
} from '../../workspace/preview-headers.js';
import { resolveWithinWorkspace } from '../../workspace/safe-path.js';
import type { WsBroadcaster } from '../ws-broadcast.js';
import { registerApplicationRoutes } from './applications.js';
import { registerWorkspaceGitRoutes } from './workspace-git.js';
import {
  extTreeId,
  gitBranchAt,
} from '../working-tree-git.js';

export function registerWorkingTreeRoutes(
  app: Hono,
  db: Db,
  broadcaster: WsBroadcaster,
): void {
  // Working trees — the right unit for "files I can see and edit right now".
  //
  // A working tree = one git working directory. A workspace's primary checkout
  // is a working tree (id `ws:<workspace_id>`); each session.worktree_path is
  // a linked worktree (id `wt:<session_id>`). All file/tree/diff/changed ops
  // operate on a working tree, not a workspace, because git status / git diff
  // / file listings only make sense at the level of a specific checkout.
  // -------------------------------------------------------------------------

  registerWorkspaceGitRoutes(app, db, broadcaster);
  function resolveWorkingTree(id: string): { path: string; workspace_id: string; session_id: string | null } | null {
    if (id.startsWith('ws:')) {
      const wsId = id.slice(3);
      const ws = db.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(wsId) as
        | { id: string; path: string } | undefined;
      if (!ws) return null;
      return { path: ws.path, workspace_id: ws.id, session_id: null };
    }
    if (id.startsWith('wt:')) {
      const sid = id.slice(3);
      const s = db.prepare('SELECT id, workspace_id, worktree_path FROM sessions WHERE id = ?').get(sid) as
        | { id: string; workspace_id: string; worktree_path: string | null } | undefined;
      if (!s || !s.worktree_path) return null;
      return { path: s.worktree_path, workspace_id: s.workspace_id, session_id: s.id };
    }
    if (id.startsWith('ext:')) {
      // ext:<workspaceId>:<base64url(path)> — the encoded path is a HINT only.
      // SEC-014 boundary: the path is accepted solely when it is a CURRENT
      // member of `git worktree list` for the named workspace's repo, so a
      // stale or forged id can never point the file/diff routes at an
      // arbitrary directory.
      const rest = id.slice(4);
      const sepIdx = rest.indexOf(':');
      if (sepIdx <= 0) return null;
      const wsId = rest.slice(0, sepIdx);
      const encoded = rest.slice(sepIdx + 1);
      const ws = db.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(wsId) as
        | { id: string; path: string } | undefined;
      if (!ws) return null;
      let decoded: string;
      try {
        decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      } catch {
        return null;
      }
      if (!isAbsolute(decoded)) return null;
      const hit = listGitWorktrees(ws.path).find(w => w.path === decoded);
      if (!hit) return null;
      return { path: hit.path, workspace_id: ws.id, session_id: null };
    }
    return null;
  }

  // Diff-source scope for the Changes review surface. Aligned with Codex's
  // five-option picker: working-tree slices (`unstaged`/`staged`), the last
  // commit (`commit`), the whole branch vs its base (`branch`), and the files
  // the agent touched in its most recent turn (`lastturn`). `all` is retained
  // for the GitBadge / legacy default and is no longer offered in the web UI.
  type ChangeScope = 'all' | 'unstaged' | 'staged' | 'commit' | 'branch' | 'lastturn';

  // Empty-tree object hash — the diff base for a root commit (no parent).
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  function gitText(cwd: string, args: string[]): string {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  // Base for the `commit` scope: the given ref's parent, or the empty tree
  // when the ref is the root commit (so the first commit still renders as
  // all-added). Defaults to HEAD for the legacy "HEAD's delta" behavior.
  function commitBaseOf(cwd: string, ref: string = 'HEAD'): string {
    try {
      execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '-q', `${ref}~1`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return `${ref}~1`;
    } catch {
      return EMPTY_TREE;
    }
  }

  // The `commit` scope optionally pins a single commit via `?sha=` (Codex's
  // Committed submenu). Only hex shas are accepted — anything else falls back
  // to HEAD's delta.
  function parseCommitSha(raw: string | undefined): string | null {
    return raw && /^[0-9a-f]{7,40}$/i.test(raw) ? raw : null;
  }

  // Base for the `branch` scope: the merge-base of HEAD with the compare
  // base — an explicit `?base=` ref when given (the web UI's second-row
  // branch picker), else the session's recorded `base_branch` for a `wt:`
  // tree, else the repo's detected default. Falls back to HEAD (→ empty
  // branch diff) when there's no distinct base or git can't resolve a
  // merge-base. Result is a commit-ish suitable for `git diff <base>`.
  function autoBaseRef(wt: { path: string; session_id: string | null }): string | null {
    if (wt.session_id) {
      const row = db
        .prepare('SELECT base_branch FROM sessions WHERE id = ?')
        .get(wt.session_id) as { base_branch: string | null } | undefined;
      if (row?.base_branch) return row.base_branch;
    }
    return detectDefaultBranch(wt.path);
  }

  function branchBase(wt: { path: string; session_id: string | null }, overrideRef?: string | null): string {
    const base = overrideRef ?? autoBaseRef(wt);
    if (!base) return 'HEAD';
    const mb = gitText(wt.path, ['merge-base', base, 'HEAD']).trim();
    return mb || 'HEAD';
  }

  // The `branch` scope optionally pins its compare base via `?base=` (the
  // second-row branch picker). Only plausible ref names are accepted —
  // anything else (or an unresolvable ref, caught by merge-base failing)
  // falls back to the auto-detected base.
  function parseBaseRef(raw: string | undefined): string | null {
    if (!raw || raw.length > 200) return null;
    return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) && !raw.includes('..') ? raw : null;
  }

  // Distinct file paths the agent edited in the session's most recent turn,
  // pulled from file-change display projections. Powers the `lastturn` scope. Empty for a
  // non-session (`ws:`) working tree or a session with no recorded turns.
  function lastTurnPaths(sessionId: string | null): Set<string> {
    const paths = new Set<string>();
    if (!sessionId) return paths;
    const turn = db
      .prepare('SELECT id FROM turns WHERE session_id = ? ORDER BY turn_number DESC LIMIT 1')
      .get(sessionId) as { id: string } | undefined;
    if (!turn) return paths;
    const rows = db
      .prepare(
        `SELECT data FROM events
         WHERE turn_id = ?
           AND (type = 'file_change'
                OR (json_valid(data) AND json_extract(data, '$.display.type') = 'activity.file-change'))`,
      )
      .all(turn.id) as Array<{ data: string }>;
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.data) as {
          files?: Array<{ path?: string }>;
          display?: { data?: { files?: Array<{ path?: string }> } };
        };
        const files = parsed.display?.data?.files ?? parsed.files ?? [];
        for (const f of files) if (f.path) paths.add(f.path);
      } catch {
        // malformed event payload — skip
      }
    }
    return paths;
  }

  type ChangedFile = { path: string; kind: 'create' | 'update' | 'delete' | 'rename'; staged: boolean; added: number; removed: number };

  // Fill per-file added/removed counts on a changed-file list: `git diff
  // --numstat` for tracked diffs, then an on-disk line count for untracked
  // creates that numstat misses (staged=false, still added=0). Shared by every
  // scope so the count logic lives in one place. Mutates `entries` in place.
  function fillLineCounts(cwd: string, entries: ChangedFile[], numstatArgs: string[]): void {
    try {
      const numstat = execFileSync('git', ['-C', cwd, ...numstatArgs], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const stats = new Map<string, { added: number; removed: number }>();
      for (const line of numstat.split('\n')) {
        if (!line) continue;
        const [a, r, p] = line.split('\t');
        if (!p) continue;
        stats.set(p, {
          added: a === '-' ? 0 : Number(a) || 0,
          removed: r === '-' ? 0 : Number(r) || 0,
        });
      }
      for (const e of entries) {
        const s = stats.get(e.path);
        if (s) { e.added = s.added; e.removed = s.removed; }
      }
    } catch {
      // numstat optional
    }

    // Untracked files don't appear in any `git diff --numstat`. Count their
    // lines from disk so they contribute to +N totals. Skip files larger than
    // 1 MiB or with a null byte in the first 8 KiB (binary).
    for (const e of entries) {
      if (e.kind !== 'create' || e.staged || e.added !== 0) continue;
      try {
        const filePath = resolve(cwd, e.path);
        const st = statSync(filePath);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const buf = readFileSync(filePath);
        const probe = buf.subarray(0, Math.min(buf.length, 8192));
        if (probe.includes(0)) continue;
        let lines = 0;
        for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++;
        // Count a trailing-newline-less last line as a line too.
        if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines++;
        e.added = lines;
      } catch {
        // file vanished or unreadable — leave at 0
      }
    }
  }

  // Per-file diff aligned with what Files Changed surfaces. `scope` selects
  // which slice of the change set to render:
  //   - 'all' (default): both staged and unstaged edits on tracked files
  //     (via `diff HEAD`), and a synthesized new-file diff for untracked
  //     paths (via `diff --no-index` against /dev/null). Bare `git diff --
  //     <path>` would miss anything already `git add`-ed and every untracked
  //     file, so 'all' uses HEAD as the base.
  //   - 'unstaged': only working-tree-vs-index changes (`diff -- <path>`),
  //     still synthesizing untracked files via --no-index.
  //   - 'staged': only index-vs-HEAD changes (`diff --cached -- <path>`).
  //     Untracked files have nothing staged, so no --no-index fallback.
  function computeFileDiff(cwd: string, rel: string, scope: ChangeScope = 'all', wt?: { path: string; session_id: string | null }, commitSha?: string | null, baseRef?: string | null): string {
    const commitRef = commitSha ?? 'HEAD';
    const baseArgs =
      scope === 'staged' ? ['diff', '--cached'] :
      scope === 'unstaged' ? ['diff'] :
      scope === 'commit' ? ['diff', commitBaseOf(cwd, commitRef), commitRef] :
      scope === 'branch' ? ['diff', branchBase(wt ?? { path: cwd, session_id: null }, baseRef)] :
      ['diff', 'HEAD']; // 'all' and 'lastturn' both diff the working tree vs HEAD
    try {
      const out = execFileSync('git', ['-C', cwd, ...baseArgs, '--', rel], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out) return out;
    } catch {
      // Not a repo, or some other git failure — nothing more we can do.
      return '';
    }
    // 'staged' and 'commit' scopes never synthesize untracked diffs — an
    // untracked file has nothing in the index and was in no commit. An empty
    // result there is correct as-is. ('branch'/'lastturn'/'all'/'unstaged'
    // fall through so a new-on-branch / agent-created file shows as added.)
    if (scope === 'staged' || scope === 'commit') return '';
    // Empty result so far means either tracked-but-clean or untracked. Probe
    // tracked-ness; only fall through to --no-index for untracked.
    try {
      execFileSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', rel], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return '';
    } catch {
      // Untracked: synthesize a "new file" diff. `--no-index` exits 1 when
      // the two paths differ, so stdout is on the thrown error object.
      try {
        execFileSync('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', rel], {
          timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
        return '';
      } catch (err) {
        const e = err as { stdout?: Buffer | string; status?: number };
        if (e.status === 1 && e.stdout != null) {
          return typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf8');
        }
        return '';
      }
    }
  }

  // Shared parser for the `scope` query param across the working-tree change
  // routes. Anything unrecognized falls back to 'all' so existing callers
  // (and GitBadge) keep today's behavior.
  function parseScope(raw: string | undefined): ChangeScope {
    return raw === 'unstaged' || raw === 'staged' || raw === 'commit' ||
      raw === 'branch' || raw === 'lastturn'
      ? raw
      : 'all';
  }

  app.get('/api/working_trees', c => {
    const wsRows = db.prepare('SELECT id, name, path FROM workspaces ORDER BY sort_order ASC').all() as
      Array<{ id: string; name: string; path: string }>;
    const sessRows = db.prepare(`
      SELECT id, name, workspace_id, worktree_path, branch
      FROM sessions
      WHERE worktree_path IS NOT NULL AND archived = 0
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; name: string | null; workspace_id: string; worktree_path: string; branch: string | null }>;

    const out: Array<{
      id: string;
      kind: 'workspace' | 'worktree';
      label: string;
      path: string;
      branch: string | null;
      workspace_id: string;
      workspace_name: string;
      session_id: string | null;
      session_name: string | null;
    }> = [];

    for (const ws of wsRows) {
      out.push({
        id: `ws:${ws.id}`,
        kind: 'workspace',
        label: ws.name,
        path: ws.path,
        branch: gitBranchAt(ws.path),
        workspace_id: ws.id,
        workspace_name: ws.name,
        session_id: null,
        session_name: null,
      });
    }
    for (const s of sessRows) {
      const ws = wsRows.find(w => w.id === s.workspace_id);
      out.push({
        id: `wt:${s.id}`,
        kind: 'worktree',
        label: s.name || `session ${s.id.slice(0, 6)}`,
        path: s.worktree_path,
        branch: s.branch ?? gitBranchAt(s.worktree_path),
        workspace_id: s.workspace_id,
        workspace_name: ws?.name ?? '',
        session_id: s.id,
        session_name: s.name,
      });
    }
    // External worktrees (created outside Gian — e.g. by the agent itself via
    // `git worktree add`). Discovered per workspace via `git worktree list`;
    // deduped against the workspace main tree and DB-owned session worktrees
    // (the `wt:` entry wins on overlap).
    const sessionPathsByWs = new Map<string, Set<string>>();
    for (const s of sessRows) {
      let set = sessionPathsByWs.get(s.workspace_id);
      if (!set) sessionPathsByWs.set(s.workspace_id, set = new Set());
      set.add(s.worktree_path);
    }
    for (const ws of wsRows) {
      const known = sessionPathsByWs.get(ws.id) ?? new Set<string>();
      known.add(ws.path);
      for (const wt of listGitWorktrees(ws.path)) {
        if (known.has(wt.path)) continue;
        out.push({
          id: extTreeId(ws.id, wt.path),
          kind: 'worktree',
          label: basename(wt.path),
          path: wt.path,
          branch: wt.branch ?? gitBranchAt(wt.path),
          workspace_id: ws.id,
          workspace_name: ws.name,
          session_id: null,
          session_name: null,
        });
      }
    }
    return c.json(out);
  });

  app.get('/api/working_trees/:id/tree', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const out = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          path: rel ? `${rel}/${e.name}` : e.name,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return c.json(out);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Flat, recursive list of every file path in the working tree. Powers the
  // FILES panel search box (filter-by-name across the whole tree, not just
  // the lazily-expanded nodes). Same ignore rules as /tree (dotfiles +
  // node_modules), capped so a pathological repo can't OOM the response.
  app.get('/api/working_trees/:id/files', async c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const MAX = 20000;
    const out: string[] = [];
    async function walk(absDir: string, rel: string): Promise<void> {
      if (out.length >= MAX) return;
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      for (const e of entries) {
        if (out.length >= MAX) return;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        // isDirectory() on a Dirent does not follow symlinks, so symlinked
        // dirs are skipped — that also guards against recursion loops.
        if (e.isDirectory()) await walk(`${absDir}/${e.name}`, childRel);
        else if (e.isFile()) out.push(childRel);
      }
    }
    await walk(wt.path, '');
    return c.json({ files: out, truncated: out.length >= MAX });
  });

  app.get('/api/working_trees/:id/file', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) return c.json({ error: 'not a file' }, 400);
      if (info.size > 1024 * 1024) return c.json({ error: 'file too large' }, 413);
      const content = await readFile(resolved, 'utf8');
      return c.json({ path: rel, size: info.size, content });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Serve a file's raw bytes with a real Content-Type so the browser can
  // render html / display pdf / show images directly. Used by the Files
  // view's "Open in new tab" for previewable types. Path-traversal check
  // mirrors /file. Security headers follow the hardened raw-preview
  // endpoint: Content-Disposition:inline, X-Frame-Options:DENY, strict
  // CSP for html/svg so a user-authored html file can't pivot into the
  // host origin.
  app.get('/api/working_trees/:id/raw', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) return c.json({ error: 'not a file' }, 400);
      if (rawPreviewOversize(info.size)) return c.json({ error: 'file too large' }, 413);
      const { headers } = buildRawPreviewHeaders({ rel, size: info.size });
      const bytes = await readFile(resolved);
      return new Response(new Uint8Array(bytes), { status: 200, headers });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/working_trees/:id/commits', c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    // Commits on this branch since it diverged from its base — powers the
    // Committed submenu in the Changes scope picker (Codex parity). Newest
    // first, capped at 50. Empty when there's no distinct base.
    const base = branchBase(wt);
    const out = gitText(wt.path, [
      'log', '-n', '50', '--format=%H%x1f%s%x1f%cr', `${base}..HEAD`,
    ]);
    const commits = out
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha = '', subject = '', rel = ''] = line.split('\x1f');
        return { sha, subject, rel };
      })
      .filter(row => row.sha);
    return c.json(commits);
  });

  app.get('/api/working_trees/:id/branches', c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    // Branch picker data for the Branch scope's second row: the checked-out
    // head, the auto-detected compare base (same logic the branch scope uses
    // when no explicit base is pinned), and every local + remote branch.
    const head = gitText(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'HEAD';
    const branches = [
      ...new Set(
        gitText(wt.path, ['branch', '-a', '--format=%(refname:short)'])
          .split('\n')
          .map(b => b.trim())
          // The `origin/HEAD` symref entry is noise in a picker.
          .filter(b => b && !b.endsWith('/HEAD')),
      ),
    ];
    return c.json({ head, base: autoBaseRef(wt), branches });
  });

  app.get('/api/working_trees/:id/diff', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);
    void resolved;
    const scope = parseScope(c.req.query('scope'));
    const sha = parseCommitSha(c.req.query('sha'));
    const base = scope === 'branch' ? parseBaseRef(c.req.query('base')) : null;
    return c.json({ diff: computeFileDiff(wt.path, rel, scope, wt, sha, base) });
  });

  app.get('/api/working_trees/:id/file_meta', async c => {
    const id = c.req.param('id');
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const resolved = await resolveWithinWorkspace(wt.path, rel);
    if (!resolved) return c.json({ error: 'path escapes working tree' }, 400);

    let uncommitted = false;
    try {
      const out = execFileSync('git', ['-C', wt.path, 'status', '--porcelain', '--', rel], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      uncommitted = out.trim().length > 0;
    } catch {
      // no git or not a repo
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayIso = todayStart.toISOString().slice(0, 19).replace('T', ' ');
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM events
         WHERE (type = 'file_change'
                OR (json_valid(data) AND json_extract(data, '$.display.type') = 'activity.file-change'))
           AND data LIKE ? AND created_at >= ?`,
      )
      .get(`%"path":"${rel}"%`, todayIso) as { n: number };

    return c.json({ uncommitted, edit_count_today: row.n });
  });

  // Changed-file list for the Changes review surface. `scope` selects which
  // slice; the five web-facing scopes mirror Codex's picker.
  //
  // Working-tree scopes — `git status --porcelain -z`, X (index) / Y (worktree)
  // codes mapped to a single kind:
  //   - all      = every changed file; counts via `git diff --numstat HEAD`
  //                (staged+unstaged combined). The original behavior; the
  //                default (no scope query) is byte-for-byte unchanged and
  //                GitBadge + FILE-004 tests depend on it. Not offered in the UI.
  //   - unstaged = files dirty in the worktree-vs-index (Y column) plus
  //                untracked; counts via `git diff --numstat` (no HEAD).
  //   - staged   = files staged in index-vs-HEAD (X column); counts via
  //                `git diff --numstat --cached`.
  //
  // History scopes — `git diff --name-status` against a base (see the branch in
  // the handler), staged=false throughout:
  //   - commit   = HEAD's committed delta (parent..HEAD, or empty-tree..HEAD
  //                for a root commit).
  //   - branch   = the whole branch vs its base (merge-base of HEAD with the
  //                session's base_branch / repo default) + untracked.
  //   - lastturn = the files the agent edited in its most recent turn
  //                (file_change events), shown as their live diff vs HEAD.
  app.get('/api/working_trees/:id/changed', c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);
    const scope = parseScope(c.req.query('scope'));

    // History scopes (commit / branch / lastturn) read the file list from
    // `git diff --name-status` against a base ref, not `git status`.
    if (scope === 'commit' || scope === 'branch' || scope === 'lastturn') {
      // Ref(s) to diff against. `<base> <ref>` = the committed delta (commit,
      // optionally pinned to `?sha=`); a single ref = that ref vs the working
      // tree (branch / lastturn).
      const commitRef = parseCommitSha(c.req.query('sha')) ?? 'HEAD';
      const baseRef = scope === 'branch' ? parseBaseRef(c.req.query('base')) : null;
      const baseRange =
        scope === 'commit' ? [commitBaseOf(wt.path, commitRef), commitRef] :
        scope === 'branch' ? [branchBase(wt, baseRef)] :
        ['HEAD']; // lastturn diffs the working tree vs HEAD, then filters
      const out: ChangedFile[] = [];
      const recs = gitText(wt.path, ['diff', '--name-status', '-z', ...baseRange]).split('\0');
      for (let i = 0; i < recs.length; i++) {
        const status = recs[i];
        if (!status) continue;
        const s0 = status[0]!;
        let path: string;
        let kind: ChangedFile['kind'];
        if (s0 === 'R' || s0 === 'C') {
          // rename/copy: `<status>\0<oldpath>\0<newpath>\0` — keep the new name.
          path = recs[i + 2] ?? recs[i + 1] ?? '';
          i += 2;
          kind = 'rename';
        } else {
          path = recs[i + 1] ?? '';
          i += 1;
          kind = s0 === 'A' ? 'create' : s0 === 'D' ? 'delete' : 'update';
        }
        if (path) out.push({ path, kind, staged: false, added: 0, removed: 0 });
      }
      // branch / lastturn also surface untracked files (new on the branch, or
      // freshly created by the agent). commit never does — they're in no commit.
      if (scope === 'branch' || scope === 'lastturn') {
        for (const rec of gitText(wt.path, ['status', '--porcelain=1', '-z']).split('\0')) {
          if (!rec.startsWith('?? ')) continue;
          const p = rec.slice(3);
          if (p && !out.some(e => e.path === p)) {
            out.push({ path: p, kind: 'create', staged: false, added: 0, removed: 0 });
          }
        }
      }
      // lastturn: keep only the paths the agent edited in its most recent turn.
      let list = out;
      if (scope === 'lastturn') {
        const turnPaths = lastTurnPaths(wt.session_id);
        list = out.filter(e => turnPaths.has(e.path));
      }
      fillLineCounts(wt.path, list, ['diff', '--numstat', ...baseRange]);
      return c.json(list);
    }

    let raw = '';
    try {
      raw = execFileSync('git', ['-C', wt.path, 'status', '--porcelain=1', '-z'], {
        timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return c.json([]);
    }

    // -z output: each entry is `XY <space> <path>\0`. Renames (R/C) are
    // followed by an extra `<oldpath>\0` record we discard.
    const out: ChangedFile[] = [];
    const records = raw.split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || rec.length < 3) continue;
      const x = rec[0]!;
      const y = rec[1]!;
      const path = rec.slice(3);
      const isRename = x === 'R' || y === 'R' || x === 'C' || y === 'C';
      if (isRename) i += 1; // skip the old-name record that follows
      // Bucket by porcelain column. X (index) dirty → there's a staged
      // change; Y (worktree) dirty, or `??` untracked → there's an unstaged
      // change. A file can be in both buckets (e.g. partially staged).
      const untracked = x === '?';
      const hasStaged = x !== ' ' && x !== '?';
      const hasUnstaged = y !== ' ' || untracked;
      if (scope === 'staged' && !hasStaged) continue;
      if (scope === 'unstaged' && !hasUnstaged) continue;
      // For unstaged/staged scope, derive kind from the relevant column so a
      // partially-staged file reports the right kind per slice. For 'all',
      // keep the original X-then-Y precedence so output is unchanged.
      const code =
        scope === 'unstaged' ? (untracked ? '?' : y) :
        scope === 'staged' ? x :
        (x !== ' ' && x !== '?' ? x : y);
      let kind: 'create' | 'update' | 'delete' | 'rename';
      if (isRename) kind = 'rename';
      else if (code === 'A' || code === '?') kind = 'create';
      else if (code === 'D') kind = 'delete';
      else kind = 'update';
      // `staged` is the per-file flag: in 'staged' scope every entry is staged;
      // in 'unstaged' scope every entry is unstaged; in 'all' scope it reflects
      // the X column (original behavior).
      const staged = scope === 'staged' ? true : scope === 'unstaged' ? false : hasStaged;
      out.push({ path, kind, staged, added: 0, removed: 0 });
    }

    // Per-file added/removed line counts. The numstat base mirrors `scope`:
    //   all      → `git diff --numstat HEAD`     (staged + unstaged)
    //   unstaged → `git diff --numstat`          (worktree vs index)
    //   staged   → `git diff --numstat --cached` (index vs HEAD)
    const numstatArgs =
      scope === 'staged' ? ['diff', '--numstat', '--cached'] :
      scope === 'unstaged' ? ['diff', '--numstat'] :
      ['diff', '--numstat', 'HEAD'];
    fillLineCounts(wt.path, out, numstatArgs);

    return c.json(out);
  });

  registerApplicationRoutes(app, db, resolveWorkingTree);
}
