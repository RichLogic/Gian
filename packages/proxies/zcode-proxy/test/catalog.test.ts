import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { startHarness, type Harness } from './harness.js';
import { serializeModelCatalog } from '../src/runtime/model-catalog.js';
import { revisionFor } from '../src/catalog.js';

const FULL_SETTINGS = {
  mode: { current: 'build' },
  permission: { mode: 'build' },
  model: {
    current: { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' },
    available: [
      {
        ref: { providerId: 'bigmodel', modelId: 'GLM-5.3-Flash' },
        label: 'GLM-5.3-Flash',
        providerLabel: 'BigModel - Coding Plan',
        contextWindow: 1_000_000,
        supportsImages: true,
        reasoning: { enabled: true, levels: [{ value: 'low' }, { value: 'max' }], defaultLevel: 'max' },
      },
      {
        ref: { providerId: 'bigmodel', modelId: 'GLM-5.3' },
        label: 'GLM-5.3',
        reasoning: { enabled: false, levels: [], defaultLevel: '' },
      },
      {
        ref: { providerId: 'zai', modelId: 'glm-5.1' },
        label: 'GLM-5.1',
        providerLabel: 'Z.AI Coding Plan',
        reasoning: {
          enabled: true,
          levels: [{ value: 'enabled' }, { value: 'disabled' }],
          defaultLevel: 'enabled',
        },
      },
    ],
  },
  thoughtLevel: { available: [{ value: 'low' }, { value: 'max' }], current: 'max', defaultLevel: 'max', enabled: true },
};

test('Registry projection returns metadata and exact reasoning choices without credentials', () => {
  const secret = 'fixture-secret-never-on-wire';
  const provider = {
    providerId: 'custom', providerName: 'Custom',
    config: { apiKey: secret, headers: { authorization: secret } },
    models: [{ modelId: 'vendor/model', config: {
      enabled: true,
      properties: { contextWindow: 200_000, inputFormat: { supportsImage: true, supportsPdf: false, supportsVideo: false } },
      optionSpecs: { reasoningLevel: { values: ['disabled', 'max'] }, maxOutputTokens: { max: 4096 } },
    } }],
  };
  const selection = { providerId: 'custom', modelId: 'vendor/model', options: { reasoningLevel: 'max' } };
  const dto = serializeModelCatalog({ providers: [provider], preferredSelection: selection });
  assert.equal(dto.schemaVersion, 1);
  assert.deepEqual(dto.selection, selection);
  assert.deepEqual(dto.models[0]?.reasoning.levels, [{ value: 'disabled' }, { value: 'max' }]);
  assert.equal(JSON.stringify(dto).includes(secret), false);
  provider.models[0]!.config.enabled = false;
  assert.deepEqual(serializeModelCatalog({ providers: [provider] }).models, []);
});

test('catalog revision changes when a model, reasoning choice or Registry entry changes', () => {
  const presentation = { mode: 'build', slashCommands: [] };
  const first = { settings: FULL_SETTINGS };
  const second = structuredClone(first);
  second.settings.model.current = { providerId: 'bigmodel', modelId: 'GLM-5.3' };
  const third = structuredClone(first);
  third.settings.thoughtLevel.current = 'low';
  const fourth = structuredClone(first);
  fourth.settings.model.available[0]!.label = 'Renamed';
  const firstRevision = revisionFor('runtime', presentation, first);
  assert.notEqual(revisionFor('runtime', presentation, second), firstRevision);
  assert.notEqual(revisionFor('runtime', presentation, third), firstRevision);
  assert.notEqual(revisionFor('runtime', presentation, fourth), firstRevision);
  assert.equal(revisionFor('runtime', presentation, first), firstRevision);
});

test('missing or incompatible model bridge fails instead of advertising invented models', async () => {
  for (const scenario of [{ behavior: { missingModelCatalog: true } }, { catalogSchemaVersion: 2 }]) {
    const harness = startHarness({ scenario });
    try {
      await initialize(harness);
      assert.equal((await harness.request('catalog.list', {})).kind, 'error');
      assert.equal(harness.fakeLog().some(entry => entry.method === 'session/create'), false);
    } finally { await harness.close(); }
  }
});

async function initialize(harness: Harness): Promise<Record<string, unknown>> {
  const response = await harness.request('initialize', {
    protocol: { name: 'gian.proxy', versions: ['2.1'] },
    host: { name: 'Gian', version: '0.0.0-test' },
  });
  assert.equal(response.kind, 'result');
  return (response.payload as { result: Record<string, unknown> }).result;
}

async function createSession(harness: Harness, sessionId = 's_1'): Promise<void> {
  const created = await harness.request('session.create', {
    sessionId,
    workspace: { cwd: '/tmp/zcode-ws', roots: ['/tmp/zcode-ws'] },
    config: {},
  });
  assert.equal(created.kind, 'result', `session.create failed: ${JSON.stringify(created.payload)}`);
}

test('catalog.list reads Registry metadata and presentation without creating a session', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    const init = await initialize(harness);
    const capabilities = init.capabilities as Record<string, number>;
    assert.equal(capabilities['catalog.resolve'], 1);
    assert.equal(capabilities['session.replay'], 1);
    assert.equal(capabilities['interaction'], 1, 'WP7-approved interaction ships by default');
    assert.equal(capabilities['input.localImage'], 1, 'v4 sendText accepts local image refs');
    assert.equal(capabilities['input.localFile'], 1);
    assert.equal(capabilities['input.skill'], 1, 'skills activate via the canonical manual prompt');
    assert.equal(capabilities['turn.steer'], 1);
    assert.equal(capabilities['session.fork'], 1);
    assert.equal(capabilities['session.rename'], 1);
    assert.equal(capabilities['event.plan'], 1);
    assert.equal(capabilities['event.diff'], 1);
    assert.equal(capabilities['sidechat'], undefined, 'side chats are not a semantic Gian Side Chat');
    assert.equal(capabilities['session.native.delete'], undefined, 'deleteSession is a close upstream');

    const catalog = await harness.request('catalog.list', {});
    const result = (catalog.payload as { result: Record<string, unknown> }).result;

    // G0 gate: no session/create calls, ever.
    const createCalls = harness.fakeLog().filter((entry) => entry.method === 'session/create');
    assert.equal(createCalls.length, 0, 'catalog.list must not create native sessions');
    // The side-effect-free read is readPresentation in 0.16.9.
    const reads = harness.fakeLog().filter((entry) => entry.method === 'workspace/readPresentation');
    assert.equal(reads.length, 1);
    assert.equal(harness.fakeLog().filter(entry => entry.method === 'gian/modelCatalog').length, 1);

    const options = result.configOptions as Array<Record<string, unknown>>;
    assert.ok(options.find((option) => option.id === 'provider'));
    assert.ok(options.find((option) => option.id === 'model'));
    assert.ok(options.find((option) => option.id === 'approval_mode'), 'approval mode projects from the presentation');
    const inputTypes = (result.input as Array<{ type: string }>).map((entry) => entry.type);
    assert.deepEqual(inputTypes, ['text', 'localImage', 'localFile', 'skill']);
    const actions = result.actions as Array<{ id: string; supported: boolean }>;
    assert.equal(actions.find((action) => action.id === 'session.fork')?.supported, true);
    assert.equal(actions.find((action) => action.id === 'sidechat.create')?.supported, false);
    assert.equal(actions.find((action) => action.id === 'session.native.delete')?.supported, false);
    assert.equal((result.specialCatalogs as Record<string, string>).approvalMode, 'approval_mode');
    const slash = result.slashCommands as Array<{ name: string; source: string }>;
    assert.ok(slash.every((command) => command.name.startsWith('/')), 'slash names are /-prefixed');
    assert.ok(slash.some((command) => command.name === '/goal'), 'builtin presentation slash commands project');
  } finally {
    await harness.close();
  }
});

