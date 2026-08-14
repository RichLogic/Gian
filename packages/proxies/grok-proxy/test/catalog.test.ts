import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogFromModelState, modelStateFromUnknown } from '../src/core/catalog.js';

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
});
