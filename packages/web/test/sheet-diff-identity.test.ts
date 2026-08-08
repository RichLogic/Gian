import { describe, expect, it } from 'vitest';
import {
  normalizeDiffQueryIdentity,
  tabMatchesDiffQuery,
  type DiffQueryIdentity,
  type SheetTab,
} from '../src/components/sheet-model.js';

function tabFor(query: DiffQueryIdentity): SheetTab {
  return {
    id: 'diff-1',
    group: 'diffs',
    name: '2 files',
    kind: 'diff',
    icoKind: 'diff',
    ico: '±',
    workingTreeId: query.workingTreeId,
    sessionId: query.sessionId ?? undefined,
    diffScope: query.scope,
    diffSha: query.sha,
    diffBase: query.base,
    diffPaths: ['src/a.ts', 'src/b.ts'],
  };
}

describe('diff query identity', () => {
  it('normalizes selectors that are inactive for the requested scope', () => {
    expect(normalizeDiffQueryIdentity('wt:1', 'commit', 'abc123', 'main', 'session-1')).toEqual({
      workingTreeId: 'wt:1', scope: 'commit', sha: 'abc123', base: null, sessionId: null,
    });
    expect(normalizeDiffQueryIdentity('wt:1', 'branch', 'abc123', 'main', 'session-1')).toEqual({
      workingTreeId: 'wt:1', scope: 'branch', sha: null, base: 'main', sessionId: null,
    });
    expect(normalizeDiffQueryIdentity('wt:1', 'lastturn', 'abc123', 'main', 'session-1')).toEqual({
      workingTreeId: 'wt:1', scope: 'lastturn', sha: null, base: null, sessionId: 'session-1',
    });
  });

  it('rejects stale working-tree, scope, ref, and last-turn session contexts', () => {
    const exact = normalizeDiffQueryIdentity('wt:1', 'commit', 'abc123');
    const tab = tabFor(exact);
    expect(tabMatchesDiffQuery(tab, exact)).toBe(true);

    const mismatches = [
      normalizeDiffQueryIdentity('wt:2', 'commit', 'abc123'),
      normalizeDiffQueryIdentity('wt:1', 'branch', null, 'main'),
      normalizeDiffQueryIdentity('wt:1', 'commit', 'def456'),
    ];
    for (const mismatch of mismatches) expect(tabMatchesDiffQuery(tab, mismatch)).toBe(false);

    const lastTurn = normalizeDiffQueryIdentity('ws:1', 'lastturn', null, null, 'session-1');
    expect(tabMatchesDiffQuery(tabFor(lastTurn), lastTurn)).toBe(true);
    expect(tabMatchesDiffQuery(
      tabFor(lastTurn),
      normalizeDiffQueryIdentity('ws:1', 'lastturn', null, null, 'session-2'),
    )).toBe(false);
  });
});
