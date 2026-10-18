import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { configOptionSchema } from '@gian/proxy-protocol';

import {
  ConfigValidationError,
  resolveConfigValues,
  toGianConfigOptions,
  validateConfigValues,
} from '../src/core/catalog.js';
import { configOptions, modelChoices } from './fixtures/config-options.js';

const native = [
  {
    id: 'model',
    name: 'Model',
    description: 'Which model',
    category: 'model',
    type: 'select',
    currentValue: 'claude-sonnet',
    options: [
      {
        group: 'anthropic',
        name: 'Anthropic',
        options: [{ value: 'claude-sonnet', name: 'Claude' }],
      },
      {
        group: 'google',
        name: 'Google',
        options: [
          { value: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'stable' },
          { value: 'Gemini-upper', name: 'Not prefix' },
          { value: 'gemini-2.5-pro', name: 'Duplicate' },
        ],
      },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'auto_edit',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'auto_edit', name: 'Auto edit' },
      { value: 'yolo', name: 'YOLO' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      {
        group: 'effort',
        name: 'Effort',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  },
  {
    id: 'flag',
    name: 'Flag',
    type: 'boolean',
    currentValue: false,
  },
] as unknown as SessionConfigOption[];

function expectError(
  run: () => unknown,
  code: string,
  domainCode: string,
): ConfigValidationError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigValidationError);
    assert.equal(error.code, code);
    assert.equal(error.domainCode, domainCode);
    assert.equal(error.retryable, false);
    return error;
  }
  assert.fail('expected ConfigValidationError');
}

test('native options keep their ids and Gemini-only model choices', () => {
  const projected = toGianConfigOptions(native);
  assert.deepEqual(projected.map((option) => option.id), ['model', 'mode', 'thought_level']);
  assert.equal(projected.some((option) => option.control === 'boolean' || option.id === 'flag'), false);
  for (const option of projected) configOptionSchema.parse(option);

  const model = projected[0]!;
  assert.equal(model.role, 'model');
  assert.equal(model.binding, 'turn');
  assert.equal(model.required, false);
  assert.equal(model.defaultValue, null);
  assert.equal(model.modeKind, undefined);
  assert.deepEqual(model.choices, [{
    value: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    description: 'stable',
  }]);
  assert.equal(JSON.stringify(model.choices).includes('group'), false);
  assert.equal(JSON.stringify(model.choices).includes('claude-sonnet'), false);
  assert.equal(JSON.stringify(model.choices).includes('Gemini-upper'), false);

  const mode = projected[1]!;
  assert.equal(mode.id, 'mode');
  assert.equal(mode.role, 'approval_mode');
  assert.equal(mode.modeKind, 'provider-native');
  assert.equal(mode.binding, 'turn');
  assert.equal(mode.defaultValue, 'auto_edit');
  assert.deepEqual(mode.choices?.map((choice) => choice.value), ['default', 'auto_edit', 'yolo']);

  const effort = projected[2]!;
  assert.equal(effort.id, 'thought_level');
  assert.equal(effort.role, 'effort');
  assert.equal(effort.binding, 'turn');
  assert.equal(effort.defaultValue, 'high');
  assert.deepEqual(effort.choices?.map((choice) => choice.value), ['low', 'high']);
});

test('a model selector with no Gemini choice is omitted and still rejected', () => {
  const options = [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'claude-sonnet',
    options: [{ value: 'claude-sonnet', name: 'Claude' }],
  }] as unknown as SessionConfigOption[];
  assert.deepEqual(toGianConfigOptions(options), []);
  const error = expectError(
    () => validateConfigValues(options, { model: 'gemini-2.5-pro' }),
    'unavailable_model',
    'CONFIG_VALUE_INVALID',
  );
  assert.equal(error.configId, 'model');
  const modeOnly = [{
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  }] as unknown as SessionConfigOption[];
  assert.deepEqual(toGianConfigOptions(modeOnly).map((option) => option.id), ['mode']);
});

