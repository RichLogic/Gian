import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { advertisedTurnValue } from '../src/session/advertised-turn-value.js';

const model = {
  choices: [
    { value: 'deepseek-flash', displayName: 'DeepSeek-V41-Flash' },
    { value: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro' },
  ],
  defaultValue: 'deepseek-flash',
};

test('a retired saved model falls back to the advertised default', () => {
  assert.equal(
    advertisedTurnValue(model, 'deepseek-v4-flash', 'deepseek-v4-flash'),
    'deepseek-flash',
  );
});

test('an advertised saved model is sent unchanged', () => {
  assert.equal(
    advertisedTurnValue(model, 'deepseek-v4-pro', 'deepseek-flash'),
    'deepseek-v4-pro',
  );
});

test('a boolean option keeps false when it has no choices', () => {
  assert.equal(
    advertisedTurnValue({ defaultValue: true }, false, undefined),
    false,
  );
});

test('an empty persisted string stays absent', () => {
  assert.equal(
    advertisedTurnValue(model, '', 'deepseek-v4-pro'),
    undefined,
  );
});

const nativeApproval = {
  choices: [
    { value: null, displayName: 'Configured default' },
    { value: 'on-request', displayName: 'On request' },
    { value: 'never', displayName: 'Never' },
  ],
  defaultValue: null,
};

test('a null catalog choice is sent when the role value is not advertised', () => {
  assert.equal(advertisedTurnValue(nativeApproval, undefined, 'ask'), null);
});
