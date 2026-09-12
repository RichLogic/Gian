// chat-ui pure helpers + transcript grouping/fold projection.

import { describe, expect, it } from 'vitest';
import { formatBytes, formatElapsed, formatTime, isNativeImageMime } from '../src/utils.js';
import { transcriptItemIdentity, transcriptItemMergeIdentity } from '../src/identity.js';
import { eventFeedItems, isTurnWorkItem } from '../src/event-feed.js';
import { groupIntoBlocks, terminalState } from '../src/transcript.js';
import { normalizeGfmTables } from '../src/markdown-tables.js';
import type { ApprovalItem, CommandItem, MsgItem, StatusItem, TranscriptItem } from '../src/types.js';

function msg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'user', id: 'u-1', text: 'hi', exec: 'claude', ts: 100, turn: 1, ...overrides };
}
function cmd(overrides: Partial<CommandItem> = {}): CommandItem {
  return { kind: 'command', id: 'c-1', command: 'ls', status: 'success', stdout: '', ts: 200, turn: 1, ...overrides };
}
function turnEnd(overrides: Partial<StatusItem> = {}): StatusItem {
  return { kind: 'turn-end', id: 'te-1', text: '', ts: 300, turn: 1, ...overrides };
}
function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval', id: 'ap-1', approvalId: 'ap-1', title: 'Bash', reason: '', cmd: 'ls',
    risk: 'medium', status: 'pending', ts: 250, turn: 1, ...overrides,
  };
}

describe('utils', () => {
  it('formatElapsed renders seconds and minutes', () => {
    expect(formatElapsed(8_000)).toBe('8s');
    expect(formatElapsed(63_000)).toBe('1m 03s');
    expect(formatElapsed(-5)).toBe('0s');
  });
  it('formatTime renders HH:MM', () => {
    expect(formatTime(0)).toMatch(/^\d{2}:\d{2}$/);
  });
  it('formatBytes picks B/KB/MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('isNativeImageMime matches the inline-renderable set', () => {
    expect(isNativeImageMime('image/png')).toBe(true);
    expect(isNativeImageMime('image/svg+xml')).toBe(false);
    expect(isNativeImageMime('application/pdf')).toBe(false);
  });
});

describe('identity', () => {
  it('turn markers key by turn+kind, content by turn+kind+id', () => {
    expect(transcriptItemIdentity(turnEnd())).toBe('1:turn-end');
    expect(transcriptItemIdentity(msg())).toBe('1:user:u-1');
  });
  it('tool projections share a coarse merge identity', () => {
    expect(transcriptItemMergeIdentity(cmd())).toBe('1:tool-projection:c-1');
    expect(transcriptItemMergeIdentity(msg())).toBe('1:user:u-1');
  });
});

describe('event-feed projection', () => {
  it('collects process kinds and resolved approvals, keeps pending inline', () => {
    expect(isTurnWorkItem(cmd())).toBe(true);
    expect(isTurnWorkItem(approval({ status: 'approved-once' }))).toBe(true);
    expect(isTurnWorkItem(approval())).toBe(false);
    expect(isTurnWorkItem(msg())).toBe(false);
  });
  it('error-level notices never fold', () => {
    const notice: TranscriptItem = {
      kind: 'auto-notice', id: 'n-1', variant: 'notice', severity: 'error',
      consecutive: 0, total: 1, ts: 1, turn: 1,
    };
    expect(isTurnWorkItem(notice)).toBe(false);
    expect(isTurnWorkItem({ ...notice, severity: 'info' })).toBe(true);
  });
  it('eventFeedItems filters to one turn', () => {
    const items = [cmd(), cmd({ id: 'c-2', turn: 2 })];
    expect(eventFeedItems(items, 2)).toHaveLength(1);
  });
});

describe('groupIntoBlocks', () => {
  it('a turn with process events and turn-end folds into one terminal block', () => {
    const blocks = groupIntoBlocks([msg(), cmd(), turnEnd()], false);
    // The turn-end marker itself stays in the stream (renders null) right
    // after the boundary block it anchors.
    expect(blocks.map(b => b.kind)).toEqual(['user', 'turn-work', 'turn-end']);
    const block = blocks[1]!;
    if (block.kind !== 'turn-work') throw new Error('expected turn-work');
    expect(block.state).toBe('worked');
    expect(block.actions).toBe(1);
  });

  it('terminal state derives from outcome or inline error text', () => {
    expect(terminalState([cmd()], 1, turnEnd({ outcome: 'stopped' }))).toBe('stopped');
    const err: StatusItem = { kind: 'error', id: 'e-1', text: 'Turn exploded', ts: 280, turn: 1 };
    expect(terminalState([cmd(), err], 1, turnEnd())).toBe('failed');
    const cancel: StatusItem = { kind: 'error', id: 'e-2', text: 'Interrupted by user', ts: 280, turn: 1 };
    expect(terminalState([cmd(), cancel], 1, turnEnd())).toBe('stopped');
  });

  it('pending approvals stay inline after the terminal block', () => {
    const blocks = groupIntoBlocks([msg(), cmd(), approval(), turnEnd()], false);
    expect(blocks.map(b => b.kind)).toEqual(['user', 'turn-work', 'approval', 'turn-end']);
  });

  it('a live turn folds process events into a working block', () => {
    const blocks = groupIntoBlocks([msg(), cmd({ status: 'running' })], true);
    expect(blocks.map(b => b.kind)).toEqual(['user', 'turn-work']);
    const block = blocks[1]!;
    if (block.kind !== 'turn-work') throw new Error('expected turn-work');
    expect(block.state).toBe('working');
  });

  it('a turn with no process events gets no work boundary', () => {
    const blocks = groupIntoBlocks([msg(), msg({ kind: 'assistant', id: 'a-1' }), turnEnd()], false);
    expect(blocks.every(b => b.kind !== 'turn-work')).toBe(true);
  });
});

describe('normalizeGfmTables', () => {
  it('pads a delimiter row to the header cell count', () => {
    const fixed = normalizeGfmTables('| a | b |\n| --- |\n| 1 | 2 |');
    expect(fixed).toContain('| --- | --- |');
  });
  it('leaves fenced code untouched', () => {
    const src = '```\n| a |\n| --- |\n```';
    expect(normalizeGfmTables(src)).toBe(src);
  });
});
