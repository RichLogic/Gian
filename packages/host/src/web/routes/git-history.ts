import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import {
  GitCommandError,
  runGit,
  type GitCommandResult,
} from '../../workspace/git-runner.js';
import type { WsBroadcaster } from '../ws-broadcast.js';

export interface HistoryWorkingTree {
  path: string;
  workspace_id: string;
  session_id: string | null;
}

export type ResolveHistoryWorkingTree = (
  id: string,
) => HistoryWorkingTree | null | Promise<HistoryWorkingTree | null>;

type RefKind = 'local' | 'remote' | 'tag';

interface HistoryRef {
  kind: RefKind;
  name: string;
  shortName: string;
  target: string;
}

interface HistoryAuthor {
  email: string;
  name: string;
}

interface HistoryCommit {
  authoredAt: string;
  author: HistoryAuthor;
  bodyPreview: string;
  body?: string;
  committedAt: string;
  isMerge: boolean;
  isRoot: boolean;
  parents: string[];
  refs: HistoryRef[];
  sha: string;
  subject: string;
}

interface HistoryCursor {
  offset: number;
  signature: string;
  snapshot: string;
  v: 1;
}

interface ChangedPath {
  added: number;
  binary: boolean;
  oldPath?: string;
  path: string;
  removed: number;
  status: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type-changed' | 'unknown';
}

const COMMIT_LIST_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s';
const COMMIT_DETAIL_FORMAT = `${COMMIT_LIST_FORMAT}%x00%b`;
const fetches = new Map<string, Promise<GitCommandResult>>();

function queryError(c: Context, code: string, message: string, status: 400 | 404 | 409 = 400): Response {
  return c.json({ error: { code, message, retryable: false } }, status);
}

