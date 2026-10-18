import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { advertisedTurnValue } from '../src/session/advertised-turn-value.js';
import { normalizeProtocolCatalog } from '../src/proxy/protocol-v2-session-client.js';
import { validateConfigValues } from '../../proxies/antigravity-proxy/src/core/catalog.js';
import { configOptions, projectedCatalog } from '../../proxies/antigravity-proxy/test/fixtures/config-options.js';

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

test('resolved legacy Antigravity Low is not downgraded to the native High default by send membership checks', () => {
  // send() resolves its unfiltered draft before calling advertisedTurnValue.
  // persistTurnConfigOptions writes only options/revision, not stored values.
  const saved = 'gemini-3.8-flash-low';
  const resolved = normalizeProtocolCatalog(projectedCatalog({ model: saved }));
  const model = resolved.configOptions.find(option => option.role === 'model')!;
  const thinking = resolved.configOptions.find(option => option.role === 'effort')!;
  const modelValue = advertisedTurnValue(model, saved, saved);
  const thinkingValue = advertisedTurnValue(thinking, undefined, null);
  assert.equal(modelValue, saved);
  assert.equal(thinkingValue, 'low');
  assert.deepEqual(validateConfigValues(configOptions(), { model: modelValue!, thinking: thinkingValue! }), [
    { configId: 'model', value: saved },
  ]);
});