test('Registry model facts feed the catalog marketplace before a session exists', async () => {
  const harness = startHarness({ scenario: { availableModels: FULL_SETTINGS.model.available } });
  try {
    await initialize(harness);
    const catalog = await harness.request('catalog.list', {});
    const result = (catalog.payload as { result: Record<string, unknown> }).result;
    const options = result.configOptions as Array<Record<string, unknown>>;
    const model = options.find((option) => option.id === 'model');
    assert.ok(model, 'model option projected from the Registry');
    assert.equal(model.binding, 'turn');
    const choices = model.choices as Array<{ value: string; displayName: string }>;
    assert.equal(choices.length, 2, 'the current provider models are advertised');
    for (const choice of choices) {
      assert.match(choice.value, /^zmodel:v1:/, 'model choice values use the scalar zmodel encoding');
    }
    const provider = options.find((option) => option.id === 'provider');
    assert.deepEqual(
      (provider!.choices as Array<{ value: string }>).map((choice) => choice.value),
      ['bigmodel', 'zai'],
      'the Registry carries the full marketplace across providers',
    );
    assert.equal((result.specialCatalogs as Record<string, string>).model, 'model');
    assert.ok(options.find((option) => option.id === 'thinking'), 'reasoning levels project for the current model');
  } finally {
    await harness.close();
  }
});

