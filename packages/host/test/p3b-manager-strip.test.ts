import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANAGER_SYS_OPEN, MANAGER_SYS_CLOSE, stripManagerSystemPrefix } from '@gian/shared';

test('strips the wrapped Manager system prefix, keeping the user text', () => {
  const userText = 'what subtasks does this task have and what should I do next?';
  const wrapped = `${MANAGER_SYS_OPEN}\nYou are the read-only project Manager...\n## Subtasks\n- X\n${MANAGER_SYS_CLOSE}\n\n${userText}`;
  assert.equal(stripManagerSystemPrefix(wrapped), userText);
});

test('leaves a plain (later-turn) message untouched', () => {
  assert.equal(stripManagerSystemPrefix('just a follow-up question'), 'just a follow-up question');
});

test('returns unchanged when the close sentinel is missing', () => {
  const t = `${MANAGER_SYS_OPEN}\nincomplete`;
  assert.equal(stripManagerSystemPrefix(t), t);
});