test('malformed options are omitted and duplicate ids keep the first projection', () => {
  assert.deepEqual(toGianConfigOptions(undefined as unknown as SessionConfigOption[]), []);
  const malformed = [
    null,
    { name: 'Missing id', type: 'boolean', currentValue: true },
    { id: 'flag', name: 'Flag', type: 'boolean' },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', options: 'nope' },
    { id: 'empty_select', name: 'Empty', type: 'select', options: [] },
    { id: 'count', name: 'Count', type: 'number', currentValue: 1 },
  ] as unknown as SessionConfigOption[];
  assert.deepEqual(toGianConfigOptions(malformed), []);
  const duplicated = [
    { id: 'flag', name: 'First', type: 'boolean', currentValue: true },
    { id: 'flag', name: 'Second', type: 'boolean', currentValue: false },
  ] as unknown as SessionConfigOption[];
  assert.deepEqual(toGianConfigOptions(duplicated), []);
  expectError(
    () => validateConfigValues(duplicated, { flag: true }),
    'ambiguous_config',
    'CONFIG_VALUE_INVALID',
  );
  expectError(
    () => validateConfigValues(malformed, { empty_select: 'x' }),
    'unknown_config',
    'CONFIG_VALUE_INVALID',
  );
});

test('explicit model and catalog failures do not fall back or echo secrets', () => {
  const secret = 'super-secret-value';
  const error = expectError(
    () => validateConfigValues(native, { model: `claude-sonnet?token=${secret}` }),
    'unavailable_model',
    'CONFIG_VALUE_INVALID',
  );
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes('[REDACTED]'), true);
  expectError(
    () => validateConfigValues(native, { model: null }),
    'unavailable_model',
    'CONFIG_VALUE_INVALID',
  );
  const bearer = expectError(
    () => validateConfigValues(native, { flag: `Bearer ${secret}` as unknown as boolean }),
    'invalid_config_value',
    'CONFIG_VALUE_INVALID',
  );
  assert.equal(bearer.message.includes(secret), false);
  expectError(
    () => validateConfigValues(native, { missing: 'x' }),
    'unknown_config',
    'CONFIG_VALUE_INVALID',
  );
  const corrupt = expectError(
    () => validateConfigValues(`Bearer ${secret}` as unknown as SessionConfigOption[], { model: 'x' }),
    'invalid_catalog',
    'RUNTIME_ERROR',
  );
  assert.equal(corrupt.message.includes(secret), false);
  expectError(
    () => validateConfigValues(native, null as unknown as Record<string, string>),
    'invalid_catalog',
    'RUNTIME_ERROR',
  );
});

test('accepted values keep caller key order and native ids', () => {
  assert.deepEqual(validateConfigValues(native, {
    mode: 'yolo',
    model: 'gemini-2.5-pro',
    thought_level: 'low',
  }), [
    { configId: 'mode', value: 'yolo' },
    { configId: 'model', value: 'gemini-2.5-pro' },
    { configId: 'thought_level', value: 'low' },
  ]);
});

test('native boolean controls are not advertised or sent as strings', () => {
  const booleans = [
    { id: 'flag', name: 'Flag', type: 'boolean', currentValue: false },
    { id: 'enabled', name: 'Enabled', type: 'boolean', currentValue: true },
  ] as unknown as SessionConfigOption[];
  assert.deepEqual(toGianConfigOptions(booleans), []);
  for (const value of [false, true, 'false', 'true']) {
    const error = expectError(
      () => validateConfigValues(booleans, { flag: value }),
      'invalid_config_value',
      'CONFIG_VALUE_INVALID',
    );
    assert.equal(error.configId, 'flag');
    assert.equal(error.message.includes('false'), false);
    assert.equal(error.message.includes('true'), false);
  }
});

