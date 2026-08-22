import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogFromModelState, modelStateFromUnknown, toV2ConfigOptions } from '../src/core/catalog.js';

test('catalog maps Grok modelState to model, reasoning effort, and permission modes', () => {
  const catalog = catalogFromModelState(modelStateFromUnknown({
    currentModelId: 'grok-4.6',
    availableModels: [{
      modelId: 'grok-4.6',
      name: 'Grok 4.6',
      _meta: {
        reasoningEffort: 'high',
        reasoningEfforts: [
          { id: 'high', value: 'high', label: 'High', default: true },
          { id: 'low', value: 'low', label: 'Low' },
        ],
      },
    }],
  }), 'auto');

  assert.deepEqual(catalog.models.map(model => model.id), ['grok-4.6']);
  assert.equal(catalog.models[0]?.efforts.find(effort => effort.isDefault)?.id, 'high');
  assert.deepEqual(catalog.modes.map(mode => mode.id), ['default', 'auto', 'always_approve']);
  assert.equal(catalog.modes.every(mode => mode.workspace === 'workspace-write'), true);
  assert.equal(catalog.sessionOptions.find(option => option.id === 'model')?.category, 'model');
  assert.equal(
    catalog.sessionOptions.find(option => option.id === 'reasoning_effort')?.category,
    'reasoning_effort',
  );
  assert.equal(
    catalog.sessionOptions.find(option => option.id === 'permission_mode')?.currentValue,
    'auto',
  );

  const options = toV2ConfigOptions(catalog.sessionOptions);
  assert.ok(options.every(option => option.binding === 'session'));
  assert.equal(options.find(option => option.id === 'model')?.role, 'model');
  assert.equal(options.find(option => option.id === 'reasoning_effort')?.role, 'effort');
  assert.equal(options.find(option => option.id === 'permission_mode')?.role, 'approval_mode');
  assert.equal(
    options.find(option => option.id === 'model')?.choices?.[0]?.displayName,
    'Grok 4.6',
  );
});

test('reasoning effort is enabled only for models that advertise efforts', () => {
  const options = toV2ConfigOptions(catalogFromModelState({
    currentModelId: 'grok-fast',
    availableModels: [
      { modelId: 'grok-fast', name: 'Grok Fast' },
      {
        modelId: 'grok-4.6',
        name: 'Grok 4.6',
        _meta: {
          reasoningEfforts: [{ id: 'high', value: 'high', label: 'High', default: true }],
        },
      },
    ],
  }).sessionOptions);
  assert.deepEqual(options.find(option => option.id === 'reasoning_effort')?.enabledWhen, [
    { optionId: 'model', oneOf: ['grok-4.6'] },
  ]);
});
