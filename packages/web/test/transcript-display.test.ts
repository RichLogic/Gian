import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import {
  displayDataForEnvelope,
  displayTypeForEnvelope,
  ensureLatestTurnEnd,
  ensureTurnEnd,
  formatAnsweredWith,
  mapApprovalDecision,
  normalizeRisk,
  parseDiffUpdated,
  parseUnifiedDiff,
} from '../src/transcript/apply.js';
import type { TranscriptItem } from '../src/types.js';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    session_id: 's-1',
    turn: 1,
    call_id: 'c-1',
    event: 'output.text',
    ts: 1,
    data: {},
    ...overrides,
  };
}

describe('displayTypeForEnvelope / displayDataForEnvelope', () => {
  it('prefers display.type and falls back to the legacy event map', () => {
    expect(displayTypeForEnvelope(envelope({
      display: { type: 'message', data: { text: 'hi' } },
    }))).toBe('message');
    expect(displayTypeForEnvelope(envelope({ event: 'turn.started' }))).toBe('state.turn-started');
    expect(displayTypeForEnvelope(envelope({ event: 'unknown.event' }))).toBeUndefined();
  });

  it('prefers display.data then envelope.data', () => {
    expect(displayDataForEnvelope(envelope({
      data: { a: 1 },
      display: { type: 'message', data: { text: 'hi' } },
    }))).toEqual({ text: 'hi' });
    expect(displayDataForEnvelope(envelope({ data: { a: 1 } }))).toEqual({ a: 1 });
  });
});

describe('normalizeRisk / mapApprovalDecision / formatAnsweredWith', () => {
  it('maps risk words and approval decisions', () => {
    expect(normalizeRisk('HIGH')).toBe('high');
    expect(normalizeRisk('danger-full-access')).toBe('high');
    expect(normalizeRisk('low-risk')).toBe('low');
    expect(normalizeRisk('')).toBe('medium');
    expect(mapApprovalDecision('declined')).toBe('declined');
    expect(mapApprovalDecision('keep_planning')).toBe('declined');
    expect(mapApprovalDecision('approved-session')).toBe('approved-session');
    expect(mapApprovalDecision('allow')).toBe('approved-once');
  });

  it('flattens AskUserQuestion answers and rejects junk', () => {
    expect(formatAnsweredWith({
      'Pick dinner': 'Rice',
      Sides: ['Soup', 'Salad', 1],
    })).toBe('Rice · Soup, Salad');
    expect(formatAnsweredWith(null)).toBeNull();
    expect(formatAnsweredWith(['x'])).toBeNull();
    expect(formatAnsweredWith({ a: 1 })).toBeNull();
  });
});

describe('parseUnifiedDiff', () => {
  it('extracts path and add/del hunks', () => {
    const files = parseUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      ' context',
      '-old',
      '+new',
    ].join('\n'));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/a.ts');
    expect(files[0]!.add).toBe(1);
    expect(files[0]!.del).toBe(1);
    expect(files[0]!.hunks[0]!.lines.map(line => line.kind)).toEqual(['ctx', 'del', 'add']);
  });
});

describe('ensureTurnEnd / ensureLatestTurnEnd', () => {
  const user: TranscriptItem = {
    kind: 'user', id: 'u-1', text: 'hi', exec: 'codex', ts: 10, turn: 2,
  };

  it('appends a turn-end and replaces a session-terminal fallback', () => {
    const added = ensureTurnEnd([user], 2, 't_2', 20);
    expect(added).toHaveLength(2);
    expect(added[1]).toMatchObject({ kind: 'turn-end', id: 't_2', turn: 2, text: 'Turn 2 · complete' });
    const same = ensureTurnEnd(added, 2, 't_2', 30);
    expect(same).toBe(added);
    const fallback = ensureTurnEnd([user], 2, 'session-terminal:s-1:2', 15);
    const replaced = ensureTurnEnd(fallback, 2, 't_canonical', 40);
    expect(replaced[1]).toMatchObject({ kind: 'turn-end', id: 't_canonical', ts: 40 });
  });

  it('stores Host/Proxy turn ids on the boundary and recovers them in place', () => {
    const withIds = ensureTurnEnd([user], 2, 't_2', 20, 'host-turn-2', 'provider-turn-2');
    expect(withIds[1]).toMatchObject({
      kind: 'turn-end',
      id: 't_2',
      turn_id: 'host-turn-2',
      source_turn_id: 'provider-turn-2',
    });

    const withoutIds = ensureTurnEnd([user], 2, 't_2', 20);
    const recovered = ensureTurnEnd(withoutIds, 2, 't_later', 99, 'host-turn-2', 'provider-turn-2');
    expect(recovered[1]).toMatchObject({
      kind: 'turn-end',
      id: 't_2',
      ts: 20,
      turn_id: 'host-turn-2',
      source_turn_id: 'provider-turn-2',
    });

    const fallback = ensureTurnEnd([user], 2, 'session-terminal:s-1:2', 15);
    const replaced = ensureTurnEnd(fallback, 2, 't_canonical', 40, 'host-turn-2', 'provider-turn-2');
    expect(replaced[1]).toMatchObject({
      kind: 'turn-end',
      id: 't_canonical',
      ts: 40,
      turn_id: 'host-turn-2',
      source_turn_id: 'provider-turn-2',
    });
  });

  it('ensureLatestTurnEnd is a no-op on empty items', () => {
    const empty: TranscriptItem[] = [];
    expect(ensureLatestTurnEnd(empty, 's-1', 1)).toBe(empty);
  });
});

describe('parseDiffUpdated', () => {
  it('parses unified diff text and falls back to a files summary', () => {
    const fromText = parseDiffUpdated(envelope({
      data: { diff: 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+hi\n' },
    }));
    expect(fromText?.files[0]?.path).toBe('a.ts');
    const fromFiles = parseDiffUpdated(envelope({
      data: { files: [{ path: 'b.ts', added: 2, removed: 1 }] },
    }));
    expect(fromFiles).toEqual({
      kind: 'diff', id: 'c-1', ts: 1, turn: 1,
      files: [{ path: 'b.ts', add: 2, del: 1, hunks: [] }],
    });
    expect(parseDiffUpdated(envelope({ data: {} }))).toBeNull();
  });
});