function gitError(
  c: Context,
  error: unknown,
  unknownOutcome = false,
  details: Record<string, unknown> = {},
): Response {
  if (!(error instanceof GitCommandError)) {
    return c.json({
      error: {
        code: 'git_command_failed', message: 'Git command failed', retryable: true, unknownOutcome, ...details,
      },
    }, 500);
  }
  const body = (code: string, message: string, retryable: boolean): object => ({
    error: { code, message, retryable, unknownOutcome, ...details },
  });
  switch (error.kind) {
    case 'authentication':
      return c.json(body('git_authentication_failed', 'Git remote authentication failed', false), 502);
    case 'not-repository':
      return c.json(body('git_not_repository', 'Working tree is not a Git repository', false), 409);
    case 'not-found':
      return c.json(body('git_object_not_found', 'Git object was not found', false), 404);
    case 'output-limit':
      return c.json(body('git_output_limit', 'Git returned more data than Gian can safely process', false), 413);
    case 'timeout':
      return c.json(body('git_timeout', 'Git command timed out', true), 504);
    case 'aborted':
      return c.json(body('git_aborted', 'Git command was cancelled', true), 503);
    case 'command':
      return c.json(body('git_command_failed', 'Git command failed', true), 502);
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function shortRefName(name: string, kind: RefKind): string {
  const prefix = kind === 'local' ? 'refs/heads/' : kind === 'remote' ? 'refs/remotes/' : 'refs/tags/';
  return name.slice(prefix.length);
}

async function listRefs(cwd: string, signal?: AbortSignal): Promise<HistoryRef[]> {
  const format = '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)';
  const { stdout } = await runGit(cwd, [
    'for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags',
  ], { signal, timeoutMs: 5_000, maxStdoutBytes: 2 * 1024 * 1024 });
  const refs: HistoryRef[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [name = '', object = '', objectType = '', peeled = '', peeledType = ''] = line.split('\0');
    if (!name || name.endsWith('/HEAD')) continue;
    const target = objectType === 'commit' ? object : peeledType === 'commit' ? peeled : '';
    if (!target) continue;
    const kind: RefKind = name.startsWith('refs/heads/')
      ? 'local'
      : name.startsWith('refs/remotes/')
        ? 'remote'
        : 'tag';
    refs.push({ kind, name, shortName: shortRefName(name, kind), target });
  }
  return refs;
}

function refsByCommit(refs: readonly HistoryRef[]): Map<string, HistoryRef[]> {
  const map = new Map<string, HistoryRef[]>();
  for (const ref of refs) {
    const current = map.get(ref.target) ?? [];
    current.push(ref);
    map.set(ref.target, current);
  }
  return map;
}

function parseCommits(raw: string, refs: Map<string, HistoryRef[]>, fieldCount: 7 | 8): HistoryCommit[] {
  const fields = raw.split('\0');
  // `-z` adds a record terminator. Detail format also has an explicit NUL
  // before `%b`, so an empty body is a meaningful eighth field; trim only the
  // extra terminator(s) needed to recover whole fixed-width records.
  while (fields.length % fieldCount !== 0 && fields.at(-1) === '') fields.pop();
  const commits: HistoryCommit[] = [];
  for (let offset = 0; offset + fieldCount <= fields.length; offset += fieldCount) {
    const sha = fields[offset] ?? '';
    const parentField = fields[offset + 1] ?? '';
    const parents = parentField ? parentField.split(' ') : [];
    const body = fieldCount === 8 ? (fields[offset + 7] ?? '').trim() : '';
    commits.push({
      sha,
      parents,
      author: { name: fields[offset + 2] ?? '', email: fields[offset + 3] ?? '' },
      authoredAt: fields[offset + 4] ?? '',
      committedAt: fields[offset + 5] ?? '',
      subject: fields[offset + 6] ?? '',
      bodyPreview: body.slice(0, 500),
      ...(fieldCount === 8 ? { body } : {}),
      refs: refs.get(sha) ?? [],
      isMerge: parents.length > 1,
      isRoot: parents.length === 0,
    });
  }
  return commits;
}

async function currentFullRef(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const result = await runGit(cwd, ['symbolic-ref', '-q', 'HEAD'], {
    acceptExitCodes: [1], signal, timeoutMs: 3_000, maxStdoutBytes: 4_096,
  });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

async function resolveCommit(cwd: string, rev: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runGit(cwd, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`], {
    signal, timeoutMs: 5_000, maxStdoutBytes: 4_096,
  });
  return stdout.trim();
}

async function tryResolveCommit(cwd: string, rev: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return await resolveCommit(cwd, rev, signal);
  } catch (error) {
    if (error instanceof GitCommandError && (error.kind === 'not-found' || error.kind === 'command')) return null;
    throw error;
  }
}

/** Whether a commit is still reachable from any advertised local/remote/tag
 * ref or from a detached HEAD. Keep this separate from detail/diff loading:
 * an already-open History tab must be able to retain its snapshot after a
 * force-push makes the commit unreachable. */
async function commitReachable(cwd: string, sha: string, signal?: AbortSignal): Promise<boolean> {
  const refs = await runGit(cwd, [
    'for-each-ref', '--contains', sha, '--format=%(refname)',
    'refs/heads', 'refs/remotes', 'refs/tags',
  ], { signal, timeoutMs: 5_000, maxStdoutBytes: 512 * 1024 });
  if (refs.stdout.trim()) return true;

  // A detached HEAD is not represented by for-each-ref. An unborn HEAD
  // resolves to null and therefore cannot make an existing commit reachable.
  const head = await tryResolveCommit(cwd, 'HEAD', signal);
  if (!head) return false;
  const result = await runGit(cwd, ['merge-base', '--is-ancestor', sha, head], {
    acceptExitCodes: [1], signal, timeoutMs: 5_000, maxStdoutBytes: 4_096,
  });
  return result.exitCode === 0;
}

function cursorSignature(input: { author: string; limit: number; q: string; ref: string }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('base64url');
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): HistoryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<HistoryCursor>;
    if (
      parsed.v !== 1
      || !Number.isSafeInteger(parsed.offset)
      || (parsed.offset ?? -1) < 0
      || typeof parsed.signature !== 'string'
      || typeof parsed.snapshot !== 'string'
    ) return null;
    return parsed as HistoryCursor;
  } catch {
    return null;
  }
}

function escapeExtendedRegex(raw: string): string {
  return raw.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

async function listAuthors(cwd: string, rev: string, signal?: AbortSignal): Promise<HistoryAuthor[]> {
  const { stdout } = await runGit(cwd, ['shortlog', '-sne', rev], {
    signal, timeoutMs: 10_000, maxStdoutBytes: 512 * 1024, truncateStdout: true,
  });
  const seen = new Set<string>();
  const authors: HistoryAuthor[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*\d+\s+(.+?)\s+<([^<>]+)>\s*$/);
    if (!match) continue;
    const name = match[1] ?? '';
    const email = match[2] ?? '';
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    authors.push({ name, email });
    if (authors.length === 500) break;
  }
  return authors;
}

async function emptyTree(cwd: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runGit(cwd, ['hash-object', '-t', 'tree', '--stdin'], {
    signal, stdin: '', timeoutMs: 3_000, maxStdoutBytes: 4_096,
  });
  return stdout.trim();
}

function statusName(raw: string): ChangedPath['status'] {
  switch (raw[0]) {
    case 'A': return 'added';
    case 'C': return 'copied';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'T': return 'type-changed';
    default: return 'unknown';
  }
}

function parseChangedPaths(raw: string): ChangedPath[] {
  const fields = raw.split('\0');
  const files: ChangedPath[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[i++] ?? '';
      const path = fields[i++] ?? '';
      if (path) files.push({ path, oldPath, status: statusName(status), added: 0, removed: 0, binary: false });
    } else {
      const path = fields[i++] ?? '';
      if (path) files.push({ path, status: statusName(status), added: 0, removed: 0, binary: false });
    }
  }
  return files;
}

function parseNumstat(raw: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const fields = raw.split('\0');
  const stats = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (let i = 0; i < fields.length;) {
    const record = fields[i++] ?? '';
    if (!record) continue;
    const [addedRaw = '', removedRaw = '', pathRaw = ''] = record.split('\t');
    let path = pathRaw;
    if (!path) {
      i += 1; // old path for rename/copy
      path = fields[i++] ?? '';
    }
    if (!path) continue;
    const binary = addedRaw === '-' || removedRaw === '-';
    stats.set(path, {
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary,
    });
  }
  return stats;
}

async function refFingerprint(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, [
      'for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags',
    ], { timeoutMs: 5_000, maxStdoutBytes: 2 * 1024 * 1024 });
    return createHash('sha256').update(stdout).digest('base64url');
  } catch {
    return null;
  }
}

function fetchRepository(cwd: string, repositoryKey: string): { coalesced: boolean; promise: Promise<GitCommandResult> } {
  const current = fetches.get(repositoryKey);
  if (current) return { coalesced: true, promise: current };
  let promise!: Promise<GitCommandResult>;
  promise = (async () => {
    try {
      return await runGit(cwd, ['fetch', '--prune', '--all'], {
        timeoutMs: 60_000,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
      });
    } finally {
      if (fetches.get(repositoryKey) === promise) fetches.delete(repositoryKey);
    }
  })();
  fetches.set(repositoryKey, promise);
  return { coalesced: false, promise };
}

export function registerGitHistoryRoutes(
  app: Hono,
  broadcaster: WsBroadcaster,
  resolveWorkingTree: ResolveHistoryWorkingTree,
): void {
  app.get('/api/working_trees/:id/history', async c => {
    const wt = await resolveWorkingTree(c.req.param('id'));
    if (!wt) return queryError(c, 'working_tree_not_found', 'Working tree not found', 404);
    const limit = parsePositiveInt(c.req.query('limit'), 50, 100);
    if (limit === null) return queryError(c, 'history_limit_invalid', 'limit must be an integer from 1 to 100');
    const q = (c.req.query('q') ?? '').trim();
    const author = (c.req.query('author') ?? '').trim();
    const requestedRef = (c.req.query('ref') ?? '').trim();
    if (q.length > 500) return queryError(c, 'history_query_too_long', 'q must be at most 500 characters');
    if (author.length > 320) return queryError(c, 'history_author_invalid', 'author must be at most 320 characters');
    if (requestedRef.length > 1_024) return queryError(c, 'history_ref_invalid', 'ref must be at most 1024 characters');

    try {
      const signal = c.req.raw.signal;
      const [refs, currentRef] = await Promise.all([
        listRefs(wt.path, signal),
        currentFullRef(wt.path, signal),
      ]);
      const headSha = currentRef
        ? refs.find(ref => ref.name === currentRef)?.target ?? await tryResolveCommit(wt.path, 'HEAD', signal)
        : await tryResolveCommit(wt.path, 'HEAD', signal);
      let selectedRef = requestedRef || currentRef || 'HEAD';
      if (requestedRef && !refs.some(ref => ref.name === requestedRef)) {
        return queryError(c, 'history_ref_invalid', 'ref must be an available full Git ref');
      }
      const snapshot = await tryResolveCommit(wt.path, selectedRef, signal);
      if (!snapshot) {
        if (requestedRef) return queryError(c, 'history_ref_not_found', 'Selected ref does not point to a commit', 404);
        return c.json({
          items: [], nextCursor: null, snapshot: null, currentRef, headSha, selectedRef,
          availableRefs: refs, availableAuthors: [],
        });
      }
      if (selectedRef === 'HEAD' && currentRef) selectedRef = currentRef;
      const signature = cursorSignature({ author, limit, q, ref: selectedRef });
      const rawCursor = c.req.query('cursor');
      const cursor = rawCursor ? decodeCursor(rawCursor) : null;
      if (rawCursor && !cursor) return queryError(c, 'history_cursor_invalid', 'cursor is malformed');
      if (cursor && (cursor.snapshot !== snapshot || cursor.signature !== signature)) {
        return queryError(c, 'history_cursor_stale', 'History changed; reload the first page', 409);
      }
      const offset = cursor?.offset ?? 0;
      const refMap = refsByCommit(refs);
      let items: HistoryCommit[];
      let hasMore = false;

      if (/^[0-9a-f]{4,64}$/i.test(q)) {
        const sha = await tryResolveCommit(wt.path, q, signal);
        if (!sha || offset > 0) {
          items = [];
        } else {
          const reachable = await runGit(wt.path, ['merge-base', '--is-ancestor', sha, snapshot], {
            acceptExitCodes: [1], signal, timeoutMs: 5_000, maxStdoutBytes: 4_096,
          });
          if (reachable.exitCode === 1) {
            items = [];
          } else {
            const { stdout } = await runGit(wt.path, ['show', '-s', '-z', `--format=${COMMIT_LIST_FORMAT}`, sha], {
              signal, timeoutMs: 5_000, maxStdoutBytes: 256 * 1024,
            });
            items = parseCommits(stdout, refMap, 7)
              .filter(commit => !author || commit.author.email.toLowerCase() === author.toLowerCase());
          }
        }
      } else {
        const args = [
          'log', '-z', '--topo-order', `--max-count=${limit + 1}`, `--skip=${offset}`,
          `--format=${COMMIT_LIST_FORMAT}`,
        ];
        if (q) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${q}`);
        if (author) args.push('--extended-regexp', `--author=<${escapeExtendedRegex(author)}>$`);
        args.push(snapshot);
        const { stdout } = await runGit(wt.path, args, {
          signal, timeoutMs: 15_000, maxStdoutBytes: 4 * 1024 * 1024,
        });
        items = parseCommits(stdout, refMap, 7);
        hasMore = items.length > limit;
        if (hasMore) items = items.slice(0, limit);
      }

      const availableAuthors = offset === 0 ? await listAuthors(wt.path, snapshot, signal) : [];
      return c.json({
        items,
        nextCursor: hasMore
          ? encodeCursor({ v: 1, offset: offset + limit, snapshot, signature })
          : null,
        snapshot,
        currentRef,
        headSha,
        selectedRef,
        availableRefs: refs,
        availableAuthors,
      });
    } catch (error) {
      return gitError(c, error);
    }
  });

  app.get('/api/working_trees/:id/history/:sha', async c => {
    const wt = await resolveWorkingTree(c.req.param('id'));
    if (!wt) return queryError(c, 'working_tree_not_found', 'Working tree not found', 404);
    const rawSha = c.req.param('sha');
    if (!/^[0-9a-f]{4,64}$/i.test(rawSha)) {
      return queryError(c, 'history_sha_invalid', 'sha must be a hexadecimal object id or prefix');
    }
    try {
      const signal = c.req.raw.signal;
      const sha = await tryResolveCommit(wt.path, rawSha, signal);
      if (!sha) return queryError(c, 'history_commit_not_found', 'Commit not found', 404);
      const refs = await listRefs(wt.path, signal);
      const { stdout } = await runGit(wt.path, ['show', '-s', '-z', `--format=${COMMIT_DETAIL_FORMAT}`, sha], {
        signal, timeoutMs: 5_000, maxStdoutBytes: 512 * 1024,
      });
      const commit = parseCommits(stdout, refsByCommit(refs), 8)[0];
      if (!commit) return queryError(c, 'history_commit_not_found', 'Commit not found', 404);
      const base = commit.parents[0] ?? await emptyTree(wt.path, signal);
      const [names, numstat] = await Promise.all([
        runGit(wt.path, ['diff', '--name-status', '-z', '-M', base, sha], {
          signal, timeoutMs: 15_000, maxStdoutBytes: 4 * 1024 * 1024,
        }),
        runGit(wt.path, ['diff', '--numstat', '-z', '-M', base, sha], {
          signal, timeoutMs: 15_000, maxStdoutBytes: 4 * 1024 * 1024,
        }),
      ]);
      const files = parseChangedPaths(names.stdout);
      const stats = parseNumstat(numstat.stdout);
      for (const file of files) Object.assign(file, stats.get(file.path) ?? {});
      return c.json({ ...commit, base, files });
    } catch (error) {
      return gitError(c, error);
    }
  });

  app.get('/api/working_trees/:id/history/:sha/reachability', async c => {
    const wt = await resolveWorkingTree(c.req.param('id'));
    if (!wt) return queryError(c, 'working_tree_not_found', 'Working tree not found', 404);
    const rawSha = c.req.param('sha');
    if (!/^[0-9a-f]{4,64}$/i.test(rawSha)) {
      return queryError(c, 'history_sha_invalid', 'sha must be a hexadecimal object id or prefix');
    }
    try {
      const signal = c.req.raw.signal;
      const sha = await tryResolveCommit(wt.path, rawSha, signal);
      if (!sha) return queryError(c, 'history_commit_not_found', 'Commit not found', 404);
      return c.json({ sha, reachable: await commitReachable(wt.path, sha, signal) });
    } catch (error) {
      return gitError(c, error);
    }
  });

  app.get('/api/working_trees/:id/history/:sha/diff', async c => {
    const wt = await resolveWorkingTree(c.req.param('id'));
    if (!wt) return queryError(c, 'working_tree_not_found', 'Working tree not found', 404);
    const rawSha = c.req.param('sha');
    const path = c.req.query('path') ?? '';
    if (!/^[0-9a-f]{4,64}$/i.test(rawSha)) {
      return queryError(c, 'history_sha_invalid', 'sha must be a hexadecimal object id or prefix');
    }
    if (
      !path
      || path.length > 4_096
      || path.includes('\0')
      || path.startsWith('/')
      || path.split('/').some(part => part === '..')
    ) {
      return queryError(c, 'history_path_invalid', 'path must be a repository-relative path');
    }
    try {
      const signal = c.req.raw.signal;
      const sha = await tryResolveCommit(wt.path, rawSha, signal);
      if (!sha) return queryError(c, 'history_commit_not_found', 'Commit not found', 404);
      const metadata = await runGit(wt.path, ['show', '-s', '-z', `--format=${COMMIT_LIST_FORMAT}`, sha], {
        signal, timeoutMs: 5_000, maxStdoutBytes: 256 * 1024,
      });
      const commit = parseCommits(metadata.stdout, new Map(), 7)[0];
      if (!commit) return queryError(c, 'history_commit_not_found', 'Commit not found', 404);
      const base = commit.parents[0] ?? await emptyTree(wt.path, signal);
      const result = await runGit(wt.path, [
        'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', base, sha, '--', path,
      ], {
        signal,
        timeoutMs: 20_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        truncateStdout: true,
      });
      return c.json({ sha, base, path, diff: result.stdout, truncated: result.truncated });
    } catch (error) {
      return gitError(c, error);
    }
  });

  app.post('/api/working_trees/:id/fetch', async c => {
    const wt = await resolveWorkingTree(c.req.param('id'));
    if (!wt) return queryError(c, 'working_tree_not_found', 'Working tree not found', 404);
    const before = await refFingerprint(wt.path);
    // Every Gian working tree for one workspace shares the same repository;
    // coalesce concurrent Fetch clicks across its main and linked worktrees.
    const fetch = fetchRepository(wt.path, wt.workspace_id);
    try {
      await fetch.promise;
      const after = await refFingerprint(wt.path);
      const refsChanged = before !== null && after !== null && before !== after;
      broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: wt.workspace_id, reason: 'fetch' });
      return c.json({ ok: true, fetchedAt: new Date().toISOString(), refsChanged, coalesced: fetch.coalesced });
    } catch (error) {
      const after = await refFingerprint(wt.path);
      const refsChanged = before !== null && after !== null && before !== after;
      if (refsChanged) {
        broadcaster.broadcast({ type: 'workspace:git-updated', workspace_id: wt.workspace_id, reason: 'fetch' });
      }
      // `fetch --all` can update an earlier remote before a later one fails.
      // A timeout is intrinsically uncertain; another failure is uncertain
      // only when the before/after ref fingerprint proves a partial update.
      const unknownOutcome = refsChanged
        || (error instanceof GitCommandError && error.kind === 'timeout');
      return gitError(c, error, unknownOutcome, { refsChanged });
    }
  });
}