test('advertised Gemini variants project a family and only its actual Thinking levels', () => {
  const options = configOptions();
  const projected = toGianConfigOptions(options);
  for (const option of projected) configOptionSchema.parse(option);
  assert.deepEqual(projected.map(option => option.id), ['model', 'thinking', 'mode']);
  assert.deepEqual(projected[0]?.choices?.map(choice => choice.value), [
    'gemini-3.8-flash', 'gemini-future-pro', 'gemini-fixed', 'gemini-unknown-turbo', 'gemini-unmatched-high',
  ]);
  assert.equal(projected[0]?.defaultValue, 'gemini-3.8-flash');
  assert.equal(projected[1]?.defaultValue, 'high');
  assert.deepEqual(projected[1]?.choices?.map(choice => choice.value), ['low', 'medium', 'high']);
  const future = toGianConfigOptions(options, { model: 'gemini-future-pro' });
  assert.deepEqual(future[1]?.choices?.map(choice => choice.value), ['max']);
  assert.equal(future[1]?.defaultValue, null);
  assert.equal(toGianConfigOptions(options, { model: 'gemini-fixed' }).some(option => option.role === 'effort'), false);
  // A family-only resolve may populate the dependent menu, but may not guess a
  // native variant when there is no selected current variant in that family.
  assert.deepEqual(resolveConfigValues(options, { model: 'gemini-future-pro' }), { model: 'gemini-future-pro' });
  expectError(() => validateConfigValues(options, { model: 'gemini-future-pro' }), 'invalid_config_value', 'CONFIG_VALUE_INVALID');
  assert.deepEqual(validateConfigValues(options, { model: 'gemini-future-pro', thinking: 'max' }), [
    { configId: 'model', value: 'gemini-future-pro-max' },
  ]);
});

test('legacy full ids and current native selections remain exact, conflicts never fall back', () => {
  const options = configOptions();
  assert.deepEqual(validateConfigValues(options, { model: 'gemini-3.8-flash-low', mode: 'auto_edit' }), [
    { configId: 'model', value: 'gemini-3.8-flash-low' }, { configId: 'mode', value: 'auto_edit' },
  ]);
  assert.deepEqual(resolveConfigValues(options, { model: 'gemini-3.8-flash-low' }), {
    model: 'gemini-3.8-flash', thinking: 'low',
  });
  const legacyCatalog = toGianConfigOptions(options, { model: 'gemini-3.8-flash-low' });
  assert.ok(legacyCatalog[0]?.choices?.some(choice => choice.value === 'gemini-3.8-flash-low'));
  assert.equal(legacyCatalog[1]?.defaultValue, 'low');
  assert.deepEqual(validateConfigValues(options, { thinking: 'medium' }), [
    { configId: 'model', value: 'gemini-3.8-flash-medium' },
  ]);
  for (const values of [
    { model: 'gemini-3.8-flash-high', thinking: 'low' },
    { model: 'gemini-3.8-flash', thinking: 'max' },
    { model: 'gemini-future-pro', thinking: 'high' },
    { model: 'gemini-fixed', thinking: 'high' },
    { thinking: null },
    { mode: 'plan' },
  ] as Array<Record<string, string | null>>) expectError(() => validateConfigValues(options, values), 'invalid_config_value', 'CONFIG_VALUE_INVALID');
});

test('fixed, unknown and colliding ids preserve identity; real native Thinking keeps its setter', () => {
  const options = configOptions();
  for (const model of ['gemini-fixed', 'gemini-unknown-turbo', 'gemini-unmatched-high']) {
    assert.deepEqual(validateConfigValues(options, { model }), [{ configId: 'model', value: model }]);
  }
  const collision = structuredClone(options);
  const model = collision[0]!;
  assert.ok(model.type === 'select');
  model.options = [...modelChoices, { value: 'gemini-3.8-flash', name: 'A genuinely fixed native base model' }];
  const projected = toGianConfigOptions(collision);
  assert.ok(projected[0]?.choices?.some(choice => choice.value === 'gemini-3.8-flash-high'));
  assert.deepEqual(validateConfigValues(collision, { model: 'gemini-3.8-flash' }), [{ configId: 'model', value: 'gemini-3.8-flash' }]);
  const realThinking = [...options, native[2]!];
  assert.deepEqual(validateConfigValues(realThinking, { model: 'gemini-3.8-flash-high', thought_level: 'low' }), [
    { configId: 'model', value: 'gemini-3.8-flash-high' }, { configId: 'thought_level', value: 'low' },
  ]);
  assert.equal(toGianConfigOptions(realThinking).some(option => option.id === 'thinking'), false);
});
