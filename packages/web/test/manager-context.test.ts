// Pure-function coverage for the Manager fixes that don't need a DOM:
//   #4 — The first Manager message renders ONCE, not twice. The host prepends a
//        sentinel-wrapped system prompt (or, later, an action-context note) to
//        the user text, so the server `user_message` echo differs from the
//        client's bare optimistic echo. applyEnvelope must reconcile them by
//        comparing the STRIPPED server text.
//   #2 — The "subtask created / dismissed" context note that gets folded into
//        the Manager's next message: wrapManagerContextNote wraps it in the
//        sentinels (so the transcript strips it) and managerCardContextNote
//        renders a sensible LLM-facing summary.

import { describe, it, expect } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import { MANAGER_SYS_OPEN, MANAGER_SYS_CLOSE, stripManagerSystemPrefix, wrapManagerContextNote } from '@gian/shared';
import type { MsgItem, TranscriptItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import { managerCardContextNote, type ManagerSubtaskCard } from '../src/views/TasksView.js';

function managerEcho(text: string): MsgItem {
  return { kind: 'user', id: 'optimistic:mgr-1:1', text, exec: 'codex', ts: 1, turn: 0, pending: true };
}

function userMessageEnvelope(text: string, call_id = 'real-1'): EventEnvelope {
  return { session_id: 'mgr-1', turn: 1, call_id, event: 'user_message', ts: 2, data: { text } };
}

const SYS_PREFIX = `${MANAGER_SYS_OPEN}\nYou are the project Manager…\n${MANAGER_SYS_CLOSE}\n\n`;

describe('#4: Manager first-message reconciliation', () => {
  it('reconciles the bare optimistic echo against a system-prefixed server message (no duplicate)', () => {
    const before: TranscriptItem[] = [managerEcho('plan this task')];
    const after = applyEnvelope(before, userMessageEnvelope(`${SYS_PREFIX}plan this task`), 'codex');

    // ONE bubble — the echo reconciled, not appended alongside.
    expect(after).toHaveLength(1);
    expect((after[0] as MsgItem).pending).toBeUndefined();
    expect((after[0] as MsgItem).id).toBe('real-1');
  });

  it('also reconciles against a context-note-prefixed later message', () => {
    const note = wrapManagerContextNote(['[The user created a subtask…]'], 'what next?');
    const before: TranscriptItem[] = [managerEcho('what next?')];
    const after = applyEnvelope(before, userMessageEnvelope(note), 'codex');
    expect(after).toHaveLength(1);
    expect((after[0] as MsgItem).pending).toBeUndefined();
  });

  it('still requires a real match — a different message does not reconcile', () => {
    const before: TranscriptItem[] = [managerEcho('plan this task')];
    const after = applyEnvelope(before, userMessageEnvelope(`${SYS_PREFIX}something else`), 'codex');
    expect(after).toHaveLength(2);
    expect((after[0] as MsgItem).pending).toBe(true);
  });

  it('reconciles even when the first turn STACKS the system prompt AND a context note (Codex review #2)', () => {
    // Edge case: a card was queued before the Manager's first turn (e.g. the
    // header "Create subtask" button on a fresh task), so the first message
    // carries the host system prompt AND the prepended context note — two
    // stacked sentinel blocks. stripManagerSystemPrefix must peel both.
    const stacked = `${SYS_PREFIX}${MANAGER_SYS_OPEN}\n[The user created a subtask …]\n${MANAGER_SYS_CLOSE}\n\nplan this task`;
    expect(stripManagerSystemPrefix(stacked)).toBe('plan this task');

    const before: TranscriptItem[] = [managerEcho('plan this task')];
    const after = applyEnvelope(before, userMessageEnvelope(stacked), 'codex');
    expect(after).toHaveLength(1); // reconciled, not doubled
    expect((after[0] as MsgItem).pending).toBeUndefined();
  });
});

describe('#2: Manager context note', () => {
  it('wraps notes in the system sentinels (so the transcript strips them) and leaves the user text', () => {
    const wrapped = wrapManagerContextNote(['note A', 'note B'], 'hello manager');
    expect(wrapped).toContain(MANAGER_SYS_OPEN);
    expect(wrapped).toContain('note A');
    expect(wrapped.endsWith('hello manager')).toBe(true);
    // Display strip recovers exactly the user's text.
    expect(stripManagerSystemPrefix(wrapped)).toBe('hello manager');
  });

  it('returns the user text unchanged when there are no notes', () => {
    expect(wrapManagerContextNote([], 'just text')).toBe('just text');
  });

  it('summarises a created card for the LLM', () => {
    const card: ManagerSubtaskCard = {
      id: 's1', status: 'created', name: 'Wire it', workspaceLabel: 'Gian-Dev',
      executor: 'codex', prompt: 'do the wiring', ts: 1000, acked: false,
    };
    const note = managerCardContextNote(card);
    expect(note).toContain('created a subtask');
    expect(note).toContain('Wire it');
    expect(note).toContain('Gian-Dev');
    expect(note).toContain('codex');
  });

  it('summarises a dismissed card for the LLM', () => {
    const card: ManagerSubtaskCard = {
      id: 'd1', status: 'dismissed', executor: 'claude', prompt: 'nope', ts: 1000, acked: false,
    };
    expect(managerCardContextNote(card)).toContain('dismissed your subtask proposal');
  });
});