test('catalog runtime restarts and reinitializes after an unexpected exit', async () => {
  const harness = startHarness({ scenario: { behavior: { crashCatalogOnce: true } } });
  try {
    await initialize(harness);
    await createSession(harness);
    const failed = await harness.request('catalog.list', {});
    assert.equal(failed.kind, 'error', 'the request owned by the crashed generation fails');

    const recovered = await harness.request('catalog.list', {});
    assert.equal(recovered.kind, 'result', `catalog did not recover: ${JSON.stringify(recovered.payload)}`);
    const result = (recovered.payload as { result: { configOptions: Array<{ id: string }> } }).result;
    assert.ok(result.configOptions.some(option => option.id === 'model'), 'model facts survive via the shared store');

    const reads = harness.fakeLog().filter(entry => entry.method === 'workspace/readPresentation');
    assert.equal(new Set(reads.map(entry => entry.pid)).size, 2, 'recovery uses a fresh app-server');
  } finally {
    await harness.close();
  }
});

test('workspace without configured models projects an approval-only catalog', async () => {
  const harness = startHarness({ scenario: { availableModels: [] } });
  try {
    await initialize(harness);
    const catalog = await harness.request('catalog.list', {});
    const result = (catalog.payload as { result: Record<string, unknown> }).result;
    const options = result.configOptions as Array<Record<string, unknown>>;
    assert.deepEqual(
      options.map((option) => option.id),
      ['approval_mode'],
      'without configured models only the presentation-backed approval mode exists',
    );
    assert.deepEqual(result.specialCatalogs, { approvalMode: 'approval_mode' });
  } finally {
    await harness.close();
  }
});

test('model scalar codec rejects malformed values with CONFIG_VALUE_INVALID', async () => {
  const harness = startHarness({ scenario: {} });
  try {
    await initialize(harness);
    const listed = await harness.request('catalog.list', {});
    const revision = ((listed.payload as { result: Record<string, unknown> }).result.catalogRevision as string);

    const bad = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: 'zmodel:v1:!!!not-base64!!!' },
    });
    assert.equal(bad.kind, 'error');
    const domain = ((bad.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode);
    assert.equal(domain, 'CONFIG_VALUE_INVALID');

    const unknown = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: 'plain-glm' },
    });
    assert.equal(unknown.kind, 'error');
    assert.equal(
      ((unknown.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
    );

    const stale = await harness.request('catalog.resolve', {
      catalogRevision: 'zcode:stale:revision',
      sessionConfig: {},
      turnConfig: {},
    });
    assert.equal(stale.kind, 'error');
  } finally {
    await harness.close();
  }
});

test('resolve fills defaults only for missing keys and keeps explicit values', async () => {
  const harness = startHarness({ scenario: { availableModels: FULL_SETTINGS.model.available } });
  try {
    await initialize(harness);
    await createSession(harness);
    const listed = await harness.request('catalog.list', {});
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const revision = catalog.catalogRevision as string;
    const modelChoices = (catalog.configOptions as Array<Record<string, unknown>>)
      .find((option) => option.id === 'model')!.choices as Array<{ value: string }>;
    const explicitModel = modelChoices[0]!.value;

    const resolved = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: explicitModel },
    });
    assert.equal(resolved.kind, 'result');
    const defaults = ((resolved.payload as { result: Record<string, unknown> }).result.resolvedDefaults as { turnConfig: Record<string, string> }).turnConfig;
    assert.equal(defaults.model, explicitModel, 'explicit values are preserved verbatim');
    assert.equal(defaults.provider, 'bigmodel', 'the model provider is explicit in resolved defaults');
    assert.equal(defaults.approval_mode, 'build', 'missing keys get defaults');

    const invalidThinking = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { model: explicitModel, thinking: 'not-advertised' },
    });
    assert.equal(
      ((invalidThinking.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
    );

    const unknownOption = await harness.request('catalog.resolve', {
      catalogRevision: revision,
      sessionConfig: {},
      turnConfig: { not_an_option: 'x' },
    });
    assert.equal(
      ((unknownOption.payload as { error: { data: { domainCode: string } } }).error.data?.domainCode),
      'CONFIG_VALUE_INVALID',
    );
  } finally {
    await harness.close();
  }
});

