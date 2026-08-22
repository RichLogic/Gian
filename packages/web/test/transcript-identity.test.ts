import { describe, expect, it } from 'vitest';

import {
  isToolProjectionItem,
  transcriptIdentity,
  transcriptItemIdentity,
  transcriptItemMergeIdentity,
} from '../src/transcript/identity.js';
import type { ReasoningItem, StatusItem, TranscriptItem } from '../src/types.js';

function turnBoundary(kind: 'turn-start' | 'turn-end', turn = 3): StatusItem {
  return { kind, id: `phys-${kind}-${turn}`, text: kind, ts: 1, turn };
}

function reasoning(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    kind: 'reasoning',
    id: 'r-1',
    text: 'thinking',
    variant: 'full',
    ts: 1,
    turn: 2,
    ...overrides,
  };
}

describe('transcriptIdentity', () => {
  it('uses only turn:kind for turn-start and turn-end', () => {
    expect(transcriptIdentity(4, 'turn-start', 'physical-a')).toBe('4:turn-start');
    expect(transcriptIdentity(4, 'turn-end', 'physical-b')).toBe('4:turn-end');
  });

  it('reasons with an explicit variant and defaults to full', () => {
    expect(transcriptIdentity(2, 'reasoning', 'r-1', 'summary')).toBe('2:reasoning:summary:r-1');
    expect(transcriptIdentity(2, 'reasoning', 'r-1')).toBe('2:reasoning:full:r-1');
  });

  it('other kinds are turn:kind:id', () => {
    expect(transcriptIdentity(1, 'user', 'u-9')).toBe('1:user:u-9');
    expect(transcriptIdentity(1, 'tool', 'call-3')).toBe('1:tool:call-3');
  });
});

describe('transcriptItemIdentity', () => {
  it('matches transcriptIdentity for the same item fields', () => {
    const start = turnBoundary('turn-start');
    const end = turnBoundary('turn-end');
    const full = reasoning();
    const summary = reasoning({ variant: 'summary', id: 'r-2' });
    const user: TranscriptItem = {
      kind: 'user', id: 'u-1', text: 'hi', exec: 'codex', ts: 1, turn: 1,
    };

    expect(transcriptItemIdentity(start)).toBe(transcriptIdentity(start.turn, start.kind, start.id));
    expect(transcriptItemIdentity(end)).toBe(transcriptIdentity(end.turn, end.kind, end.id));
    expect(transcriptItemIdentity(full)).toBe(transcriptIdentity(full.turn, full.kind, full.id, full.variant));
    expect(transcriptItemIdentity(summary)).toBe(
      transcriptIdentity(summary.turn, summary.kind, summary.id, summary.variant),
    );
    expect(transcriptItemIdentity(user)).toBe(transcriptIdentity(user.turn, user.kind, user.id));
  });
});

describe('transcriptItemMergeIdentity', () => {
  it('collapses tool-projection kinds onto one identity', () => {
    const command: TranscriptItem = {
      kind: 'command', id: 'c-1', command: 'ls', status: 'running', stdout: '', stderr: '', ts: 1, turn: 2,
    };
    const tool: TranscriptItem = {
      kind: 'tool', id: 'c-1', name: 'Bash', summary: 'ls', status: 'running', ts: 1, turn: 2,
    };
    expect(isToolProjectionItem(command)).toBe(true);
    expect(isToolProjectionItem(tool)).toBe(true);
    expect(transcriptItemMergeIdentity(command)).toBe('2:tool-projection:c-1');
    expect(transcriptItemMergeIdentity(tool)).toBe('2:tool-projection:c-1');
  });

  it('keeps transcriptItemIdentity for non-projection kinds', () => {
    const user: TranscriptItem = {
      kind: 'user', id: 'u-1', text: 'hi', exec: 'codex', ts: 1, turn: 1,
    };
    expect(isToolProjectionItem(user)).toBe(false);
    expect(transcriptItemMergeIdentity(user)).toBe(transcriptItemIdentity(user));
  });
});
