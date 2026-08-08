import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitHistory,
  GitHistoryRequestError,
  loadGitHistory,
  loadGitHistoryCommit,
  loadGitHistoryCommitReachability,
  loadGitHistoryFileDiff,
} from '../src/api.js';

afterEach(() => vi.restoreAllMocks());

describe('Git History API client', () => {
  it('encodes worktree ids and filters without exposing cursor internals', async () => {
    const page = {
      items: [], nextCursor: 'opaque+/=', snapshot: 'a'.repeat(40), currentRef: 'refs/heads/main',
      headSha: 'a'.repeat(40),
      selectedRef: 'refs/heads/main', availableRefs: [], availableAuthors: [],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(page), { status: 200 }),
    );
    await expect(loadGitHistory('wt:session/id', {
      limit: 25,
      cursor: 'opaque+/=',
      q: 'fix body',
      ref: 'refs/remotes/origin/main',
      author: 'a+b@example.invalid',
    })).resolves.toEqual(page);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/working_trees/wt%3Asession%2Fid/history?');
    const query = new URL(url, 'http://test.invalid').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      limit: '25', cursor: 'opaque+/=', q: 'fix body',
      ref: 'refs/remotes/origin/main', author: 'a+b@example.invalid',
    });
  });

  it('loads commit metadata, reachability, and one lazy file diff from separate endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'abc', files: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'abc', reachable: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'abc', path: 'a b.ts', diff: 'patch' }), { status: 200 }));
    await loadGitHistoryCommit('ws:w1', 'abc');
    await loadGitHistoryCommitReachability('ws:w1', 'abc');
    await loadGitHistoryFileDiff('ws:w1', 'abc', 'a b.ts');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/working_trees/ws%3Aw1/history/abc');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/working_trees/ws%3Aw1/history/abc/reachability');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/working_trees/ws%3Aw1/history/abc/diff?path=a+b.ts');
  });

  it('preserves structured Fetch unknown-outcome details for UI reconciliation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'git_timeout', message: 'Git command timed out', retryable: true,
        unknownOutcome: true, refsChanged: true,
      },
    }), { status: 504 }));
    const error = await fetchGitHistory('ws:w1').catch(thrown => thrown);
    expect(error).toBeInstanceOf(GitHistoryRequestError);
    expect(error).toMatchObject({
      code: 'git_timeout', retryable: true, unknownOutcome: true, refsChanged: true, status: 504,
    });
  });
});
