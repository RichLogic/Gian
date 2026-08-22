import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  GIAN_ACTION_CLOSE,
  GIAN_ACTION_OPEN,
  GIAN_ROLE_CLOSE,
  GIAN_ROLE_OPEN,
  stripGianActionBlocks,
  stripGianRolePrefix,
} from '../dist/index.js';

test('stripGianRolePrefix removes only a leading ROLE block', () => {
  const body = 'hello user';
  const text = `${GIAN_ROLE_OPEN}\nYou are INDIVIDUAL\n${GIAN_ROLE_CLOSE}\n\n${body}`;
  assert.equal(stripGianRolePrefix(text), body);
});

test('stripGianRolePrefix leaves a later ROLE literal untouched', () => {
  const text = `please ignore ${GIAN_ROLE_OPEN}not a header${GIAN_ROLE_CLOSE} later`;
  assert.equal(stripGianRolePrefix(text), text);
});

test('stripGianRolePrefix leaves an unclosed leading ROLE block untouched', () => {
  const text = `${GIAN_ROLE_OPEN}\nincomplete header\nthen the user text`;
  assert.equal(stripGianRolePrefix(text), text);
});

test('stripGianActionBlocks removes every closed action envelope', () => {
  const text = [
    'before',
    `${GIAN_ACTION_OPEN}{"method":"submit_step"}${GIAN_ACTION_CLOSE}`,
    'middle',
    `${GIAN_ACTION_OPEN}{"method":"create_subtask"}${GIAN_ACTION_CLOSE}`,
    'after',
  ].join('\n');
  assert.equal(stripGianActionBlocks(text), 'before\n\nmiddle\n\nafter');
});

test('stripGianActionBlocks truncates an unclosed action from the open sentinel', () => {
  const text = `keep this\n${GIAN_ACTION_OPEN}{"method":"submit_step"}`;
  assert.equal(stripGianActionBlocks(text), 'keep this');
});

test('stripGianActionBlocks collapses extra blank lines', () => {
  const text = `one\n\n\n${GIAN_ACTION_OPEN}x${GIAN_ACTION_CLOSE}\n\n\ntwo`;
  assert.equal(stripGianActionBlocks(text), 'one\n\ntwo');
});