test('settings with per-model reasoning hide thinking for models without it', async () => {
  const harness = startHarness({ scenario: { availableModels: FULL_SETTINGS.model.available } });
  try {
    await initialize(harness);
    await createSession(harness);
    // Fake default model has reasoning; resolve projects thinking choices.
    const listed = await harness.request('catalog.list', {});
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const options = catalog.configOptions as Array<Record<string, unknown>>;
    const thinking = options.find((option) => option.id === 'thinking');
    assert.ok(thinking, 'thinking option present for reasoning-capable default model');
    assert.equal((catalog.specialCatalogs as Record<string, string>).thinking, 'thinking');

    // Resolving the non-reasoning model drops the thinking default entirely.
    const modelChoices = (options.find((option) => option.id === 'model')!.choices as Array<{ value: string; displayName?: string }>);
    const plainModel = modelChoices.find((choice) => choice.value.includes('RzhnuTMuMw'))
      ?.value
      ?? modelChoices.find((choice) => choice.displayName === 'GLM-5.3')!.value;
    const resolved = await harness.request('catalog.resolve', {
      catalogRevision: catalog.catalogRevision as string,
      sessionConfig: {},
      turnConfig: { model: plainModel },
    });
    assert.equal(resolved.kind, 'result');
    const resolvedDefaults = ((resolved.payload as { result: Record<string, unknown> }).result.resolvedDefaults as { turnConfig: Record<string, string> }).turnConfig;
    assert.equal(resolvedDefaults.thinking, undefined, 'stale thinking values are dropped on model change');
  } finally {
    await harness.close();
  }
});

test('provider selection resolves only that Provider models and its Thinking vocabulary', async () => {
  const harness = startHarness({ scenario: { availableModels: FULL_SETTINGS.model.available } });
  try {
    await initialize(harness);
    await createSession(harness);
    const listed = await harness.request('catalog.list', {});
    const catalog = (listed.payload as { result: Record<string, unknown> }).result;
    const options = catalog.configOptions as Array<Record<string, unknown>>;
    const provider = options.find(option => option.id === 'provider');
    assert.deepEqual(
      (provider?.choices as Array<{ value: string }>).map(choice => choice.value),
      ['bigmodel', 'zai'],
    );
    const staleModel = (options.find(option => option.id === 'model')
      ?.choices as Array<{ value: string }>)[0]!.value;

    const resolved = await harness.request('catalog.resolve', {
      catalogRevision: catalog.catalogRevision,
      sessionConfig: {},
      turnConfig: {
        provider: 'zai',
        model: staleModel,
        thinking: 'max',
      },
    });
    assert.equal(resolved.kind, 'result');
    const result = (resolved.payload as { result: Record<string, unknown> }).result;
    const resolvedOptions = result.configOptions as Array<Record<string, unknown>>;
    const models = resolvedOptions.find(option => option.id === 'model')
      ?.choices as Array<{ value: string; displayName: string }>;
    assert.deepEqual(models.map(model => model.displayName), ['GLM-5.1']);
    const thinking = resolvedOptions.find(option => option.id === 'thinking');
    assert.deepEqual(
      (thinking?.choices as Array<{ value: string }>).map(choice => choice.value),
      ['enabled', 'disabled'],
    );
    const defaults = (result.resolvedDefaults as {
      turnConfig: Record<string, string>;
    }).turnConfig;
    assert.equal(defaults.provider, 'zai');
    assert.equal(defaults.model, models[0]!.value);
    assert.equal(defaults.thinking, 'enabled');
  } finally {
    await harness.close();
  }
});
