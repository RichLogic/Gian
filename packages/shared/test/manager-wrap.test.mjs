import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CREATE_SUBTASK_CLOSE,
  CREATE_SUBTASK_OPEN,
  MANAGER_SYS_CLOSE,
  MANAGER_SYS_OPEN,
  stripCreateSubtaskBlocks,
  wrapManagerContextNote,
} from '../dist/index.js';

test('wrapManagerContextNote returns the user text when there are no notes', () => {
  const userText = 'continue the task';
  assert.equal(wrapManagerContextNote([], userText), userText);
});

test('wrapManagerContextNote wraps notes in manager-system sentinels', () => {
  const wrapped = wrapManagerContextNote(
    ['created subtask A', 'created subtask B'],
    'what next?',
  );
  assert.equal(
    wrapped,
    `${MANAGER_SYS_OPEN}\ncreated subtask A\ncreated subtask B\n${MANAGER_SYS_CLOSE}\n\nwhat next?`,
  );
});

test('stripCreateSubtaskBlocks removes closed legacy blocks', () => {
  const text = `prose\n${CREATE_SUBTASK_OPEN}{"workspace":"repo"}${CREATE_SUBTASK_CLOSE}\nmore`;
  assert.equal(stripCreateSubtaskBlocks(text), 'prose\n\nmore');
});

test('stripCreateSubtaskBlocks truncates an unclosed block and collapses blank lines', () => {
  const text = `keep\n\n\n${CREATE_SUBTASK_OPEN}{"workspace":"repo"}`;
  assert.equal(stripCreateSubtaskBlocks(text), 'keep');
});
